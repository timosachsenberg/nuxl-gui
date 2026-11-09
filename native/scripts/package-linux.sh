#!/bin/bash
# Builds the app's Linux packages, the .deb and the AppImage, with the bundled OpenNuXL (and the .NET runtime of
# the .raw reader: bundle-nuxl.sh) in them.
#
#   package-linux.sh        (src-tauri/resources/nuxl has to be filled first: bundle-nuxl.sh)
#
# CI (ubuntu-22.04 and ubuntu-22.04-arm: x64 and arm64, WebKitGTK installed as packages) and the development
# machine (x64, WebKitGTK from the sysroot of in-env.sh, which this script enters by itself when the sysroot
# exists) use the same script.
# PACKAGE_SKIP_BUILD=1 skips `tauri build --no-bundle` (the release binary is up to date).
#
# Both get the third-party notices (scripts/third-party-notices.mjs, into resources/notices) and the font
# licences (dist/assets, vite.config.ts). The .deb is Tauri's, with two changes: its package name is
# `nuxl` (Tauri derives `nu-xl` from the product name and has no setting for it), and its
# /usr/share/doc/nuxl/copyright is the notices' (tauri.conf.json). The AppImage is not Tauri's: linuxdeploy,
# which Tauri's AppImage step runs, treats
# every ELF file in the AppDir as its own, so it would copy the tools' whole library closure a second time
# into usr/lib and rewrite the bundle's DT_RPATH into a RUNPATH, which the AppImage's LD_LIBRARY_PATH
# (usr/lib, with the libraries of WebKit) overrides. So the AppImage is bundled without
# resources/nuxl, which is then copied into the AppDir unchanged, and the AppDir is packed again with
# linuxdeploy's AppImage plugin (from Tauri's tool cache).
#
# On the development machine two more things are needed, because Tauri's AppImage tooling expects GTK
# and WebKitGTK under /usr and here WebKitGTK is the sysroot's:
# - pkg-config answers `--variable` with /usr in place of the sysroot's /usr, so the GTK plugin finds the
#   host's GTK modules, schemas and loaders where it looks for them;
# - WebKit's helper processes (WebKitWebProcess, WebKitNetworkProcess, WebKitGPUProcess, the injected
#   bundle) are copied into the AppDir, where Tauri puts them on a normal system, and the bundled
#   libwebkit2gtk, whose helper directory make-sysroot.sh patched to the sysroot, gets the relative
#   path that the GTK plugin writes on a normal system (././/lib/x86_64-linux-gnu/webkit2gtk-4.1,
#   relative to usr/, the AppImage's working directory).
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SYSROOT=${TAURI_SYSROOT:-/scratch/sachsenb/tools/tauri-sysroot}
if [ -d "$SYSROOT/usr/lib/x86_64-linux-gnu" ] && [ -z "${NUXL_IN_ENV:-}" ]; then
  export NUXL_IN_ENV=1
  exec "$ROOT/native/scripts/in-env.sh" "$ROOT/native/scripts/package-linux.sh" "$@"
fi
BUNDLE_DIR=$ROOT/src-tauri/target/release/bundle
TOOLS=${XDG_CACHE_HOME:-$HOME/.cache}/tauri
NUXL=$ROOT/src-tauri/resources/nuxl

die() { echo "error: $*" >&2; exit 1; }
[ -x "$NUXL/bin/OpenNuXL" ] \
  && [ -d "$NUXL/dotnet/host/fxr" ] && [ -f "$NUXL/build.json" ] \
  || die "src-tauri/resources/nuxl holds no bundled OpenNuXL: run native/scripts/bundle-nuxl.sh <openms-build> src-tauri/resources/nuxl"
