# Native tools and Tauri toolchain

The NuXL desktop app (Tauri 2) runs OpenNuXL of OpenMS, with PercolatorAdapter for its score recalibration, as its
only native code (plus the .NET runtime that OpenMS's Thermo reader hosts); OpenNuXL keeps the spectra of its PSMs for
the PSM view itself (`-out_qpx`, the QPX mz view). The bundle also has FileConverter, which the packages' start test
reads a .raw and a .d with (the app does not run it). This directory holds the tooling for the two things the app needs: a user-space
toolchain for the Tauri and Rust side, and a native OpenMS build of the tools, bundled with their libraries and data.
(It started as ProSE desktop's, whose toolchain sections below are unchanged.)

## Tauri toolchain without root

The host (ibminode06, Ubuntu 24.04) has no Rust and no WebKitGTK development files, and there is
no root. `/scratch` is node-local (ibminode06 only) and purged, so on another node, or after a
purge, the toolchain below has to be rebuilt first (rustup and `cargo install` with network access,
then `make-sysroot.sh`; the `.deb` cache is lost too). A container was tried first and does not work here: `apptainer build --fakeroot`, and
`apptainer exec --writable --fakeroot` on a sandbox, both fail with `Could not write info to
setgroups: Permission denied` (the user has no `/etc/subuid` entry, and
`kernel.apparmor_restrict_unprivileged_userns = 1` blocks the root-mapped namespace). Plain
`apptainer exec` works, but an image cannot be built. So the toolchain is installed in user space
and `native/scripts/in-env.sh` puts it on the paths:

| Piece | Where | How |
| --- | --- | --- |
| Rust stable (rustup, clippy, rustfmt) | `/scratch/sachsenb/tools/rust/{rustup,cargo}` | `curl https://sh.rustup.rs \| sh -s -- -y --no-modify-path -c clippy -c rustfmt`, with `RUSTUP_HOME` and `CARGO_HOME` set to those directories |
| `tauri-driver` | `/scratch/sachsenb/tools/rust/cargo/bin` | `cargo install tauri-driver --locked` |
| Node 24.19.0 | `/scratch/sachsenb/emsdk/node/24.19.0_64bit/bin` | already there (emsdk) |
| WebKitGTK 4.1, GTK/AppIndicator/rsvg development files, `WebKitWebDriver`, `patchelf` | `/scratch/sachsenb/tools/tauri-sysroot` | `native/scripts/make-sysroot.sh` |
| `Xvfb`, `xvfb-run`, `xauth`, `file`, GTK 3 runtime | the host | installed system packages |

### The sysroot

`make-sysroot.sh [sysroot] [deb-cache]` (defaults `/scratch/sachsenb/tools/tauri-sysroot` and
`/scratch/sachsenb/tools/tauri-sysroot-debs`) works as follows. It is safe to re-run; delete the
sysroot first for a clean slate.

1. Resolves the packages by simulating `apt-get install --no-install-recommends` of the
   top-level packages the host lacks (`libwebkit2gtk-4.1-dev libgtk-3-dev
   libayatana-appindicator3-dev librsvg2-dev webkit2gtk-driver patchelf`; `xvfb xauth file` are
   already installed) on top of the host's dpkg state. That yields exactly the 159 packages to
   add, and it already skips what the host has. (`apt-cache depends --recurse` was tried: it
   expands every alternative of every OR dependency, 530 packages including all aspell
   dictionaries and i386 packages.) Six Mesa packages are upgraded in the sysroot because their
   versioned dependencies demand it.
2. Fetches them with `apt-get download` (no root) into the deb cache and unpacks each with
   `dpkg -x`.
3. Fixes symlinks: a target present in the sysroot becomes a relative link inside it, a target
   present only on the host (for example `libglib-2.0.so -> libglib-2.0.so.0.8000.0`, whose real
   file is a host package) becomes an absolute link to the host path.
4. Patches the compiled-in WebKit helper path (below).
5. Rewrites `prefix=`, `libdir=` and `-I/-L` entries of `/usr` in the sysroot's `.pc` files to
   the sysroot. `PKG_CONFIG_SYSROOT_DIR` is not used: it would also prefix the host's own `.pc`
   files, whose files are not in the sysroot.
6. Compiles the GLib schemas and GIO module cache, and the GdkPixbuf loader cache if the sysroot
   has loaders (it has none at present; the host's cache is used).

**WebKit's helper processes.** libwebkit2gtk starts `WebKitWebProcess`, `WebKitNetworkProcess`
and `WebKitGPUProcess` from the directory compiled into it, `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1`,
and the Ubuntu build honours no environment variable to redirect it (`WEBKIT_EXEC_PATH` and
`WEBKIT_INJECTED_BUNDLE_PATH` exist only in developer builds; `strings` shows only the injected
bundle one). So `make-sysroot.sh` patches the sysroot's copy of `libwebkit2gtk-4.1.so.0.*` and
of `WebKitWebDriver`: the 40-byte path is replaced, with the same length, by
`/scratch/sachsenb/tools/webkit2gtk-4.1` (a symlink to the sysroot directory, padded with extra
slashes). The link sits beside the sysroot, so `<parent of the sysroot>/webkit2gtk-4.1` must be at
most 40 bytes long, which the script checks. `WebKitWebDriver` is patched only when the sysroot has
it (a host with `webkit2gtk-driver` installed uses its own copy). `libc6`, `libgcc-s1` and
`libstdc++6` are never unpacked into the sysroot (its library directories lead `LD_LIBRARY_PATH`,
and a second libc there would break every host binary); the script warns and skips them if apt
asks for them. Use the sysroot's copy of the library only; the
patch is repeated on every run of `make-sysroot.sh`, from the pristine `.deb`.

**WebKit sandbox.** WebKit sandboxes its processes with bubblewrap, which needs unprivileged user
namespaces; the node forbids them. WebKit looks for bubblewrap at the absolute path
`/usr/bin/bwrap`, which the host lacks, so the processes start unsandboxed anyway (checked: a Tauri
window renders without any flag). `in-env.sh --disable-webkit-sandbox` additionally sets
`WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1`, in case a `/usr/bin/bwrap` ever appears; use it for
tests on this host only, never for anything that loads untrusted content.

### Using it

```bash
native/scripts/in-env.sh [--disable-webkit-sandbox] <cmd...>
```

It runs the command with:

- `PATH`: the sysroot's `usr/bin`, the cargo bin and Node 24.19.0 in front of the host `PATH`
  without linuxbrew;
- `PKG_CONFIG_PATH` for the sysroot, `LIBRARY_PATH` and `LD_LIBRARY_PATH` for the sysroot's
  `usr/lib/x86_64-linux-gnu` and `lib/x86_64-linux-gnu` (the linker uses `LD_LIBRARY_PATH` to
  resolve the libraries' own dependencies, and binaries find the libraries through it at run time);
- `XDG_DATA_DIRS`, `GSETTINGS_SCHEMA_DIR`, `GIO_EXTRA_MODULES` (additive; `GIO_MODULE_DIR` would
  replace the host's modules) and, when the sysroot has a loader cache, `GDK_PIXBUF_MODULE_FILE`;
- `LIBGL_DRIVERS_PATH` (only if the sysroot has a `dri` directory) and `__EGL_VENDOR_LIBRARY_DIRS` for the sysroot's Mesa (software
  rendering; `libEGL warning: DRI3 error` messages on Xvfb are harmless);
- `RUSTUP_HOME` and `CARGO_HOME`.

Check the toolchain:

```bash
native/scripts/in-env.sh bash -c 'cargo --version && node --version \
  && pkg-config --modversion webkit2gtk-4.1 && WebKitWebDriver --help >/dev/null \
  && tauri-driver --help >/dev/null && Xvfb -help >/dev/null 2>&1 && echo ok'
```

and a webview under Xvfb, for example a minimal Tauri 2 app built with
`in-env.sh cargo build --release --features custom-protocol` and run with
`in-env.sh xvfb-run -a -s "-screen 0 1024x768x24" ./app`.

## Native OpenMS build

`scripts/build-openms.sh <openms-src> <build-dir>` configures and builds libOpenMS, `OpenNuXL`,
`PercolatorAdapter`, `FileConverter` and what their tests run, with the host toolchain (outside `in-env.sh`):

```bash
native/scripts/build-openms.sh <OpenMS checkout> <OpenMS checkout>/build
```

It uses Ninja, a Release build, the vcpkg toolchain of the OpenMS checkout (`x64-linux-dynamic`) and a vcpkg
binary cache (`VCPKG_BINARY_CACHE`, default `/scratch/sachsenb/vcpkg-bincache-native`), so a rebuild in a fresh
directory does not rebuild the dependencies. `JOBS` (default 100) sets the parallelism. Notes on the
configuration:

- `WITH_THERMO_RAW=ON`: OpenNuXL and FileConverter read Thermo `.raw` files in process, through
  [openms-thermo-bridge](https://github.com/OpenMS/openms-thermo-bridge) (v1.0.0, fetched by CMake's FetchContent):
  a native library (`libopenms_thermo_bridge.so`/`.dylib`, `openms_thermo_bridge.dll`), which libOpenMS links,
  hosts the bridge's managed half (`ThermoWrapperManaged.dll` with Thermo's RawFileReader assemblies, net8.0) in a
  .NET runtime through nethost and hostfxr. Configuring and building need a **.NET SDK 8 or newer** (`dotnet` on
  `PATH` or `DOTNET_ROOT`; the script stops early without one): the native library compiles against the SDK's
  nethost (its host pack), and `dotnet publish` makes the managed half (a NuGet restore; Thermo's packages are
  downloaded). OpenMS's configure also downloads Thermo's RawFileReader licence. At run time only a .NET *runtime*
  is needed; the bundle brings one (".NET runtime", below).
- `WITH_OPENTIMS=ON`: Bruker timsTOF `.d` folders (OpenTIMS, cloned from GitHub at configure time and linked
  statically into libOpenMS: no library and no runtime of its own).
- `WITH_ONNX=OFF`: OpenNuXL uses no ONNX model. `WITH_GUI=OFF`, `ENABLE_DOCS=OFF` and `PYOPENMS=OFF` leave out what
  the app does not use.
- `ENABLE_UPDATE_CHECK=OFF`: an OpenMS tool otherwise contacts `openms-update.cs.uni-tuebingen.de` once a day
  (and waits up to 5 s for it when offline), and the tools make no network contact (the app's only one is its own
  new-version check, docs/design.md §7). The app also runs OpenNuXL
  with `OPENMS_DISABLE_UPDATE_CHECK=ON` (`src-tauri/src/tool.rs`), for a tool from `NUXL_TOOL` or the PATH, and
  the PercolatorAdapter it starts inherits it.
- `PATH` is rebuilt without linuxbrew (its binutils are older than the toolchain's).
- The targets: `OpenNuXL`, `PercolatorAdapter` (OpenNuXL runs it for the score recalibration, and looks for it
  beside itself: `File::findSiblingTOPPExecutable`), `FileConverter` (the packages' start test converts a `.raw`
  and a `.d` with it through the bundled .NET runtime; the app does not run it), `FuzzyDiff` (the `TOPP_OpenNuXL`
  tests compare with it; without it they report "Not Run") and `Percolator_test`. CI builds
  `OpenMS OpenNuXL PercolatorAdapter FileConverter`.

Check the build with OpenNuXL's tests:

```bash
ctest --test-dir <OpenMS checkout>/build -R "OpenNuXL|Percolator_test" -j 32 --output-on-failure
```

## The OpenMS pin

`OPENMS_COMMIT` holds the full hash of the OpenMS commit the app's OpenNuXL is built from, a commit of
`develop`. The app's allowlist of OpenNuXL's options (`src-tauri/src/args.rs`, `PARAMETERS`), the stages of its
progress (`progress.rs`) and the names of its derived outputs (`run.rs`, `find_outputs`; `NuXLFDR.cpp`) are those
of the pinned `OpenNuXL.cpp`: check them when the pin moves. The pin has to include OpenMS#10816 (develop
`f3581006`): from there OpenNuXL reads `.raw`, `.d` (and mzPeak) through `FileHandler` itself instead of converting a
`.raw` with ThermoRawFileParser, and writes `<input stem>_pc.mzML` beside its `-in` when it recalibrates; and
OpenMS#10829 (develop `5e974cd`, the current pin): OpenNuXL's `-out_qpx` (the QPX mz view of the spectra of its PSMs,
which the app's PSM view reads; the app passes it to every run, and an OpenNuXL without it refuses the option). CI checks the
commit out of OpenMS/OpenMS; it never builds from local state.

## Bundling OpenNuXL

`scripts/bundle-nuxl.sh <openms-build> <out>` (host toolchain) fills `<out>`, normally
`src-tauri/resources/nuxl` (git-ignored; `tauri.conf.json` bundles the folder, and `build.rs` makes an empty
one so builds without it work), with what the app ships:

```bash
native/scripts/bundle-nuxl.sh <OpenMS checkout>/build src-tauri/resources/nuxl
```

| Part | What |
| --- | --- |
| `bin/OpenNuXL`, `bin/PercolatorAdapter`, `bin/FileConverter` | stripped, `DT_RPATH` `$ORIGIN/../lib`; PercolatorAdapter beside OpenNuXL, where OpenNuXL looks for it |
| `lib/` | the closure of the tools that `ldd` lists, each library once, under its sonames, stripped, `DT_RPATH` `$ORIGIN`: libOpenMS, `libopenms_thermo_bridge.so`, Arrow/Parquet, Xerces, HiGHS, ..., libgomp (the one OpenMP runtime; the script fails on any other) and the GCC runtime (libstdc++, libgcc_s: OpenMS needs GCC 13, newer than Ubuntu 22.04's). Left out: glibc only. |
| `share/OpenMS/` | `CHEMISTRY` (without the 49 MB of HMDB tables), `CV`, `MAPPING`, `SCHEMAS`, the `TOOLS` registry (the set ProSE desktop's bundle had, checked with strace there) and `NUXL` (`nuxl_presets.json`: the cross-linking protocols of `NuXL:presets`, read when OpenNuXL registers its options) |
| `share/OpenMS/openms_thermo_bridge/managed/` | the Thermo bridge's managed half (about 1.6 MB of IL assemblies, the same on every platform), from the build's `OpenMSThermoBridge_MANAGED_DIR` without `*.pdb` and `*.zip` (as OpenMS installs it); its `ThermoWrapperManaged.runtimeconfig.json` patched to `"rollForward": "Major"` |
| `dotnet/` | the .NET runtime (".NET runtime", below), as Microsoft ships it: `host/fxr/<version>/`, `shared/Microsoft.NETCore.App/<version>/`, the `dotnet` host, `LICENSE.txt`, `ThirdPartyNotices.txt` |
| `share/OpenMS/LICENSES/` | OpenMS, its vendored code, every vcpkg port, the bundled system packages (GCC runtime), Thermo's RawFileReader licence (`ThermoRawFileReader-License.doc`), the .NET runtime's (`dotnet/`); the bridge's own notices (ThermoWrapperManaged, CommandLineParser, OpenMcdf, nethost) are `openms_thermo_bridge/managed/THIRD-PARTY-NOTICES.txt` |
| `build.json` | the manifest: the tools, the OpenMS commit, the triplet, the .NET runtime's version (`dotnetRuntime`; macOS: the minimum macOS) |

`DT_RPATH`, not `RUNPATH`: it is searched before `LD_LIBRARY_PATH`, so the AppImage's library path (its
`usr/lib`, with WebKit's dependencies) cannot swap in a different libzstd or libssl. The script checks that
every library of the tools resolves into the bundle, also with the build's library directories on
`LD_LIBRARY_PATH`, that the tools run from an empty environment and are of one version, that OpenNuXL's help
lists the presets (it read `share/OpenMS/NUXL`), and that `.raw` and `.d` are read natively: the build has
`WITH_THERMO_RAW` and `WITH_OPENTIMS` on, the bridge library (Windows: and `nethost.dll`) is in the closure, the
`-in` of OpenNuXL and FileConverter takes `d` and FileConverter offers `-RawToMzML:reader inprocess` (read from
their `-write_ini` parameter files), the managed folder, the licences and `dotnet/host/fxr/<version>/` are there and
the bundled `dotnet --list-runtimes` lists the runtime. It refuses a build whose source is not at `OPENMS_COMMIT`
(`ALLOW_PIN_MISMATCH=1` overrides).

**Where the tools find share/OpenMS.** OpenMS tries paths compiled into it first: the install prefix
(`/usr/local/share/OpenMS`), then the source tree's `share/OpenMS`; only then `bin/../share/OpenMS` next to the
executable, and the `OPENMS_DATA_PATH` variable last of all. So setting `OPENMS_DATA_PATH` cannot steer the
bundled tools, and the app does not set it. The bundled tools must not pick up an OpenMS a user installed in
`/usr/local` (with presets and chemistry of another version), so `bundle-nuxl.sh` overwrites that one string in
the bundle's `libOpenMS.so` with a path of the same length that cannot exist (`/dev/null////...`), as conda does
with the prefix (OpenMS reads it through a volatile pointer for this; `File.cpp`, `installPath_`). The source and
build tree paths are the build machine's (in CI below `/home/runner/work`) and cannot be patched (GCC writes them
into the code as immediates); they do not exist on a user's machine. On the build machine they do, so the smoke
test hides them (`--hide-openms`, below).

### .NET runtime (`scripts/fetch-dotnet-runtime.sh`)

Only `.raw` inputs need .NET: the Thermo bridge loads the runtime into the tool's own process (lazily, at the first
`.raw` it opens; `--help`, mzML and `.d` never load it). `bundle-nuxl.sh` calls `fetch-dotnet-runtime.sh <bundle>`,
which downloads Microsoft's xcopy runtime archive for the machine (`dotnet-runtime-<version>-<rid>.tar.gz`, `.zip` on
Windows; RIDs `linux-x64`, `linux-arm64`, `osx-arm64`, `win-x64`; `DOTNET_RID` overrides,
`DOTNET_RUNTIME_ARCHIVE=<file>` takes a downloaded one), checks its SHA-512 and unpacks it into `<bundle>/dotnet`,
with its licence and notices also in `share/OpenMS/LICENSES/dotnet`. The runtime stays as Microsoft built and
signed it: it is outside `bin/` and `lib/`, so nothing strips, patches or re-signs it (the macOS dylibs keep
Microsoft's signatures; `bundle-nuxl.sh` and `package-macos.sh` check them).

- **.NET 10** (LTS until November 2028), pinned to **10.0.14** with the SHA-512 of each archive from Microsoft's
  release metadata (`release-notes/10.0/releases.json`). .NET 8's support ends on 10 November 2026, so the
  bridge's net8.0 assemblies run on 10 by rolling forward: their `runtimeconfig.json` in the bundle says
  `"rollForward": "Major"`, and the app sets `DOTNET_ROLL_FORWARD=Major` for the tools as well. A newer patch
  release: change the version and the four hashes in the script together (the script is part of CI's bundle cache
  key, so the next run bundles it; that rebuilds OpenMS on a cache miss).
- **How the tools find it**: when the bundle has `dotnet/`, the app (`src-tauri/src/tool.rs`) runs every tool with
  `DOTNET_ROOT=<bundle>/dotnet` (nethost looks there first; `DOTNET_ROOT_X64`, `DOTNET_ROOT_ARM64` and
  `DOTNET_ROOT(x86)` removed), `DOTNET_ROLL_FORWARD=Major`, `DOTNET_CLI_TELEMETRY_OPTOUT=1` and
  `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` (no ICU: the bundle carries none, and minimal Linux systems may have
  none), and with `OPENMS_THERMO_MANAGED_DIR=<bundle>/share/OpenMS/openms_thermo_bridge/managed` (on a build
  machine OpenMS's data path is the source tree's `share/OpenMS`, which has no managed folder). A tool from an
  OpenMS build tree (`NUXL_TOOL`) has neither folder beside it and keeps the user's environment.
- **Size**: about 70 MB unpacked per platform (the CI summary's "Package sizes" shows it as a row of its own).
- FileConverter's `-RawToMzML:reader` defaults to ThermoRawFileParser (`external`) on Windows; the start test always
  passes `inprocess`.

**`tool_info`** is `{ version, path }` (`src-tauri/src/tool.rs`): the version from `OpenNuXL --help`. The app's
`--smoke-test` also reports whether PercolatorAdapter is beside the tool. `NUXL_TOOL` names a tool to use
instead of the bundled one (the e2e specs and the `real_nuxl` tests: `src-tauri/resources/nuxl/bin/OpenNuXL`, or
`<build>/bin/OpenNuXL`, which has PercolatorAdapter beside it as well).

## macOS and Windows

CI builds both (`.github/workflows/desktop.yml`, jobs `macos` and `windows`); there is no local machine for
them. The same scripts run there:

| Step | macOS (macos-15, arm64) | Windows (windows-2025, x64) |
| --- | --- | --- |
| OpenMS | `build-openms.sh` with `VCPKG_TRIPLET=arm64-osx-dynamic-sysroot-vcrel` (OpenMS's own macOS triplet, release builds only), `OPENMS_CMAKE_ARGS="-DOpenMP_ROOT=$(brew --prefix libomp) -DMT_REQUIRE_OPENMP=ON"`, `MACOSX_DEPLOYMENT_TARGET=15.0` | `build-openms.sh` in Git Bash inside Visual Studio's developer environment, `CC=CXX=cl`, `VCPKG_TRIPLET=x64-windows-static-md-release` (OpenMS's own Windows triplet: the dependencies static, the C runtime dynamic), `-DMT_REQUIRE_OPENMP=ON` |
| .NET SDK (build only) | `actions/setup-dotnet` 8.0.x | `actions/setup-dotnet` 8.0.x |
| bundle | `bundle-nuxl.sh`: `bin/OpenNuXL`, `bin/PercolatorAdapter`, `bin/FileConverter`, `lib/*.dylib` (with `libopenms_thermo_bridge.dylib`), `dotnet/` (`osx-arm64`) | `bundle-nuxl.sh`: `bin/OpenNuXL.exe`, `bin/PercolatorAdapter.exe`, `bin/FileConverter.exe`, `bin/*.dll` (with `openms_thermo_bridge.dll` and `nethost.dll`), `dotnet/` (`win-x64`) |
| package | `package-macos.sh`: `NuXL.app`, `.dmg` | `package-windows.sh`: the NSIS installer `*-setup.exe` |
| test | `start-test.sh <dmg>`; `cargo test --test real_nuxl` with the bundled tool, with the vendor test data (`.raw`, `.d`) | `start-test.sh <setup.exe>`; the same |

**Apple silicon only.** The macOS build is arm64, not universal: OpenMS's vcpkg setup and its own CI cover
arm64-osx only, and the OpenMP runtime is Homebrew's libomp, which is arm64 on the arm64 runners. A universal
build would need a second OpenMS build on an Intel runner (`macos-15-intel`, x64-osx), merged dylib by dylib
with `lipo`, and an x86_64 libomp; that doubles the build and was left out. Intel Macs are not served.

**macOS 15 or later.** `MACOSX_DEPLOYMENT_TARGET` is the runner's macOS, as in OpenMS's CI: Homebrew's
libomp is built for it. `bundle-nuxl.sh` writes the newest minimum macOS of the bundled files into
`build.json` (`minimumMacos`), and `package-macos.sh` refuses an app whose `minimumSystemVersion`
(`src-tauri/tauri.macos.conf.json`) is older, so an older Mac says so at once instead of failing to load a
library.

### The closures (`bundle_closure.py`)

**macOS.** The script follows the tools' load commands as dyld does: `@rpath` through the LC_RPATHs of the
loading image and of those that loaded it, `@loader_path`, `@executable_path`, absolute paths; the build's
`lib`, vcpkg's `lib` and the .NET host pack's folder of nethost by name last. `/usr/lib` and `/System` stay out. Everything else is copied to
`lib/<name>` (once, for all the tools) and rewritten with `install_name_tool`:
- every reference to a bundled dylib becomes `@rpath/<name>`, and each dylib's id `@rpath/<name>`;
- the old LC_RPATHs (the build tree's) are deleted one by one (a duplicate LC_RPATH stops dyld on arm64);
- one LC_RPATH is added: `@loader_path/../lib` for the tools, `@loader_path` for the dylibs;
- then `strip -x` and an ad-hoc signature (`codesign -s -`): arm64 runs no unsigned code, and
  `install_name_tool` invalidates the linker's signature.

Exactly one OpenMP runtime, `libomp.dylib`, has to be in the closure. FASTag's approach is the same (one
libomp, rewritten install names, ad-hoc re-signing; okohlbacher/FASTag `doc/SIGNING-macos-gui.md`), without
dylibbundler. `macho-verify` checks a bundle again, also the copy inside `NuXL.app`. The app passes no
`DYLD_*` search variable to the tool (`tool.rs`): they are searched before `@rpath`.

**Windows.** OpenMS links its vcpkg dependencies statically, so the tools' closure is OpenMS's own DLLs
(`OpenMS.dll`, `OpenMS_CLI.dll`, ..., `openms_thermo_bridge.dll`), `nethost.dll` (which the bridge imports; the
build tree has none, OpenMS copies it only when installing, so `bundle-nuxl.sh` takes it from the .NET SDK's host
pack the build used, `packs/Microsoft.NETCore.App.Host.win-x64/<version>/runtimes/win-x64/native`, named in the
CMake cache, else below `DOTNET_ROOT` or the `dotnet` on `PATH`) and the Visual C++ runtime: `msvcp140*.dll`,
`vcruntime140*.dll` and `vcomp140.dll`, MSVC's OpenMP runtime, the one OpenMP runtime. The script reads the import
and delay-import tables of each PE file itself, takes the DLLs from the build's `bin`, vcpkg's `bin`, the host pack
and, for the runtime, from
the redistributable folders of the Visual Studio that built it (`VCToolsRedistDir`: Microsoft's app-local
deployment), and leaves out API sets and the DLLs of Windows. Everything goes beside the exes: Windows has no
RPATH, and the folder of the exe is searched first. `pe-verify` checks that every import is bundled or Windows'
own. Each exe's manifest gets `activeCodePage` UTF-8 (`mt.exe`): OpenMS takes narrow strings, paths among them,
for UTF-8, but a Windows process otherwise gets its arguments and narrow file APIs in the ANSI code page, and a
search in a folder named `Größe ü` (or under a user `Jörg`) read its inputs wrongly (seen with ProSE).

**The install prefix** is overwritten in the bundled `libOpenMS.dylib` as on Linux, with `/dev/null///...`. On
Windows OpenMS does not probe its install prefix at all (`File.cpp`: CMake's default prefix is the wrong
`(x86)` tree), and the string is not in `OpenMS.dll`; should it ever be, it is overwritten with
`<no-install-path>///...` (`<` cannot be part of a Windows path).

### Packages

- **macOS**: `NuXL.app` and the `.dmg`. Tauri copies `resources/nuxl` into
  `NuXL.app/Contents/Resources/resources/nuxl` unchanged. The app is signed ad hoc
  (`signingIdentity: "-"`, no hardened runtime): no Developer ID and no notarization. An ad-hoc signed app can
  be opened after the user's consent (System Settings > Privacy & Security > Open Anyway, or
  `xattr -dr com.apple.quarantine`); an unsigned arm64 app counts as damaged. The .NET runtime's dylibs in
  `resources/nuxl/dotnet` keep Microsoft's signatures (`package-macos.sh` verifies them inside the app); without
  the hardened runtime, the tools load them beside the ad-hoc signed bundle. (Should the app ever get the hardened
  runtime and notarization, OpenNuXL and FileConverter would need the `allow-jit` and
  `disable-library-validation` entitlements to host CoreCLR.)
- **Windows**: the NSIS installer, per user (`installMode: currentUser`, no administrator rights), unsigned
  (SmartScreen asks once). The tools go to `<install folder>/resources/nuxl/bin`, the .NET runtime to
  `resources/nuxl/dotnet`.

### Start test (`start-test.sh <package> <example-dir>`)

1. The package is opened as a user would: the `.dmg` is mounted and `NuXL.app` copied out; the installer is
   run silently (`/S /D=<folder>`). The bundle inside is verified (`macho-verify`, `pe-verify`).
2. The bundled OpenNuXL, PercolatorAdapter and FileConverter print their version (the same) from an empty
   environment (Windows: only Windows' folders on `PATH`). The package has the managed folder, `dotnet/` of the
   version in `build.json` and the licences of Thermo, the bridge and .NET. With `NUXL_RAW_EXAMPLE` and
   `NUXL_D_EXAMPLE` set (CI sets them, below), FileConverter converts both to indexed mzML with the options and the
   environment the app uses (`DOTNET_ROOT` the package's `dotnet/`, ...): spectra with `scan=` (Thermo) and `frame=`
   (Bruker) native IDs.
3. OpenNuXL searches the example (`OpenNuXL_1_input.mzML`, `OpenNuXL_1_input.fasta`) from the command line as
   the app runs it, in a folder with a space in its name, with the preset `RNA-UV (U)` and Percolator: exit 0, the
   outputs the app reads (the idXML of all PSMs, the cross-links and peptides, the protein report, the TSV report)
   and PSMs. (The example has far fewer than the 1000 PSMs OpenNuXL rescores, so Percolator is skipped.) The same
   in a folder named `Größe ü` has to give the same number of PSMs.
4. The app starts with `--smoke-test` (`src-tauri/src/lib.rs`): when its page has loaded it prints
   `{"page", "tool", "percolatorAdapter"}` and exits. The tool has to be the package's own, with PercolatorAdapter
   beside it, and of the version of step 2.

CI removes the OpenMS build before these steps, so the tools can only use the package's `share/OpenMS`.
A WebDriver run of the screens (as the AppImage's smoke test) is not part of it: tauri-driver does not support
macOS, and on Windows it needs msedgedriver of the runner's WebView2 version.

### What differs on Windows in the app

- **Inputs** (ruling: no symbolic links without developer mode). OpenNuXL gets the user's paths themselves when
  the inputs' stems do not clash (ignoring case, as NTFS does): the shim names each input's outputs after its
  stem (`nuxl/<stem>.idXML`, and OpenNuXL derives `<stem>_perc_...`), so two inputs clash when they share a
  stem, or when one stem is another's followed by `_` (`a` and `a_perc`). Inputs that clash go in as hard links
  `<n>__<name>` in the search folder, which works on the volume of the app's data only and is removed when the
  search ends; on another volume the search is refused with a message asking to rename one of the files. Nothing
  is ever copied (`args.rs`, `InputLinks`, `input_placements`). Stems are shortened (as links) so that the longest
  output path, `<folder>\nuxl\<stem>_perc_proteins0.0100_XLs.tsv`, stays within MAX_PATH.
- **Cancel** ends a job object the tool runs in (`run.rs`): Windows has no SIGTERM for a console tool; the job
  takes every process the tool starts (PercolatorAdapter), and it is closed with the app (`KILL_ON_JOB_CLOSE`), so
  OpenNuXL ends with the app however the app ends. The tool runs without a console window.
- **If the app dies** while OpenNuXL runs: on Linux OpenNuXL gets SIGKILL (`PR_SET_PDEATHSIG`), on Windows the job
  ends it. macOS has no death signal, so the app starts, for each run of the tool, its own executable once more as
  a watchdog (`--watch-search <app pid> <the tool's process group>`, `src-tauri/src/watchdog.rs`, std and two
  libc calls): it looks once a second whether the app is still its parent (an orphan's parent becomes launchd)
  and ends the tool's group with SIGKILL when it is not; the app ends the watchdog with the run. Should the
  watchdog not start, OpenNuXL still ends at its next write to stdout or stderr, whose reading ends died with the
  app (SIGPIPE is at its default in the tool: Rust's `Command` resets the app's ignored SIGPIPE in the child, and
  OpenMS sets no handler), at the end of its current step. The next start of the app sweeps the folder. The
  watchdog's code is the same on every Unix and is tested on Linux and in the macOS shim job
  (`tests/watchdog.rs`, and a watched search in `tests/shim.rs`).
- **Folders**: `finish_partial` retries the rename with back-off (another instance's sweep may hold the
  deleted `.lock` open), and partial folders are removed lock file first, also with back-off (`history.rs`).
- **File names** the app suggests never are device names (`CON`, `NUL.txt`, ...: a `_` in front), and their
  name part has at most 200 bytes in UTF-8 (`fileSafe`), so that a suffix still fits ext4's and NTFS's 255.
- The shim's tests run on Windows with `examples/fake_nuxl.rs`, the shell fake as a program
  (`NUXL_FAKE_EXE=1` uses it on Linux and macOS too).

## Packages

```bash
native/scripts/package-linux.sh        # .deb and AppImage into src-tauri/target/release/bundle
```

The same script runs in CI and here (it enters `in-env.sh` when the sysroot exists). The `.deb` is Tauri's
(package `nuxl`; it depends on the system's WebKitGTK; the tools go to `/usr/lib/NuXL/resources/nuxl`, the .NET
runtime to its `dotnet/`: no .NET package dependency, and no ICU, as the tools run with invariant globalization). The
AppImage is bundled by Tauri without `resources/nuxl` and the folder is added afterwards, and the AppDir packed
again with linuxdeploy's AppImage plugin: linuxdeploy treats every ELF file in the AppDir as its own, and would
copy the tools' closure a second time into `usr/lib` and turn its `DT_RPATH` into a `RUNPATH`. With the sysroot,
the script also answers the GTK plugin's `pkg-config --variable` queries with `/usr` paths and puts WebKit's
helper processes into the AppDir with the relative helper path the GTK plugin writes on a normal system (details
in the script). linuxdeploy thus never sees the .NET runtime's ELF files either; the script checks that the
AppImage's and the `.deb`'s `nuxl/dotnet` are the bundle's files unchanged, and that both have FileConverter and the
Thermo bridge's managed folder.

## AppImage smoke test

```bash
native/scripts/smoke-appimage.sh src-tauri/target/release/bundle/appimage/NuXL_0.1.0_amd64.AppImage \
  --hide-openms <OpenMS checkout>/build
```

The AppImage runs with `--appimage-extract-and-run` under `xvfb-run` and is driven through WebDriver
(`e2e/appimage.smoke.ts`): the example is searched and its results shown. tauri-driver and WebKitWebDriver are not
in the AppImage; they run from the toolchain (here `in-env.sh`, in CI the runner's packages) and drive the
AppImage's own webview over WebKit's automation protocol, which release builds allow when
`TAURI_WEBVIEW_AUTOMATION=true` (tauri-driver sets it). The application tauri-driver starts is
`e2e/appimage-app.sh`, which runs the AppImage from an empty environment (display, user basics, the automation
variables, a plain PATH; nothing of the sysroot, no `NUXL_TOOL`). The test then reads `/proc/<pid>/maps`:
OpenNuXL (polled while it searches) maps its whole closure from the bundle, one OpenMP runtime, and from the system
only glibc; the app, WebKitWebProcess and WebKitNetworkProcess map libwebkit2gtk from the AppImage; no process maps
a file of the sysroot or the OpenMS build (`SMOKE_FORBIDDEN`). `--hide-openms` renames the OpenMS build's
`share/OpenMS` and tool registry for the duration of the test, so the tools have to use the bundle's.

The one thing a host must have that the AppImage does not bring is the GL driver stack, as for every AppImage:
libEGL, libGL and libGLESv2 (`libgles2` on Ubuntu/Debian, `libglvnd-gles` on Fedora; desktops have it). The
smoke test checks the other side too: the app and WebKit's processes map none of the GUI stack the AppImage
brings (WebKitGTK, JavaScriptCore, libsoup, GTK, GDK, GLib) from the host, which matters on the CI runner, where
WebKitGTK is installed, and from the host nothing beyond an allowlist (glibc and the GCC runtime, the GL driver
stack, the X11/xcb/Wayland client libraries, fonts and text). ibminode06 is a server without `libgles2`, so
the script supplies the sysroot's `libGLESv2.so.2`, alone in a folder of its own, and reports it.

## CI

Jobs: `linux` (x64 and arm64, below), `macos` and `windows` (see "macOS and Windows": each builds OpenMS when its
bundle is not cached, with vcpkg's binary cache and ccache; the vcpkg dependencies are built by a configure step of
their own and saved before OpenMS is built, so a first run that runs out of time keeps them), `shim` (`cargo test`
on macOS and Windows, minutes after a push) and `release`. Concurrency is per job and platform: a push waits for
the running build of its platform instead of cancelling it. GitHub keeps at most 10 GB of Actions caches per
repository and evicts the least recently used beyond that; ccache's objects are saved under a key per run
(`…-<run id>-<attempt>`) and vcpkg's binary cache under the hash of its content, so each failed or changed build
adds an entry: delete the superseded ones (`gh cache list`, `gh cache delete`) when the total nears the limit.

The `linux` job of `.github/workflows/desktop.yml` (branch `main`) is a matrix of two architectures with the same
steps: x64 on `ubuntu-22.04` (vcpkg triplet `x64-linux-dynamic`, artifact `nuxl-desktop-linux`) and arm64 on
`ubuntu-22.04-arm`, GitHub's arm64 runner for public repositories (`arm64-linux-dynamic`, OpenMS's own arm64
triplet, which builds OpenBLAS for any ARMv8 CPU; artifact `nuxl-desktop-linux-arm64`). Both are Ubuntu 22.04, so
both packages need glibc 2.35. Each job checks out OpenMS at `OPENMS_COMMIT`, builds the vcpkg dependencies (a
configure step of their own, saved before OpenMS is built, as on macOS and Windows) and libOpenMS, OpenNuXL,
PercolatorAdapter and FileConverter with GCC 13 (toolchain PPA) through `build-openms.sh`, bundles them, runs
svelte-check, vitest and `cargo test` (with the bundled OpenNuXL, so the `real_nuxl` tests run too), builds the packages with
`package-linux.sh`, runs the smoke test and uploads the AppImage and the `.deb` (kept 14 days). Tauri downloads
linuxdeploy, its AppImage plugin and AppRun for the machine's architecture (none of them checksum-verified, on
either architecture: Tauri's own downloads).

**.NET SDK.** Every platform's OpenMS build installs a .NET SDK 8.0.x with `actions/setup-dotnet` (only when the
bundle is not cached) for the Thermo bridge; on Linux after the disk-space step, which removes the runner image's
`/usr/share/dotnet`. The action exports `DOTNET_ROOT` for the later steps too; the tests do not depend on it, as the
app points the tools at the bundle's own runtime.

**The vendor test data.** Before the `real_nuxl` tests, each packaging job (Linux x64 and arm64, macOS, Windows)
runs `scripts/fetch-test-data.sh`: PNNL's Thermo `Angiotensin_AllScans.raw` (BSD-2-Clause; from archive.openms.de,
else from PNNL-Comp-Mass-Spec/Thermo-Raw-File-Reader at commit 1d8ff309) and the Bruker `DDA_HeLa_50ng_5_6min.d`
(the zip from archive.openms.de, unpacked), as OpenMS's own tests use them, checked against pinned SHA-256s and
cached (key: the script's hash; saved only when both are there). It exports `NUXL_RAW_EXAMPLE` and `NUXL_D_EXAMPLE`
for the later steps: the `real_nuxl` tests search each through the shim with the bundled OpenNuXL and convert its
spectra with the bundled FileConverter (so every platform's bundled .NET runtime reads a real `.raw`), and on macOS
and Windows `start-test.sh` converts both with the installed package. A file that cannot be downloaded (the server
has answered on plain HTTP only, and not to every network) skips the tests that need it, with a `::warning::` and a
line in the run's summary, instead of failing the build.

Caches (`actions/cache`) belong to the ref that saved them and are readable from that ref and the default branch
(`main`) only. The runs of `main` share them, per runner and triplet: the bundled OpenNuXL (key: the pin, the
triplet and the scripts that make it, `fetch-dotnet-runtime.sh` with the .NET runtime's pin among them), so OpenMS
is only built when one of them changes, and vcpkg's binary cache
(key: the pin and the triplet, plus the hash of its content, so the packages built before a failure are kept;
restored from an earlier pin's when the pin moves). Pull requests read `main`'s caches; their own saves stay with
the pull request.

A tag `desktop-native-v*` builds nothing (it releases the packages that were built and tested on `main`): its
release job looks up the successful `main` run of the tagged commit, downloads that run's packages, the ones its
tests, smoke test and start tests passed on, and makes a draft release of them. All six packages are required (the
AppImage and the `.deb` of Linux x64 and of arm64, the `.dmg`, the Windows installer), each from its platform's
artifact; the release carries them under their versioned names only (`NuXL_0.1.0_x64-setup.exe`,
`NuXL_0.1.0_aarch64.dmg`, ...). It fails with a message when there is no such run (tag a commit of `main` whose run
passed), a package is missing or its artifact has expired (`gh run rerun <run>`, then re-run the release job).

The tag can also be made from the web: Actions › "Tag release" (`.github/workflows/tag-release.yml`) › Run workflow,
with the version (e.g. `0.1.0`). It checks that `main`'s head is that version and that its `main` run passed, tags
it `desktop-native-v<version>` (never moving an existing tag), and starts `desktop.yml` on the tag, whose release
job then makes the draft release. (A tag made with a workflow's own token starts no workflow by itself.)

To publish the draft, either click Publish on GitHub or run Actions › "Publish release"
(`.github/workflows/publish-release.yml`) with the version. It publishes only the one draft release of
`desktop-native-v<version>` whose tag is on `main` and which carries all six packages, and marks it the latest
release; anything else stops it with a message.

A whole release in one run: "Tag release" with `publish` checked tags `main`, waits for the release job and then
publishes the draft. Before that, the version is set on `main` with `node scripts/bump-version.mjs <version>` (through a
pull request). The steps for a Claude session are in `CLAUDE.md`, "Releasing".
