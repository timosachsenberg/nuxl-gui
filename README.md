# NuXL desktop

A desktop app for protein–RNA and protein–DNA cross-link searches with **OpenNuXL** of OpenMS: [Tauri 2](https://tauri.app)
around the OS webview, the native `OpenNuXL` tool (with `PercolatorAdapter` for the score recalibration, and
`FileConverter` for the spectra of Thermo `.raw` and Bruker `.d` inputs) as the only native code, and the screens
of ProSE desktop (same theme, shadcn-svelte components and colours). Design: `docs/design.md`.

The packages come from CI (`.github/workflows/desktop.yml`); they bundle OpenNuXL, PercolatorAdapter and FileConverter
with their libraries and data, the cross-linking protocols (NuXL presets) among them, and the .NET runtime that
reads Thermo `.raw` files (`native/README.md`). Everything runs on the
computer. The app's only network connection is its new-version check: one request to GitHub at start (on by
default) and one each time "Check for updates" is clicked ("Where the data is" says what it sends and how to turn
it off). OpenMS' own update check is off
(`native/README.md`).

What it does: New search takes mzML or Thermo `.raw` files and Bruker timsTOF `.d` folders, a FASTA and a protocol
(RNA-UV (U), DNA-UV, RNA-DEB, ...), runs OpenNuXL once per input, one after the other, with its own decoys and,
from 1000 PSMs on, Percolator, and shows the results: proteins with their cross-linked residues, peptides and PSMs,
each PSM marked as cross-link or peptide with its nucleic acid adduct and its cross-linked residue, and the spectrum
of a PSM with NuXL's own annotation (shifted ions, marker ions). Help (the ? in the top bar, or F1) explains each
view, the terms of the results and the keys, opened at the section of the view on screen.

## Install

