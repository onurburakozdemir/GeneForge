"""Sequence analysis for GeneForge: restriction, ORFs, primers, alignment,
assembly and codon optimisation.

Everything here is pure: it takes strings and returns plain dicts, so it is
easy to test and easy to call from the HTTP layer.
"""
from __future__ import annotations

import re
from typing import Any, Iterable

from Bio.Seq import Seq
from Bio.Data import CodonTable
from Bio.SeqUtils import gc_fraction, molecular_weight
from Bio.Restriction import Restriction, RestrictionBatch, CommOnly, AllEnzymes

IUPAC = {
    "A": "A", "C": "C", "G": "G", "T": "T",
    "R": "[AG]", "Y": "[CT]", "S": "[GC]", "W": "[AT]",
    "K": "[GT]", "M": "[AC]", "B": "[CGT]", "D": "[AGT]",
    "H": "[ACT]", "V": "[ACG]", "N": "[ACGT]",
}

# A sensible default enzyme panel: the workhorses plus the Type IIS enzymes
# used for Golden Gate.
POPULAR = [
    "EcoRI", "BamHI", "HindIII", "XhoI", "NotI", "NcoI", "NdeI", "XbaI",
    "SalI", "PstI", "SpeI", "KpnI", "SacI", "SmaI", "ApaI", "AscI", "AgeI",
    "BglII", "ClaI", "EcoRV", "MluI", "NheI", "PacI", "SphI", "StuI", "AvrII",
    "BsaI", "BsmBI", "BbsI", "SapI", "AarI", "Esp3I", "PmeI", "SwaI", "FseI",
    "DpnI", "BsrGI", "AflII", "BstBI", "HpaI", "PvuII", "ScaI", "XmaI",
]


# --------------------------------------------------------------------------
# basics
# --------------------------------------------------------------------------

def clean(seq: str) -> str:
    return re.sub(r"[^A-Za-z]", "", seq or "").upper()


def revcomp(seq: str) -> str:
    return str(Seq(clean(seq)).reverse_complement())


def to_rna(seq: str) -> str:
    return clean(seq).replace("T", "U")


def gc_content(seq: str) -> float:
    seq = clean(seq)
    if not seq:
        return 0.0
    return round(gc_fraction(seq) * 100, 2)


def translate(seq: str, table: str | int = 1, to_stop: bool = False) -> str:
    seq = clean(seq)
    usable = len(seq) - (len(seq) % 3)
    if usable <= 0:
        return ""
    return str(Seq(seq[:usable]).translate(table=table, to_stop=to_stop))


def seq_stats(seq: str) -> dict[str, Any]:
    seq = clean(seq)
    out: dict[str, Any] = {
        "length": len(seq),
        "gc": gc_content(seq),
        "a": seq.count("A"), "c": seq.count("C"),
        "g": seq.count("G"), "t": seq.count("T"),
    }
    if seq:
        try:
            out["mw"] = round(molecular_weight(Seq(seq), seq_type="DNA", double_stranded=True) / 1000.0, 2)
        except Exception:
            out["mw"] = None
        try:
            out["tm"] = round(_tm(seq), 2) if 6 <= len(seq) <= 120 else None
        except Exception:
            out["tm"] = None
    return out


def _tm(seq: str) -> float:
    import primer3
    return primer3.calc_tm(clean(seq))


def subsequence(seq: str, start: int, end: int, topology: str = "linear") -> str:
    """Slice, wrapping around the origin when the molecule is circular."""
    seq = clean(seq)
    n = len(seq)
    if n == 0:
        return ""
    if topology == "circular" and (start > end or end > n):
        start %= n
        end = end if end <= n else end % n
        if start > end:
            return seq[start:] + seq[:end]
    start = max(0, min(n, start))
    end = max(0, min(n, end))
    return seq[start:end]


# --------------------------------------------------------------------------
# ORFs
# --------------------------------------------------------------------------

