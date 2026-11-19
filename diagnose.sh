#!/usr/bin/env bash
# Writes a full diagnostic report into this folder as diagnostic.txt.
# Run:  ./diagnose.sh
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/diagnostic.txt"
exec > "$OUT" 2>&1
echo "GeneForge diagnostic — $(date)"
echo "=================================================="

echo; echo "## machine"
uname -a
sysctl -n machdep.cpu.brand_string 2>/dev/null
echo "RAM: $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1073741824 )) GB"
sw_vers 2>/dev/null

echo; echo "## the crash log"
for L in "$HOME/Library/Logs/GeneForge.log" "$HERE/geneforge-launch.log"; do
  echo "--- $L ---"
  [ -f "$L" ] && tail -n 120 "$L" || echo "(absent)"
done

echo; echo "## environment python"
PY=""
for c in \
  "/opt/homebrew/Caskroom/miniforge/base/envs/geneforge/bin/python" \
  "$HOME/miniforge3/envs/geneforge/bin/python" \
  "$HOME/miniconda3/envs/geneforge/bin/python" \
  "$HOME/anaconda3/envs/geneforge/bin/python" \
  "$HOME/.conda/envs/geneforge/bin/python" \
  "$HERE/.mamba/envs/geneforge/bin/python"
do [ -x "$c" ] && { PY="$c"; break; }; done
echo "resolved: ${PY:-NOT FOUND}"
[ -n "$PY" ] && "$PY" -V

echo; echo "## imports"
[ -n "$PY" ] && "$PY" - <<'PYX'
import importlib, platform, sys
print("executable:", sys.executable)
print("platform  :", platform.platform())
for m in ["Bio","primer3","RNA","pyfamsa","fastapi","uvicorn","watchdog",
          "webview","pymol","torch","dnachisel","pydna","biotite","objc"]:
    try:
        mod = importlib.import_module(m)
        print(f"  OK   {m} {getattr(mod,'__version__','')}")
    except Exception as e:
        print(f"  MISS {m}: {type(e).__name__}: {e}")
PYX

echo; echo "## can the package import?"
[ -n "$PY" ] && (cd "$HERE" && "$PY" -c "
import traceback
for m in ['geneforge','geneforge.seqio','geneforge.bio','geneforge.store','geneforge.tools','geneforge.server','geneforge.__main__']:
    try: __import__(m); print('  OK  ',m)
    except Exception: print('  FAIL',m); traceback.print_exc()
")

echo; echo "## headless server start (10s)"
[ -n "$PY" ] && (cd "$HERE" && "$PY" -m geneforge --headless --port 8899 >/tmp/gf_probe.log 2>&1 & \
   PROBE=$!; sleep 10; kill $PROBE 2>/dev/null; head -40 /tmp/gf_probe.log)
echo "(exit $?)"

echo; echo "## pywebview window probe"
[ -n "$PY" ] && "$PY" - <<'PYX'
try:
    import webview
    print("pywebview", getattr(webview, "__version__", "?"))
    import webview.platforms.cocoa as c
    print("cocoa backend import: OK")
except Exception as e:
    import traceback; traceback.print_exc()
PYX

echo; echo "## launcher"
cat "$HERE/GeneForge.app/Contents/MacOS/GeneForge" 2>/dev/null || echo "(no launcher)"
echo; echo "## marker file"
ls -la "$HOME/.geneforge-window-failed" 2>/dev/null || echo "(none)"
echo; echo "=== end ==="
