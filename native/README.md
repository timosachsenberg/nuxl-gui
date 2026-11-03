# Native engine and Tauri toolchain

The ProSE desktop app (Tauri 2) runs on a native C++ engine built against OpenMS. This
directory holds the tooling for the two things that engine needs: a user-space toolchain for the
Tauri and Rust side, and a native OpenMS build that the C++ engine compiles against.

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

`scripts/build-openms.sh <openms-src> <build-dir>` configures and builds libOpenMS, the
`ProSE` tool and the ProSE class tests with the host toolchain (outside `in-env.sh`):

```bash
native/scripts/build-openms.sh /scratch/sachsenb/openms-pr10564 \
  /scratch/sachsenb/openms-pr10564/build/native-release
```

It uses Ninja, a Release build, the vcpkg toolchain of the OpenMS checkout
(`x64-linux-dynamic`, feature `onnxruntime`) and a vcpkg binary cache in
`/scratch/sachsenb/vcpkg-bincache-native`, so a rebuild in a fresh directory does not rebuild
the dependencies. `JOBS` (default 100) sets the parallelism. Notes on the configuration:

- `WITH_THERMO_RAW=OFF`: the Thermo bridge needs dotnet. `WITH_OPENTIMS=OFF`, `WITH_GUI=OFF`,
  `ENABLE_DOCS=OFF` and `PYOPENMS=OFF` leave out what the app does not use.
- `ENABLE_UPDATE_CHECK=OFF`: an OpenMS tool otherwise contacts `openms-update.cs.uni-tuebingen.de` once a day
  (and waits up to 5 s for it when offline), and the app makes no network contact. The app also runs every
  ProSE with `OPENMS_DISABLE_UPDATE_CHECK=ON` (`src-tauri/src/tool.rs`), for a tool from `PROSE_BIN` or the PATH.
- `PATH` is rebuilt without linuxbrew: its binutils (`as` 2.36) cannot assemble the
  AVX-NE-CONVERT code in ONNX Runtime.
- The targets include `FileInfo`, `ParquetDiff` and `FuzzyDiff` (the `TOPP_ProSE` tests run them)
  and `PeptDeepLibraryPredictor_test`; without them those tests report "Not Run".
- The build directory is `build/native-release` inside the OpenMS checkout, next to the wasm
  build directories, which it does not touch.

Check the build with the ProSE class tests (83 tests):

```bash
ctest --test-dir /scratch/sachsenb/openms-pr10564/build/native-release \
  -R "ProSE|PeptDeep|OpenSearchModificationAnalysis|Percolator_test" -j 32 --output-on-failure
```

## The OpenMS pin

`OPENMS_COMMIT` holds the full hash of the OpenMS commit the app's ProSE is built from: a commit of `develop`, which
since #10676 (`-qpx_extended`, the optional columns and footer metadata of the QPX psm view the app reads: all scores,
native ID, isotope error, protein mappings, the filtered peaks and PeptDeep's predictions, the run's statistics; the
pooled and singleton protein groups, `-keep_decoys`; see `docs/parity.md`) has everything the app needs. Before, the pin
was the branch `claude/prose-desktop-pin` (develop with the pull requests not merged yet). The per-input QPX files are in
`qpx/runs/`; the reader also reads the layout of app 0.1.x (per-input files next to `quantms.*`). CI checks the commit out
of OpenMS/OpenMS; it never builds from local state. Build it with

```bash
native/scripts/build-openms.sh <OpenMS checkout at the pin> <OpenMS checkout>/build
```

and check it with `ctest --test-dir <OpenMS checkout>/build -R "ProSE|PeptDeep|QPX|Percolator_test|ArrowIOHelpers_test|ArrowSchemaRegistry_test"`
(with the default targets plus `ArrowSchemaRegistry_test` and `QPXDatasetExport_test`). Then make the parameter table
(`scripts/prose-parameters.mjs`) and the reader's fixtures (`scripts/results-fixture-native.mjs`) with its ProSE again.

## Bundling ProSE

`scripts/bundle-prose.sh <openms-build> <out>` (host toolchain) fills `<out>`, normally
`src-tauri/resources/prose` (git-ignored; `tauri.conf.json` bundles the folder, and `build.rs` makes an empty
one so builds without it work), with what the app ships:

