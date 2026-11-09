"""Optional, heavier capabilities: alignment, nucleic-acid folding, structure.

Every entry point here degrades gracefully. If a library is not installed the
function returns {"error": ...} and `capabilities()` reports it as unavailable,
so the UI can grey the feature out instead of breaking.
"""
from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import threading
import tempfile
import time
from typing import Any

from . import bio

_PARAM_LOCK = threading.Lock()   # ViennaRNA energy parameters are global state


# --------------------------------------------------------------------------
# what is actually installed
# --------------------------------------------------------------------------

def _have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def capabilities() -> dict[str, Any]:
    specs = system_specs()
    return {
        "msa": _have("pyfamsa") or bool(shutil.which("muscle")),
        "msa_engine": "FAMSA" if _have("pyfamsa") else ("MUSCLE" if shutil.which("muscle") else None),
        "fold_nucleic": _have("RNA"),
        "structure": _have("biotite"),
        "pymol": bool(shutil.which("pymol")) or _have("pymol"),
        "esmfold": _have("torch") and _have("transformers"),
        "esmfold_why": _esmfold_why(specs),
        "esmfold_install": esmfold_install_status(),
        "blender": bool(shutil.which("blender")),
        "specs": specs,
    }


def _esmfold_why(specs: dict[str, Any]) -> dict[str, Any]:
    """Why ESMFold is or is not usable, in words the panel can show as-is."""
    have_torch, have_tf = _have("torch"), _have("transformers")
    ram = specs.get("ram_gb")
    missing = [n for n, ok in (("torch", have_torch), ("transformers", have_tf)) if not ok]
    if not missing:
        return {"ready": True, "reason": "Installed and ready.", "can_install": False}
    enough_ram = ram is None or ram >= 15.0
    reason = (
        f"Not installed. ESMFold is an extra ~5 GB download ({' and '.join(missing)} "
        f"plus a 2.7 GB model on first run), so GeneForge leaves it out of the "
        f"standard install."
    )
    if not enough_ram:
        reason += (f" This machine reports {ram} GB of RAM and ESMFold needs about 16 GB, "
                   f"so it would be installed but refuse to run. Use the AlphaFold 3 "
                   f"export instead.")
    return {
        "ready": False,
        "reason": reason,
        "can_install": True,
        "enough_ram": enough_ram,
        "missing": missing,
        "command": "./setup.sh --with-esmfold",
    }


# --------------------------------------------------------------------------
# installing ESMFold on demand
# --------------------------------------------------------------------------

_INSTALL: dict[str, Any] = {"state": "idle", "log": [], "started": 0.0}
_INSTALL_LOCK = threading.Lock()


def esmfold_install_status() -> dict[str, Any]:
    with _INSTALL_LOCK:
        return {"state": _INSTALL["state"], "log": list(_INSTALL["log"])[-12:]}


def start_esmfold_install(on_event=None) -> dict[str, Any]:
    """Install torch + transformers into the running interpreter's environment.

    Runs in a background thread; progress is reported through `on_event` and
    readable at any time with esmfold_install_status().
    """
    import sys
    with _INSTALL_LOCK:
        if _INSTALL["state"] == "running":
            return {"state": "running", "note": "an install is already running"}
        _INSTALL.update({"state": "running", "log": ["starting pip install…"], "started": time.time()})

    def say(line: str) -> None:
        with _INSTALL_LOCK:
            _INSTALL["log"].append(line)
            _INSTALL["log"] = _INSTALL["log"][-200:]
        if on_event:
            try:
                on_event(line)
            except Exception:
                pass

    def run() -> None:
        cmd = [sys.executable, "-m", "pip", "install", "--upgrade",
               "torch", "transformers", "accelerate"]
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1)
            for line in proc.stdout or []:
                line = line.rstrip()
                if line and ("Downloading" in line or "Installing" in line
                             or "Successfully" in line or "ERROR" in line):
                    say(line[:200])
            code = proc.wait()
        except Exception as exc:
            say(f"install failed: {exc}")
            with _INSTALL_LOCK:
                _INSTALL["state"] = "failed"
            return
        ok = code == 0 and _have("torch") and _have("transformers")
        say("ESMFold installed — reload GeneForge to use it." if ok
            else f"pip exited with code {code}")
        with _INSTALL_LOCK:
            _INSTALL["state"] = "done" if ok else "failed"

    threading.Thread(target=run, daemon=True).start()
    return {"state": "running"}