def find_orfs(seq: str, topology: str = "linear", min_aa: int = 30,
              table: int = 1, starts: str = "ATG") -> list[dict[str, Any]]:
    """Longest ORF downstream of each stop codon, in all six frames."""
    seq = clean(seq)
    n = len(seq)
    if n < 6:
        return []
    tbl = CodonTable.unambiguous_dna_by_id[int(table)]
    stops = set(tbl.stop_codons)
    if starts == "any":
        start_set = None
    elif starts == "alt":
        start_set = set(tbl.start_codons)
    else:
        start_set = {"ATG"}

    scan = seq + seq[: min(n, 3000)] if topology == "circular" else seq
    rc_full = revcomp(seq)
    rc_scan = rc_full + rc_full[: min(n, 3000)] if topology == "circular" else rc_full

    orfs: list[dict[str, Any]] = []
    for strand, text in ((1, scan), (-1, rc_scan)):
        limit = len(text)
        for frame in range(3):
            pos = frame
            open_at: int | None = None
            while pos + 3 <= limit:
                codon = text[pos:pos + 3]
                if open_at is None:
                    if start_set is None or codon in start_set:
                        if "N" not in codon:
                            open_at = pos
                elif codon in stops:
                    aa_len = (pos - open_at) // 3
                    if aa_len >= min_aa:
                        orfs.append(_orf_record(seq, n, strand, frame, open_at, pos + 3, table, topology))
                    open_at = None
                pos += 3
    # Keep the longest ORF per stop position per strand.
    best: dict[tuple, dict] = {}
    for o in orfs:
        key = (o["strand"], o["end"] % max(n, 1), o["frame"])
        if key not in best or o["length_aa"] > best[key]["length_aa"]:
            best[key] = o
    out = sorted(best.values(), key=lambda o: -o["length_aa"])
    return out


def _orf_record(seq: str, n: int, strand: int, frame: int, a: int, b: int,
                table: int, topology: str) -> dict[str, Any]:
    local = (revcomp(seq) if strand == -1 else seq)
    local2 = local + local if topology == "circular" else local
    nt = local2[a:b]
    protein = translate(nt, table=table, to_stop=True)
    if strand == 1:
        start, end = a % n, b if b <= n else b - n
    else:
        s0, e0 = a % n, b if b <= n else b - n
        start, end = n - e0, n - s0
        if start < 0:
            start += n
    return {
        "start": int(start),
        "end": int(end),
        "strand": strand,
        "frame": (a % 3) * strand,
        "length_nt": b - a,
        "length_aa": len(protein),
        "protein": protein,
        "start_codon": nt[:3],
        "wraps": b > n,
    }


# --------------------------------------------------------------------------
# restriction
# --------------------------------------------------------------------------

def _iupac_regex(site: str) -> str:
    return "".join(IUPAC.get(ch, ch) for ch in site.upper())


_GEOM_CACHE: dict[str, tuple[int, int, int, int]] = {}


def _geometry(enz) -> tuple[int, int, int, int]:
    """Footprint geometry from the enzyme's own cut diagram.

    Returns (footprint_length, site_offset, top_cut, bottom_cut) where the two
    cut values are indices *within* the footprint, counted before the marker.
    Using elucidate() keeps Type IIS enzymes (which cut outside their
    recognition site) correct without hand-maintained offset tables.
    """
    key = str(enz)
    if key in _GEOM_CACHE:
        return _GEOM_CACHE[key]
    diagram = enz.elucidate()
    top = diagram.index("^") if "^" in diagram else 0
    after_top = diagram.replace("^", "", 1)
    bottom = after_top.index("_") if "_" in after_top else top
    plain = after_top.replace("_", "", 1)
    site = str(enz.site)
    match = re.search(_iupac_regex(site), plain)
    offset = match.start() if match else 0
    geom = (len(plain), offset, top, bottom)
    _GEOM_CACHE[key] = geom
    return geom


