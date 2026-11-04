#!/bin/bash
# Bundles OpenNuXL for the desktop app (Linux, macOS, Windows): the OpenNuXL executable, PercolatorAdapter
# (which OpenNuXL runs for its score recalibration and looks for beside itself, File::findSiblingTOPPExecutable)
# and FileConverter (the app converts the spectra of a Thermo .raw or Bruker .d input to mzML with it, for its PSM
# view), their shared-library closure, the OpenMS share/ data they read, the managed half of the Thermo .raw reader
# and a .NET runtime to host it (fetch-dotnet-runtime.sh), the licences, plus a build manifest.
#
#   bundle-nuxl.sh <openms-build> <out>
#
# <openms-build> is a build directory made by build-openms.sh; <out> is normally
# src-tauri/resources/nuxl (tauri.conf.json bundles that folder). <out> is emptied first. The layout:
#
#   Linux    bin/OpenNuXL, bin/PercolatorAdapter, bin/FileConverter     RPATH $ORIGIN/../lib
#            lib/*.so*                the closure of the tools (with libopenms_thermo_bridge.so), RPATH $ORIGIN;
#                                     system libraries left out (below)
#   macOS    bin/OpenNuXL, bin/PercolatorAdapter, bin/FileConverter     LC_RPATH @loader_path/../lib, ad-hoc signed
#            lib/*.dylib              the closure (one libomp, libopenms_thermo_bridge.dylib), ids and references
#                                     @rpath/<name>, LC_RPATH @loader_path, ad-hoc signed; /usr/lib and /System
#                                     left out
#   Windows  bin/OpenNuXL.exe, bin/PercolatorAdapter.exe, bin/FileConverter.exe, bin/*.dll
#                                     the closure beside the exes (Windows has no RPATH; the exe's folder
#                                     is searched first), with the Visual C++ runtime and vcomp140 (the one
#                                     OpenMP runtime), openms_thermo_bridge.dll and the nethost.dll it imports
#                                     (from the .NET SDK's host pack the build used); the DLLs of Windows left out
#   share/OpenMS/{CHEMISTRY,CV,MAPPING,SCHEMAS,TOOLS}
#   share/OpenMS/NUXL/nuxl_presets.json  the cross-linking protocols of NuXL:presets
#   share/OpenMS/openms_thermo_bridge/managed/
#                                     the bridge's managed half (ThermoWrapperManaged.dll, Thermo's RawFileReader
#                                     assemblies), its runtimeconfig.json set to rollForward Major
#   dotnet/                           the .NET runtime (fetch-dotnet-runtime.sh), as Microsoft ships it: never
#                                     stripped, patched or re-signed (it is outside bin/ and lib/)
#   share/OpenMS/LICENSES/...         OpenMS, its vendored code, the vcpkg ports, the bundled system libraries,
#                                     Thermo's RawFileReader licence, the bridge's notices, the .NET runtime's
#   build.json                        the manifest: the tools, the OpenMS commit, the triplet, the .NET runtime
#
# Runs on the host toolchain (outside in-env.sh; LD_LIBRARY_PATH is ignored for the closure). Needs
# python3 and, on Linux, patchelf, strip, ldd and dpkg (for the copyright files of the bundled system
# libraries); on macOS otool, install_name_tool, strip, codesign (Xcode's command line tools) and
# Homebrew's libomp; on Windows Git Bash in a Visual Studio developer environment (VCToolsRedistDir, for
# the Visual C++ runtime). The closure on macOS and Windows is bundle_closure.py's. The build has to read Thermo
# .raw (WITH_THERMO_RAW) and Bruker .d (WITH_OPENTIMS) itself, as build-openms.sh configures it: the script checks
# that the tools do. The .NET runtime is downloaded (curl, fetch-dotnet-runtime.sh, which also takes
# DOTNET_RUNTIME_ARCHIVE). Environment: ALLOW_PIN_MISMATCH=1 bundles a build whose source is not at
# native/OPENMS_COMMIT.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <openms-build> <out>" >&2
  exit 2
fi
case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=macos ;;
  MINGW* | MSYS* | CYGWIN*) PLATFORM=windows ;;
  *) echo "error: $(uname -s) is not a platform of the app" >&2; exit 1 ;;
