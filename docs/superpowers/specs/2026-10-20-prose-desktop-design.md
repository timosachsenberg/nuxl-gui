# ProSE desktop: design

Date: 2026-10-20. Branch `prose-desktop` of timosachsenberg/prose-web (an orphan branch: no history of the web app).
Since 2026-10-23 the app lives in its own repository, timosachsenberg/prose-gui (branch `main`, the same history).
Status: design, not built. Builder check done; the user's answer (PeptDeep prediction for every PSM) is in.

## 1. Intent

A clean desktop application for searching with ProSE: the bundled native **ProSE tool** of OpenMS does the work, a
small **Rust shim** (Tauri 2) starts it and reads its outputs, and the user interface is the one of the ProSE web app
(https://timosachsenberg.github.io/prose-web/), which the user finds very nice. The pattern is Oliver Kohlbacher's
FASTag and DIALibGen desktop apps: the tool stays the source of truth, the shim is Rust with minimal dependencies.

This replaces the earlier, larger attempt (branch `prose-tauri`, a native engine sharing code with the WebAssembly
bindings), which the user found too unclean.

## 2. Goals, non-goals, anti-goals

**Goals**
- The look of the web app's latest version, as close as possible: same theme, components, colours, spacing, wording.
- Its screens: New search (files, experimental design table, database with contaminants, settings with presets,
  rescoring with Percolator and PeptDeep), Results (key figures, Overview, Proteins, Peptides, PSMs, Samples, QC,
  open-search panels, filters, CSV export), the protein panel, the PSM view, History, project files.
- Searches by the native ProSE tool: no memory ceiling beyond the machine, native speed, files read where they are,
  `.mzML` and `.mzML.gz`.
- Few dependencies: the Rust side as small as FASTag's (`tauri`, `tauri-plugin-dialog`, `tauri-plugin-opener`,
  `serde`, `serde_json`, plus what process handling needs); no own C++ beyond OpenMS.
- Linux x64 first, then macOS and Windows.

**Non-goals**
- Keeping the web app and the desktop app in sync, sharing code with it, or changing the web app's branches.
- WebAssembly, service worker, memory estimates, Pages deployment.
- Reading the tool's parameter list (`-write_ini`) to build the form: the form is hand-made, as in the web app (user's
  decision).
- Code signing, auto-update (later).

**Anti-goals**
- A desktop app that looks or reads noticeably different from the web app.
- Own C++ code next to the ProSE tool.
- Naming other search tools anywhere; network access at run time; orphaned ProSE processes; writing into the user's
  input folders.

## 3. What the user decided

- A clean branch in prose-web with only the desktop app; no synchronisation with the web app.
- Tauri 2; the ProSE tool is the engine; the shim is Rust (as in Oliver's apps).
- The settings form is custom, like the web app's, not generated from `-write_ini`; the look stays close to the web
  app's latest version.
- Fragment annotation for the PSM view's ion toggles is rebuilt in TypeScript.
- A new ProSE option (OpenMS PR to `develop`): when writing QPX Parquet, each PSM also gets the **full peak list** of
  its spectrum and the **predicted b/y intensities** of PeptDeep — for every written PSM, also when PeptDeep rescoring
  is off (the user chose this so the PSM view shows the prediction by default, as the web app does). The fragment annotations are already in QPX
  (`mz_array`, `intensity_array`, `charge_array`, `ion_type_array` of `psm.parquet`).
- The unwanted shared-code commit of the earlier attempt was removed from OpenMS PR #10659.

## 4. Design

### 4.1 Parts

1. **ProSE tool**, bundled with its OpenMS libraries, ONNX Runtime and the PeptDeep models; built from OpenMS
   `develop` plus #10641 (PeptDeep memory and NCE selection, open) plus the PR of 4.5 (pinned by commit; my call: the
   other fixes the web app's engine has beyond `develop` are WebAssembly-only, and #10644 is already in `develop`; the native build script of the earlier attempt, branch
   `prose-tauri` `native/scripts/build-openms.sh`, is reused).
2. **Rust shim** (`src-tauri/`): resolves the tool (environment variable, bundled, `PATH`) and probes it
   (`--help` → version); builds the arguments from an allowlist out of the form's values (never a shell string);
   starts ProSE with the input paths, the FASTA, the outputs it needs into a per-search folder; streams progress from
   ProSE's output to the UI; cancels by ending the process; manages History folders. It does not parse result files
   beyond what is cheap (my call: Parquet is read in the UI, 4.3).
3. **User interface**: the web app's Svelte 5 / Vite / Tailwind / shadcn-svelte screens, copied onto this branch and
   cut down to what the desktop needs; one small module talks to the shim.

### 4.2 Searching

- The form (presets, enzyme, missed cleavages, tolerances, modifications, FDR as percentage with q-value, charges,
  peptide length, Percolator, PeptDeep, contaminants) maps to ProSE's `Search:` parameters as the web app did; a
  small "Advanced" area holds threads and `database:chunk_size` (my call; the web app's "All 72 parameters" dialog is
  dropped because its list came from the WebAssembly module).
