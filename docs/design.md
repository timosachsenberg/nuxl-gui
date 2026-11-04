# NuXL desktop: design

A desktop application for protein–nucleic acid cross-link searches with **OpenNuXL** of OpenMS, built as ProSE
desktop (timosachsenberg/prose-gui) is built: Tauri 2 around the OS webview, the native `OpenNuXL` tool (with
`PercolatorAdapter` for the score recalibration) as the only native code, a small Rust shim that starts it and reads
nothing it need not, and the Svelte 5 / Tailwind / shadcn-svelte screens of ProSE desktop. The tool stays the
source of truth; the app's only network connection is the new-version check (§7); files are read where they are and
never copied.

This repository started as a copy of prose-gui 0.1.4 (commit 5ed55d7); everything ProSE-specific is replaced.
OpenNuXL's options and outputs are those of OpenMS `develop` (pinned in `native/OPENMS_COMMIT`).

## 1. What differs from ProSE desktop

| | ProSE desktop | NuXL desktop |
| --- | --- | --- |
| Tool | `ProSE`, all inputs in one run, pooled FDR | `OpenNuXL`, **one run per input file**, run one after the other; FDR per file |
| Inputs | `.mzML`, `.mzML.gz` | `.mzML` only (OpenNuXL reads mzML; `.raw` needs ThermoRawFileParser, not bundled) |
| Outputs | QPX Parquet | idXML (all hits, and FDR-filtered cross-links and peptides) and TSV reports |
| Rescoring | Percolator + PeptDeep | Percolator (built into OpenMS, through `PercolatorAdapter`); OpenNuXL skips it below 1000 PSMs |
| Decoys | ProSE's | always OpenNuXL's own (prefix `DECOY_`): its FDR, filtered outputs and Percolator exist only with them, so a database's own decoys are left out of `database.fasta` (with a note) |
| Settings | enzyme, tolerances, modifications, FDR, ... | the same plus the **NuXL preset** (cross-linking protocol: RNA-UV (U), DNA-UV, RNA-DEB, ...), the longest nucleotide adduct (`NuXL:length`), scoring (`fast`/`slow`), cross-link FDR |
| Results | proteins, peptides, PSMs, QC, open-search panels | the same levels, each PSM marked **cross-link or peptide**, with its **adduct**, its **cross-linked residue** (localization) and NuXL's own fragment annotation; Proteins show the cross-linked sites |
| PSM view | observed vs PeptDeep prediction | observed peaks (read from the input mzML when the file is there) with NuXL's annotation (shifted ions, marker ions); mirror against the theoretical b/y ions |

## 2. The search folder

A search lives in `<app data>/searches/<id>/` (`<id>.partial/` while it runs), as in ProSE desktop:

- `inputs.json`: the inputs in order, `[{ id, index, link, stem, name, path }]` (`args.rs` `InputRecord`); `link`
  is `<n>__<name>` (a symbolic link to the user's file in the folder; on Windows the user's own path where
  possible), `stem` is the link's name without `.mzML`.