def system_specs() -> dict[str, Any]:
    """Real host specs. Runs on the user's machine, so this is authoritative."""
    out: dict[str, Any] = {
        "platform": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpus": os.cpu_count(),
    }
    try:
        if platform.system() == "Darwin":
            def sysctl(key):
                return subprocess.run(["sysctl", "-n", key], capture_output=True,
                                      text=True, timeout=5).stdout.strip()
            mem = sysctl("hw.memsize")
            out["ram_gb"] = round(int(mem) / 1024 ** 3, 1) if mem.isdigit() else None
            out["chip"] = sysctl("machdep.cpu.brand_string") or None
            out["macos"] = subprocess.run(["sw_vers", "-productVersion"], capture_output=True,
                                          text=True, timeout=5).stdout.strip() or None
        else:
            with open("/proc/meminfo") as fh:
                for line in fh:
                    if line.startswith("MemTotal"):
                        out["ram_gb"] = round(int(line.split()[1]) / 1024 ** 2, 1)
                        break
    except Exception:
        out.setdefault("ram_gb", None)
    try:
        import torch
        out["torch"] = torch.__version__
        out["mps"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
        out["cuda"] = bool(torch.cuda.is_available())
    except Exception:
        out["torch"] = None
    return out


# --------------------------------------------------------------------------
# multiple sequence alignment  (replaces hand-rolled code)
# --------------------------------------------------------------------------

def msa(sequences: list[dict[str, str]], seq_type: str = "dna") -> dict[str, Any]:
    """Align with FAMSA (preferred) or MUSCLE. Never with hand-written code.

    Equal-length input is still compared column-wise without alignment, which
    is exact by construction and keeps numbering identical to the reference.
    """
    seqs = [{"id": s.get("id"), "name": s.get("name") or "seq",
             "seq": bio.clean(s.get("seq", ""))} for s in sequences]
    seqs = [s for s in seqs if s["seq"]]
    if len(seqs) < 2:
        return {"error": "need at least two sequences"}

    lengths = {len(s["seq"]) for s in seqs}
    if len(lengths) == 1:
        rows = [{"id": s["id"], "name": s["name"], "aligned": s["seq"]} for s in seqs]
        return _summarise(rows, "identical-length (no alignment needed)")

    if _have("pyfamsa"):
        from pyfamsa import Aligner, Sequence
        names = [s["name"].encode()[:200] for s in seqs]
        # FAMSA keys on name; make them unique so nothing is silently merged.
        seen: dict[bytes, int] = {}
        uniq = []
        for n in names:
            seen[n] = seen.get(n, 0) + 1
            uniq.append(n if seen[n] == 1 else n + b"_%d" % seen[n])
        objs = [Sequence(u, s["seq"].encode()) for u, s in zip(uniq, seqs)]
        aligned = Aligner(guide_tree="upgma").align(objs)
        got = {s.id: s.sequence.decode() for s in aligned}
        rows = [{"id": s["id"], "name": s["name"], "aligned": got.get(u, "")}
                for u, s in zip(uniq, seqs)]
        return _summarise(rows, "FAMSA")

    if shutil.which("muscle"):
        with tempfile.TemporaryDirectory() as tmp:
            fin, fout = os.path.join(tmp, "in.fa"), os.path.join(tmp, "out.fa")
            with open(fin, "w") as fh:
                for i, s in enumerate(seqs):
                    fh.write(f">s{i}\n{s['seq']}\n")
            try:
                subprocess.run(["muscle", "-align", fin, "-output", fout],
                               capture_output=True, timeout=300, check=True)
            except Exception as exc:
                return {"error": f"MUSCLE failed: {exc}"}
            from Bio import SeqIO
            got = {r.id: str(r.seq).upper() for r in SeqIO.parse(fout, "fasta")}
        rows = [{"id": s["id"], "name": s["name"], "aligned": got.get(f"s{i}", "")}
                for i, s in enumerate(seqs)]
        return _summarise(rows, "MUSCLE")

    return {"error": "no alignment engine installed (pip install pyfamsa, or conda install muscle)"}


def _summarise(rows: list[dict[str, Any]], method: str) -> dict[str, Any]:
    ref = rows[0]["aligned"]
    width = len(ref)
    variable: set[int] = set()
    identities = []
    for row in rows[1:]:
        diffs = [i for i, (a, b) in enumerate(zip(ref, row["aligned"])) if a != b]
        row["differences"] = diffs[:20000]
        row["identity"] = round(100.0 * (width - len(diffs)) / width, 2) if width else 0.0
        identities.append(row["identity"])
        variable.update(diffs)
    rows[0]["differences"] = []
    rows[0]["identity"] = 100.0
    return {
        "rows": rows,
        "length": width,
        "method": method,
        "variable_positions": sorted(variable)[:20000],
        "mean_identity": round(sum(identities) / len(identities), 2) if identities else 100.0,
    }


# --------------------------------------------------------------------------
# nucleic acid secondary structure (ViennaRNA)
# --------------------------------------------------------------------------

def fold_nucleic(seq: str, kind: str = "rna", temperature: float = 37.0) -> dict[str, Any]:
    """MFE structure and ensemble energy for an RNA or DNA sequence."""
    if not _have("RNA"):
        return {"error": "ViennaRNA not installed (pip install ViennaRNA)"}
    import RNA
    s = bio.clean(seq)
    if not s:
        return {"error": "empty sequence"}
    if len(s) > 10000:
        return {"error": f"sequence too long for folding ({len(s)} nt; limit 10000)"}
    s = s.replace("T", "U") if kind == "rna" else s.replace("U", "T")
    with _PARAM_LOCK:
        try:
            if kind == "dna":
                RNA.params_load_DNA_Mathews2004()
            md = RNA.md()
            md.temperature = float(temperature)
            fc = RNA.fold_compound(s, md)
            structure, mfe = fc.mfe()
            fc.exp_params_rescale(mfe)
            _, ensemble = fc.pf()
            centroid, _ = fc.centroid()
            return {
                "sequence": s,
                "structure": structure,
                "mfe": round(float(mfe), 2),
                "ensemble_energy": round(float(ensemble), 2),
                "centroid": centroid,
                "kind": kind,
                "temperature": temperature,
                "engine": f"ViennaRNA {RNA.__version__}",
            }
        except Exception as exc:
            return {"error": str(exc)}
        finally:
            if kind == "dna":
                try:
                    RNA.params_load_RNA_Turner2004()
                except Exception:
                    pass


def rbs_accessibility(seq: str, rbs_start: int, rbs_end: int,
                      flank: int = 60, temperature: float = 37.0) -> dict[str, Any]:
    """Energy cost of opening the RBS, a standard proxy for translation initiation.

    Folds a window of mRNA around the ribosome binding site twice: freely, and
    with the RBS forced single-stranded. The difference is the work the
    ribosome must do to expose it. Larger dG_open means a more occluded RBS.
    """
    if not _have("RNA"):
        return {"error": "ViennaRNA not installed"}
    import RNA
    s = bio.clean(seq).replace("T", "U")
    n = len(s)
    a = max(0, int(rbs_start) - flank)
    b = min(n, int(rbs_end) + flank)
    window = s[a:b]
    if not window:
        return {"error": "empty window"}
    lo, hi = int(rbs_start) - a, int(rbs_end) - a
    if hi <= lo:
        return {"error": "RBS range is empty"}

    with _PARAM_LOCK:
        try:
            md = RNA.md()
            md.temperature = float(temperature)

            fc = RNA.fold_compound(window, md)
            structure, mfe = fc.mfe()
            fc.exp_params_rescale(mfe)
            _, g_free = fc.pf()

            fc2 = RNA.fold_compound(window, md)
            for i in range(lo, hi):
                fc2.hc_add_up(i + 1)          # ViennaRNA positions are 1-based
            st2, mfe2 = fc2.mfe()
            fc2.exp_params_rescale(mfe2)
            _, g_open = fc2.pf()

            dg = float(g_open) - float(g_free)
            paired = sum(1 for ch in structure[lo:hi] if ch != ".")
            return {
                "window_start": a, "window_end": b,
                "window": window,
                "structure": structure,
                "rbs_local": [lo, hi],
                "mfe": round(float(mfe), 2),
                "dG_open": round(dg, 2),
                "rbs_paired_bases": paired,
                "rbs_length": hi - lo,
                "verdict": _rbs_verdict(dg, paired, hi - lo),
                "engine": f"ViennaRNA {RNA.__version__}",
            }
        except Exception as exc:
            return {"error": str(exc)}


def _rbs_verdict(dg: float, paired: int, length: int) -> str:
    if dg < 2 and paired == 0:
        return "accessible - RBS is unpaired in the ensemble"
    if dg < 4:
        return "mostly accessible"
    if dg < 8:
        return "partly occluded - may reduce initiation"
    return "strongly occluded - likely to depress expression"


# --------------------------------------------------------------------------
# AlphaFold Server job file
# --------------------------------------------------------------------------

def af3_job(name: str, proteins: list[dict[str, Any]], dna: list[dict[str, Any]] | None = None,
            rna: list[dict[str, Any]] | None = None, ions: list[dict[str, Any]] | None = None,
            double_stranded: bool = True, seeds: list[str] | None = None) -> dict[str, Any]:
    """Build an AlphaFold Server job, ready to upload at alphafoldserver.com.

    DNA entities in AF3 are single strands, so a duplex needs both the given
    strand and its reverse complement - the step that is easy to get wrong by
    hand and the main reason this exists.
    """
    entities: list[dict[str, Any]] = []
    for p in proteins or []:
        aa = "".join(ch for ch in (p.get("sequence") or "").upper() if ch.isalpha()).replace("*", "")
        if not aa:
            continue
        entities.append({"proteinChain": {"sequence": aa, "count": int(p.get("count", 1))}})
    for d in dna or []:
        strand = bio.clean(d.get("sequence", "")).replace("U", "T")
        if not strand:
            continue
        entities.append({"dnaSequence": {"sequence": strand, "count": int(d.get("count", 1))}})
        if double_stranded and d.get("double", True):
            entities.append({"dnaSequence": {"sequence": bio.revcomp(strand),
                                             "count": int(d.get("count", 1))}})
    for r in rna or []:
        strand = bio.clean(r.get("sequence", "")).replace("T", "U")
        if strand:
            entities.append({"rnaSequence": {"sequence": strand, "count": int(r.get("count", 1))}})
    for i in ions or []:
        if i.get("ion"):
            entities.append({"ion": {"ion": str(i["ion"]).upper(), "count": int(i.get("count", 1))}})

    if not entities:
        return {"error": "nothing to fold"}
    job = [{
        "name": (name or "geneforge_job")[:120],
        "modelSeeds": seeds or [],
        "sequences": entities,
        "dialect": "alphafoldserver",
        "version": 1,
    }]
    tokens = sum(len(e[k]["sequence"]) * e[k].get("count", 1)
                 for e in entities for k in e
                 if k in ("proteinChain", "dnaSequence", "rnaSequence"))
    return {"job": job, "json": json.dumps(job, indent=2), "entities": len(entities),
            "approx_tokens": tokens}


ZINC_FINGER_HINT = (
    "Classical C2H2 zinc fingers need one Zn per finger - a three-finger "
    "domain such as Zif268 takes 3 Zn ions per chain."
)


# --------------------------------------------------------------------------
# ESMFold (optional, local)
# --------------------------------------------------------------------------

_ESM_CACHE: dict[str, Any] = {}


def esmfold(sequence: str, device: str | None = None,
            max_len: int = 700, min_ram_gb: float = 15.0) -> dict[str, Any]:
    """Fold a single protein chain locally with ESMFold.

    Refuses rather than thrashing: checks RAM and length first. Single chain,
    protein only - no DNA, no multimers, no metals.
    """
    if not (_have("torch") and _have("transformers")):
        return {"error": "ESMFold not installed. Run: geneforge-setup --with-esmfold"}
    aa = "".join(ch for ch in (sequence or "").upper() if ch.isalpha()).replace("*", "")
    if not aa:
        return {"error": "empty protein sequence"}
    if len(aa) > max_len:
        return {"error": f"{len(aa)} residues exceeds the {max_len}-residue guard for local folding"}
    specs = system_specs()
    ram = specs.get("ram_gb")
    if ram is not None and ram < min_ram_gb:
        return {"error": f"ESMFold needs ~16 GB RAM; this machine reports {ram} GB. "
                         f"Use the AlphaFold 3 export instead."}
    try:
        import torch
        from transformers import AutoTokenizer, EsmForProteinFolding
        if "model" not in _ESM_CACHE:
            tok = AutoTokenizer.from_pretrained("facebook/esmfold_v1")
            model = EsmForProteinFolding.from_pretrained("facebook/esmfold_v1",
                                                         low_cpu_mem_usage=True)
            model.eval()
            if device is None:
                # MPS still misses ops ESMFold needs; CPU is slower but correct.
                device = "cuda" if torch.cuda.is_available() else "cpu"
            model.to(device)
            model.esm = model.esm.float()
            try:
                model.trunk.set_chunk_size(64)
            except Exception:
                pass
            _ESM_CACHE.update({"model": model, "tok": tok, "device": device})
        model, tok = _ESM_CACHE["model"], _ESM_CACHE["tok"]
        inputs = tok([aa], return_tensors="pt", add_special_tokens=False)
        inputs = {k: v.to(_ESM_CACHE["device"]) for k, v in inputs.items()}
        with torch.no_grad():
            out = model(**inputs)
        pdb = model.output_to_pdb(out)[0]
        plddt = float(out["plddt"][0, :, 1].mean()) * (100 if float(out["plddt"].max()) <= 1 else 1)
        return {"pdb": pdb, "length": len(aa), "mean_plddt": round(plddt, 1),
                "device": _ESM_CACHE["device"], "engine": "ESMFold v1"}
    except Exception as exc:
        return {"error": f"ESMFold failed: {exc}"}


# --------------------------------------------------------------------------
# PyMOL rendering
# --------------------------------------------------------------------------

PYMOL_STYLES = {
    "cartoon": ["hide everything", "show cartoon", "spectrum count, rainbow, name CA"],
    "surface": ["hide everything", "show surface", "set transparency, 0.15", "color grey80"],
    "sticks": ["hide everything", "show sticks", "util.cbaw"],
    "cartoon_bfactor": ["hide everything", "show cartoon", "spectrum b, blue_white_red"],
}


def pymol_render(structure_path: str, out_png: str, style: str = "cartoon",
                 width: int = 1600, height: int = 1200, ray: bool = True,
                 bg: str = "white", timeout: int = 300) -> dict[str, Any]:
    """Ray-traced publication render via PyMOL, run headless.

    Driven through a Python script rather than a .pml one. PyMOL's own command
    parser does not strip quotes from arguments, so a quoted path produced a
    file literally named '"/path/x.png".png'; unquoted paths in turn break on
    spaces and commas. cmd.load()/cmd.png() take real Python strings and have
    neither problem.
    """
    exe = shutil.which("pymol")
    if not exe:
        return {"error": "PyMOL not found. Install with: mamba install -c conda-forge pymol-open-source"}
    if not os.path.exists(structure_path):
        return {"error": f"no such structure: {structure_path}"}
    out_dir = os.path.dirname(os.path.abspath(out_png))
    if out_dir and not os.path.isdir(out_dir):
        return {"error": f"no such folder for the image: {out_dir}"}
    body = PYMOL_STYLES.get(style, PYMOL_STYLES["cartoon"])
    script = "\n".join([
        "from pymol import cmd",
        f"cmd.load({structure_path!r}, 'mol')",
        *[f"cmd.do({line!r})" for line in body],
        f"cmd.bg_color({bg!r})",
        f"cmd.set('ray_opaque_background', {0 if bg == 'none' else 1})",
        "cmd.set('antialias', 2)",
        "cmd.set('ray_shadows', 0)",
        "cmd.set('specular', 0.2)",
        "cmd.orient()",
        "cmd.zoom('all', buffer=3, complete=1)",
        f"cmd.png({out_png!r}, width={int(width)}, height={int(height)}, "
        f"dpi=300, ray={1 if ray else 0})",
        # cmd.png() is asynchronous unless the image is flushed out first.
        "cmd.sync()",
        "",
    ])
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as fh:
        fh.write(script)
        spath = fh.name
    try:
        proc = subprocess.run([exe, "-cq", spath], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"error": f"PyMOL render timed out after {timeout}s"}
    finally:
        try:
            os.unlink(spath)
        except OSError:
            pass
    if not os.path.exists(out_png):
        return {"error": f"PyMOL produced no image: {(proc.stderr or proc.stdout)[-400:]}"}
    return {"png": out_png, "style": style, "size": os.path.getsize(out_png),
            "width": width, "height": height}