sysroot_mode=false
case "$(pkg-config --variable=libdir webkit2gtk-4.1 2>/dev/null)" in
  "$SYSROOT"/*) sysroot_mode=true ;;
esac

cd "$ROOT"
node scripts/third-party-notices.mjs
if [ -z "${PACKAGE_SKIP_BUILD:-}" ]; then
  npx tauri build --no-bundle
fi
for font in Inter Inconsolata LiberationMono; do
  [ -f "dist/assets/$font-LICENSE.txt" ] || die "dist/assets/$font-LICENSE.txt is missing (vite.config.ts, fontLicences)"
done
rm -rf "$BUNDLE_DIR/appimage" "$BUNDLE_DIR/deb"

# --- the .deb ----------------------------------------------------------------------------------------
npx tauri bundle --bundles deb
deb=$(find "$BUNDLE_DIR/deb" -maxdepth 1 -name '*.deb' -type f | head -n 1)
[ -n "$deb" ] || die "no .deb in $BUNDLE_DIR/deb"
# the package name: nuxl (packed again as it was, files owned by root)
debroot=$(mktemp -d)
dpkg-deb -R "$deb" "$debroot/pkg"
sed -i 's/^Package: .*/Package: nuxl/' "$debroot/pkg/DEBIAN/control"
dpkg-deb --root-owner-group -b "$debroot/pkg" "$deb" >/dev/null
rm -rf "$debroot"

# --- the AppImage, without resources/nuxl -------------------------------------------------------------
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
product=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["productName"])' src-tauri/tauri.conf.json)
python3 -I - src-tauri/tauri.conf.json "$work/no-nuxl.json" <<'PY'
import json, sys
resources = json.load(open(sys.argv[1]))["bundle"]["resources"]
kept = [r for r in resources if r.rstrip("/") != "resources/nuxl"]
if len(kept) != len(resources) - 1:
    sys.exit("tauri.conf.json: bundle.resources has no resources/nuxl/ entry")
json.dump({"bundle": {"resources": kept}}, open(sys.argv[2], "w"))
PY
if [ "$sysroot_mode" = true ]; then
  real_pkg_config=$(command -v pkg-config)
  mkdir "$work/bin"
  for name in pkg-config pkgconf; do
    cat > "$work/bin/$name" <<EOF
#!/bin/bash
# (package-linux.sh) the sysroot's pkg-config, with the sysroot's /usr as /usr in --variable answers
for arg in "\$@"; do
  case \$arg in --variable=*) "$real_pkg_config" "\$@" | sed "s|$SYSROOT/usr|/usr|g"; exit "\${PIPESTATUS[0]}" ;; esac
done
exec "$real_pkg_config" "\$@"
EOF
    chmod +x "$work/bin/$name"
  done
  PATH="$work/bin:$PATH" npx tauri bundle --bundles appimage --config "$work/no-nuxl.json"
else
  npx tauri bundle --bundles appimage --config "$work/no-nuxl.json"
fi

appdir=$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -name '*.AppDir' -type d | head -n 1)
appimage=$(find "$BUNDLE_DIR/appimage" -maxdepth 1 -name '*.AppImage' -type f | head -n 1)
[ -n "$appdir" ] && [ -n "$appimage" ] || die "tauri bundle made no AppDir/AppImage in $BUNDLE_DIR/appimage"
resources=$appdir/usr/lib/$product/resources
[ -f "$resources/fasta/crap.fasta" ] || die "the AppDir's resources are not at $resources"
[ ! -e "$resources/nuxl" ] || die "$resources/nuxl is there already: linuxdeploy has seen it"

# --- OpenNuXL into the AppDir, unchanged ------------------------------------------------------------
cp -a "$NUXL" "$resources/nuxl"

if [ "$sysroot_mode" = true ]; then
  helpers=$appdir/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1
  mkdir -p "$helpers"
  cp -a "$SYSROOT/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"/{WebKitWebProcess,WebKitNetworkProcess,WebKitGPUProcess,injected-bundle} "$helpers/"
  webkit=$appdir/usr/lib/libwebkit2gtk-4.1.so.0
  [ -f "$webkit" ] || die "no libwebkit2gtk-4.1.so.0 in $appdir/usr/lib"
  python3 -I - "$webkit" "$(dirname "$SYSROOT")/webkit2gtk-4.1" <<'PY'
import sys
path, link = sys.argv[1], sys.argv[2].encode()
upstream = b"/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1"
sysroot = link + b"/" * (len(upstream) - len(link))   # make-sysroot.sh's patch
appimage = b"././" + upstream[len(b"/usr"):]           # the GTK plugin's sed "s|/usr|././|g"
data = open(path, "rb").read()
count = data.count(sysroot)
if count == 0:
    sys.exit(f"{path}: the sysroot's helper directory {sysroot.decode()} is not in it")
open(path, "wb").write(data.replace(sysroot, appimage))
print(f"WebKit helper directory in {path}: {sysroot.decode()} -> {appimage.decode()} ({count}x)")
PY
fi