esac
# absolute paths; on Windows in the D:/x form that native programs (python, the OpenMS paths) take
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
[ -d "$1" ] || { echo "error: $1 is not a folder" >&2; exit 1; }
mkdir -p "$2"
BUILD=$(native "$(cd "$1" && pwd -P)")
OUT=$(native "$(cd "$2" && pwd -P)")
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CACHE=$BUILD/CMakeCache.txt
SUFFIX=
[ "$PLATFORM" = windows ] && SUFFIX=.exe
# the tools, OpenNuXL first; PercolatorAdapter has to be beside it; FileConverter writes the spectra of a .raw or
# .d input as mzML for the PSM view (src-tauri/src/run.rs)
TOOL_NAMES=(OpenNuXL PercolatorAdapter FileConverter)
EXES=()
for name in "${TOOL_NAMES[@]}"; do EXES+=("$BUILD/bin/$name$SUFFIX"); done
# (Windows has python, not always python3)
PY=python3
"$PY" -c '' 2>/dev/null || PY=python

die() { echo "error: $*" >&2; exit 1; }
[ -f "$CACHE" ] || die "$BUILD is not a CMake build directory (no CMakeCache.txt)"
for exe in "${EXES[@]}"; do
  [ -x "$exe" ] || die "$exe is missing (build the targets ${TOOL_NAMES[*]})"
done
case $PLATFORM in
  linux) tools=(patchelf strip ldd) ;;
  macos) tools=(otool install_name_tool strip codesign) ;;
  windows) tools=() ;;
esac
for tool in ${tools[@]+"${tools[@]}"} "$PY"; do
  command -v "$tool" >/dev/null || die "$tool is needed"
done

cache_value() { sed -n "s/^$1:[A-Z]*=//p" "$CACHE" | head -n 1; }
SRC=$(cache_value CMAKE_HOME_DIRECTORY)
TRIPLET=$(cache_value VCPKG_TARGET_TRIPLET)
[ -f "$SRC/share/OpenMS/CHEMISTRY/unimod.xml" ] || die "no OpenMS sources at '$SRC' (CMAKE_HOME_DIRECTORY)"
[ -f "$SRC/share/OpenMS/NUXL/nuxl_presets.json" ] || die "no NUXL presets in '$SRC/share/OpenMS' (an OpenMS without OpenNuXL?)"

# Thermo .raw and Bruker .d: the app offers both inputs, so a build without either is refused here rather than
# shipped (OpenNuXL would otherwise fall back to ThermoRawFileParser for .raw, which the app does not bundle).
for option in WITH_THERMO_RAW WITH_OPENTIMS; do
  [ "$(cache_value "$option")" = ON ] || die "the build has $option=$(cache_value "$option"), not ON (build-openms.sh sets it)"
done
# the managed half of the Thermo bridge, as the build published it (FetchContent: below _deps; the vcpkg port:
# below vcpkg_installed); OpenMS's install() copies it to share/OpenMS/openms_thermo_bridge/managed, as here
MANAGED=$(cache_value OpenMSThermoBridge_MANAGED_DIR)
[ -n "$MANAGED" ] || die "no OpenMSThermoBridge_MANAGED_DIR in $CACHE (a build without the Thermo bridge?)"
[ -f "$MANAGED/ThermoWrapperManaged.dll" ] && [ -f "$MANAGED/ThermoWrapperManaged.runtimeconfig.json" ] \
  || die "the Thermo bridge's managed folder $MANAGED has no ThermoWrapperManaged.dll and .runtimeconfig.json (build the OpenMS target first)"

# The folders of nethost, the .NET hosting library the Thermo bridge links (on Windows as nethost.dll, which the
# build tree does not have: OpenMS copies it only when installing): the .NET SDK's host pack the build found,
# named in the CMake cache, else the host packs of the SDK on PATH or in DOTNET_ROOT.
nethost_dirs=()
add_nethost_dir() {
  local d=$1
  [ -d "$d" ] || return 0
  case " ${nethost_dirs[*]+${nethost_dirs[*]}} " in *" $d "*) return 0 ;; esac
  nethost_dirs+=("$d")
}
while IFS= read -r value; do
  if [ -f "$value" ]; then add_nethost_dir "$(dirname "$value")"; else add_nethost_dir "$value"; fi
