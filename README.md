# ProSE desktop

A desktop app for the ProSE search engine of OpenMS: [Tauri 2](https://tauri.app) around the OS webview, the
native `ProSE` command-line tool as the only native code, and the screens of the ProSE web app (same theme,
shadcn-svelte components and colours). Design and plan: `docs/superpowers/`.

The packages come from CI (`.github/workflows/desktop.yml`); they bundle ProSE with its libraries and the PeptDeep
models (`native/README.md`). Everything runs on the computer: the app makes no network connection (ProSE's
update check is off, `native/README.md`).

## Install

**macOS** 15 or later, Apple silicon (arm64; Intel Macs are not supported): the `.dmg`. Drag ProSE to
Applications, then, once, in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/ProSE.app
```

The app is signed ad hoc only (no Developer ID, not notarized), so macOS refuses to open it until then. The other
way: open it once (it is refused), then System Settings > Privacy & Security > "Open Anyway".

**Windows** 10 (1903 or later) or 11, x64: the installer `ProSE_<version>_x64-setup.exe`, for the current user,
without administrator rights. It is not signed: SmartScreen asks once ("More info" > "Run anyway"). The app uses
Microsoft Edge WebView2, which Windows 11 and an updated Windows 10 have (the installer fetches it otherwise).

**Linux** x64 or arm64 (64-bit ARM: for example a Raspberry Pi 5 with a 64-bit system, ARM servers, ARM laptops),
Ubuntu 22.04 or later (and other distributions with glibc 2.35 or later): the AppImage runs as it is
(`chmod +x ProSE_<version>_amd64.AppImage`; on arm64 `ProSE_<version>_aarch64.AppImage`), or the `.deb` installs
with `sudo apt install ./ProSE_<version>_amd64.deb` (on arm64 `ProSE_<version>_arm64.deb`; package `prose`). The
AppImage needs one library of the system: OpenGL ES, `libGLESv2.so.2`, which desktop
installations have (the `.deb` pulls it in with WebKitGTK). Without it the app exits at once with exit code 127
("Couldn't open libGLESv2.so.2"). Install it with `sudo apt install libgles2` (Ubuntu, Debian) or `sudo dnf install
libglvnd-gles` (Fedora).

## System requirements

- A 64-bit processor and system as above; the packages take about 200 MB (ProSE and its libraries 173 MB, the
  PeptDeep models among them).
- Memory as the search needs it: ProSE has no limit of its own. The example takes well under 1 GB; a semi-tryptic
  TMT search of a 78 MB mzML against the human reference proteome (no database chunks) peaked at 7.1 GB. Larger
  searches can split the database (Settings › Advanced, `database:chunk_size`). The results are read into the
  app's page: see "Known limitations".
- Disk: each search keeps ProSE's QPX outputs, most of it the spectra of the PSMs (the QPX mz view of each input: the
  100 most intense peaks per 100 m/z and every annotated peak): about 3.6 MB per thousand PSMs of an Orbitrap HCD
  run with ~1,100 peaks per MS2 spectrum (2.8 MB the input's mz view, 0.5 MB its psm file with PeptDeep's
  predictions, 0.3 MB the merged psm file of all inputs), under 1 MB for the example.

## Where the data is

- The searches (History): a folder per search in the app's data folder, `searches/<id>/`: ProSE's outputs, the
  record `search.json`, `proteins.fasta` (the proteins of the result, so that the search opens without its
  database) and links to the inputs. The app's data folder is
  - Linux: `~/.local/share/org.openms.prose.desktop/` (`$XDG_DATA_HOME`)
  - macOS: `~/Library/Application Support/org.openms.prose.desktop/`
  - Windows: `%APPDATA%\org.openms.prose.desktop\`
- The log of the last search that failed: `logs/last-failure.log` there (the error names it).
- Presets: the app's webview keeps them, on this computer.
- The mzML and FASTA files are read where they are: never copied, and nothing is written beside them. Deleting a
  search in History removes its folder; uninstalling leaves the data folder, which can be deleted by hand.

## Project files

Export › Project (`.prose`) writes a search as one zip, which Open project (History) opens on another computer.
It holds the search's folder as the app keeps it: ProSE's outputs (the QPX Parquet files, the idXML, the
open-search tables), `search.json`, `proteins.fasta`, and `inputs.json` with the files' names only. Left out are
ProSE's log, the database copy with the contaminants and `database.json` (the path of a database searched without
them). **ProSE's outputs name folders of the computer that searched** (e.g. the database's path and all of ProSE's
parameters in the QPX provenance view, the input and database paths in the idXML), and the project carries them as they are: share it
where that is fine. A search saved by an earlier version of the app (with `summary.yaml` and OpenMS' own Parquet
files, or without the QPX run and provenance views) does not open in this one: History and Open project say so. A project file holds at
most 3 GB (larger searches are refused with a message; they stay in History).

## Known limitations

- **Large results.** The page reads a search's PSM rows into memory (`quantms.psm.parquet` through the app's IPC,
  decoded into the tables, column by column, without an object per row); the peaks and predictions of a PSM are
  read from its input's mz view and psm file when the PSM is opened (one row group of 256, the last four kept), so
  they do not count. The computer's memory bounds the largest result that opens. Measured with saved searches of one
  input made of the rows of a real Orbitrap HCD search (iPRG2015, 20,716 PSMs, ~30 scores and features per PSM,
  modifications on most rows) repeated (`e2e/large.spec.ts`; WebKitGTK 2.52 on Linux, a 128-core machine; the files
  hold the spectra of the original search only, which are not read at open):

  | PSMs | opens in | memory of the web process |
  | --- | --- | --- |
  | 500,000 | 6 s | 1.6 GB |
  | 1,000,000 | 13 s | 2.8 GB |
  | 2,000,000 | 34 s | 4.5 GB |
  | 4,000,000 | 105 s | 8.6 GB |
  | 8,000,000 | 382 s | 16.7 GB |

  About 2.1 GB per million PSMs: a computer with 16 GB opens about 5 million, with 32 GB about 10 million (no larger
  result was tried). The memory figures are lower bounds, so these counts are upper estimates. The repeated rows share
  their native-ID strings and have only the search's 20,000 distinct peptides, so a real search of as many distinct
  spectra and peptides needs somewhat more memory (estimated +10–20 %). Opening the first PSM of an input also maps
  its native IDs to the spectra for a moment. The PSM rows take about 0.3 MB of disk per thousand PSMs, the spectra
  2.8 MB (not read at open).
  On Windows the webview (WebView2) runs Chromium's JavaScript engine, whose arrays are smaller (an earlier
  measurement in Node.js, the same engine, read 4 million synthetic PSMs but not 8 million), so there the limit may
  be lower; macOS' webview is WebKit, as on Linux. Project files are written to disk entry by entry (after the save
  dialog), but read in memory when opened, and hold at most 3 GB (no zip64 is written or read; a larger search is
  refused with a message). Later, not now: reading the project zip entry by entry (with zip64).
- macOS: Apple silicon only; not signed with a Developer ID (see Install).
- Windows: two inputs of one name are searched together only when they are on the drive of the app's data.

## The example

"Try the example" in New search loads OpenMS' example run `Ecoli_MS2_small.mzML` (E. coli, LTQ Orbitrap XL, CID,
139 MS2 spectra, 1.2 MB) twice, as two replicates of one condition, and the 4,136 E. coli K-12 proteins (targets
only: ProSE adds the decoys, the app the cRAP contaminants). The settings are the default preset with a fragment
tolerance of 0.5 Da for the ion-trap fragments, a PSM FDR of 2 % and the protein FDR off: the run is too small for a
PSM FDR of 1 % (Percolator's q-values are (decoys + 1) / targets, so its ~80 PSMs reach 1.2 % at best, and none would
pass 1 %) and for a protein FDR, so its proteins are listed without one (Overview says "not applied"). Leaving the
example (other files or another database, Remove all, Start over) gives these settings back to the preset's, unless you
changed them. The search takes a few seconds and finds 77 target PSMs at 2 % FDR in each replicate (64 peptides, 61
proteins), with precursor errors between −6 and +8 ppm (median 4.1 ppm) and a few isotope errors. The run also has too
few PSMs for Percolator's full model: Percolator falls back to its best single feature (Overview says why).

## Licence

ProSE desktop is under OpenMS' licence (BSD-3-Clause, `LICENSE`). The packages list everything they bundle, with its
licence, in `resources/notices/THIRD-PARTY-NOTICES.txt`; the ProSE tool's libraries come with theirs in
`resources/prose/share/OpenMS/LICENSES`. The example is OpenMS example data. OpenMS logo © OpenMS Inc., used with
permission (the OpenMS Assets License, `src/assets/logo`).

## Develop (ibminode06, no root)

Everything runs inside the user-space toolchain of `native/scripts/in-env.sh` (Rust, the WebKitGTK 4.1 sysroot,
Node 24.19.0, `tauri-driver`); see `native/README.md` for how it is built. `/scratch` is node-local and purged.

```bash
npm install
native/scripts/in-env.sh npm run tauri:build:debug      # debug binary, no bundle: src-tauri/target/debug/prose-desktop
native/scripts/in-env.sh npm run check                  # svelte-check and tsc
native/scripts/in-env.sh e2e/run.sh [e2e/smoke.spec.ts] # WebdriverIO via tauri-driver + WebKitWebDriver, under xvfb-run
native/scripts/in-env.sh e2e/run.sh e2e/screens.shot.ts # screenshots into docs/screens
```

Packages and their smoke test (needs the OpenMS build of `native/scripts/build-openms.sh`):

```bash
native/scripts/bundle-prose.sh /scratch/sachsenb/openms-desktop/build src-tauri/resources/prose
native/scripts/package-linux.sh                                    # .deb and AppImage
native/scripts/smoke-appimage.sh src-tauri/target/release/bundle/appimage/ProSE_0.1.4_amd64.AppImage \
  --hide-openms /scratch/sachsenb/openms-desktop/build
```

`e2e/run.sh` builds the debug binary first (`E2E_SKIP_BUILD=1` skips that) and enters `in-env.sh` itself if it
is not in it.

The specs that run searches need the tool: `PROSE_BIN=/path/to/ProSE` (without it they skip); the bundled one,
`src-tauri/resources/prose/bin/ProSE`, is the one with PeptDeep (its build manifest says so, see `native/README.md`). Each spec file
gets an app of its own with its own data folder (`XDG_DATA_HOME`, made per run, removed at its end), and
`tauri-driver` runs for the whole run in a process group of its own; port 4444 must be free (a leftover
`tauri-driver` stops the run with a message). Debug builds read `PROSE_TEST_DIALOG_PATH` in place of the
system's save and open dialogs (`e2e/app.sh` sets it), since WebDriver cannot reach a dialog. The large search
(`e2e/big.spec.ts`) runs only with `PROSE_BIG=1`; it logs its time and ProSE's peak memory. The measurement of
large results (`e2e/large.spec.ts`, "Known limitations") runs only with `PROSE_LARGE_DIR`, the folder of the
synthetic searches that `src/lib/results/read.test.ts` writes on demand (both headers say how).

Host tools of the e2e specs: `xvfb-run`, and for `closing the window ends ProSE` (a window-manager close request
sent to the app's window) `xwininfo`, `xprop` and `python3` with libX11 (`e2e/close-window.py`); without them that
test skips with a message. Run one test of a spec with
`native/scripts/in-env.sh e2e/run.sh e2e/paths.spec.ts --mochaOpts.grep 'mzML.gz'`.
