#!/bin/bash
# Native (host toolchain) build of libOpenMS, the ProSE tool and the ProSE class tests.
#
#   build-openms.sh <openms-src> <build-dir>
#
# <openms-src> is any OpenMS checkout; <build-dir> is created if needed (an existing configured
# directory is reconfigured in place, so the script is safe to re-run). It runs on the host
# toolchain, outside native/scripts/in-env.sh. Environment overrides: JOBS (default 100),
# VCPKG_BINARY_CACHE, VCPKG_MAX_CONCURRENCY (default 32), OPENMS_TARGETS (default: the library, ProSE
# and the tests below; CI builds "OpenMS ProSE" only), VCPKG_INSTALL_OPTIONS (a CMake list, for
# example --clean-after-build, which CI uses to save disk space), CC and CXX (CI: gcc-13; cl on
# Windows), VCPKG_TRIPLET (default x64-linux-dynamic; CI: arm64-osx-dynamic-sysroot-vcrel on macOS,
# x64-windows-static-md-release on Windows, as OpenMS's own CI), OPENMS_CMAKE_ARGS (more -D options,
# split at spaces; macOS: -DOpenMP_ROOT=<Homebrew's libomp>), OPENMS_CONFIGURE_ONLY=1 (configure, which
# builds the vcpkg dependencies, and stop: CI saves the dependencies before the long OpenMS build).
# On Windows it runs in Git Bash inside a Visual Studio developer environment.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <openms-src> <build-dir>" >&2
  exit 2
fi
# absolute paths; on Windows in the D:/x form that cmake and vcpkg take
native() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
mkdir -p "$2"
SRC=$(native "$(cd "$1" && pwd -P)")
BUILD=$(native "$(cd "$2" && pwd -P)")
JOBS=${JOBS:-100}
BINCACHE=${VCPKG_BINARY_CACHE:-/scratch/sachsenb/vcpkg-bincache-native}
TRIPLET=${VCPKG_TRIPLET:-x64-linux-dynamic}

TOOLCHAIN="$SRC/vcpkg/scripts/buildsystems/vcpkg.cmake"
[ -f "$SRC/CMakeLists.txt" ] || { echo "error: $SRC is not an OpenMS checkout" >&2; exit 1; }
[ -f "$TOOLCHAIN" ] || { echo "error: vcpkg toolchain missing: $TOOLCHAIN (submodule not checked out?)" >&2; exit 1; }

# linuxbrew's binutils (as 2.36) cannot assemble ONNX Runtime's AVX-NE-CONVERT code: drop it from PATH.
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v 'linuxbrew' | paste -sd: -)
export PATH

# Build the vcpkg dependencies once and reuse them across builds from the binary cache.
mkdir -p "$BINCACHE"
BINCACHE=$(native "$(cd "$BINCACHE" && pwd -P)")
export VCPKG_BINARY_SOURCES="clear;files,$BINCACHE,readwrite"
export VCPKG_MAX_CONCURRENCY=${VCPKG_MAX_CONCURRENCY:-32}

# Thermo RAW is off because its bridge needs dotnet; OpenTIMS is off because the app does not read .d files.
# The update check is off: OpenMS tools otherwise contact openms-update.cs.uni-tuebingen.de once a day (the app has no
# network access at run time; the app also sets OPENMS_DISABLE_UPDATE_CHECK for the tool, src-tauri/src/tool.rs).
# shellcheck disable=SC2086 # OPENMS_CMAKE_ARGS: options, split at spaces
cmake -G Ninja -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=Release \
  -DOPENMS_USE_VCPKG=ON \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" \
  -DVCPKG_TARGET_TRIPLET="$TRIPLET" \
  -DVCPKG_MANIFEST_FEATURES=onnxruntime \
  -DWITH_ONNX=ON \
  -DWITH_GUI=OFF \
  -DWITH_THERMO_RAW=OFF \
  -DWITH_OPENTIMS=OFF \
  -DENABLE_DOCS=OFF \
  -DENABLE_UPDATE_CHECK=OFF \
  -DPYOPENMS=OFF \
  -DENABLE_CLASS_TESTING=ON \
  -DENABLE_TOPP_TESTING=ON \
  ${VCPKG_INSTALL_OPTIONS:+"-DVCPKG_INSTALL_OPTIONS=$VCPKG_INSTALL_OPTIONS"} \
  ${OPENMS_CMAKE_ARGS:-}

if [ "${OPENMS_CONFIGURE_ONLY:-}" = 1 ]; then
  echo "configured $BUILD (OPENMS_CONFIGURE_ONLY=1: not built)"
  exit 0
fi

# FileInfo, ParquetDiff and FuzzyDiff are what the TOPP_ProSE tests run to inspect and compare outputs;
# without them those tests report "Not Run". PeptDeepLibraryPredictor_test is part of the PeptDeep set, the
# QPX tests check the QPX Parquet output the app reads.
TARGETS=${OPENMS_TARGETS:-OpenMS ProSE FileInfo ParquetDiff FuzzyDiff \
  ProSEAlgorithm_test PeptDeepInference_test PeptDeepRescoring_test PeptDeepLibraryPredictor_test \
  OpenSearchModificationAnalysis_test Percolator_test \
  QPXFile_test QPXCollectionExport_test QPXValueValidation_test QPXIdentity_test ArrowIOHelpers_test}
# shellcheck disable=SC2086 # a list of targets
cmake --build "$BUILD" -j "$JOBS" --target $TARGETS
