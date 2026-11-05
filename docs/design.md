# NuXL desktop: design

A desktop application for protein–nucleic acid cross-link searches with **OpenNuXL** of OpenMS, built as ProSE
desktop (timosachsenberg/prose-gui) is built: Tauri 2 around the OS webview, the native `OpenNuXL` tool (with
`PercolatorAdapter` for the score recalibration, and `FileConverter` for the spectra of `.raw` and `.d` inputs) as
the only native code, with the .NET runtime that OpenMS' Thermo reader runs on, a small Rust shim that starts the
tools and reads nothing it need not, and the Svelte 5 / Tailwind / shadcn-svelte screens of ProSE desktop. The tool
stays the source of truth; the app's only network connection is the new-version check (§7); files are read where
they are and never copied (the spectra of a `.raw` or `.d` input are converted to mzML in the search folder, §2).

This repository started as a copy of prose-gui 0.1.4 (commit 5ed55d7); everything ProSE-specific is replaced.
OpenNuXL's options and outputs are those of OpenMS `develop` (pinned in `native/OPENMS_COMMIT`).

## 1. What differs from ProSE desktop

| | ProSE desktop | NuXL desktop |
| --- | --- | --- |
| Tool | `ProSE`, all inputs in one run, pooled FDR | `OpenNuXL`, **one run per input file**, run one after the other; FDR per file |
| Inputs | `.mzML`, `.mzML.gz` | `.mzML` and Thermo `.raw` files, Bruker timsTOF `.d` folders, all read by OpenNuXL itself (OpenMS built with `WITH_THERMO_RAW` and `WITH_OPENTIMS`; the bundle has the .NET runtime for `.raw`, `native/README.md`) |
| Outputs | QPX Parquet | idXML (all hits, and FDR-filtered cross-links and peptides) and TSV reports |
| Rescoring | Percolator + PeptDeep | Percolator (built into OpenMS, through `PercolatorAdapter`); OpenNuXL skips it below 1000 PSMs |
| Decoys | ProSE's | always OpenNuXL's own (prefix `DECOY_`): its FDR, filtered outputs and Percolator exist only with them, so a database's own decoys are left out of `database.fasta` (with a note) |
| Settings | enzyme, tolerances, modifications, FDR, ... | the same plus the **NuXL preset** (cross-linking protocol: RNA-UV (U), DNA-UV, RNA-DEB, ...), the longest nucleotide adduct (`NuXL:length`), scoring (`fast`/`slow`), cross-link FDR |
| Results | proteins, peptides, PSMs, QC, open-search panels | the same levels, each PSM marked **cross-link or peptide**, with its **adduct**, its **cross-linked residue** (localization) and NuXL's own fragment annotation; Proteins show the cross-linked sites |
| PSM view | observed vs PeptDeep prediction | observed peaks (read from the input mzML when the file is there; of a `.raw` or `.d`, from the mzML of its spectra the search wrote) with NuXL's annotation (shifted ions, marker ions); mirror against the theoretical b/y ions |

