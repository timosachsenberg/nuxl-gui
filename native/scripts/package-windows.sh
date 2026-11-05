#!/bin/bash
# Builds the app's Windows package, the NSIS installer (x64, per user: no administrator rights), with the
# bundled OpenNuXL in it. Git Bash.
#
#   package-windows.sh        (src-tauri/resources/nuxl has to be filled first: bundle-nuxl.sh)
#
# The installer puts OpenNuXL.exe, PercolatorAdapter.exe and their DLLs (with the Thermo bridge's
# openms_thermo_bridge.dll and nethost.dll) into <install folder>/resources/nuxl/bin, the .NET runtime into
# resources/nuxl/dotnet, as bundle-nuxl.sh laid them out (Windows has no RPATH: the folder of the exe is where its DLLs are looked for first). The
# installer is unsigned (SmartScreen asks the user once), shows the app's licence (LICENSE) and installs the
# third-party notices (resources/notices). start-test.sh installs it and runs it.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
NUXL=$ROOT/src-tauri/resources/nuxl
BUNDLE_DIR=$ROOT/src-tauri/target/release/bundle
die() { echo "error: $*" >&2; exit 1; }
[ -f "$NUXL/bin/OpenNuXL.exe" ] && [ -f "$NUXL/bin/PercolatorAdapter.exe" ] \
  && [ -f "$NUXL/bin/openms_thermo_bridge.dll" ] && [ -f "$NUXL/bin/nethost.dll" ] \
  && [ -n "$(find "$NUXL/dotnet/host/fxr" -name hostfxr.dll 2>/dev/null)" ] \
  && [ -f "$NUXL/share/OpenMS/openms_thermo_bridge/managed/ThermoWrapperManaged.dll" ] && [ -f "$NUXL/build.json" ] \
  || die "src-tauri/resources/nuxl holds no bundled OpenNuXL: run native/scripts/bundle-nuxl.sh <openms-build> src-tauri/resources/nuxl"

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
