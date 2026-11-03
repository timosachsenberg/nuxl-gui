# ProSE desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A clean Tauri 2 desktop app that searches with the bundled native ProSE tool, reads its outputs, and shows
them in the web app's screens with the web app's look.

**Architecture:** The ProSE tool (OpenMS, plus one new output option) is the only native code. A Rust shim starts it,
streams its progress and manages History folders. The Svelte UI, copied from the web app and cut down, reads the
tool's Parquet/YAML outputs into the web app's own result types, so its tables, charts and PSM view work unchanged.

**Tech Stack:** Tauri 2, Rust stable (`tauri`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `serde`, `serde_json`
only), Svelte 5 / Vite / TypeScript / Tailwind 4 / shadcn-svelte (as the web app), `hyparquet` (Parquet), a small YAML
parser, `fflate` (project zips), OpenMS ProSE (native, ONNX), WebKitGTK 4.1, tauri-driver + WebKitWebDriver.

**Spec:** `docs/superpowers/specs/2026-10-20-prose-desktop-design.md` (read it first).

## Global Constraints

- Branch `prose-desktop` (orphan), worktree `/scratch/sachsenb/prose-desktop`; the web app is only a source to copy
  from: `/scratch/sachsenb/prose-pages/app` at branch `prose-app` (do not modify it).
- No own C++; OpenMS changes only as the ProSE option PR to `develop` (Task 2), drafted, OpenMS tags.
- Rust dependencies limited to the five above (plus `std`); anything else needs a ledger ruling.
- The look of the web app's latest version: same theme (`app/src/app.css`), components (`app/src/lib/components/ui`),
  colours (b ions `#2a78d6`, y ions `#eb6834`, unmatched `#a1a1aa`, modified residue `#1baf7a`), wording rules of the
  web app (FDR as percentage with q-value; modification labels; no other search tools named).
- Inputs `.mzML`, `.mzML.gz`; FASTA `.fasta`/`.fa`/`.faa`; files are read by path, never copied; nothing written into
  input folders; no network at run time; no orphaned ProSE processes.
- OpenMS pin: `develop` + #10641 + the Task 2 PR, recorded in `native/OPENMS_COMMIT`.
- Linux x64 first, target Ubuntu 22.04+ (release packages built in CI on `ubuntu-22.04`); development on ibminode06
  with the user-space toolchain (`native/scripts/in-env.sh`, Rust in `/scratch/sachsenb/tools/rust`, sysroot
  `/scratch/sachsenb/tools/tauri-sysroot`); Node 24.19.0 from `/scratch/sachsenb/emsdk/node/24.19.0_64bit/bin`.
- Absolute paths and `git -C` in shell commands (a leading `cd` may be dropped on this node).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Pushing the branch `prose-desktop` for CI is allowed; releases only after the user's go.

## Review Focus

- **ProSE dies or is killed mid-search**: the UI shows the message and stage, nothing goes to History, the next search
  runs. Test: Task 8 e2e `a killed ProSE reports and the next search runs`.
- **The window closes during a search**: no ProSE process survives. Test: Task 8 e2e `closing the window ends ProSE`.
- **Paths with spaces, umlauts, or two inputs of the same name**: searched and kept apart. Tests: Task 3
  `arguments keep paths with spaces and umlauts intact`, Task 8 e2e `paths with spaces and umlauts`.
- **A large result** (100,000+ PSMs with peaks and predictions): opens in under 5 s, scrolls smoothly. Test: Task 4
  `reads a 150k-PSM fixture in under 3 s`.
- **A History folder that is incomplete, corrupt or from a newer app**: listed with a message, never a crash. Test:
  Task 7 `history lists an incomplete folder with its message`.

---

### Task 1: Branch scaffold, toolchain and an empty Tauri app with the web app's theme

**Files:**
- Create (copied from branch `prose-tauri` of the same repo, commit 6c9d684): `native/scripts/make-sysroot.sh`,
  `native/scripts/in-env.sh`, `native/scripts/build-openms.sh`, `native/README.md`
