#!/bin/bash
# The start test of a macOS or Windows package (CI), on the package as a user gets it:
#
#   start-test.sh <NuXL_*.dmg | NuXL_*-setup.exe> <example-dir>
#
# 1. The package is opened: the .dmg is mounted and NuXL.app copied out of it; the installer is run
#    silently (/S). Either goes into a folder named 'Größe ü/install', as under a user profile of a
#    non-ASCII name. The bundled tools inside are checked (bundle_closure.py macho-verify / pe-verify).
# 2. The bundled OpenNuXL and PercolatorAdapter print their version, from an empty environment (Windows: only
#    Windows' folders on PATH).
# 3. OpenNuXL searches the example (<example-dir>: OpenNuXL_1_input.mzML and OpenNuXL_1_input.fasta, copied into
#    a folder with a space in its name) from the command line as the app runs it (src-tauri/src/args.rs), with
#    the preset RNA-UV (U) and Percolator: it has to end with 0, write the outputs the app reads (its idXML of all
#    PSMs, the cross-links and peptides, the protein report and the TSV report) and find PSMs. (The example has
#    far fewer than the 1000 PSMs OpenNuXL rescores: Percolator is skipped, with OpenNuXL's warning.)
#    The same in a folder named 'Größe ü', with the temporary folder there too, has to give the same number
#    of PSMs.
# 4. The app starts with --smoke-test (src-tauri/src/lib.rs): once its page has loaded it reports the page,
#    tool_info and whether PercolatorAdapter is beside the tool, and exits. tool_info has to be the bundled
#    OpenNuXL inside the package, with the version of step 2. On macOS the app is started a second time through a
#    symbolic link to it, where Tauri names no resource folder and the app finds its bundle by the executable's
#    real path.
# The build machine's OpenMS must be gone (CI removes it after bundling), so that the tools can only use the
# package's share/OpenMS. Writes a summary to $GITHUB_STEP_SUMMARY when it is set.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <package> <example-dir>" >&2
  exit 2
fi
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PACKAGE=$1
EXAMPLE=$(cd "$2" && pwd)
PY=python3
"$PY" -c '' 2>/dev/null || PY=python
die() { echo "error: $*" >&2; exit 1; }
summary() { if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi; }
# (canonical: on macOS mktemp's /var/folders/... goes through the link /var, and Tauri refuses an app
# path with a link in it, StartingBinary, so its resource folder would not be found)
work=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$work"' EXIT
wide_root="$work/Größe ü"
mkdir -p "$wide_root/install" "$wide_root/temp"

case "$(uname -s)" in
  Darwin)
    platform=macos
    mkdir "$work/mnt"
    hdiutil attach -nobrowse -readonly -mountpoint "$work/mnt" "$PACKAGE" >/dev/null
    source_app=$(find "$work/mnt" -maxdepth 1 -name '*.app' | head -n 1)
    [ -n "$source_app" ] || die "no .app in $PACKAGE"
    app=$wide_root/install/$(basename "$source_app")
    ditto "$source_app" "$app"
    hdiutil detach "$work/mnt" >/dev/null
    executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")
    APP_BIN=$app/Contents/MacOS/$executable
    BUNDLE=$app/Contents/Resources/resources/nuxl
    TOOL=$BUNDLE/bin/OpenNuXL
    ADAPTER=$BUNDLE/bin/PercolatorAdapter
    "$PY" -I "$HERE/bundle_closure.py" macho-verify "$BUNDLE"
    native() { printf '%s\n' "$1"; }
    clean() { env -i HOME="$HOME" TMPDIR="${SEARCH_TEMP:-${TMPDIR:-/tmp}}" PATH=/usr/bin:/bin "$@"; }
    ;;
  MINGW* | MSYS* | CYGWIN*)
    platform=windows
    install=$wide_root/install
    # NSIS takes /D= last and unquoted, also with spaces in the path; bash would quote an argument with a
    # space (NSIS then ignores it and installs into its default folder), so the command line goes whole
    # through PowerShell's Start-Process
    setup_win=$(cygpath -w "$(cd "$(dirname "$PACKAGE")" && pwd)/$(basename "$PACKAGE")")
    MSYS_NO_PATHCONV=1 pwsh -NoProfile -NonInteractive -Command \
      "Start-Process -FilePath '$setup_win' -ArgumentList '/S /D=$(cygpath -w "$install")' -Wait"
    for _ in $(seq 60); do [ -d "$install/resources/nuxl/bin" ] && break; sleep 1; done
    APP_BIN=$(find "$install" -maxdepth 1 -iname '*.exe' ! -iname 'uninstall*' | head -n 1)
    [ -n "$APP_BIN" ] || die "the installer put no app into $install: $(ls "$install" 2>&1); its default folder: $(ls "$(cygpath -u "$LOCALAPPDATA")/NuXL" 2>&1 | head -n 5)"
    BUNDLE=$install/resources/nuxl
    TOOL=$BUNDLE/bin/OpenNuXL.exe
    ADAPTER=$BUNDLE/bin/PercolatorAdapter.exe
    "$PY" -I "$HERE/bundle_closure.py" pe-verify "$(cygpath -m "$BUNDLE")"
    native() { cygpath -w "$1"; }
    clean() {
      env -i SYSTEMROOT="$SYSTEMROOT" WINDIR="$WINDIR" PATH="/c/Windows/System32:/c/Windows" \
        TEMP="${SEARCH_TEMP:-$TEMP}" TMP="${SEARCH_TEMP:-$TMP}" USERPROFILE="$USERPROFILE" \
        LOCALAPPDATA="$LOCALAPPDATA" APPDATA="$APPDATA" \
        "$@"
    }
    ;;
  *) die "start-test.sh is for the macOS and Windows packages (Linux: smoke-appimage.sh)" ;;
