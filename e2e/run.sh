#!/bin/bash
# End-to-end tests: build the debug binary, then run WebdriverIO through tauri-driver and
# WebKitWebDriver under xvfb-run, all inside native/scripts/in-env.sh.
#
#   e2e/run.sh [spec...] [--mochaOpts.grep <title>]   (no spec: every e2e/*.spec.ts; options go to wdio,
#                                  e.g. one test of a spec: e2e/run.sh e2e/paths.spec.ts --mochaOpts.grep 'mzML.gz')
#
# Either `e2e/run.sh e2e/smoke.spec.ts` or `native/scripts/in-env.sh e2e/run.sh e2e/smoke.spec.ts`
# works: the script enters the environment itself when it is not in it.
# E2E_SKIP_BUILD=1 skips the build (the binary is up to date).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ -z "${PROSE_IN_ENV:-}" ]; then
  export PROSE_IN_ENV=1
  exec "$ROOT/native/scripts/in-env.sh" "$ROOT/e2e/run.sh" "$@"
fi

cd "$ROOT"
if [ -z "${E2E_SKIP_BUILD:-}" ]; then
  npm run tauri:build:debug
fi

args=()
while [ "$#" -gt 0 ]; do
  case $1 in
    --*) args+=("$1" "${2:?$1 needs a value}"); shift 2 ;;  # an option of wdio with its value
    *) args+=(--spec "$(realpath "$1")"); shift ;;
  esac
done
exec xvfb-run -a -s "-screen 0 1920x1080x24" npx wdio run e2e/wdio.conf.ts "${args[@]}"