```bash
native/scripts/bundle-prose.sh /scratch/sachsenb/openms-desktop/build src-tauri/resources/prose
```

| Part | What |
| --- | --- |
| `bin/ProSE` | stripped, `DT_RPATH` `$ORIGIN/../lib` |
| `lib/` | the whole closure that `ldd` lists, under its sonames, stripped, `DT_RPATH` `$ORIGIN`: libOpenMS, ONNX Runtime, Arrow/Parquet, the AWS SDK Arrow links, Xerces, HiGHS, ..., libgomp (the one OpenMP runtime; the script fails on any other) and the GCC runtime (libstdc++, libgcc_s: OpenMS needs GCC 13, newer than Ubuntu 22.04's). Left out: glibc only. |
| `share/OpenMS/` | `CHEMISTRY` (without the 49 MB of HMDB tables), `CV`, `MAPPING`, `SCHEMAS`, the `TOOLS` registry: what ProSE reads (checked with strace) |
| `share/OpenMS/models/` | `peptdeep_ms2_dynamic.onnx`, `peptdeep_rt_dynamic.onnx` (builds with ONNX), AlphaPeptDeep's models under the Apache License 2.0: `LICENSE-AlphaPeptDeep.txt` (`native/licenses/`) and `NOTICE.txt` |
| `share/OpenMS/LICENSES/` | OpenMS, its vendored code, every vcpkg port, the bundled system packages (GCC runtime) |
| `build.json` | the manifest: OpenMS commit, `withOnnx` (from `WITH_ONNX` in the CMakeCache), triplet, the models |

`DT_RPATH`, not `RUNPATH`: it is searched before `LD_LIBRARY_PATH`, so the AppImage's library path (its
`usr/lib`, with WebKit's dependencies) cannot swap in a different libzstd or libssl. The script checks that
every library resolves into the bundle, also with the build's library directories on `LD_LIBRARY_PATH`, and that
the tool runs from an empty environment. It refuses a build whose source is not at `OPENMS_COMMIT`
(`ALLOW_PIN_MISMATCH=1` overrides).

**Where ProSE finds share/OpenMS.** OpenMS tries paths compiled into it first: the install prefix
(`/usr/local/share/OpenMS`), then the source tree's `share/OpenMS` and, for the PeptDeep models, the build tree;
only then `bin/../share/OpenMS` next to the executable, and the `OPENMS_DATA_PATH` variable last of all. So
setting `OPENMS_DATA_PATH` cannot steer the bundled tool, and the app does not set it. The bundled tool must not
pick up an OpenMS a user installed in `/usr/local`, so `bundle-prose.sh` overwrites that one string in the
bundle's `libOpenMS.so` with a path of the same length that cannot exist (`/dev/null////...`), as conda does with
the prefix (OpenMS reads it through a volatile pointer for this; `File.cpp`, `installPath_`). The source and build
tree paths are the build machine's (in CI below `/home/runner/work`) and cannot be patched (GCC writes them into
the code as immediates); they do not exist on a user's machine. On the build machine they do, so the smoke test
hides them (`--hide-openms`, below).

