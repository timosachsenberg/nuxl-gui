# NuXL desktop: design

A desktop application for protein–nucleic acid cross-link searches with **OpenNuXL** of OpenMS, built as ProSE
desktop (timosachsenberg/prose-gui) is built: Tauri 2 around the OS webview, the native `OpenNuXL` tool (with
`PercolatorAdapter` for the score recalibration) as the only native code, a small Rust shim that starts it and reads
nothing it need not, and the Svelte 5 / Tailwind / shadcn-svelte screens of ProSE desktop. The tool stays the
source of truth; the app makes no network connection; files are read where they are and never copied.

This repository started as a copy of prose-gui 0.1.4 (commit 5ed55d7); everything ProSE-specific is replaced.
OpenNuXL's options and outputs are those of OpenMS `develop` (pinned in `native/OPENMS_COMMIT`).

## 1. What differs from ProSE desktop

| | ProSE desktop | NuXL desktop |
| --- | --- | --- |
| Tool | `ProSE`, all inputs in one run, pooled FDR | `OpenNuXL`, **one run per input file**, run one after the other; FDR per file |
| Inputs | `.mzML`, `.mzML.gz` | `.mzML` only (OpenNuXL reads mzML; `.raw` needs ThermoRawFileParser, not bundled) |
| Outputs | QPX Parquet | idXML (all hits, and FDR-filtered cross-links and peptides) and TSV reports |
| Rescoring | Percolator + PeptDeep | Percolator (built into OpenMS, through `PercolatorAdapter`); OpenNuXL skips it below 1000 PSMs |
| Decoys | ProSE's | OpenNuXL's own (`NuXL:decoys true`, prefix `DECOY_`), unless the database has decoys |
| Settings | enzyme, tolerances, modifications, FDR, ... | the same plus the **NuXL preset** (cross-linking protocol: RNA-UV (U), DNA-UV, RNA-DEB, ...), the longest nucleotide adduct (`NuXL:length`), scoring (`fast`/`slow`), cross-link FDR |
| Results | proteins, peptides, PSMs, QC, open-search panels | the same levels, each PSM marked **cross-link or peptide**, with its **adduct**, its **cross-linked residue** (localization) and NuXL's own fragment annotation; Proteins show the cross-linked sites |
| PSM view | observed vs PeptDeep prediction | observed peaks (read from the input mzML when the file is there) with NuXL's annotation (shifted ions, marker ions); mirror against the theoretical b/y ions |

## 2. The search folder

A search lives in `<app data>/searches/<id>/` (`<id>.partial/` while it runs), as in ProSE desktop:

- `inputs.json`: the inputs in order, `[{ id, index, link, stem, name, path }]` (`args.rs` `InputRecord`); `link`
  is `<n>__<name>` (a symbolic link to the user's file in the folder; on Windows the user's own path where
  possible), `stem` is the link's name without `.mzML`.
- `database.fasta` (the user's FASTA with the cRAP contaminants, `CON__` accessions) or `database.json`
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
    of the highest cross-link threshold (`1.0000`: every target cross-link with its q-value); `proteins` is that of
    the lowest threshold ≤ 0.1 (OpenNuXL writes no protein report above 10 %). `notes` are OpenNuXL's warnings of
    the run worth showing (the skipped Percolator). `fdr` are the search's cutoffs as the request gave them
    (`settings.peptideFdr`, `settings.xlFdr`, fractions): OpenNuXL ran without filtering, so the results view filters
    the peptide PSMs and the cross-link PSMs at these.
- `search.json` and `proteins.fasta`: History's record and the identified proteins, as in ProSE desktop.

## 3. The command line of one run

For input `k` (`args.rs`), in the search folder as working directory:

```
OpenNuXL -in <link or path> -database <database.fasta or the user's FASTA> -out nuxl/<stem>.idXML
         -out_tsv nuxl/<stem>.tsv -threads <n>
         -report:peptideFDR 0 -report:xlFDR 1.0 <fdr> -report:xl_peptidelevel_FDR 1.0 1.0
         -percolator_backend builtin|none -percolator_executable ""  (none: rescoring off)
         [-NuXL:decoys false]   (the database has decoys already)
         <the allowlisted parameters of the form>
```

- `report:peptideFDR 0` keeps every target peptide PSM with its q-value, `report:xlFDR 1.0` every target cross-link
  with its q-value, so that the results view filters at the search's FDR and can tighten it; `<fdr>` (the form's
  cross-link FDR, ≤ 0.1, left out when it is 1.0) is there so that OpenNuXL writes its protein report.
- The allowlist (`args.rs` `PARAMETERS`) holds OpenNuXL's options by their full name (`precursor:mass_tolerance`,
  `NuXL:presets`, ...) with their types, as in ProSE desktop; nothing else of the front end becomes an option.
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
its percentages —, post-processing, FDR, Percolator). Labels as in ProSE desktop: "Searching <name> (2 of 3)…",
"Scoring <name> (2 of 3)… 45 %", "Percolator: <name> (2 of 3)…".

## 5. Results (the front end)

`src/lib/results/read.ts` reads the folder into the `SearchResult` of ProSE desktop (`summary`, `tables`,
`spectra`, `warnings`, `proteinsSaved`), so that the results screens keep working:

- one PSM row per spectrum's top hit of the input's `xls` and `peptides` files (targets only: the filtered
  files hold no decoys), inputs in order; `qValue` is the hit's score in those files (their score type is the
  q-value), `score` NuXL's score (`NuXL:score`), or Percolator's (`svm_score`) when the run was rescored, `pep`
  Percolator's PEP when it is there;
- `tables.psms.xl` (see `types.ts`): per PSM row whether it is a cross-link, its adduct, nucleotide, site and
  site score, FDR group, and NuXL's fragment annotation;
- peptides unique by sequence with modifications and adduct (`tables.peptides.adduct`, `tables.peptides.isXL`);
  a localized cross-link carries its adduct as a modification (`NuXL:U-H3O4P1` in OpenNuXL's sequence) at its site;
- proteins from the hits' protein references, sequences from the FASTA; no protein FDR (NaN);
- the peaks of a PSM's spectrum come from the input mzML (by its index, else by scanning a file of at most 256 MB),
  read through `read_search_file` by byte range; when the file cannot be read (moved, an imported project), the
  PSM view shows the peaks NuXL annotated (`fragment_annotation`) only.

## 6. Left out (for now)

`.raw` input; PeptDeep; open search; pooled FDR over files; OpenNuXL's `optimize`, `RTpredict` and
`pcrecalibration` filters; custom presets files.
