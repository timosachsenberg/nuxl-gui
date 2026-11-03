#!/bin/bash
# Smoke test of the AppImage: it runs with --appimage-extract-and-run from an empty environment (no sysroot,
# no PROSE_BIN) under xvfb-run and searches the example with PeptDeep through WebDriver (e2e/appimage.smoke.ts).
#
#   smoke-appimage.sh <AppImage> [--hide-openms <openms-build>]
#
# WebDriver: tauri-driver and WebKitWebDriver drive the AppImage's own webview over WebKit's automation
# protocol (TAURI_WEBVIEW_AUTOMATION, which release builds honour too); neither is in the AppImage. On the
# development machine they come from in-env.sh (which this script enters by itself when the sysroot exists),
# in CI from the runner (cargo install tauri-driver, webkit2gtk-driver). The AppImage itself does not inherit
# their environment: tauri-driver starts e2e/appimage-app.sh, which clears it.
#
# --hide-openms: the bundled ProSE would find share/OpenMS and the PeptDeep models in the OpenMS source and
# build tree first, by paths compiled into it (see bundle-prose.sh), and on the build machine those exist.
# The option renames them for the duration of the test (and back on exit), so the test sees what a user's
# machine sees. The renamed paths, the build and source tree and the sysroot are passed to the test as
# SMOKE_FORBIDDEN: no process of the AppImage may map a file below them.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SYSROOT=${TAURI_SYSROOT:-/scratch/sachsenb/tools/tauri-sysroot}
if [ -d "$SYSROOT/usr/lib/x86_64-linux-gnu" ] && [ -z "${PROSE_IN_ENV:-}" ]; then
  export PROSE_IN_ENV=1
  exec "$ROOT/native/scripts/in-env.sh" "$ROOT/native/scripts/smoke-appimage.sh" "$@"
fi
die() { echo "error: $*" >&2; exit 1; }

[ "$#" -ge 1 ] || die "usage: $0 <AppImage> [--hide-openms <openms-build>]"
APPIMAGE=$(realpath "$1")
shift
OPENMS_BUILD=
while [ "$#" -gt 0 ]; do
  case $1 in
    --hide-openms) OPENMS_BUILD=$(realpath "${2:?--hide-openms needs the OpenMS build directory}"); shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
[ -x "$APPIMAGE" ] || die "$APPIMAGE is not an executable file"
for tool in xvfb-run tauri-driver WebKitWebDriver npx; do
  command -v "$tool" >/dev/null || die "$tool is needed"
done

forbidden=()
[ -d "$SYSROOT" ] && forbidden+=("$SYSROOT" "$(dirname "$SYSROOT")/webkit2gtk-4.1")

# --- the paths hidden for the test and the test's own temporary folder, restored and removed on exit ---
hidden=()
restore() {
  local path
  for path in "${hidden[@]}"; do
    if [ -e "$path.hidden-by-smoke" ] && [ ! -e "$path" ]; then
      mv "$path.hidden-by-smoke" "$path"
    else
      echo "warning: could not restore $path from $path.hidden-by-smoke" >&2
    fi
  done
}
work=$(mktemp -d)
trap 'restore; rm -rf "$work"' EXIT

# --- the host's GLES library ------------------------------------------------------------------------
# WebKit's libepoxy (in the AppImage) dlopens libGLESv2.so.2. No AppImage bundles it: it is the GL driver
# stack's, like libEGL and libGL on linuxdeploy's exclude list, and every Ubuntu desktop has it (package
# libgles2; WebKitGTK and mutter depend on it). A host without it (ibminode06 is a server) gets the
# sysroot's copy of that one library, in a folder of its own that appimage-app.sh appends to the library
# path; the test reports it.
if ! /sbin/ldconfig -p | grep -q 'libGLESv2\.so\.2 '; then
  gles=$SYSROOT/usr/lib/x86_64-linux-gnu/libGLESv2.so.2
  [ -f "$gles" ] || die "the host has no libGLESv2.so.2 (install libgles2)"
  mkdir "$work/gles"
  cp -L "$gles" "$work/gles/"
  export SMOKE_HOST_GLES=$work/gles
  echo "the host has no libGLESv2.so.2 (libgles2): the test supplies the sysroot's copy from $SMOKE_HOST_GLES"
fi

# --- hide the OpenMS build's data -------------------------------------------------------------------
if [ -n "$OPENMS_BUILD" ]; then
  cache=$OPENMS_BUILD/CMakeCache.txt
  header=$OPENMS_BUILD/src/openms/include/OpenMS/openms_data_path.h
  [ -f "$cache" ] && [ -f "$header" ] || die "$OPENMS_BUILD is not an OpenMS build directory"
  macro() { sed -n "s/^#define $1 \"\(.*\)\"$/\1/p" "$header"; }
  src=$(sed -n 's/^CMAKE_HOME_DIRECTORY:[A-Z]*=//p' "$cache")
  models=$(sed -n 's/^OPENMS_PEPTDEEP_MODEL_DIR:[A-Z]*=//p' "$cache")
  forbidden+=("$OPENMS_BUILD" "$src")
  # the source's share/OpenMS (OPENMS_DATA_PATH), the downloaded models (below OPENMS_BINARY_PATH) and the
  # build's tool registry
  for path in "$(macro OPENMS_DATA_PATH)" "$models" "$(macro OPENMS_BUILD_TOOL_REGISTRY_PATH)"; do
    [ -n "$path" ] && [ -e "$path" ] || continue
    [ ! -e "$path.hidden-by-smoke" ] || die "$path.hidden-by-smoke exists (an earlier run did not restore it?)"
    mv "$path" "$path.hidden-by-smoke"
    hidden+=("$path")
    echo "hidden for the test: $path"
  done
fi

cd "$ROOT"
[ -d node_modules/@wdio/cli ] || die "node_modules is missing: npm ci"
# the AppImage extracts itself into $TMPDIR (appimage_extracted_<digest>), and the app's end comes from
# tauri-driver, which leaves no time to remove it: a TMPDIR of the test's own, removed on exit
mkdir "$work/tmp"
export TMPDIR=$work/tmp
export PROSE_APPIMAGE=$APPIMAGE
export E2E_APPLICATION=$ROOT/e2e/appimage-app.sh
export SMOKE_FORBIDDEN
SMOKE_FORBIDDEN=$(IFS=:; echo "${forbidden[*]}")
unset PROSE_BIN
echo "smoke test of $APPIMAGE (forbidden: ${SMOKE_FORBIDDEN:-none})"
# (no exec: the trap restores what was hidden)
xvfb-run -a -s "-screen 0 1920x1080x24" npx wdio run e2e/wdio.conf.ts --spec "$ROOT/e2e/appimage.smoke.ts"
