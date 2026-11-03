#!/bin/bash
# Bundles the native ProSE tool for the desktop app (Linux, macOS, Windows): the executable, its
# shared-library closure, the OpenMS share/ data it reads, the PeptDeep models and the licences, plus a
# build manifest.
#
#   bundle-prose.sh <openms-build> <out>
#
# <openms-build> is a build directory made by build-openms.sh; <out> is normally
# src-tauri/resources/prose (tauri.conf.json bundles that folder). <out> is emptied first. The layout:
#
#   Linux    bin/ProSE                RPATH $ORIGIN/../lib
#            lib/*.so*                the closure, RPATH $ORIGIN; system libraries left out (below)
#   macOS    bin/ProSE                LC_RPATH @loader_path/../lib, ad-hoc signed
#            lib/*.dylib              the closure (one libomp), ids and references @rpath/<name>,
#                                     LC_RPATH @loader_path, ad-hoc signed; /usr/lib and /System left out
#   Windows  bin/ProSE.exe, bin/*.dll the closure beside the exe (Windows has no RPATH; the exe's folder
#                                     is searched first), with the Visual C++ runtime and vcomp140 (the one
#                                     OpenMP runtime); the DLLs of Windows left out
#   share/OpenMS/{CHEMISTRY,CV,MAPPING,SCHEMAS,TOOLS}
#   share/OpenMS/models/peptdeep_{ms2,rt}_dynamic.onnx    (builds with ONNX only), with AlphaPeptDeep's
#                                     licence (Apache-2.0, native/licenses) and a NOTICE
#   share/OpenMS/LICENSES/...         OpenMS, its vendored code, the vcpkg ports, the bundled system libraries
#   build.json                        the manifest the app reads (tool.rs): withOnnx, the OpenMS commit
#
# Runs on the host toolchain (outside in-env.sh; LD_LIBRARY_PATH is ignored for the closure). Needs
# python3 and, on Linux, patchelf, strip, ldd and dpkg (for the copyright files of the bundled system
# libraries); on macOS otool, install_name_tool, strip, codesign (Xcode's command line tools) and
# Homebrew's libomp; on Windows Git Bash in a Visual Studio developer environment (VCToolsRedistDir, for
# the Visual C++ runtime). The closure on macOS and Windows is bundle_closure.py's. Environment:
# ALLOW_PIN_MISMATCH=1 bundles a build whose source is not at native/OPENMS_COMMIT.
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
EXE=$BUILD/bin/ProSE
[ "$PLATFORM" = windows ] && EXE=$BUILD/bin/ProSE.exe
# (Windows has python, not always python3)
PY=python3
"$PY" -c '' 2>/dev/null || PY=python

die() { echo "error: $*" >&2; exit 1; }
[ -f "$CACHE" ] || die "$BUILD is not a CMake build directory (no CMakeCache.txt)"
[ -x "$EXE" ] || die "$EXE is missing (build the ProSE target)"
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
case "$(cache_value WITH_ONNX)" in
  ON|on|TRUE|true|1|YES|yes) WITH_ONNX=true ;;
  *) WITH_ONNX=false ;;
esac
[ -f "$SRC/share/OpenMS/CHEMISTRY/unimod.xml" ] || die "no OpenMS sources at '$SRC' (CMAKE_HOME_DIRECTORY)"

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
#   runtime (GCC 12), and ProSE runs in a process of its own, so its libstdc++ cannot clash with the app's;
# - libgomp, one OpenMP runtime, the one the build linked.
EXCLUDE='^(linux-vdso\.so\.1|ld-linux-x86-64\.so\.2|libc\.so\.6|libm\.so\.6|libmvec\.so\.1|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|libutil\.so\.1|libresolv\.so\.2|libanl\.so\.1|libnsl\.so\.1|libnss_[a-z]+\.so\.2|libBrokenLocale\.so\.1|libthread_db\.so\.1)$'
OPENMP='^lib(gomp|omp|iomp5|omp5)\.so'

