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

## Working in a folder

GeneForge works the way an editor does: you point it at a folder and everything
in it shows up in the sidebar. **Open folder…** in the top bar (or ⌘O) browses
to another one. Switching folders only changes what the file list shows — it
opens nothing, writes nothing and closes nothing you have open.

## What it does

**Viewing** — linear and circular maps (or both), feature arrows with their
GenBank/ApE colours, and a double-stranded sequence view: the top strand reads
dark, the bottom strand a step lighter. ORF tracks carry an arrow head on the
start codon pointing the way the frame reads. Saved primers appear as a third
strand above the duplex, and on the map, with the arrow head at the 3' end.
The sequence view is virtualised, so large plasmids stay responsive.

**Editing** — select by dragging on the sequence or the map; annotate a
selection; edit, recolour or delete features; rename; switch topology. Feature
coordinates follow sequence edits automatically.

**Right-click** — the menu over a selection is where the work happens: copy it
as DNA, reverse complement, complement, reversed, RNA either way, protein in
any frame or from the reverse strand, FASTA or the whole GenBank record;
translate *that region only*, on either strand, as its own row under the
duplex; annotate it; or jump to primer design. Right-clicking an annotation —
in the sequence, on the map or in the features list — offers edit and delete.

**Cutting enzymes** — keep your own list: type a name to add one, click its ×
to drop it, and show or hide the cut marks with one button. Analysis is
recognition-site driven, not cut-driven, so a site is shown even when its cut
lands off the end of a linear fragment (common for designed Golden Gate ends,
and a case Biopython's own `search()` reports as *no sites*). Reports cut
positions, overhang sequence and type, fragments, and non-cutters.

**Primers** — primer3 design over a selection, with real Tm, GC, hairpin and
self-dimer values. Saved primers are annotated onto the construct as
`primer_bind` features and drawn on both the sequence and the map.

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
ray-traced renders, shown in the panel as well as written next to the
structure; an AlphaFold 3 job builder that takes as many components as the
complex needs — several protein chains, DNA, RNA and ions, each with a copy
count — and writes a correct `alphafoldserver.com` job file, including both
strands for a duplex; optional local ESMFold, which the Tools panel will
install for you if you want it.

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

Run on macOS 27 / Apple Silicon: the `.app` bundle, the pywebview window, and
PyMOL ray-traced rendering on osx-arm64 all work. `setup.sh` verifies each
library and reports failures; if something misbehaves on first launch, the log
will say so.

Still untested here: ESMFold on Apple Silicon, because it is not installed by
default. `tools.esmfold` uses CPU unless CUDA is present — MPS historically
misses ops ESMFold needs — and it refuses to run below 15 GB of RAM rather
than thrashing.

ESMFold is single-chain protein only — no DNA, no multimers, no metals. For a
zinc-finger–DNA complex use the AlphaFold 3 export instead.

Molecular Nodes is not supported. GeneForge used to write a Blender script you
had to run by hand, which produced no image on its own; that was removed rather
than left looking like a render button. PyMOL is the render path.

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