def enzyme_catalog(scope: str = "popular") -> list[dict[str, Any]]:
    if scope == "popular":
        pool = [getattr(Restriction, nm) for nm in POPULAR if hasattr(Restriction, nm)]
    elif scope == "commercial":
        pool = list(CommOnly)
    else:
        pool = list(AllEnzymes)
    out = []
    for enz in pool:
        try:
            L, offset, top, bottom = _geometry(enz)
            out.append({
                "name": str(enz),
                "site": str(enz.site),
                "length": len(enz.site),
                "blunt": top == bottom,
                "overhang": bottom - top,
                "pattern": enz.elucidate(),
                "type2s": (offset + len(str(enz.site))) <= top or top < offset,
            })
        except Exception:
            continue
    out.sort(key=lambda e: e["name"])
    return out


def _resolve(names: Iterable[str]):
    enzymes, seen = [], set()
    for nm in names:
        nm = str(nm).strip()
        if not nm or nm in seen:
            continue
        enz = getattr(Restriction, nm, None)
        if enz is not None and hasattr(enz, "site"):
            seen.add(nm)
            enzymes.append(enz)
    return enzymes


def restriction_map(seq: str, enzymes: Iterable[str], topology: str = "linear") -> dict[str, Any]:
    """Map recognition sites and the cuts they produce.

    Site-driven rather than cut-driven: a recognition site is reported even
    when its cut falls off the end of a linear fragment (common for designed
    Golden Gate ends), with ``cut_in_range`` saying whether it can actually be
    cleaved as drawn.
    """
    seq = clean(seq)
    n = len(seq)
    circular = topology == "circular"
    results: list[dict[str, Any]] = []
    all_cuts: list[int] = []

    if n == 0:
        return {"enzymes": [], "fragments": [], "unique": [], "non_cutters": []}

    # For circular molecules, scan a doubled window so sites spanning the
    # origin are found exactly once.
    for enz in _resolve(enzymes):
        try:
            L, offset, top, bottom = _geometry(enz)
        except Exception:
            continue
        site = str(enz.site)
        rc_site = revcomp(site)
        pad = min(n, max(L, len(site)) + 8)
        window = seq + seq[:pad] if circular else seq
        sites: list[dict[str, Any]] = []
        seen_keys: set[tuple[int, int]] = set()

        for strand, pattern in ((1, site), (-1, rc_site)):
            if strand == -1 and rc_site == site:
                continue  # palindrome: already counted on the forward pass
            for m in re.finditer(f"(?={_iupac_regex(pattern)})", window):
                g = m.start()
                if circular and g >= n:
                    continue
                if strand == 1:
                    footprint = g - offset
                    cut_top, cut_bot = footprint + top, footprint + bottom
                else:
                    footprint = g + offset + len(site) - L
                    cut_top, cut_bot = footprint + L - bottom, footprint + L - top
                key = (g % n, strand)
                if key in seen_keys:
                    continue
                seen_keys.add(key)

                in_range = circular or (0 <= cut_top <= n and 0 <= cut_bot <= n)
                ov_a, ov_b = sorted((cut_top, cut_bot))
                overhang_seq = subsequence(seq, ov_a % n if circular else max(0, ov_a),
                                           ov_b % n if circular else min(n, ov_b),
                                           topology) if ov_b > ov_a else ""
                sites.append({
                    "start": g % n,
                    "end": (g + len(site)) % n if circular else min(n, g + len(site)),
                    "strand": strand,
                    "cut": (cut_top % n) if circular else cut_top,
                    "cut_bottom": (cut_bot % n) if circular else cut_bot,
                    "cut_in_range": bool(in_range),
                    "overhang": overhang_seq,
                    "overhang_type": "blunt" if cut_top == cut_bot else ("5'" if cut_top < cut_bot else "3'"),
                })
                if in_range and 0 <= (cut_top % n if circular else cut_top) <= n:
                    all_cuts.append((cut_top % n) if circular else cut_top)

        if not sites:
            continue
        sites.sort(key=lambda s: s["start"])
        cuttable = [s for s in sites if s["cut_in_range"]]
        results.append({
            "name": str(enz),
            "site": site,
            "pattern": enz.elucidate(),
            "blunt": top == bottom,
            "overhang_len": abs(bottom - top),
            "count": len(sites),
            "cuts": len(cuttable),
            "sites": sites,
        })

    results.sort(key=lambda r: (r["count"], r["name"]))
    requested = {str(e) for e in _resolve(enzymes)}
    return {
        "enzymes": results,
        "fragments": fragments_from_cuts(sorted(set(all_cuts)), n, topology),
        "unique": [r["name"] for r in results if r["cuts"] == 1],
        "non_cutters": sorted(requested - {r["name"] for r in results}),
    }


