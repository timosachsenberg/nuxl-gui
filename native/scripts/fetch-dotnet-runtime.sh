#!/bin/bash
# Puts a .NET runtime (Microsoft.NETCore.App, xcopy layout) into the bundle, for OpenMS's Thermo .raw reader:
# the openms-thermo-bridge library hosts the managed half (ThermoWrapperManaged.dll and Thermo's RawFileReader
# assemblies, share/OpenMS/openms_thermo_bridge/managed) in the tool's own process through nethost and hostfxr,
# which find the runtime through DOTNET_ROOT (the app sets it to <bundle>/dotnet, src-tauri/src/tool.rs). Only
# .raw inputs load it; mzML and Bruker .d inputs never do.
#
#   fetch-dotnet-runtime.sh <bundle>        (normally src-tauri/resources/nuxl; bundle-nuxl.sh calls it)
#
# Writes
#   <bundle>/dotnet/                          the runtime archive as Microsoft publishes it: the dotnet muxer,
#                                             host/fxr/<version>/, shared/Microsoft.NETCore.App/<version>/,
#                                             LICENSE.txt, ThirdPartyNotices.txt
#   <bundle>/share/OpenMS/LICENSES/dotnet/    the runtime's LICENSE.txt and ThirdPartyNotices.txt
# and prints the version on its last line. <bundle>/dotnet is replaced. Its files stay as Microsoft built and
# signed them: it is outside bin/ and lib/, which bundle-nuxl.sh strips, patches and (macOS) re-signs.
#
# The runtime is .NET 10 (LTS, supported until November 2028). The bridge's managed half targets net8.0, whose
# support ends in November 2026; it runs on 10 because the bundle's runtimeconfig.json says rollForward Major
# (bundle-nuxl.sh patches it) and the app sets DOTNET_ROLL_FORWARD=Major for the tools.
#
# The version and the SHA-512 of each archive are pinned below, from Microsoft's release metadata
# (https://builds.dotnet.microsoft.com/dotnet/release-metadata/10.0/releases.json, the same as
# https://github.com/dotnet/core/blob/main/release-notes/10.0/releases.json: "runtime" > "files", the
# dotnet-runtime-<rid> archives). A newer patch release: change DOTNET_VERSION and the four hashes together; the
# script's hash is part of CI's bundle cache key, so the next run bundles it.
#
# The platform is the machine's (uname); DOTNET_RID overrides it (linux-x64, linux-arm64, osx-arm64, win-x64).
# DOTNET_RUNTIME_ARCHIVE=<file> takes the archive from a file instead of downloading it (it is checked against the
# same hash). Needs curl (unless DOTNET_RUNTIME_ARCHIVE is given) and python3 (Windows: python).
set -euo pipefail

DOTNET_VERSION=10.0.14

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <bundle>" >&2
  exit 2
fi
die() { echo "error: $*" >&2; exit 1; }
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
PY=python3
"$PY" -c '' 2>/dev/null || PY=python
mkdir -p "$1"
OUT=$(native "$(cd "$1" && pwd -P)")

if [ -z "${DOTNET_RID:-}" ]; then
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=osx ;;
    MINGW* | MSYS* | CYGWIN*) os=win ;;
    *) die "no .NET runtime for $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) die "no .NET runtime for the machine $(uname -m)" ;;
  esac
  DOTNET_RID=$os-$arch
fi
case $DOTNET_RID in
  linux-x64) sha512=634326028645f38731c8c4e71a68356e4ca0d6b6607139a234ab760687f742063edaf33a1f20dda615742d2dc8300ca2ff857619d51fbb38090383b71334af89 ;;
  linux-arm64) sha512=99e1d6eb5d3de935853404fd378c77cbf813bd3ae094837b5a589000a492c289bf0d01d8a6bff99b4470572d9f85dc0b41239b5b7801e031197b83d527cdfeb2 ;;
  osx-arm64) sha512=19c5781dc2f87600865886b8774a4c5851caf1f5cf3f591185b922b0e51dea6b8c0ed0bf80ae4d3be2e083db662124258743e779fab6885322d641eff52b0382 ;;
  win-x64) sha512=a176095f1db69b42c81acc60940744078d6bf2d2ac643e418342aa9c81889f4bd13e42f4621b131f9e77e4bc781ad46e375956219df9a4f979031d2a5a8d93cd ;;
  *) die "no pinned .NET runtime for $DOTNET_RID (one of linux-x64, linux-arm64, osx-arm64, win-x64)" ;;
esac
case $DOTNET_RID in
  win-*) ext=zip ;;
  *) ext=tar.gz ;;