- `database.fasta` (the user's FASTA with the cRAP contaminants, `CON__` accessions, and without decoys of its own) or `database.json`
  (`{ "path": ... }`, the user's FASTA searched as it is).
- `nuxl.log`: the tool's output of all runs (each run starts with a `$ <command line>` line).
- `nuxl/` with OpenNuXL's outputs of input `k`, all named after the input's stem `<stem>`:
  - `<stem>.idXML` (`-out`: every PSM, targets and decoys, before any FDR filter);
  - `<stem>.tsv` (`-out_tsv`: OpenNuXL's report, one row per spectrum's top hit);
  - what OpenNuXL derives from `-out`: `<stem>_<q>_peptides.idXML`, `<stem>_<q>_XLs.idXML`,
    `<stem>_proteins<q>_XLs.tsv`, and after Percolator the same with `_perc_` (`<stem>_perc_<q>_XLs.idXML`, ...)
    and `<stem>_perc.tsv`; `<q>` is the threshold with four decimals (`1.0000`, `0.0100`).
  - `<stem>.outputs.json`, written by the shim when the run of input `k` has ended successfully — the reader's
    only way to find the derived files (it never guesses their names):

    ```json
    {
      "input": 0,
      "all": "nuxl/<stem>.idXML",
      "xls": "nuxl/<stem>_perc_1.0000_XLs.idXML",
      "peptides": "nuxl/<stem>_perc_0.0000_peptides.idXML",
      "proteins": "nuxl/<stem>_perc_proteins0.0100_XLs.tsv",
      "report": "nuxl/<stem>_perc.tsv",
      "percolator": true,
      "notes": ["Too few PSMs for score recalibration. Skipped."],
      "seconds": 12.3,
      "fdr": { "peptide": 0.01, "xl": 0.01 }
    }
    ```

    `xls`, `peptides`, `proteins`, `report` are `null` when the file is not there. With `percolator: true` they
    are the `_perc_` files (Percolator ran and its results were written), else the plain ones. `xls` is the file
    of the highest cross-link threshold (`1.0000`: every target cross-link with its q-value; a `0.0000` one is a
    positive cross-link FDR below 0.00005 rounded by `%.4f`, since NuXLFDR turns 0 into 1 before it names any file); `proteins` is that of
    the lowest threshold ≤ 0.1 (OpenNuXL writes no protein report above 10 %). `notes` are OpenNuXL's warnings of
    the run worth showing (the skipped Percolator; OpenNuXL warns of too few PSMs also with the rescoring off, and
    then the shim leaves that warning out), and the shim's note when the database's own decoys were left out. `fdr` are the search's cutoffs as the request gave them
    (`settings.peptideFdr`, `settings.xlFdr`, fractions): OpenNuXL ran without filtering, so the results view filters
    the peptide PSMs and the cross-link PSMs at these.
- OpenNuXL also writes a debug table beside its `-in` in every run, `<-in>.ambiguous_masses.csv`
  (`calculateNucleotideTags_`): through a link it is in the search folder; with the user's own path (Windows) it is
  beside the user's mzML. The shim removes it after each run, unless a file of that name was there before the run
  (OpenNuXL overwrites that one; the shim leaves it).
- `search.json` and `proteins.fasta`: History's record and the identified proteins, as in ProSE desktop.

## 3. The command line of one run

For input `k` (`args.rs`), in the search folder as working directory:

```
OpenNuXL -in <link or path> -database <database.fasta or the user's FASTA> -out nuxl/<stem>.idXML
         -out_tsv nuxl/<stem>.tsv -threads <n>
         -report:peptideFDR 0 -report:xlFDR 1.0 <fdr> -report:xl_peptidelevel_FDR 1.0 1.0
         -percolator_backend builtin|none   (none: rescoring off)
         <the allowlisted parameters of the form>
```

- `report:peptideFDR 0` keeps every target peptide PSM with its q-value (and its peptide-level `peptide q-value`,
  which NuXLFDR filters on too at a peptide FDR: the results view applies both, §5), `report:xlFDR 1.0` every target cross-link
  with its q-value, so that the results view filters at the search's FDR and can tighten it; `<fdr>` (the form's
  cross-link FDR, ≤ 0.1, left out when it is 1.0) is there so that OpenNuXL writes its protein report.
- The allowlist (`args.rs` `PARAMETERS`) holds OpenNuXL's options by their full name (`precursor:mass_tolerance`,
  `NuXL:presets`, ...) with their types, as in ProSE desktop; nothing else of the front end becomes an option.
- `NuXL:decoys` is never passed (OpenNuXL's FDR needs its decoys), nor `-percolator_executable` (empty, it would turn
  the built-in Percolator off too). `precursor:isotopes` is an integer list.
- `-in`, `-database`, `-out*`, `-threads`, `-report:*FDR*`, `-percolator_*`, `NuXL:decoys`, `output_folder`,
  `NuXL:presets_file`, `ThermoRaw_executable`, `NET_executable` are the shim's own and never come from the form.

The request (`args.rs` `SearchRequest`, camelCase JSON from `src/lib/desktop.ts`):

```ts
{ files: [{ id, path }], database: string, contaminants: boolean,
  settings: { parameters: Record<string, number | string | boolean | string[]>, rescore: boolean, threads: number,
              peptideFdr: number, xlFdr: number } }
```

`rescore` false gives `-percolator_backend none`. `peptideFdr` and `xlFdr` are fractions in (0, 1].

## 4. Progress