closure_linux() {

  # --- The executable and its closure --------------------------------------------------------------
  # ldd lists the whole closure (transitively) as the build's RUNPATH resolves it.
  closure=$(env -u LD_LIBRARY_PATH -u LD_PRELOAD ldd "$EXE")
  if grep -q 'not found' <<<"$closure"; then
    die "unresolved libraries of $EXE:"$'\n'"$(grep 'not found' <<<"$closure")"
  fi
  while read -r name arrow path _; do
    [ "$arrow" = "=>" ] || continue
    if [[ $name =~ $EXCLUDE ]]; then
      excluded+=("$name")
      continue
    fi
    [[ $name =~ $OPENMP ]] && omp+=("$name")
    cp -L "$path" "$OUT/lib/$name"
    case $path in /lib/* | /usr/lib/*) system_libs+=("$path") ;; esac
  done <<<"$closure"
  [ "${#omp[@]}" -eq 1 ] && [ "${omp[0]}" = libgomp.so.1 ] \
    || die "expected exactly one OpenMP runtime, libgomp.so.1; the closure has: ${omp[*]:-none}"
  cp "$EXE" "$OUT/bin/ProSE"
  chmod 0755 "$OUT/bin/ProSE"
  chmod 0644 "$OUT"/lib/*

  # Symbol tables are not needed at run time; strip before patchelf (strip can undo patchelf's layout).
  strip --strip-unneeded "$OUT/bin/ProSE" "$OUT"/lib/*

  # DT_RPATH (not RUNPATH): it is searched before LD_LIBRARY_PATH, so a library path set around the app
  # (the AppImage runtime, a user's environment) cannot swap in a different libarrow or libOpenMS.
  patchelf --force-rpath --set-rpath '$ORIGIN/../lib' "$OUT/bin/ProSE"
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
  # - the source and build tree (OPENMS_DATA_PATH, OPENMS_BINARY_PATH for the PeptDeep models, the tool
  #   registry): paths of the build machine (in CI below /home/runner/work), which do not exist on a
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
# @rpath ids, resolved through the build's LC_RPATHs.
closure_macos() {
  "$PY" -I "$HERE/bundle_closure.py" macho "$EXE" "$OUT" \
    --search "$BUILD/lib" --search "$BUILD/vcpkg_installed/$TRIPLET/lib" \
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
# from the redistributable folders of the Visual Studio that built it.
closure_windows() {
  [ -n "${VCToolsRedistDir:-}" ] || die "VCToolsRedistDir is not set: run in a Visual Studio developer environment"
  local redist=() d root
  root=$(native "$VCToolsRedistDir")
  for d in "$root"/x64/Microsoft.VC*.CRT "$root"/x64/Microsoft.VC*.OpenMP; do
    [ -d "$d" ] && redist+=(--redist "$d")
  done
  [ "${#redist[@]}" -gt 0 ] || die "no x64 runtime folders in $root"
  "$PY" -I "$HERE/bundle_closure.py" pe "$EXE" "$OUT" \
    --search "$BUILD/bin" --search "$BUILD/vcpkg_installed/$TRIPLET/bin" "${redist[@]}" \
    --install-path "$install_data_path"
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

# --- share/OpenMS ---------------------------------------------------------------------------------
# What ProSE reads (checked with strace on the example, with and without PeptDeep): CHEMISTRY (unimod,
# enzymes, modifications, PSI-MOD, XLMOD), CV (psi-ms and the obo files it imports), MAPPING
# (ms-mapping.xml), the TOOLS registry; SCHEMAS for the mzML/mzIdentML readers. The metabolomics HMDB
# tables (49 MB) and the examples are left out.
share=$OUT/share/OpenMS
cp -r "$SRC/share/OpenMS/CHEMISTRY" "$SRC/share/OpenMS/CV" "$SRC/share/OpenMS/MAPPING" \
  "$SRC/share/OpenMS/SCHEMAS" "$share/"
rm -f "$share"/CHEMISTRY/HMDB*
cp -r "$BUILD/share/OpenMS/TOOLS" "$share/"
models=()
if [ "$WITH_ONNX" = true ]; then
  model_dir=$(cache_value OPENMS_PEPTDEEP_MODEL_DIR)
  mkdir -p "$share/models"
  # the two ProSE uses (peptdeep:ms2_model, peptdeep:rt_model); the CCS model is for ion mobility
  for model in peptdeep_ms2_dynamic.onnx peptdeep_rt_dynamic.onnx; do
    [ -f "$model_dir/$model" ] || die "$model_dir/$model is missing (the configure step downloads it)"
    cp "$model_dir/$model" "$share/models/"
    models+=("share/OpenMS/models/$model")
  done
  # the models are AlphaPeptDeep's (Apache-2.0): its licence goes with them
  cp "$HERE/../licenses/AlphaPeptDeep-LICENSE.txt" "$share/models/LICENSE-AlphaPeptDeep.txt"
  cat > "$share/models/NOTICE.txt" <<'NOTICE'
peptdeep_ms2_dynamic.onnx and peptdeep_rt_dynamic.onnx are the pretrained MS2 and retention time models of
AlphaPeptDeep (https://github.com/MannLabs/alphapeptdeep), Copyright 2020 MannLabs, as ONNX models
(OpenMS, http://archive.openms.de/openms/models). They are licensed under the Apache License 2.0:
LICENSE-AlphaPeptDeep.txt.
NOTICE
fi

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
"$PY" -I - "$OUT/build.json" "$COMMIT" "$WITH_ONNX" "$TRIPLET" ${models[@]+"${models[@]}"} <<'PY'
import json, sys
path, commit, onnx, triplet, *models = sys.argv[1:]
manifest = {"tool": "ProSE", "openmsCommit": commit, "withOnnx": onnx == "true", "triplet": triplet, "models": models}
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
PY

# --- Checks ---------------------------------------------------------------------------------------
# Every bundled library resolves inside the bundle, and the tool runs in an empty environment.
# - Linux: also with a library path that offers the build's own copies first (DT_RPATH wins).
# - macOS: every reference is the system's or @rpath/<a bundled dylib>, the LC_RPATHs are the bundle's
#   only, the signatures are valid; the newest minimum macOS of the files goes into the manifest
#   (`minimumMacos`; tauri.macos.conf.json's minimumSystemVersion must not be older).
# - Windows: every import is bundled or Windows' own; the tool runs with only Windows' folders on PATH.
run_empty() { env -i "$@"; }
case $PLATFORM in
  linux)
    for env_path in "" "$BUILD/lib:$BUILD/vcpkg_installed/$TRIPLET/lib"; do
      resolved=$(env -i LD_LIBRARY_PATH="$env_path" ldd "$OUT/bin/ProSE")
      if grep -q 'not found' <<<"$resolved"; then die "unresolved in the bundle:"$'\n'"$resolved"; fi
      while read -r name arrow path _; do
        [ "$arrow" = "=>" ] || continue
        [[ $name =~ $EXCLUDE ]] && continue
        [ "$(realpath "$path")" = "$OUT/lib/$name" ] || die "$name resolves to $path, not into the bundle (LD_LIBRARY_PATH=$env_path)"
      done <<<"$resolved"
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
tool=$OUT/bin/$(basename "$EXE")
version=$(run_empty "$tool" --help 2>&1 | sed -n 's/^ *Version: *\([^ ]*\).*/\1/p' | head -n 1)
[ -n "$version" ] || die "the bundled ProSE does not run: $(run_empty "$tool" --help 2>&1 | tail -n 5)"

echo "bundled ProSE $version (OpenMS $COMMIT, ONNX: $WITH_ONNX) into $OUT"
[ "${#excluded[@]}" -gt 0 ] && echo "  left out (system): ${excluded[*]}"
libs=$OUT/lib
[ "$PLATFORM" = windows ] && libs=$OUT/bin
echo "  libraries: $(find "$libs" -type f | wc -l | tr -d ' ') (of the system: ${system_libs[*]+${system_libs[*]##*/}}), OpenMP runtime: ${omp[*]}"
for part in "" /bin /lib /share/OpenMS /share/OpenMS/models; do
  if [ -d "$OUT$part" ]; then echo "  $(du -sh "$OUT$part" | cut -f1)	${part:-total}"; fi
done
