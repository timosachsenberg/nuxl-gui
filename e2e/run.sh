#!/bin/bash
# End-to-end tests: build the debug binary, then run WebdriverIO through tauri-driver and
# WebKitWebDriver under xvfb-run, all inside native/scripts/in-env.sh.
#
#   e2e/run.sh [spec...] [--mochaOpts.grep <title>]   (no spec: every e2e/*.spec.ts; options go to wdio,
#                                  e.g. one test of a spec: e2e/run.sh e2e/paths.spec.ts --mochaOpts.grep 'mzML.gz')
#
# Either `e2e/run.sh e2e/smoke.spec.ts` or `native/scripts/in-env.sh e2e/run.sh e2e/smoke.spec.ts`
# works: the script enters the environment itself when it is not in it, and when the toolchain of in-env.sh
# (its sysroot, TAURI_SYSROOT or /scratch/sachsenb/tools/tauri-sysroot) is not on this machine it runs with the
# host's own (cargo, node, tauri-driver, WebKitWebDriver and xvfb-run on the PATH, WebKitGTK 4.1 installed).
# E2E_SKIP_BUILD=1 skips the build (the binary is up to date). E2E_SCREEN is the screen of xvfb-run (default
# 1920x1080x24; e2e/screens.shot.ts at GDK_SCALE=2 needs a larger one).
# NUXL_FAKE=1 runs the specs that search against the stand-in for OpenNuXL (e2e/fake/OpenNuXL, which writes the
# example's outputs, src/lib/results/fixtures/example) in place of a real tool: NUXL_TOOL is set to it. The
# screenshots (e2e/screens.shot.ts) get the outputs of fixtures/screens (OpenNuXL's test 3: realistic precursor
# errors) instead; FAKE_NUXL_RESULTS (a folder, or a fixture's name) chooses others.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ -z "${NUXL_IN_ENV:-}" ] && [ -d "${TAURI_SYSROOT:-/scratch/sachsenb/tools/tauri-sysroot}/usr/lib/x86_64-linux-gnu" ]; then
  export NUXL_IN_ENV=1
  exec "$ROOT/native/scripts/in-env.sh" "$ROOT/e2e/run.sh" "$@"
fi

if [ -n "${NUXL_FAKE:-}" ]; then
  export NUXL_TOOL="$ROOT/e2e/fake/OpenNuXL"
  if [ -z "${FAKE_NUXL_RESULTS:-}" ]; then
    FAKE_NUXL_RESULTS=example
    for a in "$@"; do
      case $a in *screens.shot.ts) FAKE_NUXL_RESULTS=screens ;; esac
    done
  fi
  export FAKE_NUXL_RESULTS
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
exec xvfb-run -a -s "-screen 0 ${E2E_SCREEN:-1920x1080x24}" npx wdio run e2e/wdio.conf.ts "${args[@]}"