- Contaminants: the bundled cRAP FASTA is merged with the user's database as the web app does (`CON__` accessions).
- Several files are searched in one ProSE run with pooled FDR (`-out_merged`), as the web app pools them; the
  experimental design table stays in the UI and forms samples there, as in the web app.
- Progress: per-file labels as in the web app ("Searching <file> (i of n)…", PeptDeep, Percolator), parsed from
  ProSE's log output (builder: which lines; FASTag parses its tool's progress lines the same way).
- Errors: ProSE's message with the stage and the file where it can be told.

### 4.3 Results

- ProSE writes, per search, into the search's History folder: QPX Parquet (`-out_qpx`, with the new option),
  OpenMS Parquet if needed (`-out_parquet`: proteins, protein groups), the summary (`-summary_out`, YAML), the merged
  idXML (export), and the open-search modification analysis (`-out_mod_analysis_dir`) when open search is on.
- The UI reads them (Parquet with a small pure-JavaScript reader such as `hyparquet`, YAML with a small parser — my
  call: keeps the Rust side minimal) into the web app's results model, so every table, filter, chart and the PSM view
  work as before. Protein sequences for coverage come from the FASTA the search used.
- **Parity rule:** everything the web app shows must be filled. Where a value is in none of ProSE's outputs, the
  builder lists it; if it is needed, it goes into the same ProSE PR (4.5) as a small output addition, not into own
  C++. Examples to check: pooled q-values and decoys for the QC score distributions, the Percolator features shown in
  the PSM view, per-file statistics of Overview, the PeptDeep NCE per file.

### 4.4 PSM view

Observed peaks and the predicted intensities come from the QPX Parquet (4.5); the mirror shows the PeptDeep
prediction by default with a switch to the theoretical spectrum, as in the web app. The ion table, the
fragment ladder, mass errors and the ion/charge/loss toggles come from a TypeScript port of the web app's annotation
rules (the C++ of `annotatePeaks`, spec of the web app §4.7: ppm/Da tolerance, ion types a/b/c/x/y/z, losses,
charges, precursor), tested against ProSE's own annotations in the Parquet for the default ions. The theoretical lower half is
computed by the same TypeScript port.

### 4.5 OpenMS PR (to `develop`)

A ProSE/QPX option (name: builder) that adds to each PSM row of the QPX `psm.parquet`:
- the full peak list of its spectrum (m/z and intensity, float32), only for PSMs that are written;
- the predicted b/y fragment intensities of PeptDeep for every written PSM, also when PeptDeep rescoring is off
  (then ProSE runs the prediction for the written PSMs only, with the NCE calibrated as PeptDeepRescoring does);
  with rescoring on, the predictions it already computed, at the NCE it used; the NCE per file is written too.
Plus whatever the parity check of 4.3 finds missing, kept small. Class and TOPP tests; draft PR.

### 4.6 History and project files

Each search is a folder in the app's data folder: the tool's outputs plus a small JSON with the name, date, inputs,
design and settings. History lists, opens, renames and deletes these folders. A project file is that folder as one
zip (`.prose`); opening one unpacks it into History. (My call: the format follows the tool's outputs; it is not the
web app's `.prose` format, as the apps are no longer kept in sync.)

### 4.7 Files and dialogs

System file dialogs and drag and drop from the file manager give paths; nothing is copied. Two files of the same
name from different folders stay distinct.

### 4.8 Build, test, release

- Development on ibminode06 with the user-space toolchain of the earlier attempt (`prose-tauri`:
  `native/scripts/make-sysroot.sh`, `in-env.sh`; Rust under `/scratch/sachsenb/tools/rust`, WebKitGTK 4.1 unpacked into
  `/scratch/sachsenb/tools/tauri-sysroot`), reused on this branch.
- Tests: Rust unit tests for the trust boundaries (arguments, paths, process handling), TypeScript unit tests for the
  results reader and the annotation port, end-to-end tests of the app (WebDriver through tauri-driver under xvfb).
- Target systems: Ubuntu 22.04 and newer (my call). Development on ibminode06 (24.04); the release packages are
  built in CI on an `ubuntu-22.04` runner so they run on older systems too.
- Releases: AppImage and deb for Linux x64 first; GitHub releases tagged `desktop-native-v0.1.0` etc. (builder may pick
  a clearer tag), unsigned, only after the user's go. macOS and Windows built in CI afterwards.

## 5. Success

- The example search and a large human semi-tryptic search run on Linux; every screen looks and behaves like the web
  app's; History survives a restart; a project file opens again.
- The PSM view shows the observed spectrum mirrored against PeptDeep's prediction from the Parquet, with working ion
  toggles.
- The Rust side's dependencies stay at FASTag's level; no own C++.

## 6. Left to the builder

Which ProSE log lines carry progress; the exact output set and how the reader maps it to the results model; the
option's name and columns; the History folder layout; the copy-and-cut of the UI (which components, removing the
WebAssembly-specific parts); test tooling; CI.