done < <(sed -n 's/^[^/:][^:]*:[A-Z]*=\(.*Microsoft\.NETCore\.App\.Host\..*\)$/\1/p' "$CACHE")
# (as a Unix path for the glob: Windows' C:\Program Files\dotnet has backslashes, which a glob takes as escapes)
posix() { if command -v cygpath >/dev/null; then cygpath -u "$1"; else printf '%s\n' "$1"; fi; }
dotnet_exe=$(command -v dotnet 2>/dev/null || true)
for root in ${DOTNET_ROOT:+"$DOTNET_ROOT"} ${dotnet_exe:+"$(dirname "$dotnet_exe")"}; do
  root=$(posix "$root")
  for d in "$root"/packs/Microsoft.NETCore.App.Host.*/*/runtimes/*/native; do
    if [ -d "$d" ]; then add_nethost_dir "$(native "$d")"; fi
  done
done
nethost_search=()
for d in ${nethost_dirs[@]+"${nethost_dirs[@]}"}; do nethost_search+=(--search "$d"); done

COMMIT=$(git -C "$SRC" rev-parse HEAD)
PIN_FILE=$HERE/../OPENMS_COMMIT
if [ -f "$PIN_FILE" ] && [ "$(tr -d '[:space:]' < "$PIN_FILE")" != "$COMMIT" ]; then
  msg="the OpenMS source is at $COMMIT, native/OPENMS_COMMIT names $(tr -d '[:space:]' < "$PIN_FILE")"
  [ "${ALLOW_PIN_MISMATCH:-}" = 1 ] || die "$msg (ALLOW_PIN_MISMATCH=1 bundles it anyway)"
  echo "warning: $msg" >&2
fi

# --- The system libraries left out of the closure ------------------------------------------------
# glibc only: every Linux has its own, and a bundled one cannot be loaded beside the system's loader (the
# release build is made on ubuntu-22.04, so it needs glibc 2.35, which every Ubuntu 22.04+ has).
# Everything else is bundled, including
# - the GCC runtime (libstdc++, libgcc_s): OpenMS needs GCC 13 (C++23), newer than Ubuntu 22.04's own
#   runtime (GCC 12), and the tools run in processes of their own, so their libstdc++ cannot clash with the app's;
# - libgomp, one OpenMP runtime, the one the build linked.
EXCLUDE='^(linux-vdso\.so\.1|ld-linux-x86-64\.so\.2|libc\.so\.6|libm\.so\.6|libmvec\.so\.1|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|libutil\.so\.1|libresolv\.so\.2|libanl\.so\.1|libnsl\.so\.1|libnss_[a-z]+\.so\.2|libBrokenLocale\.so\.1|libthread_db\.so\.1)$'
OPENMP='^lib(gomp|omp|iomp5|omp5)\.so'

