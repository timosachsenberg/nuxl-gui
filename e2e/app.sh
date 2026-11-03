#!/bin/bash
# The application that tauri-driver starts for a session: the debug build, with its own data folder.
#
#   app.sh <data-home> [app arguments...]
#
# wdio.conf.ts passes a folder of its own for every spec file as the first argument (tauri:options.args),
# and it becomes XDG_DATA_HOME, so the spec's app-data folder (<data-home>/org.openms.prose.desktop)
# holds only the searches of that spec. exec: the app takes this process's place.
set -euo pipefail
home=$1
shift
export XDG_DATA_HOME=$home
# the file that the specs choose in place of the system dialogs (debug builds only; see lib.rs)
export PROSE_TEST_DIALOG_PATH=$home/chosen.prose
exec "$(dirname "${BASH_SOURCE[0]}")/../src-tauri/target/debug/prose-desktop" "$@"
