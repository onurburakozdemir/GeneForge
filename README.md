# GeneForge

A local sequence-design workbench. A Python engine owns your sequences in
memory; the browser is a live view onto it. Edits — yours or an agent's — are
pushed over a WebSocket, so open views update in place without a reload and
without losing your selection, zoom or scroll position.

## Install

```bash
cd GeneForge
./setup.sh                 # core install
./setup.sh --with-esmfold  # also local protein folding (~5 GB extra)
```

`setup.sh` prints your chip, RAM, cores and macOS version, creates the mamba
environment `geneforge`, verifies every library, and builds **GeneForge.app**.
Double-click it, or drag it to Applications or the Dock.

Logs go to `~/Library/Logs/GeneForge.log`.

From the command line:

```bash
mamba run -n geneforge python -m geneforge --folder /path/to/sequences
mamba run -n geneforge python -m geneforge --browser     # tab instead of a window
mamba run -n geneforge python -m geneforge --headless    # server only, for agents
```

## Two deliberate defaults

**Nothing opens automatically.** The app starts empty. Open files by dragging
them in, or by clicking them in the folder list.

**Autosave is off.** Edits live in memory until you press Save, and saving over
an existing file asks first. Turn autosave on with `--autosave` if you want it.

## What it does

**Viewing** — linear and circular maps (or both), feature arrows with their
GenBank/ApE colours, dual-strand sequence view, three-frame translation, ORF
tracks, restriction cut marks. The sequence view is virtualised, so large
plasmids stay responsive.

**Editing** — select by dragging on the sequence or the map; annotate a
selection; edit, recolour or delete features; rename; switch topology. Feature
coordinates follow sequence edits automatically.

**Special copy** — forward DNA, reverse complement, complement, reversed, RNA
(either strand), protein in any of three frames or from the reverse strand,
FASTA, or the whole GenBank record.

**Restriction** — recognition-site driven, not cut-driven, so a site is shown
even when its cut lands off the end of a linear fragment (common for designed
Golden Gate ends, and a case Biopython's own `search()` reports as *no sites*).
Reports cut positions, overhang sequence and type, fragments, and non-cutters.

**Primers** — primer3 design over a selection, with real Tm, GC, hairpin and
self-dimer values. Saved primers are annotated onto the construct as
`primer_bind` features.

**Alignment** — FAMSA (or MUSCLE). Equal-length inputs are compared
column-wise, which is exact and keeps numbering identical to the reference.

**Secondary structure** — ViennaRNA, with RNA *or* DNA parameters. The RBS
check folds the mRNA window around your ribosome binding site twice, once
freely and once with the RBS forced open, and reports ΔG_open — the work the
ribosome must do to expose it.

**Mutagenesis** — protein-level variants by name (`F12L`, `W8F`), applied to
any chosen region, producing a new sequence with the change annotated.

**Assembly** — Golden Gate (Type IIS overhang matching) and Gibson, via pydna.

**Structure** — built-in 3D viewer (3Dmol.js, offline) for PDB/CIF; PyMOL
ray-traced renders; an AlphaFold 3 job builder that writes a correct
`alphafoldserver.com` job file, including both DNA strands for a duplex and the
right ion count; optional local ESMFold.

## Driving it from an agent

Run with `--headless` and use the REST API; every change broadcasts to open
views. Full schema at `http://127.0.0.1:8731/api/docs`.

```bash
B=http://127.0.0.1:8731
curl -s $B/api/state                                     # everything open
curl -s -X POST $B/api/open -d '{"path":"x.gb"}' -H 'Content-Type: application/json'
curl -s -X POST $B/api/sequences -H 'Content-Type: application/json' \
     -d '{"name":"design1","seq":"ATG...","topology":"linear"}'
curl -s -X POST $B/api/sequences/design1/mutate -H 'Content-Type: application/json' \
     -d '{"cds_start":417,"cds_end":465,"mutations":["F12L"]}'
curl -s -X POST $B/api/sequences/design1/rbs -d '{}' -H 'Content-Type: application/json'
```

Sequences can be addressed by id **or by name**. Anything created with
`"origin":"agent"` is highlighted in the UI as it arrives.

## Honest status

Verified against real constructs: parsing (GenBank/FASTA, circular, compound
locations, ApE colours), restriction mapping and fragment sums, ORF finding,
primer3 design, protein mutation, FAMSA alignment, ViennaRNA folding and the
RBS check, the AlphaFold 3 job builder, and the full UI driven through a real
browser.

Not yet run on macOS: the `.app` bundle, the pywebview window, PyMOL on
arm64, and ESMFold on Apple Silicon. These were written without a Mac to test
on. `setup.sh` verifies each library and reports failures; if something
misbehaves on first launch, the log will say so.

ESMFold is single-chain protein only — no DNA, no multimers, no metals. For a
zinc-finger–DNA complex use the AlphaFold 3 export instead.

Molecular Nodes is supported by writing a ready-to-run Blender script rather
than driving Blender headlessly, because its maintainers describe the scripting
API as still changing. PyMOL is the production render path.

## Layout

```
GeneForge/
  setup.sh            install + build the app
  environment.yml     the mamba environment
  make_icon.py        generates the app icon (standard library only)
  geneforge/
    __main__.py       launcher
    server.py         REST + WebSocket
    store.py          live project state, broadcast, autosave, file watching
    seqio.py          GenBank/FASTA read and write
    bio.py            restriction, ORFs, primers, mutation, assembly
    tools.py          alignment, ViennaRNA, AlphaFold 3, ESMFold, PyMOL
    static/           the interface
```

GeneForge never writes to your sequence files unless you explicitly save.