closure_linux() {

  # --- The executables and their closure ------------------------------------------------------------
  # ldd lists the whole closure (transitively) as the build's RUNPATH resolves it; the tools share most of it
  # (libOpenMS), each library is bundled once.
  local exe closure seen=" "
  for exe in "${EXES[@]}"; do
    closure=$(env -u LD_LIBRARY_PATH -u LD_PRELOAD ldd "$exe")
    if grep -q 'not found' <<<"$closure"; then
      die "unresolved libraries of $exe:"$'\n'"$(grep 'not found' <<<"$closure")"
    fi
    while read -r name arrow path _; do
      [ "$arrow" = "=>" ] || continue
      case $seen in *" $name "*) continue ;; esac
      seen="$seen$name "
      if [[ $name =~ $EXCLUDE ]]; then
        excluded+=("$name")
        continue
      fi
      [[ $name =~ $OPENMP ]] && omp+=("$name")
      cp -L "$path" "$OUT/lib/$name"
      case $path in /lib/* | /usr/lib/*) system_libs+=("$path") ;; esac
    done <<<"$closure"
    cp "$exe" "$OUT/bin/$(basename "$exe")"
  done
  [ "${#omp[@]}" -eq 1 ] && [ "${omp[0]}" = libgomp.so.1 ] \
    || die "expected exactly one OpenMP runtime, libgomp.so.1; the closure has: ${omp[*]:-none}"
  chmod 0755 "$OUT"/bin/*
  chmod 0644 "$OUT"/lib/*

  # Symbol tables are not needed at run time; strip before patchelf (strip can undo patchelf's layout).
  strip --strip-unneeded "$OUT"/bin/* "$OUT"/lib/*

  # DT_RPATH (not RUNPATH): it is searched before LD_LIBRARY_PATH, so a library path set around the app
  # (the AppImage runtime, a user's environment) cannot swap in a different libarrow or libOpenMS.
  for exe in "$OUT"/bin/*; do
    patchelf --force-rpath --set-rpath '$ORIGIN/../lib' "$exe"
  done
  for lib in "$OUT"/lib/*; do
    patchelf --force-rpath --set-rpath '$ORIGIN' "$lib"
  done

  # --- The compiled-in install path -----------------------------------------------------------------
  # OpenMS looks for share/OpenMS at paths compiled into it before it looks next to the executable
  # (bin/../share/OpenMS, the bundle's), and the OPENMS_DATA_PATH variable comes last of all (File.cpp,
  # resolveOpenMSDataPath_). So setting the variable cannot steer a bundled tool; what has to be ruled out is
  # that one of the compiled-in paths exists on the user's machine:
  # - the install prefix (OPENMS_INSTALL_DATA_PATH, /usr/local/share/OpenMS): a user may well have an
  #   OpenMS of another version installed there. The bundle's copy of that string is overwritten in place
  #   with a path of the same length that cannot exist ("/dev/null////..."), as relocating packagers
  #   (conda) rewrite the prefix; OpenMS reads it through a volatile pointer for exactly this reason
  #   (installPath_), so the string in .rodata is the one used.
  # - the source and build tree (OPENMS_DATA_PATH, OPENMS_BINARY_PATH, the tool registry): paths of the build machine (in CI below /home/runner/work), which do not exist on a
  #   user's machine. GCC writes these strings into the code as immediates, so they cannot be patched;
  #   smoke-appimage.sh --hide-openms hides them on the build machine to test the bundle as a user's
  #   machine sees it.
  "$PY" -I - "$OUT/lib/libOpenMS.so" "$install_data_path" <<'PY'
import sys
path, old = sys.argv[1], sys.argv[2].encode()
if len(old) < len(b"/dev/null"):
    sys.exit(f"the install path {old!r} is shorter than /dev/null")
new = b"/dev/null" + b"/" * (len(old) - len(b"/dev/null"))
data = open(path, "rb").read()
# a whole C string: the path and its terminating NUL
count = data.count(b"\0" + old + b"\0")
if count != 1:
    sys.exit(f"{path}: expected the install path {old.decode()} once as a string of its own, found it {count} times")
data = data.replace(b"\0" + old + b"\0", b"\0" + new + b"\0")
if old in data:
    sys.exit(f"{path} still holds {old.decode()}")
open(path, "wb").write(data)
print(f"  compiled-in install path {old.decode()} overwritten in lib/libOpenMS.so")
PY
}

# --- macOS: bundle_closure.py (Mach-O) -----------------------------------------------------------
# Homebrew's libomp is the one OpenMP runtime (Apple's clang has none); vcpkg's dylibs and OpenMS's carry
# @rpath ids, resolved through the build's LC_RPATHs (nethost, should the bridge load it as a dylib, from the
# host pack's folder by name).
closure_macos() {
  "$PY" -I "$HERE/bundle_closure.py" macho "${EXES[@]}" "$OUT" \
    --search "$BUILD/lib" --search "$BUILD/vcpkg_installed/$TRIPLET/lib" ${nethost_search[@]+"${nethost_search[@]}"} \
    --install-path "$install_data_path"
  omp=(libomp.dylib)
  local keg
  keg=$(cache_value OpenMP_ROOT)
  [ -n "$keg" ] || keg=$(brew --prefix libomp 2>/dev/null || true)
  system_libs=("${keg:-/opt/homebrew/opt/libomp}/lib/libomp.dylib")
}

# --- Windows: bundle_closure.py (PE) ------------------------------------------------------------------
# OpenMS links its vcpkg dependencies statically (x64-windows-static-md-release, as OpenMS's own CI), so
# the closure is OpenMS's DLLs, the Visual C++ runtime and vcomp140 (MSVC's OpenMP), taken app-locally
# from the redistributable folders of the Visual Studio that built it; openms_thermo_bridge.dll is in the
# build's bin, the nethost.dll it imports in the .NET SDK's host pack (nethost_search).
closure_windows() {
  [ -n "${VCToolsRedistDir:-}" ] || die "VCToolsRedistDir is not set: run in a Visual Studio developer environment"
  local redist=() d root
  root=$(native "$VCToolsRedistDir")
  for d in "$root"/x64/Microsoft.VC*.CRT "$root"/x64/Microsoft.VC*.OpenMP; do
    [ -d "$d" ] && redist+=(--redist "$d")
  done
  [ "${#redist[@]}" -gt 0 ] || die "no x64 runtime folders in $root"
  "$PY" -I "$HERE/bundle_closure.py" pe "${EXES[@]}" "$OUT" \
    --search "$BUILD/bin" --search "$BUILD/vcpkg_installed/$TRIPLET/bin" ${nethost_search[@]+"${nethost_search[@]}"} \
    "${redist[@]}" --install-path "$install_data_path"
  rmdir "$OUT/lib"
  omp=(vcomp140.dll)
}

header=$BUILD/src/openms/include/OpenMS/openms_data_path.h
[ -f "$header" ] || die "$header is missing"
install_data_path=$(sed -n 's/^#define OPENMS_INSTALL_DATA_PATH "\(.*\)"$/\1/p' "$header")
[ -n "$install_data_path" ] || die "no OPENMS_INSTALL_DATA_PATH in $header"

rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib" "$OUT/share/OpenMS"
excluded=()
omp=()
system_libs=()
"closure_$PLATFORM"

# The Thermo bridge came with the closure (libOpenMS links it), and on Windows the nethost.dll it imports: without
# them a .raw input would fail only when a user searches one.
case $PLATFORM in
  linux) bridge=("$OUT"/lib/libopenms_thermo_bridge.so*) ;;
  macos) bridge=("$OUT"/lib/libopenms_thermo_bridge*.dylib) ;;
  windows) bridge=("$OUT/bin/openms_thermo_bridge.dll" "$OUT/bin/nethost.dll") ;;
esac
for f in "${bridge[@]}"; do
  [ -f "$f" ] || die "the closure has no ${f#"$OUT/"} (the Thermo bridge; nethost from: ${nethost_dirs[*]:-no .NET host pack found})"
done

# --- share/OpenMS ---------------------------------------------------------------------------------
# What the tools read: CHEMISTRY (unimod, enzymes, modifications, PSI-MOD, the elements and residues of the
# nucleotide adducts), CV (psi-ms and the obo files it imports), MAPPING (ms-mapping.xml), the TOOLS registry;
# SCHEMAS for the mzML and idXML readers and writers; NUXL, the presets of NuXL:presets, which OpenNuXL reads
# when it registers its options (also for --help). The metabolomics HMDB tables (49 MB) and the examples are left
# out (the set ProSE desktop's bundle had, checked with strace there, and NUXL).
share=$OUT/share/OpenMS
cp -r "$SRC/share/OpenMS/CHEMISTRY" "$SRC/share/OpenMS/CV" "$SRC/share/OpenMS/MAPPING" \
  "$SRC/share/OpenMS/SCHEMAS" "$SRC/share/OpenMS/NUXL" "$share/"
rm -f "$share"/CHEMISTRY/HMDB*
cp -r "$BUILD/share/OpenMS/TOOLS" "$share/"
# The Thermo bridge's managed half, where OpenMS looks for it after OPENMS_THERMO_MANAGED_DIR (which the app
# sets to this folder: on a build machine OpenMS's data path is the source tree's share/OpenMS, which has none):
# the platform-independent assemblies, without the debug symbols and the zip they may come with (as OpenMS's own
# install). Never below bin/ or lib/, whose every file is stripped and patched above.
managed=$share/openms_thermo_bridge/managed
mkdir -p "$managed"
cp -r "$MANAGED"/. "$managed/"
find "$managed" -type f \( -name '*.pdb' -o -name '*.zip' \) -exec rm -f {} +
# The assemblies target net8.0; the bundled runtime is .NET 10 (fetch-dotnet-runtime.sh: .NET 8's support ends in
# November 2026), so the runtimeconfig.json lets them roll forward to a newer major version (the app also sets
# DOTNET_ROLL_FORWARD=Major for the tools, src-tauri/src/tool.rs; either is enough, each covers the other).
"$PY" -I - "$managed" <<'PY'
import json, pathlib, sys
configs = sorted(pathlib.Path(sys.argv[1]).glob("*.runtimeconfig.json"))
if not configs:
    sys.exit(f"error: no *.runtimeconfig.json in {sys.argv[1]}")
for path in configs:
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    options = config.setdefault("runtimeOptions", {})
    options["rollForward"] = "Major"
    path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    framework = options.get("framework") or (options.get("frameworks") or [{}])[0]
    print(f"  {path.name}: {framework.get('name')} {framework.get('version')}, rollForward Major")
PY

# --- dotnet/: the .NET runtime that hosts it ----------------------------------------------------------
"$HERE/fetch-dotnet-runtime.sh" "$OUT"
dotnet_version=$(ls "$OUT/dotnet/shared/Microsoft.NETCore.App")
[ "$(wc -w <<<"$dotnet_version")" -eq 1 ] || die "expected one runtime in $OUT/dotnet/shared/Microsoft.NETCore.App, found: $dotnet_version"

# --- Licences -------------------------------------------------------------------------------------
lic=$share/LICENSES
mkdir -p "$lic/vcpkg"
cp "$SRC/LICENSE" "$lic/OpenMS-LICENSE.txt"
[ -f "$BUILD/thirdparty_licenses.txt" ] && cp "$BUILD/thirdparty_licenses.txt" "$lic/"
if [ -f "$BUILD/third_party_notices/files.txt" ]; then
  while IFS='|' read -r dest source; do
    [ -n "$dest" ] && [ -f "$source" ] || continue
    mkdir -p "$share/$(dirname "$dest")"
    cp "$source" "$share/$dest"
  done < "$BUILD/third_party_notices/files.txt"
fi
for copyright in "$BUILD/vcpkg_installed/$TRIPLET"/share/*/copyright; do
  [ -f "$copyright" ] || continue
  port=$(basename "$(dirname "$copyright")")
  mkdir -p "$lic/vcpkg/$port"
  cp "$copyright" "$lic/vcpkg/$port/"