esac
for exe in "$TOOL" "$ADAPTER"; do
  [ -x "$exe" ] || [ -f "$exe" ] || die "the package has no bundled $(basename "$exe") at $exe"
done
# the licences that go with it: the app's third-party notices, OpenMS' and its libraries'
[ -s "$BUNDLE/../notices/THIRD-PARTY-NOTICES.txt" ] || die "the package has no resources/notices/THIRD-PARTY-NOTICES.txt"
[ -f "$BUNDLE/share/OpenMS/LICENSES/OpenMS-LICENSE.txt" ] || die "the package has no licence of OpenMS"
[ -f "$BUNDLE/share/OpenMS/NUXL/nuxl_presets.json" ] || die "the package has no presets of OpenNuXL"
echo "package: $PACKAGE"
echo "app: $APP_BIN"
echo "bundled OpenNuXL: $TOOL"
cat "$BUNDLE/build.json"

# --- 2. the versions -------------------------------------------------------------------------------
tool_version() { clean "$1" --help 2>&1 | sed -n 's/^ *Version: *\([^ ]*\).*/\1/p' | head -n 1; }
version=$(tool_version "$TOOL")
[ -n "$version" ] || die "the bundled OpenNuXL does not run: $(clean "$TOOL" --help 2>&1 | tail -n 5)"
adapter_version=$(tool_version "$ADAPTER")
[ "$adapter_version" = "$version" ] \
  || die "the bundled PercolatorAdapter reports version '${adapter_version}', OpenNuXL $version: $(clean "$ADAPTER" --help 2>&1 | tail -n 5)"
echo "OpenNuXL and PercolatorAdapter version: $version"

# --- 3. the example from the command line ----------------------------------------------------------
search() { # <folder>: copies the example there and searches it as the app does; leaves out.txt
  local dir=$1
  mkdir -p "$dir"
  cp "$EXAMPLE/OpenNuXL_1_input.mzML" "$EXAMPLE/OpenNuXL_1_input.fasta" "$dir/"
  clean "$TOOL" -in "$(native "$dir/OpenNuXL_1_input.mzML")" \
    -database "$(native "$dir/OpenNuXL_1_input.fasta")" \
    -out "$(native "$dir/run.idXML")" -out_tsv "$(native "$dir/run.tsv")" -threads 3 \
    -report:peptideFDR 0 -report:xlFDR 1.0 0.01 -report:xl_peptidelevel_FDR 1.0 1.0 \
    -percolator_backend builtin \
    -precursor:mass_tolerance 10 -NuXL:presets "RNA-UV (U)" >"$dir/out.txt" 2>&1
}
started=$(date +%s)
data="$work/example data"
if ! search "$data"; then
  tail -n 30 "$data/out.txt"
  die "the command-line search failed"
fi
seconds=$(( $(date +%s) - started ))
for f in run.idXML run.tsv run_0.0000_peptides.idXML run_1.0000_XLs.idXML run_0.0100_XLs.idXML run_proteins0.0100_XLs.tsv; do
  [ -s "$data/$f" ] || die "the search wrote no $f: $(tail -n 20 "$data/out.txt")"
