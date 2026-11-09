"""HTTP + WebSocket layer for GeneForge.

Every mutating endpoint goes through the Store, so a change made by an agent
over HTTP shows up in an open browser view instantly, and vice versa.
"""
from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import Body, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import bio, seqio, tools
from .store import Store

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


def create_app(store: Store) -> FastAPI:
    app = FastAPI(title="GeneForge", version="1.0.0", docs_url="/api/docs")
    app.state.store = store

    # ------------------------------------------------------------ helpers

    def resolve(ref: str) -> dict[str, Any]:
        """Accept a sequence id or a name, so agents can call by name."""
        try:
            return store.get(ref)
        except KeyError:
            found = store.find_by_name(ref)
            if found is None:
                raise HTTPException(404, f"no sequence {ref!r}")
            return found

    @app.on_event("startup")
    async def _startup():
        store.loop = asyncio.get_running_loop()
        store.start_watching()

    # -------------------------------------------------------------- state

    @app.get("/api/health")
    def health():
        return {"ok": True, "folder": store.folder, "open": len(store.sequences)}

    @app.get("/api/state")
    def state():
        return store.snapshot()

    @app.get("/api/files")
    def files():
        return {"files": seqio.list_folder(store.folder)}

    @app.get("/api/folder/browse")
    def browse_folder(path: str = Query("")):
        """Sub-folders of `path`, for picking a working folder from the UI."""
        target = os.path.abspath(os.path.expanduser(path or store.folder))
        if not os.path.isdir(target):
            raise HTTPException(404, f"no such folder: {target}")
        try:
            entries = sorted(
                (e for e in os.scandir(target) if e.is_dir() and not e.name.startswith(".")),
                key=lambda e: e.name.lower())
        except PermissionError:
            raise HTTPException(403, f"not allowed to read {target}")
        parent = os.path.dirname(target)
        return {
            "path": target,
            "parent": parent if parent != target else None,
            "home": os.path.expanduser("~"),
            "folders": [{"name": e.name, "path": e.path} for e in entries[:400]],
            "n_sequences": len(seqio.list_folder(target)),
        }

    @app.post("/api/folder")
    def set_folder(body: dict = Body(...)):
        path = body.get("path")
        if not path:
            raise HTTPException(400, "path required")
        try:
            return store.set_folder(path)
        except (FileNotFoundError, NotADirectoryError) as exc:
            raise HTTPException(404, str(exc))

    @app.post("/api/open")
    def open_file(body: dict = Body(...)):
        path = body.get("path")
        if not path:
            raise HTTPException(400, "path required")
        if not os.path.isabs(path):
            path = os.path.join(store.folder, path)
        if not os.path.exists(path):
            raise HTTPException(404, f"no such file: {path}")
        try:
            return {"sequences": store.open_path(path, origin=body.get("origin", "user"))}
        except Exception as exc:
            raise HTTPException(400, f"could not parse {os.path.basename(path)}: {exc}")

    @app.post("/api/import")
    def import_text(body: dict = Body(...)):
        """Open a file the user dragged in, from its text, without touching disk."""
        import tempfile
        text = body.get("text") or ""
        name = body.get("filename") or "dropped.gb"
        if not text.strip():
            raise HTTPException(400, "empty file")
        ext = os.path.splitext(name)[1].lower() or ".gb"
        with tempfile.NamedTemporaryFile("w", suffix=ext, delete=False) as fh:
            fh.write(text)
            tmp = fh.name
        try:
            loaded = seqio.read_file(tmp)
        except Exception as exc:
            raise HTTPException(400, f"could not parse {name}: {exc}")
        finally:
            try: os.unlink(tmp)
            except OSError: pass
        if not loaded:
            raise HTTPException(400, f"no sequences found in {name}")
        out = []
        for seq in loaded:
            seq["path"] = body.get("path") or None
            seq["dirty"] = not seq["path"]
            out.append(store.add_sequence(seq, origin="user"))
        return {"sequences": out}

    # ---------------------------------------------------------- sequences

    @app.post("/api/sequences")
    def create_sequence(body: dict = Body(...)):
        seq = {
            "name": body.get("name") or "untitled",
            "seq": bio.clean(body.get("seq", "")),
            "topology": body.get("topology", "linear"),
            "description": body.get("description", ""),
            "features": body.get("features") or [],
            "path": body.get("path"),
        }
        for feat in seq["features"]:
            feat.setdefault("id", seqio.new_id("f"))
            if not feat.get("segments"):
                feat["segments"] = [[int(feat.pop("start", 0)), int(feat.pop("end", 0))]]
            feat.setdefault("color", seqio.color_for(feat.get("type", ""), feat.get("label", "")))
        created = store.add_sequence(seq, origin=body.get("origin", "agent"))
        if body.get("save"):
            store.save(created["id"], body.get("path"), origin="agent")
        return created

    @app.patch("/api/sequences/{ref}")
    def patch_sequence(ref: str, body: dict = Body(...)):
        seq = resolve(ref)
        return store.update_sequence(
            seq["id"], origin=body.get("origin", "user"),
            name=body.get("name"), description=body.get("description"),
            topology=body.get("topology"), format=body.get("format"))

    @app.delete("/api/sequences/{ref}")
    def close_sequence(ref: str):
        seq = resolve(ref)
        store.close_sequence(seq["id"])
        return {"ok": True}

    @app.post("/api/sequences/{ref}/save")
    def save_sequence(ref: str, body: dict = Body(default={})):
        seq = resolve(ref)
        path = body.get("path")
        if path and not os.path.isabs(path):
            path = os.path.join(store.folder, path)
        try:
            return {"path": store.save(seq["id"], path, body.get("format"))}
        except Exception as exc:
            raise HTTPException(400, str(exc))

    @app.post("/api/sequences/{ref}/edit")
    def edit_sequence(ref: str, body: dict = Body(...)):
        seq = resolve(ref)
        return store.edit_sequence(
            seq["id"], int(body.get("start", 0)), int(body.get("end", 0)),
            body.get("replacement", ""), origin=body.get("origin", "user"))

    @app.get("/api/sequences/{ref}/export", response_class=PlainTextResponse)
    def export_sequence(ref: str, format: str = Query("genbank")):
        seq = resolve(ref)
        return seqio.to_text(seq, "fasta" if format == "fasta" else "genbank")

    # ----------------------------------------------------------- features

    @app.post("/api/sequences/{ref}/features")
    def add_feature(ref: str, body: dict = Body(...)):
        seq = resolve(ref)
        return store.add_feature(seq["id"], dict(body), origin=body.get("origin", "user"))

    @app.patch("/api/sequences/{ref}/features/{feat_id}")
    def patch_feature(ref: str, feat_id: str, body: dict = Body(...)):
        seq = resolve(ref)
        try:
            return store.update_feature(seq["id"], feat_id, dict(body),
                                        origin=body.get("origin", "user"))
        except KeyError as exc:
            raise HTTPException(404, str(exc))

    @app.delete("/api/sequences/{ref}/features/{feat_id}")
    def delete_feature(ref: str, feat_id: str):
        seq = resolve(ref)
        try:
            store.delete_feature(seq["id"], feat_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc))
        return {"ok": True}

    # ----------------------------------------------------------- analysis

    @app.get("/api/sequences/{ref}/orfs")
    def orfs(ref: str, min_aa: int = Query(30), starts: str = Query("ATG"),
             table: int = Query(1)):
        seq = resolve(ref)
        return {"orfs": bio.find_orfs(seq["seq"], seq["topology"], min_aa, table, starts)}

    @app.post("/api/sequences/{ref}/restriction")
    def restriction(ref: str, body: dict = Body(default={})):
        seq = resolve(ref)
        names = body.get("enzymes")
        if not names:
            names = [e["name"] for e in bio.enzyme_catalog(body.get("scope", "popular"))]
        return bio.restriction_map(seq["seq"], names, seq["topology"])

    @app.get("/api/enzymes")
    def enzymes(scope: str = Query("popular")):
        return {"enzymes": bio.enzyme_catalog(scope)}

    @app.post("/api/sequences/{ref}/stats")
    def stats(ref: str, body: dict = Body(default={})):
        seq = resolve(ref)
        start, end = int(body.get("start", 0)), int(body.get("end", len(seq["seq"])))
        return bio.seq_stats(bio.subsequence(seq["seq"], start, end, seq["topology"]))

    @app.post("/api/copy")
    def special_copy(body: dict = Body(...)):
        """Authoritative text for the 'copy as...' menu."""
        seq = resolve(body["id"]) if body.get("id") else None
        if seq is not None:
            start = int(body.get("start", 0))
            end = int(body.get("end", len(seq["seq"])))
            text = bio.subsequence(seq["seq"], start, end, seq["topology"])
        else:
            text = bio.clean(body.get("seq", ""))
        mode = body.get("mode", "dna")
        strand = int(body.get("strand", 1))
        if strand == -1:
            text = bio.revcomp(text)
        frame = int(body.get("frame", 0))

        if mode == "dna":
            out = text
        elif mode == "dna_rev":
            out = text[::-1]
        elif mode == "dna_complement":
            out = bio.revcomp(text)[::-1]
        elif mode == "dna_revcomp":
            out = bio.revcomp(text)
        elif mode == "rna":
            out = bio.to_rna(text)
        elif mode == "rna_revcomp":
            out = bio.to_rna(bio.revcomp(text))
        elif mode == "protein":
            out = bio.translate(text[frame:], table=int(body.get("table", 1)))
        elif mode == "protein_revcomp":
            out = bio.translate(bio.revcomp(text)[frame:], table=int(body.get("table", 1)))
        elif mode == "fasta":
            name = (seq or {}).get("name", "selection")
            out = f">{name}\n" + "\n".join(text[i:i + 60] for i in range(0, len(text), 60))
        elif mode == "genbank" and seq is not None:
            out = seqio.to_text(seq, "genbank")
        else:
            out = text
        return {"text": out, "length": len(out)}

    # ------------------------------------------------------------ primers

    @app.post("/api/sequences/{ref}/primers/design")
    def design(ref: str, body: dict = Body(...)):
        seq = resolve(ref)
        result = bio.design_primers(
            seq["seq"], int(body.get("start", 0)), int(body.get("end", 0)),
            n_return=int(body.get("n_return", 5)),
            opt_size=int(body.get("opt_size", 20)),
            min_tm=float(body.get("min_tm", 57)),
            opt_tm=float(body.get("opt_tm", 60)),
            max_tm=float(body.get("max_tm", 63)),
            flank=int(body.get("flank", 250)))
        return result

    @app.get("/api/primers")
    def list_primers():
        return {"primers": list(store.primers.values())}

    @app.post("/api/primers")
    def add_primer(body: dict = Body(...)):
        primer = {
            "name": body.get("name") or "primer",
            "seq": bio.clean(body.get("seq", "")),
            "notes": body.get("notes", ""),
        }
        if not primer["seq"]:
            raise HTTPException(400, "primer sequence required")
        primer.update(bio.primer_stats(primer["seq"]))
        primer["name"] = body.get("name") or "primer"
        created = store.add_primer(primer, origin=body.get("origin", "user"))
        if body.get("attach_to"):
            target = resolve(body["attach_to"])
            for site in bio.binding_sites(created["seq"], target["seq"], target["topology"]):
                if site["full"] or site["anneal"] >= 15:
                    store.add_feature(target["id"], {
                        "label": created["name"], "type": "primer_bind",
                        "segments": [[site["start"], site["end"]]],
                        "strand": site["strand"],
                        "qualifiers": {"note": f"Tm {created.get('tm')} C"},
                    }, origin="user")
                    break
        return created

    @app.delete("/api/primers/{primer_id}")
    def remove_primer(primer_id: str):
        store.delete_primer(primer_id)
        return {"ok": True}

    @app.get("/api/sequences/{ref}/primer_sites")
    def primer_sites(ref: str, min_anneal: int = Query(15)):
        """Where every saved primer lands on this sequence, for the map view."""
        target = resolve(ref)
        out = []
        for primer in store.primers.values():
            for site in bio.binding_sites(primer["seq"], target["seq"],
                                          target["topology"], min_anneal):
                if site["full"] or site["anneal"] >= min_anneal:
                    out.append({"id": primer["id"], "name": primer["name"],
                                "seq": primer["seq"], "tm": primer.get("tm"),
                                **site})
        return {"sites": out}

    @app.post("/api/primers/bind")
    def bind(body: dict = Body(...)):
        target = resolve(body["id"])
        return {"sites": bio.binding_sites(bio.clean(body.get("seq", "")),
                                           target["seq"], target["topology"],
                                           int(body.get("min_anneal", 15)))}

    @app.post("/api/primer/stats")
    def stats_primer(body: dict = Body(...)):
        return bio.primer_stats(bio.clean(body.get("seq", "")))

    # ---------------------------------------------------------- alignment

    @app.post("/api/align")
    def align(body: dict = Body(...)):
        refs = body.get("ids") or []
        if len(refs) < 2:
            raise HTTPException(400, "select at least two sequences")
        seqs = []
        for ref in refs:
            s = resolve(ref)
            seqs.append({"id": s["id"], "name": s["name"], "seq": s["seq"]})
        return bio.align(seqs, body.get("mode", "global"))

    # -------------------------------------------------- structure & folding

    @app.get("/api/capabilities")
    def capabilities():
        return tools.capabilities()

    @app.post("/api/fold/nucleic")
    def fold_nucleic(body: dict = Body(...)):
        if body.get("id"):
            seq = resolve(body["id"])
            text = bio.subsequence(seq["seq"], int(body.get("start", 0)),
                                   int(body.get("end", len(seq["seq"]))), seq["topology"])
        else:
            text = bio.clean(body.get("seq", ""))
        return tools.fold_nucleic(text, body.get("kind", "rna"),
                                  float(body.get("temperature", 37)))

    @app.post("/api/sequences/{ref}/rbs")
    def rbs(ref: str, body: dict = Body(default={})):
        seq = resolve(ref)
        start, end = body.get("start"), body.get("end")
        if start is None or end is None:
            hit = None
            for f in seq["features"]:
                blob = f"{f.get('label','')} {f.get('type','')}".lower()
                if "rbs" in blob or "ribosome" in blob or "shine" in blob:
                    hit = f
                    break
            if hit is None:
                raise HTTPException(400, "no RBS feature found; give start and end")
            start, end = hit["segments"][0][0], hit["segments"][-1][1]
        out = tools.rbs_accessibility(seq["seq"], int(start), int(end),
                                      int(body.get("flank", 60)),
                                      float(body.get("temperature", 37)))
        out["rbs_start"], out["rbs_end"] = int(start), int(end)
        return out

    @app.post("/api/af3")
    def af3(body: dict = Body(...)):
        job = tools.af3_job(
            body.get("name") or "geneforge_job",
            body.get("proteins") or [], body.get("dna") or [],
            body.get("rna") or [], body.get("ions") or [],
            bool(body.get("double_stranded", True)), body.get("seeds"))
        if job.get("error"):
            raise HTTPException(400, job["error"])
        if body.get("save"):
            name = "".join(c for c in (body.get("name") or "job") if c.isalnum() or c in "-_") or "job"
            path = os.path.join(store.folder, f"{name}_alphafold3.json")
            with open(path, "w") as fh:
                fh.write(job["json"])
            job["path"] = path
            store.broadcast({"type": "files", "files": seqio.list_folder(store.folder)})
        return job

    @app.post("/api/esmfold")
    def esmfold(body: dict = Body(...)):
        protein = body.get("protein")
        if not protein and body.get("id"):
            seq = resolve(body["id"])
            nt = bio.subsequence(seq["seq"], int(body.get("start", 0)),
                                 int(body.get("end", len(seq["seq"]))), seq["topology"])
            if int(body.get("strand", 1)) == -1:
                nt = bio.revcomp(nt)
            protein = bio.translate(nt, to_stop=True)
        out = tools.esmfold(protein or "", body.get("device"))
        if out.get("error"):
            raise HTTPException(400, out["error"])
        if body.get("save"):
            name = "".join(c for c in (body.get("name") or "esmfold") if c.isalnum() or c in "-_")
            path = os.path.join(store.folder, f"{name}.pdb")
            with open(path, "w") as fh:
                fh.write(out["pdb"])
            out["path"] = path
            store.broadcast({"type": "files", "files": seqio.list_folder(store.folder)})
        return out

    @app.post("/api/render")
    def render(body: dict = Body(...)):
        path = body.get("path") or ""
        if not os.path.isabs(path):
            path = os.path.join(store.folder, path)
        out_png = body.get("out") or os.path.splitext(path)[0] + f"_{body.get('style','cartoon')}.png"
        if not os.path.isabs(out_png):
            out_png = os.path.join(store.folder, out_png)
        out = tools.pymol_render(path, out_png, body.get("style", "cartoon"),
                                 int(body.get("width", 1600)), int(body.get("height", 1200)))
        if out.get("error"):
            raise HTTPException(400, out["error"])
        store.broadcast({"type": "files", "files": seqio.list_folder(store.folder)})
        return out

    @app.get("/api/image")
    def image(path: str = Query(...)):
        """Serve a rendered PNG so the panel can show it instead of a file path."""
        from fastapi.responses import FileResponse
        if not os.path.isabs(path):
            path = os.path.join(store.folder, path)
        if os.path.splitext(path)[1].lower() not in {".png", ".jpg", ".jpeg"}:
            raise HTTPException(400, "not an image")
        if not os.path.exists(path):
            raise HTTPException(404, "no such image")
        return FileResponse(path)

    @app.post("/api/reveal")
    def reveal(body: dict = Body(...)):
        """Show a file we produced in the Finder."""
        import platform
        import subprocess
        path = body.get("path") or ""
        if not os.path.isabs(path):
            path = os.path.join(store.folder, path)
        if not os.path.exists(path):
            raise HTTPException(404, "no such file")
        if platform.system() != "Darwin":
            raise HTTPException(400, "only on macOS")
        subprocess.Popen(["open", "-R", path])
        return {"ok": True, "path": path}

    @app.post("/api/copy_file")
    def copy_file(body: dict = Body(...)):
        """Save a copy of something GeneForge made, under a name the user picks."""
        import shutil
        src = body.get("from") or ""
        if not os.path.isabs(src):
            src = os.path.join(store.folder, src)
        if not os.path.exists(src):
            raise HTTPException(404, "no such file")
        name = os.path.basename(body.get("name") or os.path.basename(src))
        if not name:
            raise HTTPException(400, "name required")
        dest = os.path.join(store.folder, name)
        if os.path.abspath(dest) == os.path.abspath(src):
            return {"path": dest, "note": "already there"}
        shutil.copy2(src, dest)
        store.broadcast({"type": "files", "files": seqio.list_folder(store.folder)})
        return {"path": dest}

    @app.post("/api/esmfold/install")
    def esmfold_install(body: dict = Body(default={})):
        return tools.start_esmfold_install(
            on_event=lambda line: store.notice(line, "info", origin="install"))

    @app.get("/api/esmfold/install")
    def esmfold_install_status():
        return tools.esmfold_install_status()

    @app.get("/api/structures")
    def structures():
        exts = {".pdb", ".cif", ".mmcif", ".ent"}
        found = []
        for root, dirs, files in os.walk(store.folder):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for fn in files:
                if os.path.splitext(fn)[1].lower() in exts:
                    full = os.path.join(root, fn)
                    found.append({"path": full, "name": fn,
                                  "rel": os.path.relpath(full, store.folder),
                                  "size": os.path.getsize(full)})
        return {"structures": sorted(found, key=lambda f: f["name"])}

    @app.get("/api/structure", response_class=PlainTextResponse)
    def structure_text(path: str = Query(...)):
        if not os.path.isabs(path):
            path = os.path.join(store.folder, path)
        if os.path.splitext(path)[1].lower() not in {".pdb", ".cif", ".mmcif", ".ent"}:
            raise HTTPException(400, "not a structure file")
        if not os.path.exists(path):
            raise HTTPException(404, "no such structure")
        with open(path) as fh:
            return fh.read()

    # ----------------------------------------------------------- assembly

    @app.post("/api/assembly/goldengate")
    def goldengate(body: dict = Body(...)):
        frags = _fragments(body, resolve)
        return bio.golden_gate(frags, body.get("enzyme", "BsaI"),
                               bool(body.get("circular", True)))

    @app.post("/api/assembly/gibson")
    def gibson(body: dict = Body(...)):
        frags = _fragments(body, resolve)
        return bio.gibson(frags, int(body.get("min_homology", 20)),
                          bool(body.get("circular", True)))

    @app.post("/api/optimize")
    def optimize(body: dict = Body(...)):
        if body.get("id"):
            seq = resolve(body["id"])
            text = bio.subsequence(seq["seq"], int(body.get("start", 0)),
                                   int(body.get("end", len(seq["seq"]))), seq["topology"])
        else:
            text = bio.clean(body.get("seq", ""))
        return bio.codon_optimize(text, body.get("avoid_enzymes") or [],
                                  body.get("species", "e_coli"),
                                  bool(body.get("keep_protein", True)))

    @app.post("/api/sequences/{ref}/mutate")
    def mutate(ref: str, body: dict = Body(...)):
        seq = resolve(ref)
        cds_start = int(body.get("cds_start", 0))
        cds_end = int(body.get("cds_end", len(seq["seq"])))
        strand = int(body.get("strand", 1))
        muts = body.get("mutations") or ([body["mutation"]] if body.get("mutation") else [])
        if not muts:
            raise HTTPException(400, "no mutations given")
        text = seq["seq"]
        applied = []
        for mut in muts:
            try:
                res = bio.apply_protein_mutation(text, cds_start, cds_end, strand, mut)
            except ValueError as exc:
                raise HTTPException(400, str(exc))
            text = res["seq"]
            applied.append({k: v for k, v in res.items() if k != "seq"})

        if body.get("in_place"):
            store.edit_sequence(seq["id"], 0, len(seq["seq"]), text, origin="agent")
            return {"id": seq["id"], "applied": applied}

        import copy
        clone = {
            "name": body.get("name") or f"{seq['name']}_{'_'.join(m['mutation'] for m in applied)}",
            "seq": text,
            "topology": seq["topology"],
            "description": f"{seq['name']} with " + ", ".join(m["mutation"] for m in applied),
            "features": copy.deepcopy(seq["features"]),
            "path": None,
        }
        for feat in clone["features"]:
            feat["id"] = seqio.new_id("f")
        created = store.add_sequence(clone, origin="agent")
        for m in applied:
            store.add_feature(created["id"], {
                "label": m["mutation"], "type": "variation",
                "segments": [[m["nt_start"], m["nt_start"] + 3]],
                "strand": strand,
                "qualifiers": {"note": f"{m['old_codon']} -> {m['new_codon']}"},
            }, origin="agent")
        if body.get("save"):
            store.save(created["id"], body.get("path"), origin="agent")
        return {"id": created["id"], "applied": applied, "sequence": store.get(created["id"])}

    # ---------------------------------------------------------- websocket

    @app.websocket("/ws")
    async def websocket_endpoint(ws: WebSocket):
        await ws.accept()
        queue = store.subscribe()
        await ws.send_json({"type": "state", **store.snapshot()})

        async def pump_incoming():
            try:
                while True:
                    await ws.receive_text()
            except Exception:
                return

        reader = asyncio.create_task(pump_incoming())
        try:
            while not reader.done():
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    await ws.send_json({"type": "ping"})
                    continue
                await ws.send_json(event)
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception:
            pass
        finally:
            reader.cancel()
            store.unsubscribe(queue)

    # ------------------------------------------------------------- static

    @app.get("/", response_class=HTMLResponse)
    def index():
        with open(os.path.join(STATIC_DIR, "index.html")) as fh:
            return HTMLResponse(fh.read(), headers={"Cache-Control": "no-store"})

    @app.middleware("http")
    async def no_cache_static(request, call_next):
        """The front end has no build step, so a reload must show the new file."""
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, must-revalidate"
        return response

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
    return app


def _fragments(body: dict, resolve) -> list[dict[str, Any]]:
    frags: list[dict[str, Any]] = []
    for ref in body.get("ids") or []:
        s = resolve(ref)
        frags.append({"name": s["name"], "seq": s["seq"], "circular": s["topology"] == "circular"})
    for raw in body.get("fragments") or []:
        frags.append({"name": raw.get("name", "fragment"), "seq": bio.clean(raw.get("seq", "")),
                      "circular": bool(raw.get("circular"))})
    return frags