done
# The licences of the .raw reader: Thermo's RawFileReader licence (OpenMS's configure downloads it; the vcpkg
# port installs it as its copyright), the bridge's notices (ThermoWrapperManaged, CommandLineParser, OpenMcdf,
# nethost) and the .NET runtime's (fetch-dotnet-runtime.sh put them there).
[ -f "$lic/ThermoRawFileReader-License.doc" ] || [ -f "$lic/vcpkg/openms-thermo-bridge/copyright" ] \
  || die "no Thermo RawFileReader licence (LICENSES/ThermoRawFileReader-License.doc: OpenMS's configure downloads it; configure again)"
[ -f "$managed/THIRD-PARTY-NOTICES.txt" ] || die "no THIRD-PARTY-NOTICES.txt in $managed"
for f in LICENSE.txt ThirdPartyNotices.txt; do
  [ -f "$lic/dotnet/$f" ] || die "no $lic/dotnet/$f (the .NET runtime's)"
done
# the bundled libraries of the system, with their licences:
# - Linux: the GCC runtime (GPL-3.0 with the GCC Runtime Library Exception), with the copyright file of its
#   Debian package;
# - macOS: Homebrew's libomp (LLVM: Apache-2.0 WITH LLVM-exception), the licence files of its keg;
# - Windows: the Visual C++ runtime, Microsoft's redistributable code (the Visual Studio licence's
#   "Distributable Code"), named in a note.
if [ "$PLATFORM" = macos ]; then
  keg=$(cd "$(dirname "${system_libs[0]}")/.." && pwd -P)
  mkdir -p "$lic/system/libomp"
  find "$keg/" -maxdepth 1 -type f \( -iname 'LICENSE*' -o -iname 'COPYING*' -o -iname 'NOTICE*' \) \
    -exec cp {} "$lic/system/libomp/" \;
  [ -n "$(ls "$lic/system/libomp")" ] || echo "warning: no licence file found in $keg" >&2