- Create: `package.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `src/main.ts`, `src/App.svelte`,
  `src/app.css` and `src/lib/components/ui/**` (copied from the web app), `src-tauri/{Cargo.toml,build.rs,
  tauri.conf.json,capabilities/default.json,src/main.rs,src/lib.rs}`, `e2e/wdio.conf.ts`, `e2e/smoke.spec.ts`,
  `e2e/run.sh`, `.gitignore`, `README.md`

**Interfaces:**
- Produces: `npm run tauri:build:debug` (debug binary, no bundle); `e2e/run.sh [spec…]` runs WebdriverIO through
  tauri-driver + WebKitWebDriver under `xvfb-run` inside `native/scripts/in-env.sh`; productName `ProSE`,
  identifier `org.openms.prose.desktop`, version `0.1.0`.

- [ ] **Step 1:** Copy the toolchain scripts; fix the deferred minors recorded for them: `in-env.sh` header comment
  about the sandbox, `build-openms.sh` "not in the container" line, `LIBGL_DRIVERS_PATH` only when the directory
  exists, a guard that `libc6`/`libgcc-s1`/`libstdc++6` never enter the sysroot, no abort when `webkit2gtk-driver` is
  already installed, README note that `/scratch` is node-local.
- [ ] **Step 2:** Write `e2e/smoke.spec.ts`: `the window shows the ProSE top bar` (text `ProSE` and the nav items
  `New search`, `Results`, `History` visible).
- [ ] **Step 3:** Run `native/scripts/in-env.sh e2e/run.sh e2e/smoke.spec.ts`. Expected: FAIL (no app).
- [ ] **Step 4:** Scaffold the Tauri app with the web app's Vite/Tailwind/shadcn setup and its `TopBar` (static nav,
  no engine chip yet).
- [ ] **Step 5:** Run the smoke test. Expected: PASS; take a screenshot `docs/screens/01-shell.png` and compare it by
  eye with the web app's top bar (`/scratch/sachsenb/prose-app-screenshots/01-new-search-empty.png`).
- [ ] **Step 6:** Commit `desktop: scaffold, toolchain and the web app's shell`.

### Task 2: OpenMS — ProSE option for peaks and PeptDeep predictions, parity of outputs

**Files (new OpenMS worktree `/scratch/sachsenb/openms-desktop` of the clone `/scratch/sachsenb/openms-pr10564`,
branch `claude/prose-qpx-spectra` from `origin/develop`):**
- Modify: `src/topp/ProSE.cpp`, `src/openms/source/FORMAT/QPXFile.cpp` (+ header), the PeptDeep rescoring/prediction
  call site as needed; tests `src/tests/topp/` (new `TOPP_ProSE_<n>` with a Parquet check), class tests as needed
- Create in this repo: `docs/parity.md`, `native/OPENMS_COMMIT`

**Interfaces:**
- Produces: a ProSE flag (name decided here, e.g. `-out_qpx_spectra`) that adds to each written PSM row of the QPX
  `psm.parquet` the columns `peak_mz list<float32>`, `peak_intensity list<float32>` (the full spectrum),
  `predicted_ion list<utf8>` (`b3`, `y5++`), `predicted_mz list<float32>`, `predicted_intensity list<float32>`, and a
  per-file `peptdeep_nce` in the summary — predictions for every written PSM, also when PeptDeep rescoring is off
  (then calibrated as `PeptDeepRescoring` does).
- Produces `docs/parity.md`: for every field of the web app's `ResultTables`, `StoredSpectra`, `ProSEMultiSummary`
  (types in `/scratch/sachsenb/prose-pages/app/public/openms/openms.d.ts`), the ProSE output file and column it
  comes from; fields with no source are added to this PR as small output additions or marked "derived in the UI"
  with the derivation.

- [ ] **Step 1:** Write `docs/parity.md` from reading `ProSE.cpp`, `QPXFile.cpp`, the summary writer and the web
  app's types; list the gaps.
- [ ] **Step 2:** Write the TOPP test (example data of `TOPP_ProSE_11_rescore`, with and without
  `peptdeep:enable`): the new columns exist, `peak_mz` lengths equal the spectra's peak counts, predicted intensities
  are non-empty for every PSM with charge 1–6, values match `PeptDeepMS2Inference` for one PSM within 1e-5.
- [ ] **Step 3:** Build natively (`native/scripts/build-openms.sh /scratch/sachsenb/openms-desktop
  /scratch/sachsenb/openms-desktop/build`) and run it. Expected: FAIL.
- [ ] **Step 4:** Implement the option and the gap additions; merge `origin/claude/peptdeep-onnx-memory` (#10641) into
  a local integration branch `claude/prose-desktop-pin` = develop + #10641 + this branch, built for the app.
- [ ] **Step 5:** Run the new test and `ctest -R "ProSE|PeptDeep|QPX|Percolator_test"`. Expected: PASS.
- [ ] **Step 6:** Push `claude/prose-qpx-spectra`, open a draft PR to `develop` (description: what, why — the ProSE
  desktop app —, tests); write the integration commit to `native/OPENMS_COMMIT`; commit `docs: output parity and the
  OpenMS pin`.

### Task 3: Rust shim — the tool, its arguments, progress and cancel

**Files:**
- Create: `src-tauri/src/tool.rs` (resolve and probe), `src-tauri/src/args.rs` (settings → arguments),
  `src-tauri/src/run.rs` (process, progress, cancel), `src-tauri/tests/fake-prose.sh`
- Modify: `src-tauri/src/lib.rs` (commands)

**Interfaces:**
- Consumes: Task 2's ProSE flags.
- Produces (Rust → TS, serde camelCase):
  - `SearchRequest { files: Vec<{ id: String, path: String }>, database: String, contaminants: bool,
    settings: SearchSettings }`, `SearchSettings { parameters: Map<String, Value>, rescore: bool, peptdeep: bool,
    threads: u32 }`.
  - Commands `"tool_info"` → `{ version, path, onnx: bool }`; `"start_search"(request)` → `{ searchId }`;
    `"cancel_search"(searchId)`.
  - Events `"search://progress" { searchId, label, file, fraction }`, `"search://done" { searchId, folder }`,
    `"search://failed" { searchId, message, stage, file? }`.
  - `build_args(&SearchRequest, out_dir: &Path) -> Result<Vec<OsString>, String>`: parameters only from an allowlist
    of ProSE `Search:` keys (the keys the web app's form sets plus `threads`, `database:chunk_size`), values typed;
    paths validated (exist, regular file, allowed extension).
  - Resolution order: `PROSE_BIN`, bundled `resources/prose/bin/ProSE`, `PATH`; `OPENBLAS_NUM_THREADS=1` unless set
    (as FASTag).
  - Contaminants: with `contaminants`, the shim writes `database.fasta` into the search folder (the user's FASTA plus
    the bundled `resources/fasta/crap.fasta` with `CON__`-prefixed accessions, as the web app builds it) and passes that
    to ProSE; otherwise the user's path. Outputs: `-out_qpx` with the Task 2 flag, `-out_merged`, `-summary_out`,
    `-out_mod_analysis_dir` for open searches, plus what `docs/parity.md` lists.

- [ ] **Step 1:** Write Rust tests: `arguments keep paths with spaces and umlauts intact`, `unknown parameters are
  refused`, `contaminants are appended with CON__ accessions`, `progress lines become events with file and fraction` (fixture of real ProSE log lines captured from
  the Task 2 build), `cancel ends the process and its children`, `a crash becomes search://failed with the last
  stage` (fake-prose.sh).
- [ ] **Step 2:** Run `native/scripts/in-env.sh cargo test --manifest-path src-tauri/Cargo.toml`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run. Expected: PASS; plus one real run of the example through `start_search` from a Rust
  integration test against the Task 2 build: `search://done` with a folder containing `psm.parquet`.
- [ ] **Step 5:** Commit `desktop: the ProSE shim (arguments, progress, cancel)`.

### Task 4: Results reader — tool outputs into the web app's result types

**Files:**
- Create: `src/lib/results/types.ts` (the web app's `ResultTables`, `StoredSpectra`, `ProSEMultiSummary`,
  `ProSEFileSummary`, `PeakMatch`, `PeakAnnotationResult`, `PredictedIon` copied verbatim from its `openms.d.ts`;
  plus `PredictedSpectra { psmOffsets: Uint32Array; ion: string[]; mz: Float32Array; intensity: Float32Array }`),
  `src/lib/results/read.ts`, `src/lib/results/read.test.ts`, `src/lib/results/fixtures/` (outputs of one real example
  search, committed)

**Interfaces:**
- Consumes: Task 2 columns (`docs/parity.md`).
- Produces: `readSearch(files: (name: string) => Promise<Uint8Array>): Promise<{ summary: ProSEMultiSummary;
  tables: ResultTables; spectra: StoredSpectra; predicted: PredictedSpectra }>`.

- [ ] **Step 1:** Write tests: `the example reads as the web app's result` — counts and columns equal the web app's
  result of the same example (export it once from the web app's wasm module in Node with
  `/scratch/sachsenb/wasm-logs/wasm64/packages-r2/wasm32` into `fixtures/web-example.json`; scores and q-values within
  1e-6, PeptDeep features 1e-5); `peaks and predictions belong to their PSM`; `reads a 150k-PSM fixture in under 3 s`
  (synthetic Parquet written by the test).
- [ ] **Step 2:** Run `npx vitest run src/lib/results`. Expected: FAIL.
- [ ] **Step 3:** Implement with `hyparquet` and the YAML parser.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `desktop: the results reader`.

### Task 5: Fragment annotation in TypeScript

**Files:**
- Create: `src/lib/psm/annotate.ts`, `src/lib/psm/annotate.test.ts`, `src/lib/psm/fixtures/annotations.json`

**Interfaces:**
- Produces: `annotatePeaks(mz: Float32Array, intensity: Float32Array, peptide: string, charge: number,
  options: AnnotationOptions): PeakAnnotationResult` with the web app's `AnnotationOptions` (`tolerance`, `unit`,
  `maxCharge`, `ions`, `losses`, `precursor`) and its semantics (web app spec §4.7: ppm — each ion to its closest
  peak, a peak may carry several ions; Da — one-to-one alignment; loss names `H3PO4`, `HPO3`).

- [ ] **Step 1:** Write tests: `equals the web module's annotatePeaks` for 50 PSMs of the example across option sets
  (golden from the wasm module exported once into `annotations.json`); `agrees with ProSE's own annotations for b/y`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement (masses from monoisotopic residue and modification masses; modifications from the
  peptide's OpenMS string as the web app parses it).
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `desktop: fragment annotation in TypeScript`.

### Task 6: The screens

**Files:**
- Create (copied from the web app and cut down): `src/views/{NewSearch,Results,History}.svelte`,
  `src/lib/components/{search,results,protein,psm,charts,history}/**`, `src/lib/{design,format,results,search,
  settings,psm}/**` model code with its unit tests; `src/lib/desktop.ts` (the only module calling Tauri: commands,
  events, dialogs); `public/fasta/crap.fasta`, `public/example/`
- Not copied: WebAssembly engine, service worker, memory estimate, wasm64, `AllParametersDialog`, the web History
  backend.

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: New search builds a `SearchRequest`; the settings form keeps the web app's presets and fields and adds an
  "Advanced" area with `threads` (default: all cores) and `database:chunk_size`; files come from the dialog or drag
  and drop as paths; the PSM view uses `predicted` (bottom: PeptDeep by default, switch to theoretical) and
  `annotatePeaks` for the toggles.

- [ ] **Step 1:** Carry over the web app's unit tests for the copied model code; add `the form builds the arguments
  of the example preset` and `a search request carries paths, not file contents`.
- [ ] **Step 2:** Run `npx vitest run`. Expected: the new ones FAIL.
- [ ] **Step 3:** Copy and adapt; remove every import of the removed parts.
- [ ] **Step 4:** Run `npx vitest run` and `npm run check`. Expected: PASS, 0 errors.
- [ ] **Step 5:** Run the example through the app (e2e smoke extended: `the example search shows 1,790 PSMs`); take
  screenshots `docs/screens/` of New search, Results › Proteins, the protein panel, the PSM view, Overview, QC and
  put them side by side with `/scratch/sachsenb/prose-app-screenshots/` (same window size 1440×900) in
  `docs/screens/compare.html`.
- [ ] **Step 6:** Commit `desktop: the web app's screens on the ProSE tool`.

### Task 7: History and project files

**Files:**
- Create: `src-tauri/src/history.rs`, `src/lib/history/history.ts`, tests next to each
- Modify: `src/views/History.svelte`, the export menu

**Interfaces:**
- Produces: each search a folder `appDataDir()/searches/<id>/` with the tool's outputs and `search.json`
  (`{ schema: 1, id, name, createdAt, appVersion, toolVersion, files, database, design, settings, psms }`);
  commands `"history_list"` → entries (an unreadable folder listed with `error`), `"history_read"(id, name)` →
  bytes, `"history_rename"(id, name)`, `"history_delete"(id)`, `"history_import"(zipPath)`,
  `"write_bytes"(path, bytes)` (paths only from a save dialog); project file = the folder as a zip (`.prose`) written
  with `fflate` in TS.

- [ ] **Step 1:** Write tests: `history lists, renames and deletes`, `history lists an incomplete folder with its
  message`, `a project round-trips` (export → import → same tables), `a newer schema is refused with a message`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement; a search is written to History only after `search://done`.
- [ ] **Step 4:** Run. Expected: PASS.
- [ ] **Step 5:** Commit `desktop: History and project files`.

### Task 8: End-to-end tests

**Files:**
- Create: `e2e/*.spec.ts`

- [ ] **Step 1:** Write specs: `the example with PeptDeep: 1,790 PSMs, a PSM shows the PeptDeep mirror`, `the example
  without PeptDeep still shows the prediction`, `ion toggles change the annotation`, `History survives a restart`, `a
  project opens again with the same PSMs`, `cancel leaves nothing in History and the next search runs`, `a killed
  ProSE reports and the next search runs`, `closing the window ends ProSE`, `paths with spaces and umlauts`, `an
  mzML.gz searches like its mzML`, `a human semi-tryptic search without chunks finishes` (on-demand, env
  `PROSE_BIG=1`, data `/scratch/sachsenb/prose-bench/data`).
- [ ] **Step 2:** Run `native/scripts/in-env.sh e2e/run.sh`. Fix what fails in the code that owns it.
- [ ] **Step 3:** Run again. Expected: all pass (the on-demand one run once and reported).
- [ ] **Step 4:** Commit `desktop: end-to-end tests`.

### Task 9: Linux packages and CI

**Files:**
- Create: `native/scripts/bundle-prose.sh`, `native/scripts/smoke-appimage.sh`, `.github/workflows/desktop.yml`
- Modify: `src-tauri/tauri.conf.json` (resources, `appimage`, `deb`), `native/README.md`, `README.md`

**Interfaces:**
- Produces: `bundle-prose.sh <openms-build> <out>` fills `src-tauri/resources/prose/` with `bin/ProSE`, its
  shared-library closure (RPATH `$ORIGIN/../lib`, one OpenMP runtime), the OpenMS `share/` data ProSE needs, the
  PeptDeep models; CI on `ubuntu-22.04`: builds the pinned OpenMS (vcpkg binary cache in `actions/cache`), the app,
  `appimage` and `deb`, runs the unit tests and the smoke test, uploads the packages; on tags `desktop-native-v*` a
  draft release.

- [ ] **Step 1:** Write `smoke-appimage.sh`: run the AppImage with `--appimage-extract-and-run` on the host without
  the sysroot environment under `xvfb-run`, drive the example through WebDriver. Expected first: FAIL.
- [ ] **Step 2:** Implement bundling, the workflow; build locally; push `prose-desktop`.
- [ ] **Step 3:** Run the smoke test locally and see the CI run pass. Expected: 1,790 PSMs; record package sizes.
- [ ] **Step 4:** Commit `desktop: Linux packages and CI`.

### Task 10: macOS and Windows builds in CI

**Files:**
- Modify: `.github/workflows/desktop.yml`, `native/scripts/bundle-prose.sh`, `native/README.md`

- [ ] **Step 1:** Add jobs for macOS (`universal-apple-darwin`, or arm64 if universal fails — record the choice) and
  Windows x64, each building the pinned OpenMS and bundling ProSE (dylibs with `install_name_tool` and one `libomp`;
  DLLs beside the executable).
- [ ] **Step 2:** Each job ends with a start test: the bundled ProSE prints its version, searches the example from the
  command line, and the app starts and exits.
- [ ] **Step 3:** Iterate until both pass; commit `desktop: macOS and Windows builds`.