def fragments_from_cuts(cuts: list[int], n: int, topology: str) -> list[dict[str, Any]]:
    cuts = sorted(set(c for c in cuts if 0 <= c <= n))
    if not cuts:
        return [{"start": 0, "end": n, "length": n, "wraps": False}]
    frags = []
    if topology == "circular":
        if len(cuts) == 1:
            frags.append({"start": cuts[0], "end": cuts[0], "length": n, "wraps": True})
        else:
            for i, c in enumerate(cuts):
                nxt = cuts[(i + 1) % len(cuts)]
                if nxt > c:
                    frags.append({"start": c, "end": nxt, "length": nxt - c, "wraps": False})
                else:
                    frags.append({"start": c, "end": nxt, "length": n - c + nxt, "wraps": True})
    else:
        bounds = [0] + cuts + [n]
        for a, b in zip(bounds, bounds[1:]):
            if b > a:
                frags.append({"start": a, "end": b, "length": b - a, "wraps": False})
    frags.sort(key=lambda f: -f["length"])
    return frags


# --------------------------------------------------------------------------
# primers
# --------------------------------------------------------------------------

def primer_stats(seq: str) -> dict[str, Any]:
    import primer3
    s = clean(seq)
    out: dict[str, Any] = {
        "seq": s,
        "length": len(s),
        "gc": gc_content(s),
    }
    if not (6 <= len(s) <= 200):
        out.update({"tm": None, "hairpin_tm": None, "homodimer_tm": None})
        return out
    try:
        out["tm"] = round(primer3.calc_tm(s), 2)
        hp = primer3.calc_hairpin(s)
        out["hairpin_tm"] = round(hp.tm, 2) if hp.structure_found else None
        hd = primer3.calc_homodimer(s)
        out["homodimer_tm"] = round(hd.tm, 2) if hd.structure_found else None
        out["gc_clamp"] = s[-1] in "GC"
    except Exception:
        out.setdefault("tm", None)
    return out