The inputs in New search (`src/lib/search/files.ts`, `form.svelte.ts`): "Add files" opens a file dialog for mzML
and `.raw` files, "Add .d folders" a folder dialog of its own (a file dialog cannot pick folders on Windows and
Linux). Dropped on the window: mzML and `.raw` files, `.d` folders, and a `.d`'s `analysis.tdf`/`analysis.tdf_bin`
(`.tsf`), which stand for their folder; the folder's other files dropped with them are left out quietly. A folder
from the `.d` dialog that is not named `.d` gets a notice of its own (choose the `.d` folders, not the folder that
holds them). The extensions are case-insensitive, and a trailing `/` or `\` is dropped (front end and shim). The
shim (`args.rs`, `inspect_files` in `files.rs`) takes a `.d` only when it holds `analysis.tdf` and
`analysis.tdf_bin`, or `analysis.tsf` and `analysis.tsf_bin`; a `.d` with the table but not its binary file is "not
a complete Bruker timsTOF .d folder", one with neither "not a Bruker timsTOF .d folder"; a `.raw` folder (Waters), a
`.d.zip` and a `.mzML.gz` are refused with what to do instead. `inspect_files` gives a `.raw` its file size, a `.d`
the sum of its `analysis.*` files, and neither a spectrum count (nothing of them is read).

## 2. The search folder

A search lives in `<app data>/searches/<id>/` (`<id>.partial/` while it runs), as in ProSE desktop:

- `inputs.json`: the inputs in order, `[{ id, index, link, stem, name, path }]` (`args.rs` `InputRecord`); `link`
  is `<n>__<name>` (a symbolic link to the user's file or `.d` folder in the folder; on Windows the user's own path
  where possible, else a hard link), `stem` is the link's name without `.mzML`, `.raw` or `.d` (inputs of one name
  and different kinds clash, as two of one kind do). `path` is the user's path without trailing `/` or `\` (a `.d`
  may come as `run.d/`). Windows cannot hard-link a folder: a `.d` keeps its own path (of a `.d` and a file whose
  outputs would clash, the file is linked; of two `.d`, the later one), and a `.d` that would still need a link
  (a name too long for the outputs, a clash with an earlier `.d`) is refused with what to rename.
- `database.fasta` (the user's FASTA with the cRAP contaminants, `CON__` accessions, and without decoys of its own) or `database.json`
  (`{ "path": ... }`, the user's FASTA searched as it is).
- `nuxl.log`: the tools' output of all runs, OpenNuXL's and FileConverter's (each run starts with a
  `$ <command line>` line).
- `nuxl/` with OpenNuXL's outputs of input `k`, all named after the input's stem `<stem>`:
  - `<stem>.idXML` (`-out`: every PSM, targets and decoys, before any FDR filter);
  - `<stem>.tsv` (`-out_tsv`: OpenNuXL's report, one row per spectrum's top hit);
  - what OpenNuXL derives from `-out`: `<stem>_<q>_peptides.idXML`, `<stem>_<q>_XLs.idXML`,
    `<stem>_proteins<q>_XLs.tsv`, and after Percolator the same with `_perc_` (`<stem>_perc_<q>_XLs.idXML`, ...)
    and `<stem>_perc.tsv`; `<q>` is the threshold with four decimals (`1.0000`, `0.0100`).
  - of a `.raw` or `.d` input, `<stem>.spectra.mzML`: its spectra as indexed mzML, which the shim's FileConverter run
    writes after the input's run (§3) for the PSM view (§5). FileConverter writes `<stem>.spectra.tmp.mzML`, which
    the shim renames when it has ended successfully, and removes when it has not. A conversion that fails, or a
    bundle without FileConverter, does not fail the search: `spectra` is `null` and a note says "The PSM view shows
    the annotated peaks only: the spectra of <name> could not be converted (…)."
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
      "spectra": "nuxl/<stem>.spectra.mzML",
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
    the peptide PSMs and the cross-link PSMs at these. `spectra` is the converted spectra of a `.raw` or `.d`
    input, relative to the search folder; `null` (or absent, which the reader takes the same) for an mzML input,
    which is read where it is, and for spectra that could not be converted. `seconds` is OpenNuXL's run alone,
    without the conversion.
- OpenNuXL also writes a debug table beside its `-in` in every run, `<-in>.ambiguous_masses.csv`
  (`calculateNucleotideTags_`; of a `.d`, beside the folder, not in it): through a link it is in the search folder;
  with the user's own path (Windows) it is beside the user's input. The shim removes it after each run, unless a file of that name was there before the run
  (OpenNuXL overwrites that one; the shim leaves it).
- `search.json` and `proteins.fasta`: History's record and the identified proteins, as in ProSE desktop.
- `curation.json` (once the user marks a PSM): the user's curation, `{ "schema": 1, "psms": [{ file, spectrum,
  peptide, adduct, charge, mark }] }` with `mark` `accepted` or `rejected` (`src/lib/results/curation.ts`), each PSM
  named by its file's name, native ID, ProForma, adduct and charge (not its row). The results view reads it through
  `read_search_file` and replaces it whole through `save_curation` (`history.rs`: a saved search, JSON of this
  shape, at most 64 MB). A project holds it; marks of PSMs the result does not have are kept as they are.

Show search folder (the Export menu, History's rows, the Overview, which also shows the path: `search_folder`) opens
the system's file manager at the folder of a search, by its id (`show_search_folder`, `history.rs` `show_folder`;
the page never names a path): the opener plugin's `reveal_item_in_dir`, called from Rust only (the plugin is not
registered, the page has none of its commands), which selects the folder in `searches/` (Finder, Explorer; Linux: the
file manager's `org.freedesktop.FileManager1` on D-Bus, else the desktop portal, else `xdg-open` of the folder,
waited for up to 5 s: an exit status other than 0, e.g. 3 without a file manager, is an error that names the folder).

A project (`.nuxl`, `project.rs`, `history.ts` `leftOut`) holds the folder but `database.fasta`, `database.json`,
`nuxl.log` and the converted spectra (`nuxl/<stem>.spectra.mzML`, `.spectra.tmp.mzML`: about as large as the
input, they would make most such projects too large for a zip without zip64). A search opened from a project shows
the annotated peaks only.

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
- `-in` is the link or the user's path, without trailing separators; OpenNuXL reads `.mzML`, `.raw` and `.d`
  through OpenMS' `FileHandler` (the pin includes OpenMS#10816), so the app converts nothing before the search.
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

After the run of a `.raw` or `.d` input has ended successfully, the shim converts its spectra with the
`FileConverter` beside OpenNuXL (`args.rs` `conversion_args`), in the same working directory, with the same `-in`:

```
FileConverter -in <link or path> -out <search folder>/nuxl/<stem>.spectra.tmp.mzML -out_type mzML -threads <n>
              -process_lowmemory -zstd_compression
              -RawToMzML:reader inprocess   (.raw: Thermo's RawFileReader, as OpenNuXL reads it; FileConverter's
                                             default on Windows is ThermoRawFileParser, which is not bundled)
              -bruker:load_ms1 false        (.d: the MS2 spectra OpenNuXL searches; the MS1 frames are most of a run)