elif [ "$PLATFORM" = windows ]; then
  mkdir -p "$lic/system"
  {
    echo "bin/msvcp140*.dll, bin/vcruntime140*.dll, bin/vcomp140.dll, bin/concrt140.dll (those present):"
    echo "the Microsoft Visual C++ Redistributable $(basename "$(native "$VCToolsRedistDir")"), deployed"
    echo "app-locally, as the Visual Studio licence terms allow for its Distributable Code."
  } > "$lic/system/msvc-runtime.txt"
fi
# (${a[@]+"${a[@]}"}: an empty array under set -u in macOS's bash 3.2)
debian_libs=()
[ "$PLATFORM" = linux ] && debian_libs=(${system_libs[@]+"${system_libs[@]}"})
for path in ${debian_libs[@]+"${debian_libs[@]}"}; do
  package=$(dpkg -S "$(realpath "$path")" 2>/dev/null | head -n 1 | cut -d: -f1) || true
  [ -n "$package" ] || package=$(dpkg -S "$path" 2>/dev/null | head -n 1 | cut -d: -f1) || true
  if [ -n "$package" ] && [ -f "/usr/share/doc/$package/copyright" ]; then
    mkdir -p "$lic/system/$package"
    cp "/usr/share/doc/$package/copyright" "$lic/system/$package/"
  else
    echo "warning: no copyright file found for $path" >&2
  fi
