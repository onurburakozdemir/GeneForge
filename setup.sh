#!/usr/bin/env bash
# GeneForge setup. Creates the mamba environment and builds GeneForge.app.
#
#   ./setup.sh                 core install
#   ./setup.sh --with-esmfold  also install local protein folding (~5 GB)
#   ./setup.sh --no-pymol      skip PyMOL (faster solve)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
ENV_NAME="geneforge"
WITH_ESM=0; NO_PYMOL=0
for a in "$@"; do
  case "$a" in
    --with-esmfold) WITH_ESM=1 ;;
    --no-pymol)     NO_PYMOL=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- specs
bold "This machine"
OS="$(uname -s)"; ARCH="$(uname -m)"
if [ "$OS" = "Darwin" ]; then
  CHIP="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo '?')"
  RAM_B="$(sysctl -n hw.memsize 2>/dev/null || echo 0)"
  RAM_GB=$(( RAM_B / 1073741824 ))
  CORES="$(sysctl -n hw.ncpu 2>/dev/null || echo '?')"
  MACOS="$(sw_vers -productVersion 2>/dev/null || echo '?')"
  echo "  $CHIP · $CORES cores · ${RAM_GB} GB RAM · macOS $MACOS · $ARCH"
  FREE_GB=$(df -g "$HOME" | awk 'NR==2{print $4}')
  echo "  Free disk: ${FREE_GB} GB"
else
  RAM_GB=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null || echo 0)
  CORES="$(nproc 2>/dev/null || echo '?')"
  echo "  $OS $ARCH · $CORES cores · ${RAM_GB} GB RAM"
fi

if [ "$WITH_ESM" = 1 ] && [ "${RAM_GB:-0}" -lt 16 ]; then
  warn "ESMFold wants 16 GB of RAM and this machine reports ${RAM_GB} GB."
  warn "Installing anyway, but GeneForge will refuse to run it rather than thrash."
fi

# ------------------------------------------------------------ conda/mamba
bold "Package manager"
MAMBA=""
for c in mamba micromamba conda; do
  # Absolute path: a double-clicked .app runs with a minimal PATH that will
  # not contain conda, so a bare command name would fail to launch.
  # `type -P` skips shell functions (conda/mamba are often functions).
  p="$(type -P "$c" 2>/dev/null || true)"
  if [ -z "$p" ] && [ -n "${CONDA_EXE:-}" ] && [ -x "$(dirname "$CONDA_EXE")/$c" ]; then
    p="$(dirname "$CONDA_EXE")/$c"
  fi
  if [ -n "$p" ]; then MAMBA="$p"; break; fi
done
if [ -z "$MAMBA" ]; then
  warn "no conda/mamba found; fetching micromamba into $HERE/.bin"
  mkdir -p "$HERE/.bin"
  case "$OS-$ARCH" in
    Darwin-arm64) MM_URL="https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-osx-arm64" ;;
    Darwin-x86_64) MM_URL="https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-osx-64" ;;
    *) MM_URL="https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-linux-64" ;;
  esac
  curl -fsSL -o "$HERE/.bin/micromamba" "$MM_URL" || die "could not download micromamba"
  chmod +x "$HERE/.bin/micromamba"
  export MAMBA_ROOT_PREFIX="$HERE/.mamba"
  MAMBA="$HERE/.bin/micromamba"
fi
ok "using $($MAMBA --version 2>/dev/null | head -1) via $MAMBA"

# ------------------------------------------------------------- environment
bold "Environment '$ENV_NAME'"
ENV_FILE="environment.yml"
if [ "$NO_PYMOL" = 1 ]; then
  ENV_FILE="$(mktemp -t geneforge-env).yml"
  grep -v 'pymol-open-source' environment.yml > "$ENV_FILE"
  warn "building without PyMOL"
fi
if $MAMBA env list 2>/dev/null | awk '{print $1}' | grep -qx "$ENV_NAME"; then
  ok "already exists — updating"
  $MAMBA env update -n "$ENV_NAME" -f "$ENV_FILE" --prune || die "environment update failed"
