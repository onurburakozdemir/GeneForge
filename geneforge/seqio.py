"""Reading and writing sequence files (GenBank / FASTA) for GeneForge.

A Sequence is a plain dict so it serialises straight to JSON for the UI:

    {id, name, description, seq, topology, features[], path, format, dirty}

A Feature is:

    {id, label, type, segments[[start,end],...], strand, color, qualifiers{}}

All coordinates are 0-based, half-open, on the forward strand.
"""
from __future__ import annotations

import os
import uuid
from typing import Any, Iterable

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqRecord import SeqRecord
from Bio.SeqFeature import SeqFeature, SimpleLocation, CompoundLocation

GENBANK_EXT = {".gb", ".gbk", ".genbank", ".ape"}
FASTA_EXT = {".fasta", ".fa", ".fna", ".ffn", ".fsa", ".seq"}
READABLE_EXT = GENBANK_EXT | FASTA_EXT

# Palette used when a feature carries no colour of its own. Chosen to match the
# conventions people are used to from ApE / SnapGene / Benchling maps.
TYPE_COLORS = {
    "cds": "#84b0dc",
    "gene": "#84b0dc",
    "promoter": "#faac61",
    "terminator": "#ffef86",
    "rbs": "#c6c9d1",
    "primer_bind": "#f8d3a9",
    "origin": "#9eafd2",
    "rep_origin": "#9eafd2",
    "misc_feature": "#75c6a9",
    "mat_peptide": "#b1ff67",
    "sig_peptide": "#b1ff67",
    "protein_bind": "#85dae9",
    "regulatory": "#faac61",
    "source": "#d6b295",
    "trna": "#f58a5e",
    "rrna": "#f58a5e",
    "ncrna": "#f58a5e",
    "intron": "#d9d9d9",
    "exon": "#b4abac",
    "variation": "#ff9ccd",
    "modified_base": "#ff9ccd",
    "stem_loop": "#ffe4c4",
    "repeat_region": "#d6b295",
}
FALLBACK_COLOR = "#75c6a9"

# Qualifier keys that describe the feature itself and are rebuilt on write,
# so they must not be duplicated into the free-form qualifier bag.
_MANAGED_QUALIFIERS = {
    "label",
    "ApEinfo_fwdcolor",
    "ApEinfo_revcolor",
    "ApEinfo_graphicformat",
    "benchling_strand",
}


def new_id(prefix: str = "f") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def color_for(ftype: str, label: str = "") -> str:
    return TYPE_COLORS.get((ftype or "").lower(), FALLBACK_COLOR)


def _feature_label(feat: SeqFeature) -> str:
    q = feat.qualifiers
    for key in ("label", "gene", "product", "note", "standard_name", "locus_tag"):
        vals = q.get(key)
        if vals:
            text = vals[0] if isinstance(vals, (list, tuple)) else vals
            text = str(text).strip()
            if text:
                return text
    return feat.type or "feature"


def _feature_color(feat: SeqFeature, ftype: str, label: str) -> str:
    q = feat.qualifiers
    for key in ("ApEinfo_fwdcolor", "ApEinfo_revcolor", "color"):
        vals = q.get(key)
        if vals:
            val = vals[0] if isinstance(vals, (list, tuple)) else vals
            val = str(val).strip()
            if val.startswith("#") and len(val) in (4, 7):
                return val
    return color_for(ftype, label)


def _segments_from_location(loc) -> list[list[int]]:
    """Flatten a Biopython location into 0-based half-open segments."""
    parts = getattr(loc, "parts", None) or [loc]
    segs: list[list[int]] = []
    for part in parts:
        try:
            start, end = int(part.start), int(part.end)
        except TypeError:
            # Fuzzy / unknown positions: fall back to the overall span.
            continue
        if end < start:
            start, end = end, start
        segs.append([start, end])
    if not segs:
        segs = [[int(loc.start), int(loc.end)]]
    return segs


def feature_from_biopython(feat: SeqFeature) -> dict[str, Any]:
    ftype = feat.type or "misc_feature"
    label = _feature_label(feat)
    strand = feat.location.strand
    strand = 0 if strand is None else int(strand)
    quals = {
        k: (v[0] if isinstance(v, (list, tuple)) and len(v) == 1 else v)
        for k, v in feat.qualifiers.items()
        if k not in _MANAGED_QUALIFIERS
    }
    return {
        "id": new_id(),
        "label": label,
        "type": ftype,
        "segments": _segments_from_location(feat.location),
        "strand": strand,
        "color": _feature_color(feat, ftype, label),
        "qualifiers": quals,
    }


def feature_to_biopython(feature: dict[str, Any]) -> SeqFeature:
    segs = [list(map(int, s)) for s in feature.get("segments") or []]
    if not segs:
        segs = [[0, 0]]
    strand = int(feature.get("strand") or 0)
    bio_strand = strand if strand in (1, -1) else None
    locs = [SimpleLocation(s, e, strand=bio_strand) for s, e in segs]
    if len(locs) == 1:
        location = locs[0]
    else:
        if bio_strand == -1:
            locs = list(reversed(locs))
        location = CompoundLocation(locs)

    quals: dict[str, Any] = {}
    for k, v in (feature.get("qualifiers") or {}).items():
        if k in _MANAGED_QUALIFIERS:
            continue
        quals[k] = v if isinstance(v, list) else [v]
    label = feature.get("label") or feature.get("type") or "feature"
    color = feature.get("color") or FALLBACK_COLOR
    quals["label"] = [label]
    quals["ApEinfo_fwdcolor"] = [color]
    quals["ApEinfo_revcolor"] = [color]
    return SeqFeature(location=location, type=feature.get("type") or "misc_feature", qualifiers=quals)