OpenNuXL prints OpenMS' progress lines on stdout: `Progress of '<label>':`, then `\r  12.34 %` updates, then
`-- done [took ...] --`, and log lines such as `Running percolator.`. The shim (`progress.rs`) turns them into
`{ label, file, fraction }`: the file `k` of `n` and a fraction over all runs, each run weighted equally and split
into its stages (reading and preprocessing the spectra, the database and decoys, scoring — the long stage, with
its percentages —, post-processing, FDR, Percolator). Labels as in ProSE desktop: "Searching <name> (2 of 3)...",
"Scoring <name> (2 of 3)... this step 45 %" (the percentage of the scoring step, which OpenNuXL reports; the bar and the percentage beside it are the whole search's), "Percolator: <name> (2 of 3)...". The autotune's own load of the spectra (the filter `spectrumclusterfilter`,
before `IDFilter excludes <n> spectra.`) is part of the autotune.

## 5. Results (the front end)

`src/lib/results/read.ts` reads the folder into the `SearchResult` of ProSE desktop (`summary`, `tables`,
`spectra`, `warnings`, `proteinsSaved`), so that the results screens keep working:

- one PSM row per spectrum's top hit of the input's `xls` and `peptides` files (targets only: the filtered
  files hold no decoys), inputs in order; `qValue` is the hit's score in those files (their score type is the
  q-value), `score` NuXL's score (`NuXL:score`), or Percolator's (`svm_score`) when every run was rescored (with only
  some rescored, NuXL's for all, so that the column has one scale; `SearchResult.nuxl.percolatorScores`), `pep`
  Percolator's PEP when it is there;
- `tables.psms.xl` (see `types.ts`): per PSM row whether it is a cross-link, its adduct, nucleotide, site and
  site score, FDR group, peptide-level q-value (`peptide q-value`) and NuXL's fragment annotation;
- a peptide PSM is within the peptide FDR t as OpenNuXL would report it at `report:peptideFDR` t: PSM q-value ≤ t and
  `peptide q-value` < t (NuXLFDR filters on both); a cross-link PSM by its q-value ≤ the cross-link FDR only
  (`report:xl_peptidelevel_FDR` 1.0);
- peptides unique by sequence with modifications and adduct (`tables.peptides.adduct`, `tables.peptides.isXL`);
  a localized cross-link carries its adduct as a modification (`NuXL:U-H3O4P1` in OpenNuXL's sequence) at its site;
- proteins from the hits' protein references, sequences from the FASTA; no protein FDR (NaN);
- the PSM and Peptides tables show where a peptide is in its proteins (`positions.ts`): Sequence (the residues only),
  Start and End (1-based, inclusive) and Protein site (the cross-linked residue there, "Cas7 K137": a PSM's localized
  site, a peptide row's residue that carries the adduct; empty when not localized, the PSM's tooltip naming the
  candidate residues). A cell shows the first occurrence, in the Proteins column's order, with "+n" for the others (all
  in its tooltip); the CSV has every occurrence, joined by ";" in the order of its Proteins column ("Protein start",
  "Protein end", "Protein site" with the accession). A position the protein's sequence does not confirm (no sequence,
  or the peptide is not there: read.ts keeps what the search recorded) has a "?" ("12?"); none recorded: "–" (empty in
  the CSV). The protein panel and the PSM view’s header ("· Cas7 K137") count from 1 as well;
- the peaks of a PSM's spectrum come from the input mzML (by its index, else by scanning a file of at most 256 MB),
  read through `read_search_file` by byte range; arrays uncompressed, zlib or zstd (plain, byte-shuffled,
  dictionary-encoded, as OpenMS develop writes them), not MS-Numpress; when the file cannot be read (moved, an imported project), the
  PSM view shows the peaks NuXL annotated (`fragment_annotation`) only.

## 6. Left out (for now)

`.raw` input; PeptDeep; open search; pooled FDR over files; OpenNuXL's `optimize`, `RTpredict` and
`pcrecalibration` filters; custom presets files.

## 7. The new-version check

The app's one network connection. `src/lib/update/update.ts` asks GitHub for the latest release
(`GET https://api.github.com/repos/timosachsenberg/nuxl-gui/releases/latest`: published, not a draft nor a
prerelease; `Accept: application/vnd.github+json`, no credentials or referrer, 8 s timeout; the web view adds its
own User-Agent, Accept-Language and Origin, nothing about files or searches is sent), reads the version
of its tag (`desktop-native-v<major>.<minor>.<patch>`, anything else is ignored) and compares it numerically with the
app's (Tauri's `getVersion`, tauri.conf.json's). The result is `newer` (version, page), `current` or `error` (offline,
timeout, HTTP errors and GitHub's rate limit, 403/429, an answer that is not JSON or has no such tag).

- At start (`update.svelte.ts`, App.svelte): once, 5 s after the start, when the setting "Check for new versions at
  start" is on (the default; localStorage `nuxl.updateCheck`) and the shim allows it (`update_check_at_start`: false
  with `NUXL_NO_UPDATE_CHECK` set, which the e2e specs set in `e2e/app.sh` and `e2e/appimage-app.sh`). A newer release
  shows a banner under the top bar (UpdateBanner.svelte, inside an always-present `role="status"` region so that it
  is read out): Download (hides it for this start only), Not now (localStorage `nuxl.updateDismissed`: no banner
  again for that version, one for a newer). No banner either when, while it waited for GitHub, the setting was turned
  off or "Check for updates" was clicked (that check shows its own result). Errors are silent.
- The About menu (AboutMenu.svelte, ⓘ in the top bar): the app's and OpenNuXL's versions, "Check for updates" with
  its result in place, and the setting. A Download that cannot open the page says so where it was clicked (banner or
  panel); a new check or Not now clears it.
- The release page opens in the system's browser through the shim, `open_release_page(version)`
  (`src-tauri/src/update.rs`): the version must be digits and dots (`major.minor.patch`); the URL
  (`https://github.com/timosachsenberg/nuxl-gui/releases/tag/desktop-native-v<version>`) is built in Rust, never taken
  from the page or from GitHub's answer, and opened with `xdg-open` (from an AppImage without the AppImage's library
  and GTK variables), `open` (macOS) or `rundll32 url.dll,FileProtocolHandler` (Windows; no shell). No plugin.
- The CSP's `connect-src` has `https://api.github.com` beside the app's own (tauri.conf.json); nothing else.