```

`-out` is the absolute path in the `.partial` folder. Never `-lossy_compression` (MS-Numpress, which the PSM view
does not read). FileConverter reads with the readers and defaults OpenNuXL uses, so the native IDs match (Thermo
`controllerType=0 controllerNumber=1 scan=N`, Bruker `frame=F scan=S precursor=P`). It runs as OpenNuXL does: its
`$ <command line>` in `nuxl.log`, ended by cancel in the same way, its exit as in a failure of OpenNuXL ("FileConverter
ended with exit code 6"), which here becomes the note of §2.

The tools' environment (`tool.rs` `command_with`; OpenNuXL, FileConverter and the version probe, and the
PercolatorAdapter OpenNuXL starts inherits it): always `OPENMS_DISABLE_UPDATE_CHECK=ON` and, unless the user set it,
`OPENBLAS_NUM_THREADS=1`; on macOS without the `DYLD_*` search variables. When the bundle has its .NET runtime
(`<tool dir>/../dotnet`): `DOTNET_ROOT` names it, `DOTNET_ROOT_X64`, `DOTNET_ROOT_ARM64` and `DOTNET_ROOT(x86)` are
removed, and `DOTNET_ROLL_FORWARD=Major` (the Thermo bridge targets .NET 8, the bundle has 10),
`DOTNET_CLI_TELEMETRY_OPTOUT=1` and `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` (no ICU) are set. When it has the
bridge's managed part (`<tool dir>/../share/OpenMS/openms_thermo_bridge/managed`), `OPENMS_THERMO_MANAGED_DIR` names
it. A tool without these folders (a build tree's, `NUXL_TOOL`) keeps the user's environment for them.

The packaged app's `--smoke-test` reports, beside the tool's version, whether PercolatorAdapter and FileConverter are
beside it (`percolatorAdapter`, `fileConverter`) and whether the bundle has `dotnet/` and the managed part
(`dotnet`, `thermoBridge`); it fails without PercolatorAdapter or FileConverter.

## 4. Progress

OpenNuXL prints OpenMS' progress lines on stdout: `Progress of '<label>':`, then `\r  12.34 %` updates, then
`-- done [took ...] --`, and log lines such as `Running percolator.`. The shim (`progress.rs`) turns them into
`{ label, file, fraction }`: the file `k` of `n` and a fraction over all runs, each run weighted equally and split
into its stages (reading and preprocessing the spectra, the database and decoys, scoring — the long stage, with
its percentages —, post-processing, FDR, Percolator). Labels as in ProSE desktop: "Searching <name> (2 of 3)...",
"Scoring <name> (2 of 3)... this step 45 %" (the percentage of the scoring step, which OpenNuXL reports; the bar and the percentage beside it are the whole search's), "Percolator: <name> (2 of 3)...". The autotune's own load of the spectra (the filter `spectrumclusterfilter`,
before `IDFilter excludes <n> spectra.`) is part of the autotune.
The reading of the spectra is the reader's load, whichever it is: `loading mzML`, `Loading Thermo RAW file` (`.raw`),
`Loading DDA-PASEF data` (`.d` of TDF data) or `Loading frames` (TSF). The conversion of a `.raw` or `.d` input's
spectra after its run (§3) ends that run's part of the bar: "Preparing the spectra of <name> for the PSM view (2 of
3)...".

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
  candidate residues, and a localized one's tooltip the other residues OpenNuXL finds likely). A cell shows the first
  occurrence, in the Proteins column's order, with "+n" for the others (all in its tooltip), and sorts by its protein,
  then its position; the CSV has every occurrence, joined by ";" in the order of its Proteins column ("Protein start",
  "Protein end", "Protein site" with the accession). A position the protein's sequence does not confirm (no sequence,
  or the peptide is not there: read.ts keeps what the search recorded) has a "?" ("12?"); none recorded: "–" (empty in
  the CSV). The protein panel and the PSM view’s header ("· Cas7 K137") count from 1 as well;
- the protein panel's Coverage tab saves the protein's cross-linked sites (`crossLinkedSites`, with their best
  localization score) as a ChimeraX `.cxc` or PyMOL `.pml` script (`structure.ts`, through `save_text`): a UniProt
  accession (`sp|…|…`, `tr|…|…`, bare; not an isoform) makes it fetch the AlphaFold DB model (`alphafold fetch` in
  ChimeraX; PyMOL asks the AlphaFold API for the model's file, else tries the files of the newest versions), anything
  else leaves opening a structure to the user. The viewer downloads the model, never the app (§7 stays its one
  connection). Labels start with the structure's residue so that another numbering shows; the PyMOL script checks
  the residues too;
- the peaks of a PSM's spectrum come from the input mzML (by its index, else by scanning a file of at most 256 MB),
  read through `read_search_file` by byte range; arrays uncompressed, zlib or zstd (plain, byte-shuffled,
  dictionary-encoded, as OpenMS develop writes them), not MS-Numpress; when the file cannot be read (moved, an imported project), the
  PSM view shows the peaks NuXL annotated (`fragment_annotation`) only, and says why;
- of a `.raw` or `.d` input, the peaks come from the mzML of its spectra that its `outputs.json` names (`spectra`, a
  file of the search folder read by its relative name), matched by native ID; the input itself (a vendor file, a
  folder) is never read, and its link or path is not probed (`read_search_file` serves inputs only when they are
  `.mzML`). Without `spectra` (the conversion failed) the PSM view says that the spectra of <name> were not
  converted; with `spectra` but no file (an imported project) that a project leaves them out; both show the
  annotated peaks only;
- the Spectrum column, the PSM view and the names of saved SVGs call a spectrum by the number of its native ID's
  `scan=` term (Thermo: `scan=4711` is 4711), `spectrum=` or `index=`; of a Bruker ID by its `precursor=` (the
  `scan=` of `frame=12 scan=301 precursor=4711` is a mobility scan that other precursors share), and one without a
  precursor by its scan ("frame 12, scan 301").

### The spectral library (DIA-NN TSV)

Export › "Spectral library (DIA-NN TSV)…" (`LibraryDialog.svelte`, `src/lib/results/library/`) is a TypeScript port
of nuxl-app's `src/nuxl2dia.py` (NuXL Team; NuXLDIA, github.com/timosachsenberg/NuXLDIA; BSD-3, Copyright OpenMS Inc.),
run in the page on the PSMs the reader has (`tables.psms`, with NuXL:score and the hit's `IM` kept for it in
`psms.xl.nuxlScore` and `psms.xl.ccs`), so that it works for imported projects too (no spectra needed).

As nuxl2dia.py:
- targets only: a hit whose proteins are all decoys is left out (one with a target protein too stays, its ProteinId
  naming both);
- cross-links only when localized: NuXL:best_localization_score > 0 (0 and none are left out, and counted);
- one cross-link per (peptide, NuXL:NA, charge), the best localization score, then the best NuXL:score; one peptide
  per (modified peptide, charge), the best NuXL:score (the oxidised and the plain peptide stay apart); the peptide is
  the TextExporter's (OpenMS' notation) without OpenNuXL's adduct modification, so two localizations of an adduct are
  one entry; the cross-links first, by localization score, then the peptides, by NuXL:score;
- ModifiedPeptideSequence: OpenMS' notation with `(Oxidation)` and `(Carbamidomethyl)` as `(UniMod:35)`, `(UniMod:4)`,
  every other modification as OpenMS writes it, the adduct as `[<NuXL:NA>]` after its residue, before it when the
  residue has another modification (`PE[U]M(UniMod:35)K`, nuxl2dia.py's rule for its TextExporter input), a leading
  dinucleotide in alphabetical order (`UC-H3N1` is `CU-H3N1`, as NuXLDIA's DIA-NN declarations have them);
  PeptideSequence the residues; PrecursorMz, PrecursorCharge and AverageExperimentalRetentionTime (s) the PSM's;
  PrecursorIonMobility 1/K0 from the CCS (Mason–Schamp, N2, 305 K, nuxl2dia.py's constants), empty without; ProteinId
  the accessions, `;`-separated;
- the fragments: the b and y ions of `fragment_annotation` (shifted ones and those with losses included; a, c, x, z,
  precursor, immonium, marker and internal ions left out), at the annotated m/z and NuXL's relative intensity, with
  the peak's charge and NuXL's label as Annotation; a precursor without one is left out;
- the columns in nuxl2dia.py's order; numbers in full (the shortest text that reads back as the same double).

Decisions where it differs:
- **The PSMs**: the search's within the dialog's own peptide and cross-link FDR (`psmPasses`: a peptide PSM by its
  peptide-level q-value too), each 1 % at first (the usual library FDR; nuxl-app reads Percolator's 1 % files only),
  or the search's tighter cutoff; never looser than the search's ("A looser cutoff needs a new search"). The tables'
  filters do not count: a library is the whole search's (the PSM table starts at cross-links only). The file name
  says the FDRs (`<name>_library_pep1%_xl1%.tsv`). Rescored and RDDF identifications are not offered.
- **FragmentLossType** (nuxl2dia.py writes `FragmenLossType`, which DIA-NN ignores, and leaves it empty but for
  shifted ions; an empty value would read as an unknown loss): `noloss`, `H2O` for one `-H2O1`, `NH3` for one
  `-H3N1`, `unknown` for any other loss or several and for every ion shifted by a nucleotide (fragment): an apostrophe
  ion (`y9+C'-NH3`) or any `+<shift>` (`+U`, `+C-NH3`, `+tU-H2S` of 4SU, which nuxl2dia.py's `+C/+U/+G/+A` rule
  misses). DIA-NN has no loss classes of its own for these.