def record_to_sequence(rec: SeqRecord, path: str | None, fmt: str) -> dict[str, Any]:
    raw = str(rec.seq).upper().replace("\n", "").replace(" ", "")
    topology = "linear"
    ann_topo = str(rec.annotations.get("topology", "")).lower()
    if ann_topo.startswith("circ"):
        topology = "circular"
    name = rec.name if rec.name and rec.name != "<unknown name>" else ""
    if not name:
        name = (rec.id or "").split()[0] if rec.id else ""
    if not name or name == "<unknown id>":
        name = os.path.splitext(os.path.basename(path))[0] if path else "untitled"
    desc = rec.description or ""
    if desc in (".", "<unknown description>", name):
        desc = ""
    features = []
    for feat in rec.features:
        if feat.type == "source" and len(rec.features) > 1:
            # 'source' spans the whole record and only adds noise to the map.
            continue
        try:
            features.append(feature_from_biopython(feat))
        except Exception:
            continue
    return {
        "id": new_id("s"),
        "_meta": {
            "date": rec.annotations.get("date"),
            "molecule_type": rec.annotations.get("molecule_type"),
            "accession": (rec.annotations.get("accessions") or [None])[0],
            "upper": raw.isupper(),
        },
        "name": name,
        "description": desc,
        "seq": raw,
        "topology": topology,
        "features": features,
        "path": path,
        "format": fmt,
        "dirty": False,
    }


def sequence_to_record(sequence: dict[str, Any]) -> SeqRecord:
    seq = Seq(sequence.get("seq", ""))
    name = (sequence.get("name") or "untitled")[:60]
    rec = SeqRecord(
        seq,
        id=name.replace(" ", "_")[:16] or "seq",
        name=name.replace(" ", "_")[:16] or "seq",
        description=sequence.get("description") or ".",
    )
    meta = sequence.get("_meta") or {}
    rec.annotations["molecule_type"] = meta.get("molecule_type") or "DNA"
    rec.annotations["topology"] = sequence.get("topology") or "linear"
    rec.annotations["data_file_division"] = "SYN"
    if meta.get("date"):
        rec.annotations["date"] = meta["date"]
    rec.features = [feature_to_biopython(f) for f in sequence.get("features", [])]
    return rec


def detect_format(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    if ext in GENBANK_EXT:
        return "genbank"
    if ext in FASTA_EXT:
        return "fasta"
    # Sniff the first non-blank character for files with odd extensions.
    try:
        with open(path, "r", errors="ignore") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                return "fasta" if line.startswith(">") else "genbank"
    except OSError:
        pass
    return "genbank"


def read_file(path: str) -> list[dict[str, Any]]:
    """Parse a file into one or more sequence dicts."""
    fmt = detect_format(path)
    records = list(SeqIO.parse(path, fmt))
    if not records and fmt == "genbank":
        fmt = "fasta"
        records = list(SeqIO.parse(path, fmt))
    out = [record_to_sequence(rec, path, fmt) for rec in records]
    for i, seq in enumerate(out):
        seq["_record_index"] = i
    return out


def write_file(sequence: dict[str, Any], path: str | None = None, fmt: str | None = None) -> str:
    target = path or sequence.get("path")
    if not target:
        raise ValueError("no path to write to")
    fmt = fmt or sequence.get("format") or detect_format(target)
    rec = sequence_to_record(sequence)
    if fmt == "fasta":
        rec.description = sequence.get("description") or ""
    tmp = f"{target}.geneforge.tmp"
    with open(tmp, "w") as fh:
        SeqIO.write([rec], fh, fmt)
    os.replace(tmp, target)
    return target


def write_records(sequences: list[dict[str, Any]], path: str, fmt: str | None = None) -> str:
    """Write several records into one file (multi-FASTA / multi-GenBank)."""
    fmt = fmt or detect_format(path)
    recs = [sequence_to_record(s) for s in sequences]
    if fmt == "fasta":
        for rec, src in zip(recs, sequences):
            rec.description = src.get("description") or ""
    tmp = f"{path}.geneforge.tmp"
    with open(tmp, "w") as fh:
        SeqIO.write(recs, fh, fmt)
    os.replace(tmp, path)
    return path


def to_text(sequence: dict[str, Any], fmt: str = "genbank") -> str:
    rec = sequence_to_record(sequence)
    handle = __import__("io").StringIO()
    SeqIO.write([rec], handle, fmt)
    return handle.getvalue()


def list_folder(folder: str) -> list[dict[str, Any]]:
    """Every readable sequence file under a folder, newest first."""
    found: list[dict[str, Any]] = []
    for root, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d != "GeneForge"]
        for fname in files:
            if fname.startswith("."):
                continue
            if os.path.splitext(fname)[1].lower() not in READABLE_EXT:
                continue
            full = os.path.join(root, fname)
            try:
                stat = os.stat(full)
            except OSError:
                continue
            found.append({
                "path": full,
                "name": fname,
                "rel": os.path.relpath(full, folder),
                "size": stat.st_size,
                "mtime": stat.st_mtime,
            })
    found.sort(key=lambda f: f["mtime"], reverse=True)
    return found