**macOS** 15 or later, Apple silicon (arm64; Intel Macs are not supported): the `.dmg`. Drag NuXL to Applications,
then, once, in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/NuXL.app
```

The app is signed ad hoc only (no Developer ID, not notarized), so macOS refuses to open it until then. The other
way: open it once (it is refused), then System Settings > Privacy & Security > "Open Anyway".

**Windows** 10 (1903 or later) or 11, x64: the installer `NuXL_<version>_x64-setup.exe`, for the current user,
without administrator rights. It is not signed: SmartScreen asks once ("More info" > "Run anyway"). The app uses
Microsoft Edge WebView2, which Windows 11 and an updated Windows 10 have (the installer fetches it otherwise).

**Linux** x64 or arm64, Ubuntu 22.04 or later (and other distributions with glibc 2.35 or later): the AppImage runs
as it is (`chmod +x NuXL_<version>_amd64.AppImage`; on arm64 `NuXL_<version>_aarch64.AppImage`), or the `.deb`
installs with `sudo apt install ./NuXL_<version>_amd64.deb` (on arm64 `NuXL_<version>_arm64.deb`; package `nuxl`).
The AppImage needs one library of the system: OpenGL ES, `libGLESv2.so.2`, which desktop installations have (the
`.deb` pulls it in with WebKitGTK). Without it the app exits at once with exit code 127 ("Couldn't open
libGLESv2.so.2"). Install it with `sudo apt install libgles2` (Ubuntu, Debian) or `sudo dnf install libglvnd-gles`
(Fedora).

## System requirements

- A 64-bit processor and system as above. The size of the packages, and of the bundled tools in them, is not
  measured yet; the bundled .NET runtime takes about 70 MB of it unpacked. Nothing needs to be installed for `.raw`
  files (no .NET, no ThermoRawFileParser).
- Memory as the search needs it: OpenNuXL has no limit of its own, and its memory grows with the database, the
  protocol's adducts (`NuXL:length`, the longest nucleotide adduct) and the variable modifications. How much a
  typical search needs is not measured yet; the example takes very little.
- Disk: each search keeps OpenNuXL's outputs (idXML of all PSMs and of the filtered cross-links and peptides, the TSV
  reports; docs/design.md §2). The spectra of an mzML are not copied: the PSM view reads the peaks from the input
  mzML when a PSM is opened. Of a `.raw` or `.d` input the search keeps its spectra as mzML
  (`nuxl/<stem>.spectra.mzML`, MS2 only for a `.d`), which can take about as much disk as the input. How much disk
  a search takes per thousand PSMs is not measured yet; History shows each search's
  size.

## Where the data is

- The searches (History): a folder per search in the app's data folder, `searches/<id>/`: OpenNuXL's outputs in
  `nuxl/`, its log `nuxl.log`, the record `search.json`, `proteins.fasta` (the proteins of the result, so that the
  search opens without its database) and links to the inputs. The app's data folder is
  - Linux: `~/.local/share/org.openms.nuxl.desktop/` (`$XDG_DATA_HOME`)
  - macOS: `~/Library/Application Support/org.openms.nuxl.desktop/`
  - Windows: `%APPDATA%\org.openms.nuxl.desktop\`
- The log of the last search that failed: `logs/last-failure.log` there (the error names it).
- To get to a search's folder from the app: "Show search folder" (the last item of the result's Export menu, the
  folder button of a row of History, or Show beside the folder's path in the Overview) opens the system's file
  manager (Finder, Explorer, the desktop's) with the search's folder selected.
- Presets of the settings: the app's webview keeps them, on this computer.
- The new-version check: a few seconds after the start the app asks GitHub for the latest release of NuXL, one
  `GET https://api.github.com/repos/timosachsenberg/nuxl-gui/releases/latest`, without cookies or credentials;
  nothing about the files or the searches is sent. GitHub sees the request with the IP address and the headers the
  app's web view adds to every request, as for any web page: a User-Agent (operating system, CPU architecture and
  web-engine version), Accept-Language (the system's language) and the app's Origin. When a newer version exists, a
  banner under the top bar says so: Download opens its release page in the browser (the banner comes back at the
  next start), Not now hides it until a still newer version comes out. If the check fails (offline, GitHub's
  limit of requests) the app says nothing. Turn it off in the About menu (the ⓘ button in the top bar): "Check for
  new versions at start"; "Check for updates" there checks when asked (also with the setting off). Setting the
  environment variable `NUXL_NO_UPDATE_CHECK` (any non-empty value) turns the check at start off for every user of a
  computer.
  Nothing else of the app uses the network (the CSP lets the page connect to `api.github.com` only). The ChimeraX
  and PyMOL scripts of a protein's cross-linked sites ("Cross-linked sites on a 3D structure") download the
  AlphaFold DB model when they are run in ChimeraX or PyMOL, not in the app.
- The spectra (mzML, `.raw`, `.d`) and FASTA files are read where they are: never copied, and nothing is left
  beside them. After the search of a `.raw` or `.d` the app writes its spectra as mzML into the search's folder, for
  the PSM view. (On Windows, OpenNuXL writes a debug table `<name>.ambiguous_masses.csv` beside an input searched
  by its own path, e.g. `run.mzML.ambiguous_masses.csv`; the app removes it when the run ends, but leaves, and
  OpenNuXL overwrites, a file of that name that was there before.) Deleting a search in History removes its folder;
  uninstalling leaves the data folder, which can be deleted by hand.

## Project files

Export › Project (`.nuxl`) writes a search as one zip, which Open project (History) opens on another computer. It
holds the search's folder as the app keeps it: OpenNuXL's outputs (`nuxl/`), `search.json`, `proteins.fasta`, and
`inputs.json` with the files' names only. Left out are OpenNuXL's log (its command lines carry this computer's
paths), the database copy with the contaminants and `database.json` (the path of a database searched without them).
**OpenNuXL's outputs name folders of the computer that searched** (the input and database paths in the idXML), and
the project carries them as they are: share it where that is fine. The spectra are not in a project, nor the mzML
the app wrote of a `.raw` or `.d` (it would make most such projects too large): where the input mzML cannot be read,
and for every `.raw` or `.d` input, the PSM view shows the peaks NuXL annotated, and says why. A project file holds at most 3 GB (larger searches are refused with a message; they stay in History).

## Cross-linked sites on a 3D structure

The protein panel (Proteins, a protein's row, Coverage) lists the protein's cross-linked residues and saves them as a
script for ChimeraX (`.cxc`: open it in ChimeraX) or PyMOL (`.pml`: File › Run Script). The script shows the
structure as a grey cartoon and the sites as sticks, coloured by their PSMs (light to dark violet) and labelled with
their adducts; a comment table at its top lists the sites with their PSMs, best localization score and adducts.

- A protein with a UniProt accession (`sp|P02768|ALBU_HUMAN`, `tr|…|…`, a bare `P02768`): the script opens its
  AlphaFold DB model (CC-BY 4.0), which ChimeraX or PyMOL downloads from EBI, sending the accession. AlphaFold
  numbers the model as UniProt's canonical sequence, which is the FASTA's when the FASTA is UniProt's current one.
- Any other accession (and an isoform, `P02768-2`): open a structure of the protein first, numbered as the FASTA's
  sequence (e.g. from the PDB, renumbered if needed), then run the script; it marks the residues of every open model.
  To use such a structure for a UniProt protein, delete the lines that fetch the model.
- Each label starts with the structure's own residue ("LYS 123"): where it is not the site's residue (K123), the
  structure is numbered otherwise (another isoform, sequence version or construct). The PyMOL script also checks every
  site and prints a warning in its log.

## Known limitations

- **One run per file.** OpenNuXL searches each input file on its own, one after the other, and estimates the FDR of
  each file apart: there is no FDR pooled over files.
- **No protein FDR, no protein groups.** OpenNuXL estimates none; the Proteins tab lists the proteins of the PSMs
  that pass the peptide and cross-link FDRs.
- **Percolator** rescores a run of 1000 PSMs or more only; below that OpenNuXL skips it, and Overview says so with
  OpenNuXL's note. The score columns show Percolator's score only when every file was rescored; otherwise they show
  NuXL's score for all PSMs, so that they compare on one scale (the q-values stay those of each file).
- **Input** is mzML, Thermo `.raw` (a file) or Bruker timsTOF `.d` (a folder with `analysis.tdf` and
  `analysis.tdf_bin`, or the `.tsf` pair). Not taken: `.mzML.gz` and `.d.zip` (unpack them first), Waters `.raw`
  folders, `.d` folders of other vendors (Agilent, Waters) and mzPeak; convert those to mzML. On Windows a `.d`
  cannot be linked into the search folder: a `.d` whose name is too long, or whose results would clash with an
  earlier `.d` of the same name, is refused with what to rename. If the spectra of a `.raw` or `.d` cannot be
  converted after its search, the search still ends, and the PSM view shows the annotated peaks only (Overview says
  so). PeptDeep and open search
  (ProSE desktop's) are not part of NuXL desktop, nor OpenNuXL's `optimize`, `RTpredict` and `pcrecalibration`
  filters and custom presets files (docs/design.md §6).
- **Large results.** The page reads a search's PSM rows into memory. How large a result opens, and how fast, is not
  measured yet for NuXL desktop (`e2e/large.spec.ts` measures it with `NUXL_LARGE_DIR`; see "Develop").
- macOS: Apple silicon only; not signed with a Developer ID (see Install).

## The example

"Try the example" in New search loads OpenMS' test run of OpenNuXL, `OpenNuXL_1_input.mzML` (20 MS2 spectra of a UV
cross-linked protein–RNA sample), against its proteins, `OpenNuXL_1_input.fasta` (targets only: OpenNuXL makes the
decoys, the app adds the cRAP contaminants), as one run of the condition "example". The settings are the preset's,
with the precursor tolerance of OpenMS' test (10 ppm; OpenNuXL's default is 6 ppm); leaving the example (other files
or another database, Remove all, Start over) gives them back to the preset's, unless you changed them. The run has
far fewer than the 1000 PSMs Percolator needs, so OpenNuXL skips it, and Overview says why. How many PSMs and
cross-links it finds, and how long it takes, depends on the protocol and is not recorded here.

## Licence

NuXL desktop was created by Timo Sachsenberg. It is under OpenMS' licence (BSD-3-Clause, `LICENSE`). The packages list everything they bundle, with its
licence, in `resources/notices/THIRD-PARTY-NOTICES.txt`; the tools' libraries come with theirs in
`resources/nuxl/share/OpenMS/LICENSES`. The example is OpenMS test data. OpenMS logo © OpenMS Inc., used with
permission (the OpenMS Assets License, `src/assets/logo`).

## Develop (ibminode06, no root)

Everything runs inside the user-space toolchain of `native/scripts/in-env.sh` (Rust, the WebKitGTK 4.1 sysroot,
Node 24.19.0, `tauri-driver`); see `native/README.md` for how it is built. `/scratch` is node-local and purged.

```bash
npm install
native/scripts/in-env.sh npm run tauri:build:debug      # debug binary, no bundle: src-tauri/target/debug/nuxl-desktop
native/scripts/in-env.sh npm run check                  # svelte-check and tsc
npx vitest run                                          # the front end's tests
native/scripts/in-env.sh e2e/run.sh [e2e/smoke.spec.ts] # WebdriverIO via tauri-driver + WebKitWebDriver, under xvfb-run
native/scripts/in-env.sh e2e/run.sh e2e/screens.shot.ts # screenshots
```

Packages and their smoke test (needs the OpenMS build of `native/scripts/build-openms.sh`):

```bash
native/scripts/bundle-nuxl.sh <OpenMS checkout>/build src-tauri/resources/nuxl
native/scripts/package-linux.sh                                    # .deb and AppImage
native/scripts/smoke-appimage.sh src-tauri/target/release/bundle/appimage/NuXL_<version>_amd64.AppImage \
  --hide-openms <OpenMS checkout>/build
```

`e2e/run.sh` builds the debug binary first (`E2E_SKIP_BUILD=1` skips that) and enters `in-env.sh` itself if it is not
in it; on a machine without that toolchain (no sysroot) it uses the host's (cargo, Node, `tauri-driver`,
`WebKitWebDriver`, `xvfb-run` and the WebKitGTK 4.1 development libraries installed).