done

# --- The manifest -----------------------------------------------------------------------------------
"$PY" -I - "$OUT/build.json" "$COMMIT" "$TRIPLET" "$dotnet_version" "${TOOL_NAMES[@]}" <<'PY'
import json, sys
path, commit, triplet, dotnet, *tools = sys.argv[1:]
manifest = {"tool": tools[0], "tools": tools, "openmsCommit": commit, "triplet": triplet, "dotnetRuntime": dotnet}
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

# --- Checks ---------------------------------------------------------------------------------------
# Every bundled library resolves inside the bundle, and the tools run in an empty environment.
# - Linux: also with a library path that offers the build's own copies first (DT_RPATH wins).
# - macOS: every reference is the system's or @rpath/<a bundled dylib>, the LC_RPATHs are the bundle's
#   only, the signatures are valid; the newest minimum macOS of the files goes into the manifest
#   (`minimumMacos`; tauri.macos.conf.json's minimumSystemVersion must not be older).
# - Windows: every import is bundled or Windows' own; the tools run with only Windows' folders on PATH.
run_empty() { env -i "$@"; }
case $PLATFORM in
  linux)
    for exe in "$OUT"/bin/*; do
      for env_path in "" "$BUILD/lib:$BUILD/vcpkg_installed/$TRIPLET/lib"; do
        resolved=$(env -i LD_LIBRARY_PATH="$env_path" ldd "$exe")
        if grep -q 'not found' <<<"$resolved"; then die "unresolved in the bundle ($exe):"$'\n'"$resolved"; fi
        while read -r name arrow path _; do
          [ "$arrow" = "=>" ] || continue
          [[ $name =~ $EXCLUDE ]] && continue
          [ "$(realpath "$path")" = "$OUT/lib/$name" ] || die "$name of $exe resolves to $path, not into the bundle (LD_LIBRARY_PATH=$env_path)"
        done <<<"$resolved"
      done
    done
    ;;
  macos)
    verified=$("$PY" -I "$HERE/bundle_closure.py" macho-verify "$OUT")
    echo "$verified"
    minimum=$(sed -n 's/.*minimum macOS \([0-9.]*\).*/\1/p' <<<"$verified")
    [ -n "$minimum" ] || die "no minimum macOS found"
    "$PY" -I - "$OUT/build.json" "$minimum" <<'PY'
import json, sys
path, minimum = sys.argv[1:]
manifest = json.load(open(path))
manifest["minimumMacos"] = minimum
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY
    ;;
  windows)
    "$PY" -I "$HERE/bundle_closure.py" pe-verify "$OUT"
    # (no PATH beyond Windows' folders: a DLL the bundle lacks is not found elsewhere)
    run_empty() { env -i SYSTEMROOT="$SYSTEMROOT" WINDIR="$WINDIR" PATH="/c/Windows/System32:/c/Windows" "$@"; }
    ;;
esac
# (all: PercolatorAdapter runs only at the end of a search and FileConverter after it, so a broken one would show
# late; the three are one build, of one version. OpenNuXL's help lists the presets among the valid values of
# NuXL:presets, which it reads from share/OpenMS/NUXL; the help wraps its lines, so line ends and indentation are
# squeezed to one space first.)
version=
for name in "${TOOL_NAMES[@]}"; do
  tool=$OUT/bin/$name$SUFFIX
  tool_version=$(run_empty "$tool" --help 2>&1 | sed -n 's/^ *Version: *\([^ ]*\).*/\1/p' | head -n 1)
  [ -n "$tool_version" ] || die "the bundled $name does not run: $(run_empty "$tool" --help 2>&1 | tail -n 5)"
  [ -z "$version" ] || [ "$tool_version" = "$version" ] || die "the bundled $name is version $tool_version, OpenNuXL $version"
  version=$tool_version
done
run_empty "$OUT/bin/OpenNuXL$SUFFIX" --help 2>&1 | tr -s ' \n' '  ' | grep -q 'RNA-UV (U)' \
  || die "the bundled OpenNuXL does not list the presets of share/OpenMS/NUXL/nuxl_presets.json"

