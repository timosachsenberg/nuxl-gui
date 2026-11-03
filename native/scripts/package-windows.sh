#!/bin/bash
# Builds the app's Windows package, the NSIS installer (x64, per user: no administrator rights), with the
# bundled ProSE in it. Git Bash.
#
#   package-windows.sh        (src-tauri/resources/prose has to be filled first: bundle-prose.sh)
#
# The installer puts ProSE.exe and its DLLs into <install folder>/resources/prose/bin, as bundle-prose.sh
# laid them out (Windows has no RPATH: the folder of the exe is where its DLLs are looked for first). The
# installer is unsigned (SmartScreen asks the user once), shows the app's licence (LICENSE) and installs the
# third-party notices (resources/notices). start-test.sh installs it and runs it.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PROSE=$ROOT/src-tauri/resources/prose
BUNDLE_DIR=$ROOT/src-tauri/target/release/bundle
die() { echo "error: $*" >&2; exit 1; }
[ -f "$PROSE/bin/ProSE.exe" ] && [ -f "$PROSE/build.json" ] \
  || die "src-tauri/resources/prose holds no bundled ProSE: run native/scripts/bundle-prose.sh <openms-build> src-tauri/resources/prose"

cd "$ROOT"
node scripts/third-party-notices.mjs
rm -rf "$BUNDLE_DIR/nsis"
npx tauri build --bundles nsis
for font in Inter Inconsolata LiberationMono; do
  [ -f "dist/assets/$font-LICENSE.txt" ] || die "dist/assets/$font-LICENSE.txt is missing (vite.config.ts, fontLicences)"
done

setup=$(find "$BUNDLE_DIR/nsis" -maxdepth 1 -name '*-setup.exe' | head -n 1)
[ -n "$setup" ] || die "no installer in $BUNDLE_DIR/nsis"
echo "package:"
du -sh "$setup"
