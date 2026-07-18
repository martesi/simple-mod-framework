#!/usr/bin/env bash
# Build mod-manager-tauri for Windows (x86_64-pc-windows-gnu) on Linux,
# drop the .exe into the e2e runtime layout, then run it via WSL interop.
#
# Prerequisites (provided by `nix develop`):
#   - x86_64-w64-mingw32-gcc    (MinGW cross-linker)
#   - cargo with x86_64-pc-windows-gnu std (fenix toolchain)
#   - CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER set in shellHook
#
# Usage:
#   ./scripts/windows-test-deploy.sh [--debug] [--run] [--devtools]
#
#   --debug    build debug binary (faster, includes debug info)
#   --run      launch the .exe via WSL interop immediately after deploy
#   --devtools open WebView2 remote debugging port 9222 when launching

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MMT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SMF_ROOT="$(cd "$MMT_DIR/.." && pwd)"

WIN_TARGET="x86_64-pc-windows-gnu"
PROFILE="release"
CARGO_FLAGS="--release"
DO_RUN=false
DEVTOOLS=false

for arg in "$@"; do
    case "$arg" in
        --debug)   PROFILE="debug"; CARGO_FLAGS="" ;;
        --run)     DO_RUN=true ;;
        --devtools) DEVTOOLS=true; DO_RUN=true ;;
    esac
done

EXE_SRC="$MMT_DIR/src-tauri/target/$WIN_TARGET/$PROFILE/mod-manager-tauri.exe"

# The e2e runtime already has the correct SMF directory layout.
FRAMEWORK="$MMT_DIR/e2e/.runtime/game/framework"
APP_DIR="$FRAMEWORK/Mod Manager"
EXE_DEST="$APP_DIR/mod-manager-tauri.exe"

echo "==> target:  $WIN_TARGET ($PROFILE)"
echo "==> dest:    $EXE_DEST"
echo

# --------------------------------------------------------------------------
# 1. Build the SvelteKit frontend (output goes to mod-manager-tauri/build/)
#    tauri-build embeds this at compile time via frontendDist = "../build"
# --------------------------------------------------------------------------
echo "[1/3] Building frontend..."
cd "$MMT_DIR"
npm run build
echo

# --------------------------------------------------------------------------
# 2. Compile the Rust/Tauri binary for Windows
# --------------------------------------------------------------------------
echo "[2/3] Compiling Rust backend (cross → $WIN_TARGET)..."
cargo build $CARGO_FLAGS \
    --target "$WIN_TARGET" \
    --manifest-path src-tauri/Cargo.toml
echo

# --------------------------------------------------------------------------
# 3. Install into the e2e runtime layout
#    framework_root = e2e/.runtime/game/framework/
#    app_dir        = framework/Mod Manager/    (paths.rs: exe's parent dir)
# --------------------------------------------------------------------------
echo "[3/3] Installing .exe to $EXE_DEST ..."
mkdir -p "$APP_DIR"
cp "$EXE_SRC" "$EXE_DEST"

echo
echo "======================================================================"
echo " Built:  $EXE_DEST"
echo
echo " Layout:"
echo "   framework/            ← framework_root (Deploy.exe, config.json)"
echo "     Mod Manager/"
echo "       mod-manager-tauri.exe"
echo
echo " Run manually:"
echo "   '$EXE_DEST'"
echo
echo " Run with devtools (WebView2 remote debugging on port 9222):"
echo "   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9222 --remote-allow-origins=http://localhost:9222' \\"
echo "     '$EXE_DEST'"
echo " then open Chrome/Edge → http://localhost:9222"
echo "======================================================================"

# --------------------------------------------------------------------------
# Optional: launch immediately via WSL interop
# --------------------------------------------------------------------------
if "$DO_RUN"; then
    echo
    if "$DEVTOOLS"; then
        echo "Launching with devtools port 9222 via WSL interop..."
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222 --remote-allow-origins=http://localhost:9222" \
            "$EXE_DEST"
    else
        echo "Launching via WSL interop..."
        "$EXE_DEST"
    fi
fi