# --- pack the AppDir again ----------------------------------------------------------------------------
plugin=$TOOLS/linuxdeploy-plugin-appimage.AppImage
[ -x "$plugin" ] || die "$plugin is missing (tauri bundle downloads it)"
rm -f "$appimage"
# (ARCH: the AppImage runtime's architecture, x86_64 or aarch64, as Tauri's own AppImage step sets it)
(cd "$BUNDLE_DIR/appimage" && APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$(uname -m)" LDAI_OUTPUT="$appimage" OUTPUT="$appimage" \
  "$plugin" --appimage-extract-and-run --appdir "$appdir")
[ -f "$appimage" ] || die "the AppImage plugin wrote no $appimage"
chmod +x "$appimage"

# --- checks -------------------------------------------------------------------------------------------
mkdir "$work/deb"
dpkg-deb -x "$deb" "$work/deb"
[ "$(dpkg-deb -f "$deb" Package)" = nuxl ] || die "the .deb's package name is $(dpkg-deb -f "$deb" Package), not nuxl"
grep -q '^License: BSD-3-Clause' "$work/deb/usr/share/doc/nuxl/copyright" \
  || die "the .deb has no /usr/share/doc/nuxl/copyright with the app's licence"
for notices in "$resources/notices/THIRD-PARTY-NOTICES.txt" "$work/deb/usr/lib/$product/resources/notices/THIRD-PARTY-NOTICES.txt"; do
  [ -s "$notices" ] || die "$notices is missing"
done
[ -f "$resources/nuxl/share/OpenMS/NUXL/nuxl_presets.json" ] || die "OpenNuXL's presets are missing"
for nuxl in "$resources/nuxl" "$work/deb/usr/lib/$product/resources/nuxl"; do
  for exe in "$nuxl/bin/OpenNuXL"; do
    [ -x "$exe" ] || die "$exe is missing or not executable"
    readelf -d "$exe" | grep -q 'RPATH.*\[\$ORIGIN/\.\./lib\]' || die "$exe lost its RPATH \$ORIGIN/../lib"
  done
  # the .raw reader: the Thermo bridge's managed half and the .NET runtime that hosts it, the runtime's files as
  # bundled (the AppImage gets them after linuxdeploy ran; the .deb as Tauri copied them)
  [ -f "$nuxl/share/OpenMS/openms_thermo_bridge/managed/ThermoWrapperManaged.dll" ] \
    || die "$nuxl has no share/OpenMS/openms_thermo_bridge/managed/ThermoWrapperManaged.dll"
  diff <(cd "$NUXL/dotnet" && find . -type f -exec cksum {} + | sort) <(cd "$nuxl/dotnet" && find . -type f -exec cksum {} + | sort) >/dev/null \
    || die "$nuxl/dotnet is not the bundle's .NET runtime"
done
# glibc is the system's (bundle-nuxl.sh's exclude list): neither its loader (ld-linux-x86-64.so.2,
# ld-linux-aarch64.so.1) nor libc may be in the bundle
glibc=$(find "$resources/nuxl/lib" \( -name 'ld-linux*' -o -name 'libc.so*' -o -name 'libm.so*' -o -name 'libpthread.so*' \) -printf '%f ')
[ -z "$glibc" ] || die "the bundled OpenNuXL holds glibc's libraries: $glibc"
deployed=$(find "$appdir/usr/lib" -maxdepth 1 \( -name 'libOpenMS.so*' -o -name 'libarrow.so*' -o -name 'libgomp.so*' \) -printf '%f ')
[ -z "$deployed" ] || die "deployed into the AppDir's usr/lib: $deployed(the tools' closure belongs to resources/nuxl)"

echo
echo "packages:"
for f in "$appimage" "$deb"; do
  echo "  $(du -h "$f" | cut -f1)	$(basename "$f")"
done
echo "  $(du -sh "$appdir" | cut -f1)	AppDir (unpacked AppImage), of which $(du -sh "$resources/nuxl" | cut -f1) OpenNuXL ($(du -sh "$resources/nuxl/dotnet" | cut -f1) of it the .NET runtime)"
echo "  $(dpkg-deb -f "$deb" Installed-Size) KiB	installed size of the .deb $(dpkg-deb -f "$deb" Package) ($(dpkg-deb -f "$deb" Depends))"