**The `onnx` flag of `tool_info`** comes from `build.json`: `withOnnx` and every model it names present inside
the bundle (`src-tauri/src/tool.rs`, `has_onnx`). A tool without a manifest (a build tree's, one on the PATH)
counts as without ONNX, so `PROSE_BIN=src-tauri/resources/prose/bin/ProSE` is the tool for the e2e specs and
`real_prose` tests with PeptDeep.

## macOS and Windows

CI builds both (`.github/workflows/desktop.yml`, jobs `macos` and `windows`); there is no local machine for
them. The same scripts run there:

| Step | macOS (macos-15, arm64) | Windows (windows-2025, x64) |
| --- | --- | --- |
| OpenMS | `build-openms.sh` with `VCPKG_TRIPLET=arm64-osx-dynamic-sysroot-vcrel` (OpenMS's own macOS triplet, release builds only), `OPENMS_CMAKE_ARGS="-DOpenMP_ROOT=$(brew --prefix libomp) -DMT_REQUIRE_OPENMP=ON"`, `MACOSX_DEPLOYMENT_TARGET=15.0` | `build-openms.sh` in Git Bash inside Visual Studio's developer environment, `CC=CXX=cl`, `VCPKG_TRIPLET=x64-windows-static-md-release` (OpenMS's own Windows triplet: the dependencies static, the C runtime dynamic), `-DMT_REQUIRE_OPENMP=ON` |
| bundle | `bundle-prose.sh`: `bin/ProSE`, `lib/*.dylib` | `bundle-prose.sh`: `bin/ProSE.exe`, `bin/*.dll` |
| package | `package-macos.sh`: `ProSE.app`, `.dmg` | `package-windows.sh`: the NSIS installer `*-setup.exe` |
| test | `start-test.sh <dmg>`; `cargo test --test real_prose` with the bundled tool | `start-test.sh <setup.exe>`; the same |

**Apple silicon only.** The macOS build is arm64, not universal: OpenMS's vcpkg setup and its own CI cover
arm64-osx only, and the OpenMP runtime is Homebrew's libomp, which is arm64 on the arm64 runners. A universal
build would need a second OpenMS build on an Intel runner (`macos-15-intel`, x64-osx), merged dylib by dylib
with `lipo`, and an x86_64 libomp; that doubles the build and was left out. Intel Macs are not served.

**macOS 15 or later.** `MACOSX_DEPLOYMENT_TARGET` is the runner's macOS, as in OpenMS's CI: Homebrew's
libomp is built for it. `bundle-prose.sh` writes the newest minimum macOS of the bundled files into
`build.json` (`minimumMacos`), and `package-macos.sh` refuses an app whose `minimumSystemVersion`
(`src-tauri/tauri.macos.conf.json`) is older, so an older Mac says so at once instead of failing to load a
library.

### The closures (`bundle_closure.py`)

**macOS.** The script follows the tool's load commands as dyld does: `@rpath` through the LC_RPATHs of the
loading image and of those that loaded it, `@loader_path`, `@executable_path`, absolute paths; the build's
`lib` and vcpkg's `lib` by name last. `/usr/lib` and `/System` stay out. Everything else is copied to
`lib/<name>` and rewritten with `install_name_tool`:
- every reference to a bundled dylib becomes `@rpath/<name>`, and each dylib's id `@rpath/<name>`;
- the old LC_RPATHs (the build tree's) are deleted one by one (a duplicate LC_RPATH stops dyld on arm64);
- one LC_RPATH is added: `@loader_path/../lib` for the tool, `@loader_path` for the dylibs;
- then `strip -x` and an ad-hoc signature (`codesign -s -`): arm64 runs no unsigned code, and
  `install_name_tool` invalidates the linker's signature.

Exactly one OpenMP runtime, `libomp.dylib`, has to be in the closure. FASTag's approach is the same (one
libomp, rewritten install names, ad-hoc re-signing; okohlbacher/FASTag `doc/SIGNING-macos-gui.md`), without
dylibbundler. `macho-verify` checks a bundle again, also the copy inside `ProSE.app`. The app passes no
`DYLD_*` search variable to the tool (`tool.rs`): they are searched before `@rpath`.

**Windows.** OpenMS links its vcpkg dependencies statically, so ProSE's closure is OpenMS's own DLLs
(`OpenMS.dll`, `OpenMS_CLI.dll`, `OpenSwathAlgo.dll`) and the Visual C++ runtime: `msvcp140*.dll`,
`vcruntime140*.dll` and `vcomp140.dll`, MSVC's OpenMP runtime, the one OpenMP runtime. The script reads the
import and delay-import tables of each PE file itself, takes the DLLs from the build's `bin`, vcpkg's `bin` and,
for the runtime, from the redistributable folders of the Visual Studio that built it (`VCToolsRedistDir`:
Microsoft's app-local deployment), and leaves out API sets and the DLLs of Windows. Everything goes beside
`ProSE.exe`: Windows has no RPATH, and the folder of the exe is searched first. `pe-verify` checks that every
import is bundled or Windows' own. `ProSE.exe`'s manifest gets `activeCodePage` UTF-8 (`mt.exe`): OpenMS takes
narrow strings, paths among them, for UTF-8, but a Windows process otherwise gets its arguments and narrow file
APIs in the ANSI code page, and a search in a folder named `Größe ü` (or under a user `Jörg`) read its inputs
wrongly and ended in Percolator's "median decoy score <= score at 1% FDR".

**The install prefix** is overwritten in the bundled `libOpenMS.dylib` as on Linux, with `/dev/null///...`. On
Windows OpenMS does not probe its install prefix at all (`File.cpp`: CMake's default prefix is the wrong
`(x86)` tree), and the string is not in `OpenMS.dll`; should it ever be, it is overwritten with
`<no-install-path>///...` (`<` cannot be part of a Windows path).

### Packages

- **macOS**: `ProSE.app` and the `.dmg`. Tauri copies `resources/prose` into
  `ProSE.app/Contents/Resources/resources/prose` unchanged. The app is signed ad hoc
  (`signingIdentity: "-"`, no hardened runtime): no Developer ID and no notarization. An ad-hoc signed app can
  be opened after the user's consent (System Settings > Privacy & Security > Open Anyway, or
  `xattr -dr com.apple.quarantine`); an unsigned arm64 app counts as damaged.
- **Windows**: the NSIS installer, per user (`installMode: currentUser`, no administrator rights), unsigned
  (SmartScreen asks once). ProSE goes to `<install folder>/resources/prose/bin`.

### Start test (`start-test.sh <package> <example-dir>`)

1. The package is opened as a user would: the `.dmg` is mounted and `ProSE.app` copied out; the installer is
   run silently (`/S /D=<folder>`). The bundle inside is verified (`macho-verify`, `pe-verify`).
2. The bundled ProSE prints its version from an empty environment (Windows: only Windows' folders on `PATH`).
3. It searches the example (`Ecoli_MS2_small.mzML`, `Ecoli_K12_proteome.fasta`) from the command line, in a folder
   with a space in its name, with the example's settings, Percolator and PeptDeep: exit 0, the outputs the app
   reads, the `[PeptDeepRescoring] Predicted features added` line, and more than 40 target PSMs at the example's 2 %
   FDR (81 with these settings; the run is too small for 1 %, see the README's "The example"). The same in a folder named `Größe ü` has to give the same number.
4. The app starts with `--smoke-test` (`src-tauri/src/lib.rs`): when its page has loaded it prints
   `{"page", "tool"}` (`tool_info`) and exits. The tool has to be the package's own, with ONNX, and of the
   version of step 2.

CI removes the OpenMS build before these steps, so ProSE can only use the package's `share/OpenMS`.
A WebDriver run of the screens (as the AppImage's smoke test) is not part of it: tauri-driver does not support
macOS, and on Windows it needs msedgedriver of the runner's WebView2 version.

### What differs on Windows in the app

- **Inputs** (ruling: no symbolic links without developer mode). ProSE gets the user's paths themselves when
  the inputs' stems differ (ignoring case, as NTFS does; `.mzML` and `.mzML.gz` of one name clash). Inputs that
  share a stem go in as hard links `<n>__<name>` in the search folder, which works on the volume of the app's
  data only and is removed when the search ends; on another volume the search is refused with a message asking
  to rename one of the files. An input of stem `quantms` goes in as such a link as well: ProSE refuses it, since
  its merged QPX views are `quantms.*.parquet`. Nothing is ever copied (`args.rs`, `InputLinks`,
  `input_placements`). The app's own example is a hard link, or a copy where the app is on another drive than its
  data.
- **Cancel** ends a job object the tool runs in (`run.rs`): Windows has no SIGTERM for a console tool; the job
  takes every process the tool starts, and it is closed with the app (`KILL_ON_JOB_CLOSE`), so ProSE ends with
  the app however the app ends. The tool runs without a console window.
- **If the app dies** while ProSE runs: on Linux ProSE gets SIGKILL (`PR_SET_PDEATHSIG`), on Windows the job
  ends it. macOS has no death signal, so the app starts, for each search, its own executable once more as a
  watchdog (`--watch-search <app pid> <ProSE's process group>`, `src-tauri/src/watchdog.rs`, std and two libc
  calls): it looks once a second whether the app is still its parent (an orphan's parent becomes launchd) and
  ends ProSE's group with SIGKILL when it is not; the app ends the watchdog with the search. Should the
  watchdog not start, ProSE still ends at its next write to stdout or stderr, whose reading ends died with the
  app (SIGPIPE is at its default in ProSE: Rust's `Command` resets the app's ignored SIGPIPE in the child, and
  OpenMS sets no handler), at the end of its current step. The next start of the app sweeps the folder. The
  watchdog's code is the same on every Unix and is tested on Linux and in the macOS shim job
  (`tests/watchdog.rs`, and a watched search in `tests/shim.rs`).
- **Folders**: `finish_partial` retries the rename with back-off (another instance's sweep may hold the
  deleted `.lock` open), and partial folders are removed lock file first, also with back-off (`history.rs`).
- **File names** the app suggests never are device names (`CON`, `NUL.txt`, ...: a `_` in front), and their
  name part has at most 200 bytes in UTF-8 (`fileSafe`), so that a suffix still fits ext4's and NTFS's 255.
- The shim's tests run on Windows with `examples/fake_prose.rs`, the shell fake as a program
  (`PROSE_FAKE_EXE=1` uses it on Linux and macOS too).

## Packages

```bash
native/scripts/package-linux.sh        # .deb and AppImage into src-tauri/target/release/bundle
```

The same script runs in CI and here (it enters `in-env.sh` when the sysroot exists). The `.deb` is Tauri's
(it depends on the system's WebKitGTK; ProSE goes to `/usr/lib/ProSE/resources/prose`). The AppImage is bundled
by Tauri without `resources/prose` and the folder is added afterwards, and the AppDir packed again with
linuxdeploy's AppImage plugin: linuxdeploy treats every ELF file in the AppDir as its own, and would copy ProSE's
closure a second time into `usr/lib` and turn its `DT_RPATH` into a `RUNPATH`. With the sysroot, the script also
answers the GTK plugin's `pkg-config --variable` queries with `/usr` paths and puts WebKit's helper processes
into the AppDir with the relative helper path the GTK plugin writes on a normal system (details in the script).

## AppImage smoke test

```bash
native/scripts/smoke-appimage.sh src-tauri/target/release/bundle/appimage/ProSE_0.1.4_amd64.AppImage \
  --hide-openms /scratch/sachsenb/openms-desktop/build
```

The AppImage runs with `--appimage-extract-and-run` under `xvfb-run` and is driven through WebDriver
(`e2e/appimage.smoke.ts`): the example with PeptDeep gives 154 PSMs and the PeptDeep mirror. tauri-driver and
WebKitWebDriver are not in the AppImage; they run from the toolchain (here `in-env.sh`, in CI the runner's
packages) and drive the AppImage's own webview over WebKit's automation protocol, which release builds allow when
`TAURI_WEBVIEW_AUTOMATION=true` (tauri-driver sets it). The application tauri-driver starts is
`e2e/appimage-app.sh`, which runs the AppImage from an empty environment (display, user basics, the automation
variables, a plain PATH; nothing of the sysroot, no `PROSE_BIN`). The test then reads `/proc/<pid>/maps`: ProSE
(polled while it searches) maps its whole closure from the bundle, one OpenMP runtime, and from the system only
glibc; the app, WebKitWebProcess and WebKitNetworkProcess map libwebkit2gtk from the AppImage; no process maps a
file of the sysroot or the OpenMS build (`SMOKE_FORBIDDEN`). `--hide-openms` renames the OpenMS build's
`share/OpenMS`, models and tool registry for the duration of the test, so ProSE has to use the bundle's.

The one thing a host must have that the AppImage does not bring is the GL driver stack, as for every AppImage:
libEGL, libGL and libGLESv2 (`libgles2` on Ubuntu/Debian, `libglvnd-gles` on Fedora; desktops have it). The
smoke test checks the other side too: the app and WebKit's processes map none of the GUI stack the AppImage
brings (WebKitGTK, JavaScriptCore, libsoup, GTK, GDK, GLib) from the host, which matters on the CI runner, where
WebKitGTK is installed, and from the host nothing beyond an allowlist (glibc and the GCC runtime, the GL driver
stack, the X11/xcb/Wayland client libraries, fonts and text). ibminode06 is a server without `libgles2`, so
the script supplies the sysroot's `libGLESv2.so.2`, alone in a folder of its own, and reports it.

## CI

Jobs: `linux` (x64 and arm64, below), `macos` and `windows` (see "macOS and Windows": each builds OpenMS when its bundle is not
cached, with vcpkg's binary cache and ccache; the vcpkg dependencies are built by a configure step of their own
and saved before OpenMS is built, so a first run that runs out of time keeps them), `shim` (`cargo test` on
macOS and Windows, minutes after a push) and `release`. Concurrency is per job and platform: a push waits for
the running build of its platform instead of cancelling it. GitHub keeps at most 10 GB of Actions caches per
repository and evicts the least recently used beyond that; ccache's objects are saved under a key per run
(`…-<run id>-<attempt>`) and vcpkg's binary cache under the hash of its content, so each failed or changed build
adds an entry (Windows' vcpkg cache alone is about 2.6 GB): delete the superseded ones (`gh cache list`,
`gh cache delete`) when the total nears the limit.

The `linux` job of `.github/workflows/desktop.yml` (branch `main` of timosachsenberg/prose-gui) is a
matrix of two architectures with the same steps: x64 on `ubuntu-22.04` (vcpkg triplet `x64-linux-dynamic`,
artifact `prose-desktop-linux`) and arm64 on `ubuntu-22.04-arm`, GitHub's arm64 runner for public repositories
(`arm64-linux-dynamic`, OpenMS's own arm64 triplet, which builds OpenBLAS for any ARMv8 CPU; artifact
`prose-desktop-linux-arm64`). Both are Ubuntu 22.04, so both packages need glibc 2.35. Each job
checks out OpenMS at `OPENMS_COMMIT`, builds the vcpkg dependencies (a configure step of their own, saved before
OpenMS is built, as on macOS and Windows) and libOpenMS and ProSE with GCC 13 (toolchain PPA) through
`build-openms.sh`, on x64 with GNU as 2.42 built from source for it (ONNX Runtime's AVX-NE-CONVERT code needs
as >= 2.40, Ubuntu 22.04 has 2.38; GCC gets it through `COMPILER_PATH`; MLAS's arm64 code needs nothing newer),
bundles ProSE, runs svelte-check, vitest and `cargo test` (with the bundled ProSE, so the `real_prose` tests run
too), builds the packages with `package-linux.sh`, runs the smoke test and uploads the AppImage and the `.deb`
(kept 14 days). ONNX Runtime is vcpkg's port, built from source for each triplet; Tauri downloads linuxdeploy,
its AppImage plugin and AppRun for the machine's architecture (none of them checksum-verified, on either
architecture: Tauri's own downloads).

Caches (`actions/cache`) belong to the ref that saved them and are readable from that ref and the default branch
(`main`) only. The runs of `main` share them, per runner and triplet: the bundled ProSE (key:
the pin, the triplet and the two scripts), so OpenMS is only built when one of them changes, and vcpkg's binary cache (key: the pin and the
triplet, plus the hash of its content, so the packages built before a failure are kept; restored from an earlier
pin's when the pin moves). Pull requests read `main`'s caches; their own saves stay with the pull request.

A tag `desktop-native-v*` builds nothing (it releases the packages that were built and tested on `main`): its
release job looks up the successful `main` run of the tagged commit,
downloads that run's packages, the ones its tests, smoke test and start tests passed on, and makes a draft release
of them. All six packages are required (the AppImage and the `.deb` of Linux x64 and of arm64, the `.dmg`, the
Windows installer), each from its platform's artifact; the release carries them under their versioned names only
(`ProSE_0.1.2_x64-setup.exe`, `ProSE_0.1.2_aarch64.dmg`, ...), and the web app links to the page of the latest
release (`https://github.com/timosachsenberg/prose-gui/releases/latest`). It fails with a message when there is no
such run (tag a commit of `main` whose run passed), a package is missing or its artifact has expired (`gh run rerun <run>`, then
re-run the release job).