else
  $MAMBA env create -n "$ENV_NAME" -f "$ENV_FILE" || die "environment creation failed"
fi

run_in_env() { $MAMBA run -n "$ENV_NAME" "$@"; }

if [ "$WITH_ESM" = 1 ]; then
  bold "ESMFold (large download)"
  run_in_env pip install --quiet torch transformers accelerate || warn "ESMFold install failed; everything else still works"
fi

# ------------------------------------------------------------------ check
bold "Verifying"
VERIFY_PY="$(mktemp -t geneforge-verify).py"; cat > "$VERIFY_PY" <<'PY'
import importlib, sys
need = [("Bio","biopython"),("primer3","primer3-py"),("RNA","ViennaRNA"),
        ("pyfamsa","pyfamsa"),("fastapi","fastapi"),("uvicorn","uvicorn")]
opt  = [("pymol","PyMOL"),("torch","torch (ESMFold)"),("webview","pywebview"),
        ("dnachisel","dnachisel"),("pydna","pydna"),("biotite","biotite")]
bad = []
for mod, name in need:
    try: importlib.import_module(mod); print(f"  \033[32m✓\033[0m {name}")
    except Exception as e: bad.append(name); print(f"  \033[31m✗\033[0m {name}: {e}")
for mod, name in opt:
    try: importlib.import_module(mod); print(f"  \033[32m✓\033[0m {name} (optional)")
    except Exception: print(f"  \033[33m-\033[0m {name} (optional, not installed)")
if bad:
    sys.exit("missing required packages: " + ", ".join(bad))
PY
run_in_env python "$VERIFY_PY"

# ------------------------------------------------------------------- icon
bold "App bundle"
APP="$HERE/GeneForge.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [ "$OS" = "Darwin" ] && command -v iconutil >/dev/null 2>&1; then
  python3 make_icon.py "$HERE/icon_1024.png" >/dev/null 2>&1 || true
  if [ -f "$HERE/icon_1024.png" ]; then
    ICONSET="$(mktemp -d)/GeneForge.iconset"; mkdir -p "$ICONSET"
    for sz in 16 32 64 128 256 512; do
      sips -z $sz $sz "$HERE/icon_1024.png" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1
      sips -z $((sz*2)) $((sz*2)) "$HERE/icon_1024.png" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
    done
    cp "$HERE/icon_1024.png" "$ICONSET/icon_512x512@2x.png" 2>/dev/null || true
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/GeneForge.icns" >/dev/null 2>&1 && ok "icon built"
  fi
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>GeneForge</string>
  <key>CFBundleDisplayName</key><string>GeneForge</string>
  <key>CFBundleIdentifier</key><string>local.geneforge.app</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>GeneForge</string>
  <key>CFBundleIconFile</key><string>GeneForge</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST

cat > "$APP/Contents/MacOS/GeneForge" <<LAUNCH
#!/bin/bash
# Launcher written by setup.sh — paths are absolute on purpose.
export MAMBA_ROOT_PREFIX="${MAMBA_ROOT_PREFIX:-}"
export PATH="/usr/local/bin:/opt/homebrew/bin:\$PATH"
LOG="\$HOME/Library/Logs/GeneForge.log"
mkdir -p "\$(dirname "\$LOG")"
cd "$HERE"
echo "--- \$(date) ---" >> "\$LOG"
exec "$MAMBA" run -n "$ENV_NAME" python -m geneforge >> "\$LOG" 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/GeneForge"
ok "built $APP"

bold "Done"
echo "  Double-click GeneForge.app, or drag it to your Applications folder / Dock."
echo "  Logs: ~/Library/Logs/GeneForge.log"
echo "  Command line: $MAMBA run -n $ENV_NAME python -m geneforge --folder /path/to/folder"
if [ "$WITH_ESM" != 1 ]; then
  echo "  Local protein folding is not installed. Add it later with: ./setup.sh --with-esmfold"
fi
