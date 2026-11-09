"""The live project: the single source of truth for GeneForge.

Everything the UI shows lives here in memory. Any mutation -- whether it came
from a click in the browser or from an agent calling the HTTP API -- updates
this store and is pushed to every connected client over the WebSocket, so open
views stay current without reloading and without losing local UI state.
"""
from __future__ import annotations

import asyncio
import os
import threading
import time
from typing import Any

from . import seqio

AUTOSAVE_DELAY = 1.2  # seconds of quiet before a changed sequence hits disk


class Store:
    def __init__(self, folder: str, autosave: bool = False):
        self.folder = os.path.abspath(folder)
        self.autosave = autosave
        self.sequences: dict[str, dict[str, Any]] = {}
        self.primers: dict[str, dict[str, Any]] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._lock = threading.RLock()
        self._save_handles: dict[str, asyncio.TimerHandle] = {}
        self._self_writes: dict[str, float] = {}
        self._observer = None

    # ---------------------------------------------------------------- events

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=256)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)

    def broadcast(self, event: dict[str, Any]) -> None:
        """Push an event to every open client, from any thread."""
        event.setdefault("ts", time.time())
        if self.loop is None:
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self._fanout(event)
        else:
            self.loop.call_soon_threadsafe(self._fanout, event)

    def _fanout(self, event: dict[str, Any]) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                self._subscribers.discard(q)

    def notice(self, message: str, level: str = "info", origin: str = "system") -> None:
        self.broadcast({"type": "notice", "level": level, "message": message, "origin": origin})

    # --------------------------------------------------------------- reading

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "folder": self.folder,
                "sequences": list(self.sequences.values()),
                "primers": list(self.primers.values()),
                "files": seqio.list_folder(self.folder),
            }

    def set_folder(self, folder: str) -> dict[str, Any]:
        """Point the workbench at another folder, the way an editor does.

        Open sequences are left alone: switching folders changes what the file
        list shows, it does not close or write anything.
        """
        target = os.path.abspath(os.path.expanduser(folder))
        if not os.path.exists(target):
            raise FileNotFoundError(f"no such folder: {target}")
        if not os.path.isdir(target):
            raise NotADirectoryError(f"not a folder: {target}")
        with self._lock:
            self.folder = target
            self._self_writes.clear()
        obs, self._observer = self._observer, None
        if obs is not None:
            try:
                obs.stop()
            except Exception:
                pass
        self.start_watching()
        snap = self.snapshot()
        self.broadcast({"type": "state", **snap})
        return {"folder": target, "files": snap["files"]}

    def get(self, seq_id: str) -> dict[str, Any]:
        with self._lock:
            seq = self.sequences.get(seq_id)
        if seq is None:
            raise KeyError(f"no sequence {seq_id!r}")
        return seq

    def find_by_name(self, name: str) -> dict[str, Any] | None:
        want = (name or "").strip().lower()
        with self._lock:
            for seq in self.sequences.values():
                if seq["name"].lower() == want:
                    return seq
            for seq in self.sequences.values():
                if want and want in seq["name"].lower():
                    return seq
        return None

    # --------------------------------------------------------------- writing

    def _emit(self, seq: dict[str, Any], origin: str, note: str | None = None,
              autosave: bool = True) -> None:
        self.broadcast({"type": "seq.upsert", "sequence": seq, "origin": origin, "note": note})
        # Only ever write back after a real edit. Merely opening or reloading a
        # file must leave the user's file byte-for-byte alone.
        if autosave and self.autosave and seq.get("path") and seq.get("dirty"):
            self.schedule_save(seq["id"])

    def open_path(self, path: str, origin: str = "user") -> list[dict[str, Any]]:
        path = os.path.abspath(path)
        with self._lock:
            existing = [s for s in self.sequences.values() if s.get("path") == path]
        if existing:
            return existing
        loaded = seqio.read_file(path)
        with self._lock:
            try:
                self._self_writes[path] = os.path.getmtime(path)
            except OSError:
                pass
            for seq in loaded:
                self.sequences[seq["id"]] = seq
        for seq in loaded:
            self._emit(seq, origin, note=f"opened {os.path.basename(path)}", autosave=False)
        return loaded

    def add_sequence(self, seq: dict[str, Any], origin: str = "user") -> dict[str, Any]:
        seq.setdefault("id", seqio.new_id("s"))
        seq.setdefault("features", [])
        seq.setdefault("topology", "linear")
        seq.setdefault("format", "genbank")
        seq.setdefault("description", "")
        seq.setdefault("path", None)
        seq["seq"] = (seq.get("seq") or "").upper()
        seq["dirty"] = True
        with self._lock:
            self.sequences[seq["id"]] = seq
        self._emit(seq, origin, note=f"added {seq['name']}")
        return seq

    def close_sequence(self, seq_id: str, origin: str = "user") -> None:
        with self._lock:
            self.sequences.pop(seq_id, None)
            handle = self._save_handles.pop(seq_id, None)
        if handle:
            handle.cancel()
        self.broadcast({"type": "seq.remove", "id": seq_id, "origin": origin})

    def update_sequence(self, seq_id: str, origin: str = "user", **fields) -> dict[str, Any]:
        seq = self.get(seq_id)
        with self._lock:
            for key in ("name", "description", "topology", "format"):
                if key in fields and fields[key] is not None:
                    seq[key] = fields[key]
            seq["dirty"] = True
        self._emit(seq, origin, note=fields.get("_note"))
        return seq

    # --------------------------------------------------------------- features

    def add_feature(self, seq_id: str, feature: dict[str, Any], origin: str = "user") -> dict[str, Any]:
        seq = self.get(seq_id)
        feature.setdefault("id", seqio.new_id("f"))
        feature.setdefault("type", "misc_feature")
        feature.setdefault("strand", 1)
        feature.setdefault("qualifiers", {})
        if not feature.get("segments"):
            feature["segments"] = [[int(feature.get("start", 0)), int(feature.get("end", 0))]]
        feature["segments"] = [[int(a), int(b)] for a, b in feature["segments"]]
        feature.pop("start", None)
        feature.pop("end", None)
        if not feature.get("color"):
            feature["color"] = seqio.color_for(feature["type"], feature.get("label", ""))
        feature.setdefault("label", feature["type"])
        with self._lock:
            seq["features"].append(feature)
            seq["features"].sort(key=lambda f: (f["segments"][0][0], f["segments"][-1][1]))
            seq["dirty"] = True
        self._emit(seq, origin, note=f"+ {feature['label']}")
        return feature

    def update_feature(self, seq_id: str, feat_id: str, patch: dict[str, Any],
                       origin: str = "user") -> dict[str, Any]:
        seq = self.get(seq_id)
        with self._lock:
            feat = next((f for f in seq["features"] if f["id"] == feat_id), None)
            if feat is None:
                raise KeyError(f"no feature {feat_id!r}")
            for key, val in patch.items():
                if key == "segments" and val:
                    feat["segments"] = [[int(a), int(b)] for a, b in val]
                elif key in ("label", "type", "strand", "color", "qualifiers"):
                    feat[key] = val
            seq["features"].sort(key=lambda f: (f["segments"][0][0], f["segments"][-1][1]))
            seq["dirty"] = True
        self._emit(seq, origin, note=f"~ {feat.get('label')}")
        return feat

    def delete_feature(self, seq_id: str, feat_id: str, origin: str = "user") -> None:
        seq = self.get(seq_id)
        with self._lock:
            before = len(seq["features"])
            seq["features"] = [f for f in seq["features"] if f["id"] != feat_id]
            if len(seq["features"]) == before:
                raise KeyError(f"no feature {feat_id!r}")
            seq["dirty"] = True
        self._emit(seq, origin, note="feature deleted")

    # --------------------------------------------------------- sequence edits

    def edit_sequence(self, seq_id: str, start: int, end: int, replacement: str,
                      origin: str = "user") -> dict[str, Any]:
        """Replace [start, end) with `replacement`, moving features to match."""
        seq = self.get(seq_id)
        text = seq["seq"]
        n = len(text)
        start = max(0, min(n, int(start)))
        end = max(start, min(n, int(end)))
        replacement = "".join(ch for ch in (replacement or "").upper() if ch.isalpha())
        delta = len(replacement) - (end - start)

        with self._lock:
            seq["seq"] = text[:start] + replacement + text[end:]
            kept = []
            for feat in seq["features"]:
                segs = []
                for a, b in feat["segments"]:
                    a2, b2 = _shift(a, start, end, delta), _shift(b, start, end, delta)
                    if b2 > a2:
                        segs.append([a2, b2])
                if segs:
                    feat["segments"] = segs
                    kept.append(feat)
            seq["features"] = kept
            seq["dirty"] = True
        self._emit(seq, origin, note=f"edited {start}-{end} ({delta:+d} bp)")
        return seq

    # ---------------------------------------------------------------- primers

    def add_primer(self, primer: dict[str, Any], origin: str = "user") -> dict[str, Any]:
        primer.setdefault("id", seqio.new_id("p"))
        primer["seq"] = (primer.get("seq") or "").upper()
        primer.setdefault("name", "primer")
        primer.setdefault("notes", "")
        with self._lock:
            self.primers[primer["id"]] = primer
        self.broadcast({"type": "primers", "primers": list(self.primers.values()), "origin": origin,
                        "note": f"+ primer {primer['name']}"})
        return primer

    def delete_primer(self, primer_id: str, origin: str = "user") -> None:
        with self._lock:
            self.primers.pop(primer_id, None)
        self.broadcast({"type": "primers", "primers": list(self.primers.values()), "origin": origin})

    # ------------------------------------------------------------------ disk

    def schedule_save(self, seq_id: str) -> None:
        if self.loop is None:
            return
        def arm():
            handle = self._save_handles.pop(seq_id, None)
            if handle:
                handle.cancel()
            self._save_handles[seq_id] = self.loop.call_later(
                AUTOSAVE_DELAY, lambda: self._do_save(seq_id))
        try:
            if asyncio.get_running_loop() is self.loop:
                arm()
                return
        except RuntimeError:
            pass
        self.loop.call_soon_threadsafe(arm)

    def _do_save(self, seq_id: str) -> None:
        self._save_handles.pop(seq_id, None)
        try:
            self.save(seq_id, origin="autosave")
        except Exception as exc:
            self.notice(f"autosave failed: {exc}", level="error")

    def save(self, seq_id: str, path: str | None = None, fmt: str | None = None,
             origin: str = "user") -> str:
        seq = self.get(seq_id)
        target = path or seq.get("path")
        if not target:
            name = "".join(c for c in seq["name"] if c.isalnum() or c in "-_. ") or "sequence"
            target = os.path.join(self.folder, f"{name}.gb")
        with self._lock:
            companions = [x for x in self.sequences.values()
                          if x.get("path") == target and x["id"] != seq_id]
        if companions:
            # This file holds several records (e.g. a multi-FASTA). Write them
            # all back, in their original order, so none are lost.
            group = sorted([seq] + companions, key=lambda x: x.get("_record_index", 0))
            written = seqio.write_records(group, target, fmt)
        else:
            written = seqio.write_file(seq, target, fmt)
        with self._lock:
            seq["path"] = written
            seq["format"] = fmt or seq.get("format") or seqio.detect_format(written)
            seq["dirty"] = False
            try:
                self._self_writes[written] = os.path.getmtime(written)
            except OSError:
                pass
        self.broadcast({"type": "seq.upsert", "sequence": seq, "origin": origin,
                        "note": f"saved {os.path.basename(written)}"})
        self.broadcast({"type": "files", "files": seqio.list_folder(self.folder)})
        return written

    # ------------------------------------------------------------- watching

    def start_watching(self) -> None:
        try:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler
        except Exception:
            return

        store = self

        WATCHED = {"modified", "created", "moved", "deleted"}

        class Handler(FileSystemEventHandler):
            def on_any_event(self, event):
                # Newer watchdog also emits 'opened' and 'closed'; reacting to
                # those makes merely reading a file look like an edit.
                if event.is_directory or event.event_type not in WATCHED:
                    return
                path = os.path.abspath(getattr(event, "dest_path", "") or event.src_path)
                if os.path.splitext(path)[1].lower() not in seqio.READABLE_EXT:
                    return
                store._external_change(path)

        try:
            obs = Observer()
            obs.schedule(Handler(), self.folder, recursive=True)
            obs.daemon = True
            obs.start()
            self._observer = obs
        except Exception:
            self._observer = None

    def _external_change(self, path: str) -> None:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            self.broadcast({"type": "files", "files": seqio.list_folder(self.folder)})
            return
        if abs(self._self_writes.get(path, -1) - mtime) < 0.01:
            return  # our own autosave coming back round
        self._self_writes[path] = mtime

        with self._lock:
            open_ids = [s["id"] for s in self.sequences.values() if s.get("path") == path]
        if open_ids:
            try:
                fresh = seqio.read_file(path)
            except Exception:
                return
            for seq_id, new in zip(open_ids, fresh):
                with self._lock:
                    cur = self.sequences.get(seq_id)
                    if cur is None:
                        continue
                    new["id"] = seq_id
                    new["dirty"] = False
                    self.sequences[seq_id] = new
                self.broadcast({"type": "seq.upsert", "sequence": new, "origin": "disk",
                                "note": f"{os.path.basename(path)} changed on disk"})
        self.broadcast({"type": "files", "files": seqio.list_folder(self.folder)})


def _shift(pos: int, start: int, end: int, delta: int) -> int:
    """Move one coordinate in response to an edit of [start, end)."""
    if pos <= start:
        return pos
    if pos >= end:
        return pos + delta
    return start  # inside the replaced stretch: collapse to its left edge