def design_primers(template: str, start: int, end: int, n_return: int = 5,
                   opt_size: int = 20, min_tm: float = 57.0, opt_tm: float = 60.0,
                   max_tm: float = 63.0, flank: int = 250) -> dict[str, Any]:
    """Design primer pairs that amplify template[start:end] using primer3."""
    import primer3
    template = clean(template)
    n = len(template)
    start = max(0, min(n, int(start)))
    end = max(start + 1, min(n, int(end)))

    left = max(0, start - flank)
    right = min(n, end + flank)
    region = template[left:right]
    tgt_start = start - left
    tgt_len = end - start
    product_min = tgt_len
    product_max = min(len(region), tgt_len + 2 * flank)

    seq_args = {
        "SEQUENCE_ID": "geneforge",
        "SEQUENCE_TEMPLATE": region,
        "SEQUENCE_TARGET": [tgt_start, tgt_len],
    }
    global_args = {
        "PRIMER_NUM_RETURN": int(n_return),
        "PRIMER_OPT_SIZE": int(opt_size),
        "PRIMER_MIN_SIZE": 18,
        "PRIMER_MAX_SIZE": 30,
        "PRIMER_OPT_TM": float(opt_tm),
        "PRIMER_MIN_TM": float(min_tm),
        "PRIMER_MAX_TM": float(max_tm),
        "PRIMER_MIN_GC": 30.0,
        "PRIMER_MAX_GC": 70.0,
        "PRIMER_MAX_POLY_X": 4,
        "PRIMER_PRODUCT_SIZE_RANGE": [[max(60, product_min), max(product_max, product_min + 1)]],
    }
    try:
        res = primer3.bindings.design_primers(seq_args, global_args)
    except Exception as exc:  # primer3 is strict; surface a usable message
        return {"pairs": [], "error": str(exc)}

    pairs = []
    count = int(res.get("PRIMER_PAIR_NUM_RETURNED", 0) or 0)
    for i in range(count):
        lseq = res.get(f"PRIMER_LEFT_{i}_SEQUENCE")
        rseq = res.get(f"PRIMER_RIGHT_{i}_SEQUENCE")
        if not lseq or not rseq:
            continue
        lpos = res.get(f"PRIMER_LEFT_{i}", (0, 0))
        rpos = res.get(f"PRIMER_RIGHT_{i}", (0, 0))
        pairs.append({
            "index": i,
            "left": {
                "seq": lseq,
                "start": left + int(lpos[0]),
                "length": int(lpos[1]),
                "tm": round(float(res.get(f"PRIMER_LEFT_{i}_TM", 0)), 2),
                "gc": round(float(res.get(f"PRIMER_LEFT_{i}_GC_PERCENT", 0)), 2),
                "strand": 1,
            },
            "right": {
                "seq": rseq,
                "start": left + int(rpos[0]) - int(rpos[1]) + 1,
                "length": int(rpos[1]),
                "tm": round(float(res.get(f"PRIMER_RIGHT_{i}_TM", 0)), 2),
                "gc": round(float(res.get(f"PRIMER_RIGHT_{i}_GC_PERCENT", 0)), 2),
                "strand": -1,
            },
            "product_size": int(res.get(f"PRIMER_PAIR_{i}_PRODUCT_SIZE", 0)),
            "penalty": round(float(res.get(f"PRIMER_PAIR_{i}_PENALTY", 0)), 3),
        })
    return {"pairs": pairs, "error": res.get("PRIMER_ERROR") or None}


def binding_sites(primer: str, template: str, topology: str = "linear",
                  min_anneal: int = 15) -> list[dict[str, Any]]:
    """Where a primer anneals: full match, or 3' anchored partial match."""
    p = clean(primer)
    t = clean(template)
    n = len(t)
    if not p or not t:
        return []
    scan = t + t[: len(p)] if topology == "circular" else t
    hits = []
    for strand in (1, -1):
        probe_full = p if strand == 1 else revcomp(p)
        for anneal in range(len(p), max(min_anneal, 6) - 1, -1):
            probe = probe_full[-anneal:] if strand == 1 else probe_full[:anneal]
            idx = scan.find(probe)
            seen = set()
            while idx != -1:
                key = idx % max(n, 1)
                if key not in seen:
                    seen.add(key)
                    hits.append({
                        "start": key,
                        "end": (idx + len(probe)) if (idx + len(probe)) <= n else (idx + len(probe)) - n,
                        "strand": strand,
                        "anneal": anneal,
                        "full": anneal == len(p),
                        "tm": primer_stats(probe).get("tm"),
                    })
                idx = scan.find(probe, idx + 1)
            if hits:
                break
    return hits[:50]


# --------------------------------------------------------------------------
# alignment
# --------------------------------------------------------------------------