- **The adduct in the sequence**: OpenNuXL of the pin writes a localized adduct as a modification of its residue
  (`K(NuXL:C-H3N1)DIHPK`); it becomes the bracket at that residue, never a second one. On a residue with a
  modification already OpenNuXL merges the two (`M(NuXL:U-H2O1~Oxidation)`): the bracket is the adduct, the other
  modification stays the residue's (`[U-H2O1]M(UniMod:35)`, also in the deduplication). Where it could not merge, it
  writes the adduct's mass as a mass delta (`K[+306.0253]`): within 0.01 Da of NuXL:NA_MASS_z0 that is the bracket.
  An `IM` of 0 (a spectrum OpenNuXL could not convert) is no ion mobility.
- **iRT**: an optional reference (MSFragger/EasyPQP `library.tsv`, also gzipped; RT `RT` or
  `AverageExperimentalRetentionTime`, iRT `iRT` or `NormalizedRetentionTime`, as nuxl2dia.py): a straight
  least-squares line of its iRT over its retention time, applied to NuXL's retention times. Linear only (nuxl-app's
  piecewise mode falls back to linear without pwlf); the right slope (nuxl2dia.py's fallback without scipy divides
  the sample covariance by the population variance).
- **DIA-NN's declarations**: beside the TSV, `<stem>_diann_mods.txt` (`save_text_with_companion`, `export.rs`): one
  `--mod <name>,<mass>` per adduct in the library's brackets, 6 decimals, the mass OpenNuXL computed
  (NuXL:NA_MASS_z0), else from the name and the protocol's nucleotide formulas (nucleotides less a water per bond,
  then the formulas added or lost; checked against NuXLDIA's `declare_mod_UV_UCGA_ext.txt`, all 99). The dialog
  shows them with Copy. A companion that exists writes nothing: the shim keeps the chosen file and the dialog asks
  "Replace <name>?"; Replace writes both there (`replace: true`, no second save dialog). Without cross-links no file.