done
# the PSMs of the idXML of all hits (targets and decoys, every spectrum's top hits)
count_psms() { grep -c '<PeptideHit ' "$1/run.idXML" || true; }
psms=$(count_psms "$data")
[ -n "$psms" ] && [ "$psms" -gt 0 ] || die "the search found no PSMs: $(tail -n 20 "$data/out.txt")"
percolator=$(grep -E '^(Too few PSMs for score recalibration|Score recalibration failed|Running percolator)' "$data/out.txt" | head -n 1)
echo "command-line search: $psms PSMs, in ${seconds} s (${percolator:-no word of Percolator})"

# a folder name outside ASCII, the temporary folder too (Windows: the tools run with the UTF-8 code page,
# bundle_closure.py; without it ProSE, whose bundle this comes from, read its inputs wrongly)
wide="$wide_root/data"
SEARCH_TEMP=$(native "$wide_root/temp")
if ! search "$wide"; then
  grep -vE '^(Warning: |Schema error)' "$wide/out.txt" | grep -v '^\s*$' | tail -n 30
  die "the command-line search in a folder named 'Größe ü' failed"
fi
wide_psms=$(count_psms "$wide")
[ "${wide_psms:-0}" = "$psms" ] || die "in 'Größe ü' the search found ${wide_psms:-no} PSMs, not $psms"
unset SEARCH_TEMP
wide_result="searched ($wide_psms PSMs; the package installed below it)"
echo "a folder named 'Größe ü': $wide_result"

# --- 4. the app starts, finds its OpenNuXL, and exits ------------------------------------------------
smoke() { # <app binary> <label> <through-a-link: 0|1>: starts it with --smoke-test; sets report
  local bin=$1 label=$2 linked=$3 pid status=0
  "$bin" --smoke-test >"$work/app-$label.json" 2>"$work/app-$label.err" &
  pid=$!
  for _ in $(seq 180); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    die "the app ($label) did not exit within 180 s: $(tail -n 20 "$work/app-$label.err")"
  fi
  wait "$pid" || status=$?
  report=$(grep -m1 '^{' "$work/app-$label.json" || true)
  echo "app --smoke-test, $label (exit $status): $report"
  [ "$status" -eq 0 ] && [ -n "$report" ] || die "the app's start ($label) failed: $(tail -n 20 "$work/app-$label.err")"
  "$PY" -I - "$report" "$(native "$TOOL")" "$version" "$linked" <<'PY'
import json, os, sys
report, tool, version, linked = sys.argv[1:]
data = json.loads(report)
info = data.get("tool") or sys.exit(f"no tool_info: {data}")
def norm(p):
    # (Windows: a \\?\ path, 8.3 names; macOS: /var is /private/var)
    if p.startswith("\\\\?\\"):
        p = p[4:]
    return os.path.normcase(os.path.realpath(p))
if norm(info["path"]) != norm(tool):
    sys.exit(f"the app runs {info['path']}, not its bundled {tool}")
if data.get("percolatorAdapter") is not True:
    sys.exit("the app finds no PercolatorAdapter beside its OpenNuXL")
if info.get("version") != version:
    sys.exit(f"the app reports version {info.get('version')}, the tool {version}")
if not data.get("page"):
    sys.exit("no page loaded")
if linked == "1" and not str(data.get("tauriResources", "")).startswith("(none"):
    sys.exit(f"started through a link, Tauri still named a resource folder: {data.get('tauriResources')}")
how = " (Tauri named none: the bundle's own Resources)" if linked == "1" else ""
print(f"app: page {data['page']}, OpenNuXL {info['version']} with PercolatorAdapter, inside the package{how}")
PY
}
smoke "$APP_BIN" installed 0
report_installed=$report
report_linked=""
if [ "$platform" = macos ]; then
  ln -s "$app" "$work/Linked.app"
  smoke "$work/Linked.app/Contents/MacOS/$executable" linked 1
  report_linked=$report
fi

summary "### Start test ($platform)"
summary ""
summary "- package: \`$(basename "$PACKAGE")\`"
summary "- bundled OpenNuXL and PercolatorAdapter: \`$version\`"
summary "- command-line search of the example: $psms PSMs, ${seconds} s (${percolator:-no word of Percolator})"
summary "- a folder named \`Größe ü\`: $wide_result"
summary "- app \`--smoke-test\`: \`$report_installed\`"
if [ -n "$report_linked" ]; then summary "- the app through a symbolic link: \`$report_linked\`"; fi
echo "start test passed"