esac
name=dotnet-runtime-$DOTNET_VERSION-$DOTNET_RID.$ext
url=https://builds.dotnet.microsoft.com/dotnet/Runtime/$DOTNET_VERSION/$name

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
if [ -n "${DOTNET_RUNTIME_ARCHIVE:-}" ]; then
  [ -f "$DOTNET_RUNTIME_ARCHIVE" ] || die "DOTNET_RUNTIME_ARCHIVE: no file $DOTNET_RUNTIME_ARCHIVE"
  archive=$DOTNET_RUNTIME_ARCHIVE
else
  archive=$work/$name
  echo "downloading $url"
  curl --fail --location --proto '=https' --proto-redir '=https' --silent --show-error \
    --retry 8 --retry-delay 5 --retry-all-errors --connect-timeout 30 --max-time 900 \
    --output "$archive" "$url" || die "could not download $url"
fi

# Checked, then unpacked into a fresh folder and only then put in place: an interrupted run leaves no half runtime.
# (Python for both formats: Git Bash on Windows need not have unzip, macOS has no sha512sum.)
dest=$OUT/dotnet
rm -rf "$dest.new"
"$PY" -I - "$(native "$archive")" "$sha512" "$dest.new" <<'PY'
import hashlib, sys, tarfile, zipfile
archive, want, dest = sys.argv[1:]
h = hashlib.sha512()
with open(archive, "rb") as f:
    for block in iter(lambda: f.read(1 << 20), b""):
        h.update(block)
if h.hexdigest() != want:
    sys.exit(f"error: SHA-512 mismatch for {archive}:\n  expected {want}\n  actual   {h.hexdigest()}")
if archive.endswith(".zip"):
    with zipfile.ZipFile(archive) as z:
        for member in z.namelist():
            if member.startswith(("/", "\\")) or ".." in member.replace("\\", "/").split("/"):
                sys.exit(f"error: {archive}: unsafe member {member}")
        z.extractall(dest)
else:
    with tarfile.open(archive, "r:gz") as t:
        members = t.getmembers()
        for m in members:
            if m.name.startswith("/") or ".." in m.name.split("/") or not (m.isfile() or m.isdir() or m.issym()):
                sys.exit(f"error: {archive}: unsafe member {m.name}")
        # (filter "data" where Python has it: no absolute paths, devices or links out of the folder)
        if hasattr(tarfile, "data_filter"):
            t.extractall(dest, members, filter="data")
        else:
            t.extractall(dest, members)
PY

# Tauri copies the bundle's regular files only, and the package checks compare files: a symbolic link (none
# in the archives so far) becomes a copy of what it points to.
while IFS= read -r link; do
  [ -n "$link" ] || continue
  [ -f "$link" ] || die "$link: a symbolic link to no regular file in the runtime archive"
  cp -L "$link" "$link.copy"
  rm "$link"
  mv "$link.copy" "$link"
done < <(find "$dest.new" -type l)

# the layout nethost and hostfxr look for below DOTNET_ROOT
fxr=$dest.new/host/fxr/$DOTNET_VERSION
case $DOTNET_RID in
  linux-*) hostfxr=$fxr/libhostfxr.so ;;
  osx-*) hostfxr=$fxr/libhostfxr.dylib ;;
  win-*) hostfxr=$fxr/hostfxr.dll ;;
esac
[ -f "$hostfxr" ] || die "$name has no ${hostfxr#"$dest.new/"}"
[ -f "$dest.new/shared/Microsoft.NETCore.App/$DOTNET_VERSION/System.Private.CoreLib.dll" ] \
  || die "$name has no shared/Microsoft.NETCore.App/$DOTNET_VERSION"
licence=$(find "$dest.new" -maxdepth 1 -type f -iname 'LICENSE.txt' | head -n 1)
notices=$(find "$dest.new" -maxdepth 1 -type f -iname 'ThirdPartyNotices.txt' | head -n 1)
[ -n "$licence" ] && [ -n "$notices" ] || die "$name has no LICENSE.txt or ThirdPartyNotices.txt"

rm -rf "$dest"
mv "$dest.new" "$dest"
lic=$OUT/share/OpenMS/LICENSES/dotnet
mkdir -p "$lic"
cp "$dest/$(basename "$licence")" "$lic/LICENSE.txt"
cp "$dest/$(basename "$notices")" "$lic/ThirdPartyNotices.txt"
echo "  .NET runtime $DOTNET_VERSION ($DOTNET_RID) in $dest: $(du -sh "$dest" | cut -f1)"
echo "$DOTNET_VERSION"
