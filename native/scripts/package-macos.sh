#!/bin/bash
# Builds the app's macOS packages, NuXL.app and the .dmg (arm64), with the bundled OpenNuXL in them.
#
#   package-macos.sh        (src-tauri/resources/nuxl has to be filled first: bundle-nuxl.sh)
#
# Tauri copies resources/nuxl into NuXL.app/Contents/Resources/resources/nuxl as it is (bundle-nuxl.sh
# has made the dylibs relocatable and ad-hoc signed them). The app is signed ad hoc too
# (tauri.macos.conf.json: signingIdentity "-", no hardened runtime): no Developer ID, no notarization;
# arm64 Macs run no unsigned code, and an ad-hoc signed bundle can be opened after the user's consent
# (System Settings > Privacy & Security > Open Anyway), where an unsigned one counts as damaged.
#
# The app gets the third-party notices (scripts/third-party-notices.mjs, Resources/resources/notices) and the
# font licences (dist/assets); the .dmg no licence agreement (tauri.macos.conf.json: an agreement would stop
# every mount of it for a BSD licence).
#
# Checks: the bundle's minimum macOS (build.json, minimumMacos) is not newer than the app's
# (minimumSystemVersion); the bundle inside the app is the same files, still relocatable and validly
# signed (bundle_closure.py macho-verify), with the Thermo bridge's managed half and the .NET runtime (its dylibs
# validly signed, by Microsoft).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
NUXL=$ROOT/src-tauri/resources/nuxl
BUNDLE_DIR=$ROOT/src-tauri/target/release/bundle
die() { echo "error: $*" >&2; exit 1; }
[ -x "$NUXL/bin/OpenNuXL" ] \
  && [ -d "$NUXL/dotnet/host/fxr" ] && [ -f "$NUXL/build.json" ] \
  || die "src-tauri/resources/nuxl holds no bundled OpenNuXL: run native/scripts/bundle-nuxl.sh <openms-build> src-tauri/resources/nuxl"

python3 -I - "$NUXL/build.json" "$ROOT/src-tauri/tauri.macos.conf.json" <<'PY'
import json, sys
need = json.load(open(sys.argv[1])).get("minimumMacos")
have = json.load(open(sys.argv[2]))["bundle"]["macOS"]["minimumSystemVersion"]
if not need:
    sys.exit("the bundle's build.json names no minimumMacos")
key = lambda v: tuple(int(x) for x in v.split("."))
if key(need) > key(have):
    sys.exit(f"the bundled OpenNuXL needs macOS {need}, the app says {have} (tauri.macos.conf.json)")
print(f"minimum macOS: bundle {need}, app {have}")
PY

cd "$ROOT"
node scripts/third-party-notices.mjs
rm -rf "$BUNDLE_DIR/macos" "$BUNDLE_DIR/dmg"
npx tauri build --bundles app,dmg
for font in Inter Inconsolata LiberationMono; do
  [ -f "dist/assets/$font-LICENSE.txt" ] || die "dist/assets/$font-LICENSE.txt is missing (vite.config.ts, fontLicences)"
done

app=$(find "$BUNDLE_DIR/macos" -maxdepth 1 -name '*.app' | head -n 1)
[ -n "$app" ] || die "no .app in $BUNDLE_DIR/macos"
inside=$app/Contents/Resources/resources/nuxl
for exe in OpenNuXL; do
  [ -x "$inside/bin/$exe" ] || die "$inside/bin/$exe is missing"
done
diff <(cd "$NUXL" && find . -type f | sort) <(cd "$inside" && find . -type f | sort) \
  || die "the app's resources/nuxl is not the bundle"
# the .NET runtime of the .raw reader, as Microsoft signed it (bundle_closure.py re-signs bin/ and lib/ only): arm64
# loads no dylib without a valid signature. And the Thermo bridge's managed half.
dylibs=0
while IFS= read -r dylib; do
  codesign --verify "$dylib" 2>/dev/null || die "$dylib has no valid signature"
  dylibs=$((dylibs + 1))
done < <(find "$inside/dotnet" -type f -name '*.dylib')
[ "$dylibs" -gt 0 ] || die "the app's resources/nuxl/dotnet holds no dylibs (no .NET runtime)"
echo "the app's .NET runtime: $dylibs dylibs, validly signed"
[ -f "$inside/share/OpenMS/openms_thermo_bridge/managed/ThermoWrapperManaged.dll" ] \
  || die "the app has no share/OpenMS/openms_thermo_bridge/managed/ThermoWrapperManaged.dll"
python3 -I "$ROOT/native/scripts/bundle_closure.py" macho-verify "$inside"
[ -s "$app/Contents/Resources/resources/notices/THIRD-PARTY-NOTICES.txt" ] || die "the app has no third-party notices"
codesign --verify --verbose=1 "$app"
codesign --display --verbose=2 "$app" 2>&1 | grep -E '^(Identifier|Signature|Format)' || true

dmg=$(find "$BUNDLE_DIR/dmg" -maxdepth 1 -name '*.dmg' | head -n 1)
[ -n "$dmg" ] || die "no .dmg in $BUNDLE_DIR/dmg"
echo "packages:"
du -sh "$app" "$dmg" "$inside/dotnet"