- ProteinId names each accession once; integers are written without nuxl2dia.py's `.0`; of PSMs of a peptide with
  the same best score the first is kept (nuxl2dia.py's unstable pandas sort keeps any).

Parity (`library.parity.test.ts`): 45 cross-link and 30 peptide rows of NuXLDIA's timsTOF TextExporter output through
the real nuxl2dia.py and through the port give the same precursors and, but for two tied peptides, the same rows, in
the same order, with the differences above only (and the last bit of a double that pandas' fast parser rounds
differently). Questions for DIA-NN and NuXL experts: `docs/library-open-questions.md`. No OpenSWATH variant: OpenMS'
TargetedFileConverter cannot read the bracket names (AASequence takes a bracket as a mass).

## 6. Left out (for now)

PeptDeep; open search; pooled FDR over files; OpenNuXL's `optimize`, `RTpredict` and `pcrecalibration` filters;
custom presets files. Inputs: `.mzML.gz` and zipped `.d` folders (`.d.zip`: unpack them first), `.d` folders without
timsTOF data (Agilent, Waters), Waters `.raw` folders and mzPeak (which OpenNuXL reads, but the app does not take);
the converted spectra of `.raw` and `.d` inputs in projects.

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
- The About menu (AboutMenu.svelte, ⓘ in the top bar): the app's and OpenNuXL's versions (when OpenNuXL cannot be
  run, `tool_info`'s error in full: how it ended, the tool, its last output), "Check for updates" with its result in
  place, and the setting. A Download that cannot open the page says so where it was clicked (banner or
  panel); a new check or Not now clears it.
- The release page opens in the system's browser through the shim, `open_release_page(version)`
  (`src-tauri/src/update.rs`): the version must be digits and dots (`major.minor.patch`); the URL
  (`https://github.com/timosachsenberg/nuxl-gui/releases/tag/desktop-native-v<version>`) is built in Rust, never taken
  from the page or from GitHub's answer, and opened with `xdg-open` (from an AppImage without the AppImage's library
  and GTK variables), `open` (macOS) or `rundll32 url.dll,FileProtocolHandler` (Windows; no shell). No plugin.
- The CSP's `connect-src` has `https://api.github.com` beside the app's own (tauri.conf.json); nothing else.