def align(sequences: list[dict[str, str]], mode: str = "global") -> dict[str, Any]:
    """Multiple sequence alignment.

    Delegates to FAMSA or MUSCLE via tools.msa. Previously this contained a
    hand-written alignment projection, which is exactly the kind of code that
    silently mis-registers columns; it has been removed.
    """
    from .tools import msa
    return msa(sequences)


# --------------------------------------------------------------------------
# mutation
# --------------------------------------------------------------------------

AA3 = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C", "GLN": "Q",
    "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I", "LEU": "L", "LYS": "K",
    "MET": "M", "PHE": "F", "PRO": "P", "SER": "S", "THR": "T", "TRP": "W",
    "TYR": "Y", "VAL": "V",
}
# Codons favoured for E. coli expression, which is what these constructs target.
PREFERRED_CODON = {
    "A": "GCG", "R": "CGT", "N": "AAC", "D": "GAT", "C": "TGC", "Q": "CAG",
    "E": "GAA", "G": "GGC", "H": "CAT", "I": "ATT", "L": "CTG", "K": "AAA",
    "M": "ATG", "F": "TTT", "P": "CCG", "S": "AGC", "T": "ACC", "W": "TGG",
    "Y": "TAT", "V": "GTG", "*": "TAA",
}


def apply_protein_mutation(seq: str, cds_start: int, cds_end: int, strand: int,
                           mutation: str, table: int = 1) -> dict[str, Any]:
    """Apply a mutation like 'F12L' to a CDS and return the new nucleotide sequence."""
    seq = clean(seq)
    m = re.fullmatch(r"\s*([A-Za-z]{1,3})\s*(\d+)\s*([A-Za-z]{1,3}|\*)\s*", mutation or "")
    if not m:
        raise ValueError(f"cannot parse mutation {mutation!r} (expected e.g. F12L)")
    frm, pos, to = m.group(1).upper(), int(m.group(2)), m.group(3).upper()
    frm = AA3.get(frm, frm)
    to = AA3.get(to, to)
    if len(frm) != 1 or len(to) != 1:
        raise ValueError(f"unknown amino acid in {mutation!r}")

    cds = seq[cds_start:cds_end]
    if strand == -1:
        cds = revcomp(cds)
    protein = translate(cds, table=table)
    if pos < 1 or pos > len(protein):
        raise ValueError(f"residue {pos} is outside the CDS (1-{len(protein)})")
    observed = protein[pos - 1]
    if observed != frm:
        raise ValueError(f"residue {pos} is {observed}, not {frm}")
    new_codon = PREFERRED_CODON.get(to)
    if not new_codon:
        raise ValueError(f"no codon for {to}")

    i = (pos - 1) * 3
    new_cds = cds[:i] + new_codon + cds[i + 3:]
    if strand == -1:
        new_cds = revcomp(new_cds)
    new_seq = seq[:cds_start] + new_cds + seq[cds_end:]
    return {
        "seq": new_seq,
        "mutation": f"{frm}{pos}{to}",
        "old_codon": cds[i:i + 3],
        "new_codon": new_codon,
        "nt_start": cds_start + (i if strand == 1 else len(cds) - i - 3),
    }


# --------------------------------------------------------------------------
# assembly
# --------------------------------------------------------------------------

