#!/bin/bash
# The application that tauri-driver starts for the AppImage smoke test (native/scripts/smoke-appimage.sh):
# the AppImage in $PROSE_APPIMAGE, run with --appimage-extract-and-run (no FUSE needed) in an environment
# that keeps nothing of the development toolchain.
#
#   appimage-app.sh <data-home> [app arguments...]
#
# tauri-driver and WebKitWebDriver may run inside native/scripts/in-env.sh (the sysroot's WebKitWebDriver);
# their environment (LD_LIBRARY_PATH, XDG_DATA_DIRS, GIO_EXTRA_MODULES, ... of the sysroot, PROSE_BIN) is
# not passed on: the AppImage starts from an empty environment with only the display, the user's basics,
# the variables of the automation session (TAURI_AUTOMATION, TAURI_WEBVIEW_AUTOMATION,
# WEBKIT_INSPECTOR_SERVER) and a plain PATH; on a host without libGLESv2.so.2 also LD_LIBRARY_PATH with
# the one folder that smoke-appimage.sh made for it (SMOKE_HOST_GLES). What was kept and dropped (names
# only) goes to <data-home>/appimage-env.txt.
set -euo pipefail
home=$1
shift
appimage=${PROSE_APPIMAGE:?PROSE_APPIMAGE names the AppImage}

keep=()
kept=()
dropped=()
while IFS= read -r -d '' entry; do
  name=${entry%%=*}
  case $name in
    DISPLAY | XAUTHORITY | HOME | USER | LOGNAME | LANG | LANGUAGE | LC_* | TZ | TMPDIR | XDG_RUNTIME_DIR | \
      DBUS_SESSION_BUS_ADDRESS | TAURI_AUTOMATION | TAURI_WEBVIEW_AUTOMATION | WEBKIT_INSPECTOR_SERVER)
      keep+=("$entry")
      kept+=("$name")
      ;;
    *) dropped+=("$name") ;;
  esac
done < <(env -0)
if [ -n "${SMOKE_HOST_GLES:-}" ]; then
  keep+=("LD_LIBRARY_PATH=$SMOKE_HOST_GLES")
fi
printf 'kept: %s\ndropped: %s\nhost GLES: %s\n' "${kept[*]}" "${dropped[*]}" "${SMOKE_HOST_GLES:-from the host}" \
  > "$home/appimage-env.txt"

exec env -i "${keep[@]}" XDG_DATA_HOME="$home" PATH=/usr/local/bin:/usr/bin:/bin \
  "$appimage" --appimage-extract-and-run "$@"