# Native .raw and .d reading is compiled in: OpenNuXL's and FileConverter's -in take 'd' (WITH_OPENTIMS), and
# FileConverter offers the in-process Thermo reader (RawToMzML:reader inprocess, WITH_THERMO_RAW; OpenNuXL reads
# .raw through the same reader then, and through ThermoRawFileParser, which the app does not bundle, otherwise).
# Read from the tools' parameter files (-write_ini), not from the help, whose wording and wrapping may change.
inis=$(mktemp -d)
for name in OpenNuXL FileConverter; do
  run_empty "$OUT/bin/$name$SUFFIX" -write_ini "$(native "$inis/$name.ini")" >/dev/null 2>&1 \
    || die "the bundled $name could not write its parameters (-write_ini)"
done
"$PY" -I - "$(native "$inis/OpenNuXL.ini")" "$(native "$inis/FileConverter.ini")" <<'PY' || { rm -rf "$inis"; die "the bundled tools do not read .raw and .d natively"; }
import sys
import xml.etree.ElementTree as ET
def instance(path):
    # <PARAMETERS><NODE name="<tool>"><NODE name="1">...: the tool's parameters
    node = ET.parse(path).getroot().find("NODE/NODE[@name='1']")
    if node is None:
        sys.exit(f"{path}: no parameters of instance 1")
    return node
def item(node, name):
    found = node.find(f"ITEM[@name='{name}']")
    if found is None:
        sys.exit(f"no parameter {name}")
    return found
def values(element, attribute):
    return {v.strip().lstrip("*.").lower() for v in element.get(attribute, "").split(",") if v.strip()}
nuxl, converter = (instance(p) for p in sys.argv[1:])
failed = []
for tool, node in (("OpenNuXL", nuxl), ("FileConverter", converter)):
    formats = values(item(node, "in"), "supported_formats")
    if not {"raw", "d"} <= formats:
        failed.append(f"{tool} -in takes {sorted(formats)}: no 'raw' and 'd' (Bruker .d: WITH_OPENTIMS)")
raw = converter.find("NODE[@name='RawToMzML']")
readers = values(item(raw, "reader"), "restrictions") if raw is not None else set()
if "inprocess" not in readers:
    failed.append(f"FileConverter -RawToMzML:reader offers {sorted(readers)}: no 'inprocess' (WITH_THERMO_RAW)")
if failed:
    sys.exit("\n".join(failed))
print("  OpenNuXL and FileConverter read .raw (in process) and .d natively")
PY
rm -rf "$inis"

# The .NET runtime is complete for nethost/hostfxr below DOTNET_ROOT, and its host lists it.
case $PLATFORM in
  linux) hostfxr=libhostfxr.so ;;
  macos) hostfxr=libhostfxr.dylib ;;
  windows) hostfxr=hostfxr.dll ;;
esac
[ -f "$OUT/dotnet/host/fxr/$dotnet_version/$hostfxr" ] || die "no dotnet/host/fxr/$dotnet_version/$hostfxr in the bundle"
[ -f "$managed/ThermoWrapperManaged.dll" ] || die "no ThermoWrapperManaged.dll in $managed"
if [ "$PLATFORM" = macos ]; then
  # (arm64 loads no dylib without a valid signature; these are Microsoft's)
  while IFS= read -r dylib; do
    codesign --verify "$dylib" 2>/dev/null || die "$dylib (the .NET runtime) has no valid signature"
  done < <(find "$OUT/dotnet" -type f -name '*.dylib')
fi
run_empty "$OUT/dotnet/dotnet$SUFFIX" --list-runtimes 2>&1 | grep -q "^Microsoft\.NETCore\.App $dotnet_version " \
  || die "the bundled .NET does not list its runtime: $(run_empty "$OUT/dotnet/dotnet$SUFFIX" --list-runtimes 2>&1 | tail -n 5)"

echo "bundled ${TOOL_NAMES[*]} $version (OpenMS $COMMIT), .NET runtime $dotnet_version, into $OUT"
[ "${#excluded[@]}" -gt 0 ] && echo "  left out (system): ${excluded[*]}"
libs=$OUT/lib
[ "$PLATFORM" = windows ] && libs=$OUT/bin
echo "  libraries: $(find "$libs" -type f | wc -l | tr -d ' ') (of the system: ${system_libs[*]+${system_libs[*]##*/}}), OpenMP runtime: ${omp[*]}"
for part in "" /bin /lib /share/OpenMS /share/OpenMS/openms_thermo_bridge /dotnet; do
  if [ -d "$OUT$part" ]; then echo "  $(du -sh "$OUT$part" | cut -f1)	${part:-total}"; fi
done