def golden_gate(fragments: list[dict[str, str]], enzyme: str = "BsaI",
                circular: bool = True) -> dict[str, Any]:
    """Simulate a Type IIS (Golden Gate) assembly by matching 4-nt overhangs."""
    from pydna.dseq import Dseq
    enz = getattr(Restriction, enzyme, None)
    if enz is None:
        return {"error": f"unknown enzyme {enzyme}"}

    pieces = []
    for frag in fragments:
        s = clean(frag.get("seq", ""))
        if not s:
            continue
        d = Dseq(s, circular=bool(frag.get("circular")))
        try:
            cut = d.cut(enz)
        except Exception as exc:
            return {"error": f"{frag.get('name')}: {exc}"}
        if len(cut) < 2:
            return {"error": f"{frag.get('name')!r} is not cut twice by {enzyme}"}
        inner = max(cut[1:-1] or cut, key=len) if not frag.get("circular") else max(cut, key=len)
        pieces.append({"name": frag.get("name") or "fragment", "dseq": inner})

    if not pieces:
        return {"error": "no usable fragments"}

    def five(d):
        try:
            return str(d.five_prime_end()[1]).upper()
        except Exception:
            return ""

    def three(d):
        try:
            return str(d.three_prime_end()[1]).upper()
        except Exception:
            return ""

    order = [pieces.pop(0)]
    while pieces:
        tail = three(order[-1]["dseq"])
        match = next((p for p in pieces if five(p["dseq"]) == tail and tail), None)
        if match is None:
            break
        pieces.remove(match)
        order.append(match)

    assembled = order[0]["dseq"]
    for p in order[1:]:
        assembled = assembled + p["dseq"]
    closes = bool(three(assembled)) and three(assembled) == five(order[0]["dseq"])

    return {
        "sequence": str(assembled).upper(),
        "length": len(str(assembled)),
        "order": [p["name"] for p in order],
        "unused": [p["name"] for p in pieces],
        "circular": bool(circular and closes),
        "closes": closes,
        "enzyme": enzyme,
    }


def gibson(fragments: list[dict[str, str]], min_homology: int = 20,
           circular: bool = True) -> dict[str, Any]:
    """Simulate Gibson / HiFi assembly via overlapping ends."""
    from pydna.dseqrecord import Dseqrecord
    from pydna.assembly import Assembly
    recs = []
    for frag in fragments:
        s = clean(frag.get("seq", ""))
        if s:
            r = Dseqrecord(s, circular=bool(frag.get("circular")))
            r.name = (frag.get("name") or "frag")[:16]
            recs.append(r)
    if len(recs) < 2:
        return {"error": "need at least two fragments"}
    try:
        asm = Assembly(recs, limit=int(min_homology))
        products = asm.assemble_circular() if circular else asm.assemble_linear()
    except Exception as exc:
        return {"error": str(exc)}
    if not products:
        return {"error": f"no assembly found with >={min_homology} bp homology"}
    best = products[0]
    return {
        "sequence": str(best.seq).upper(),
        "length": len(best),
        "circular": bool(circular),
        "products": len(products),
        "min_homology": min_homology,
    }


def codon_optimize(seq: str, avoid_enzymes: list[str] | None = None,
                   species: str = "e_coli", keep_protein: bool = True) -> dict[str, Any]:
    """Codon-optimise a CDS, optionally removing restriction sites."""
    from dnachisel import (
        DnaOptimizationProblem, EnforceTranslation, CodonOptimize,
        AvoidPattern, EnforceGCContent, Location,
    )
    s = clean(seq)
    if len(s) % 3 != 0:
        return {"error": "sequence length must be a multiple of 3"}
    constraints = [EnforceGCContent(mini=0.3, maxi=0.7, window=60)]
    if keep_protein:
        constraints.append(EnforceTranslation(location=Location(0, len(s), 1)))
    for name in (avoid_enzymes or []):
        try:
            constraints.append(AvoidPattern(f"{name}_site"))
        except Exception:
            continue
    try:
        problem = DnaOptimizationProblem(
            sequence=s,
            constraints=constraints,
            objectives=[CodonOptimize(species=species, location=Location(0, len(s), 1))],
            logger=None,
        )
        problem.resolve_constraints()
        problem.optimize()
    except Exception as exc:
        return {"error": str(exc)}
    new = str(problem.sequence).upper()
    changes = sum(1 for a, b in zip(s, new) if a != b)
    return {
        "sequence": new,
        "changes": changes,
        "identity": round(100.0 * (len(s) - changes) / len(s), 2) if s else 0.0,
        "protein_preserved": translate(s) == translate(new),
        "gc_before": gc_content(s),
        "gc_after": gc_content(new),
    }