Without OpenNuXL, `NUXL_FAKE=1 e2e/run.sh` runs the specs that search against a stand-in (`e2e/fake/OpenNuXL`, i.e.
`src-tauri/tests/fake-nuxl.sh`, which writes the example's outputs of `src/lib/results/fixtures/example` for every
input; an input named `crash.mzML` fails as OpenNuXL does; the spectra of `.raw` and `.d` inputs are converted by
the stand-in for FileConverter beside it, `e2e/fake/FileConverter`, the same script). Screenshots for `docs/screens` at device scale factor 2:
`GDK_SCALE=2 E2E_SCREEN=3000x2000x24 NUXL_FAKE=1 e2e/run.sh e2e/screens.shot.ts`; for them the fake writes
`src/lib/results/fixtures/screens` instead (`FAKE_NUXL_RESULTS=screens`: OpenMS' OpenNuXL test 3 at 10 ppm, made by
`node scripts/results-fixtures.mjs`).

The specs that run searches need the tool: `NUXL_TOOL=/path/to/OpenNuXL` (without it they skip), with
PercolatorAdapter beside it (`src-tauri/resources/nuxl/bin/OpenNuXL`, or `<build>/bin/OpenNuXL`). Each spec file gets
an app of its own with its own data folder (`XDG_DATA_HOME`, made per run, removed at its end); port 4444 must be free
(a leftover `tauri-driver` stops the run with a message). The shim's tests against the real tool
(`cargo test --test real_nuxl`, gated by `NUXL_TOOL`) also search a Thermo `.raw` file and a Bruker `.d` folder when
`NUXL_RAW_EXAMPLE` and `NUXL_D_EXAMPLE` name them (FileConverter beside the tool; `native/scripts/fetch-test-data.sh
<dir>` downloads the files CI uses). Debug builds read `NUXL_TEST_DIALOG_PATH` in place of the
system's save and open dialogs (`e2e/app.sh` sets it), since WebDriver cannot reach a dialog. The large search
(`e2e/big.spec.ts`) runs only with `NUXL_BIG=1` and the data of `NUXL_BIG_DIR`; the measurement of large results
(`e2e/large.spec.ts`) only with `NUXL_LARGE_DIR` (both headers say how).

Host tools of the e2e specs: `xvfb-run`, and for the test that closes the window (a window-manager close request sent
to the app's window) `xwininfo`, `xprop` and `python3` with libX11 (`e2e/close-window.py`); without them that test
skips with a message.
