# Output parity: the web app's result types and ProSE's outputs

The desktop app shows ProSE's results in the web app's screens, so it has to fill the web app's result types
(`ResultTables`, `StoredSpectra`, `ProSEMultiSummary`, in `prose-pages/app/public/openms/openms.d.ts`; semantics in
`prose-pages/docs/prose-app-spec.md` §4.5–4.8) from the files the ProSE tool writes. This document lists every field,
where it comes from, and a verdict:

- **available**: a column or key of a ProSE output holds it as it is (or as a plain unit or index change);
- **derived in the UI**: the reader computes it from available values (the derivation is given);
- **added in #10676**: no output had it; OpenMS PR [#10676](https://github.com/OpenMS/OpenMS/pull/10676) (merged into
  `develop`, in the pin `native/OPENMS_COMMIT`) adds it;
- **not needed**: the desktop app does not show it (the reason is given).

Checked against ProSE of the pin (`native/OPENMS_COMMIT`, a develop commit; the fixtures are made with it) on the app's
example (OpenMS' `Ecoli_MS2_small.mzML`, LTQ Orbitrap XL CID, as two inputs, with Percolator and PeptDeep), the web app's
example (`DatabaseSuitability_in_spec.mzML`, simulated, one and two inputs), the TOPP test data (closed and open search,
with and without Percolator and PeptDeep) and a search without decoys. The reader's result equals the web app's but for
the size of the fragment index (`indexedPeptides`, `indexedFragments`: the native tool indexes the whole database once
for both inputs, the web module only the peptides the precursor windows reach) and for what the pinned ProSE computes
differently from the web app's older one (`src/lib/results/read.test.ts` checks these differences): its q-values are at
or above the web app's (1/T for T target PSMs without a decoy PSM, OpenMS #10714; Percolator's (decoys + 1) / targets
without pi0, as the percolator executable, #10721), Percolator's scores and PEPs differ (by up to 0.01 and 0.05 on the
web app's example), the recommended tolerances are whole ppm (#10715) and the delta-mass table counts the target PSMs
only, with each peak's own unique peptides (#10715). The app's example is searched at a PSM FDR of 2 % (none of its PSMs
passes 1 % with these q-values): 112 of the web app's 120 PSMs (at 1 %) are among its 154, equal but for Percolator's
values.

**The app reads only QPX** (the user's decision, 2026-10-21): the QPX psm, mz, pg, run and provenance views ProSE writes
with `-out_qpx` and its `-qpx_extended` (#10676), with optional columns. QPX readers ignore columns and keys they do
not know (QPX `docs/spec/serialization.md`); the column names are those proposed in
[bigbio/qpx#355](https://github.com/bigbio/qpx/issues/355) (and `spectrum_reference` of
[#259](https://github.com/bigbio/qpx/issues/259)), so that they need no rename if QPX adopts them. OpenMS' own
Parquet (`-out_parquet`), the PSM spectra sidecar (gone from the tool) and the summary YAML (`-summary_out`) are not
written for the app any more.

## How the app runs ProSE

```
ProSE -in <files…> -database <fasta (+ cRAP)> -threads <n> -Search:… (form)
      -out_qpx <dir>/qpx -qpx_extended -qpx_peak_window 100 -qpx_peak_top 100
      -keep_decoys
      [-out_merged <dir>/merged.idXML]                  (two or more inputs: the pooled inference, and the Export menu's idXML)
      [-out_idxml <dir>/search.idXML]                   (one input: the Export menu's idXML)
      [-out_mod_analysis_dir <dir>/mods]                 (open search)
```

| Short name | File | Content |
| --- | --- | --- |
| psm | `qpx/runs/<stem>.psm.parquet` (per input) | one row per written PSM (best hit of a spectrum): the QPX psm view, with the columns of `-qpx_extended` (below) including PeptDeep's prediction; written as soon as its input is done, in row groups of 256 rows (the PSM view reads the row group of the PSM it opens) |
| mz | `qpx/runs/<stem>.mz.parquet` (per input) | the QPX mz view of the MS2 spectra of the input's written PSMs only, one row per spectrum in the order of its first PSM and one per native ID (the view's key: of several spectra of one native ID only the first's, so the PSMs of the others have none), with **filtered peaks** (below); row groups of 256 rows; its footer has the filter (`prose_peak_window`, `prose_peak_top`, `prose_peak_annotated` "kept") |
| merged psm | `qpx/quantms.psm.parquet` | the rows of all inputs (whose files were written), in input order, without the prediction columns: the reader's PSM rows |
| run | `qpx/quantms.run.parquet` | the QPX run view: one row per input, in input order, with ProSE's optional columns (below) |
| provenance | `qpx/quantms.provenance.parquet` | the QPX provenance view: one row per step of the search (`peptide_search`, `spectrum_prediction`, `psm_rescoring`, `target_decoy_fdr`, `protein_grouping`) with curated `parameters`; the complete ProSE parameters as JSON in the `config` of the search step |
| sample | `qpx/quantms.sample.parquet` | the QPX sample view: one sample per input (its stem; organism and organism part "not available", which ProSE does not know); the reader does not read it |
| pg | `qpx/quantms.pg.parquet` | the protein groups: of one input its own (`qpx/runs/<stem>.pg.parquet`); of several the pooled inference of `-out_merged` (with its protein FDR, decoys kept by `-keep_decoys`); without protein inference one group per protein |
| footer | the Parquet footer key-value metadata of the per-input files | what describes their optional content: of the psm file `prose_prediction_ms2_model`, `prose_prediction_instrument`; of the mz view the peak filter |
| mod TSV | `mods/<the provenance's mod_analysis_delta_masses>`, `…_ptms` | open-search modification analysis (header lines `# Total PSMs: …` and a table) |
| FASTA | `proteins.fasta`, `database.fasta`, or the database the provenance names (`database_file`) | protein descriptions and sequences |

The per-input files are in `qpx/runs/` (ProSE of OpenMS 3.7 puts them there; `quantms.*` stay in `qpx/`). Searches saved by app
0.1.x have them next to `quantms.*` (`qpx/<stem>.psm.parquet`, `.mz.parquet`): the reader decides per input from its psm file
(`qpx/runs/<stem>.psm.parquet`, else `qpx/<stem>.psm.parquet`) and takes the input's mz file from the same folder.

The columns `-qpx_extended` adds to the psm view: `additional_scores` with **every** numeric score and meta value of
the PSM in snake_case (`global_qvalue`: the PSM-level q-value, computed over the PSMs of its input file; `ln_hyperscore`;
`percolator_score`, `percolator_qvalue`, `percolator_pep`; `precursor_mz_error_ppm`, `isotope_error` (observed minus
theoretical, as the column), `delta_mass`, the Percolator features, PeptDeep's), with `higher_better` where it is
known; `spectrum_reference` (the native ID); `isotope_error` (int16, observed minus theoretical, whatever ProSE's
`report:isotope_error_convention`); `protein_mappings` (accession, 1-based `start`/`end`, `aa_before`/`aa_after`, `-`
at a protein terminus); and in the per-input files
`predicted_ion_type_array`/`predicted_mz_array`/`predicted_intensity_array` (PeptDeep, below; QPX has no place for a
prediction). The observed peaks are in the QPX mz view (the spec's preferred place for spectra, `mz.md`), not in the
psm view: per input `qpx/runs/<stem>.mz.parquet` with the spec's columns (`id` the native ID = the psm's
`spectrum_reference`, `run_file_name`, `scan`, `ms_level`, `centroid`, `scan_start_time` in minutes,
`inverse_ion_mobility`, `ion_injection_time` (null if unknown), `total_ion_current` of all its peaks, `precursors`,
`cv_params` (null)) and `mz`/`intensity` (float32, by m/z) **filtered**: the 100 most intense peaks per 100 m/z
(jumping windows, each starting at its first peak; the last window keeps 100 too) and the peaks of the fragment
annotations `mz_array` of its PSMs — of deisotoped spectra also the raw 2+/3+ peak of a fragment that deisotoping
moved to its 1+ m/z, so every annotated fragment keeps its peak. The file holds the spectra of the written PSMs only.

The run view (`quantms.run.parquet`): the QPX columns `run_accession` and `run_file_name` (the input's stem, as its
psm file is named), `file_name`, `samples` (one sample per run: the stem, label `LFQ`; ProSE knows no design),
`enzymes`, `modification_parameters` (fixed and variable, `UNIMOD:` accession, position, target residue); and
ProSE's optional columns `search_status` (`EXECUTION_OK`, `INPUT_FILE_EMPTY`, `UNEXPECTED_RESULT`, `UNKNOWN_ERROR`,
`ILLEGAL_PARAMETERS`), `ms2_spectra_count`, `identified_spectra_count` (target PSMs after the FDR filters),
`decoy_psm_count`, `psm_rows` (its rows in `quantms.psm.parquet`), `rescoring_applied` (null: the search did not
rescore), `rescoring_skipped_reason`, `rescoring_warning`, `prediction_nce`, `precursor_error_median_ppm`,
`precursor_error_mad_ppm`, `precursor_tolerance_recommended_ppm`, `fragment_error_median_ppm`,
`fragment_error_mad_ppm`, `fragment_tolerance_recommended_ppm` (null: no estimate), `search_seconds`.

The provenance view's `parameters` (the tool's documentation): of `peptide_search` `database_file`, `enzyme`,
`enzyme_specificity`, `missed_cleavages`, `peptide_min_length`, `peptide_max_length`,
`precursor_mass_tolerance_lower`/`_upper`/`_unit`, `fragment_mass_tolerance`/`_unit`, `min_charge`, `max_charge`,
`fixed_modifications`, `variable_modifications`, `clip_nterm_methionine`, `decoy_mode`, `decoy_string`,
`decoy_position`, `open_search`, `calibration`, `chunked`, `isotope_error_convention`, `extra_features`,
`db_target_proteins`, `db_decoy_proteins`, `indexed_peptides`, `indexed_fragments`, `seconds_index_build`,
`seconds_total`, and in open search `mod_analysis_delta_masses`, `mod_analysis_ptms`; of `spectrum_prediction`
(category `rescoring`, the closest QPX one) `method`, `ms2_model`, `instrument`, `rescoring_features`; of
`psm_rescoring` `method`; of `target_decoy_fdr` `psm_fdr`, `protein_fdr`, `psm_fdr_method`, `protein_fdr_method`,
`protein_fdr_applied`; of `protein_grouping` `algorithm`, `pooled`.

All Parquet files are Zstandard-compressed (Arrow C++): the reader needs a Zstandard decoder (hyparquet has Snappy
only). The FASTA is the folder's `database.fasta` with contaminants; without them ProSE searched the user's file,
whose path is the provenance's `database_file` (absolute, outside the search folder): the shim serves that path
only if the folder's `database.json` (written by the shim at the start of such a search) records it.

**Precision.** QPX has `observed_mz`, `calculated_mz` and `rt` as float32 (OpenMS' own Parquet had doubles): the m/z
and RT the app shows agree with the web app's within float32's precision, a relative 1e-7 (0.1 ppm), and so do the
.pin features `CalcMass` and `mass`; `dm`/`absdm` (differences of two of them) within 2e-4 Da. The tests compare with
these tolerances (`src/lib/results/read.test.ts`). The scores are doubles as before.

**Protein sequences and descriptions** come, in this order, from `proteins.fasta` in the search folder (the identified
proteins of the table, decoys as searched; the app writes it when it saves the search to History), from the database (`database.fasta`, else the provenance's `database_file`), or
not at all: then the sequences are '' (no coverage), the descriptions those of the pg view (`pg_names`), and the reader returns a warning
(`SearchResult.warnings`); it does not fail.

**History** adds two files to the folder when a search is saved (after `search://done`): `proteins.fasta` and, last,
`search.json` (schema 1: `schema, id, name, createdAt, appVersion, toolVersion, files, database, design, settings,
psms, psmFdr, proteinFdr, seconds`, see `src/lib/history/history.ts`; `psms` from the run view
`qpx/quantms.run.parquet`, the sum of `identified_spectra_count`). A folder with `search.json` is a saved search; a
project file (`.prose`) is a zip of the folder's regular files (not the links to the inputs, not `database.fasta`, not
`database.json`; `inputs.json` with the file names only). An imported search has `imported: true` in `search.json`:
it reads only the files of its folder (no absolute path is served). A running search or import holds an exclusive
lock on `<id>.partial/.lock`, which the startup sweep honours.

**Searches of the earlier layouts** (saved by the app before task 11: `summary.yaml`, `oms/`, `spectra/` next to QPX
files without the `-qpx_extended` columns; or of task 11 before its fix round, QPX files without the run and
provenance views): the reader refuses them with a clear message (`OldLayoutError`: "This
search was saved by an earlier version of ProSE Desktop, whose results this version cannot read. Open it with that
version, or run the search again."), shown where History or Open project opens them; nothing crashes.

**Missing files**: the reader's `files` callback rejects with `FileNotFound` (anything with `notFound: true`) for a file
that does not exist; only that counts as missing (a failed input's psm file, the pg file, mod TSVs, a FASTA source).
Any other error fails the read, naming the file; so does a file that cannot be parsed, a psm file without the
columns of `-qpx_extended`, and rows that the run view's `psm_rows` do not account for. A per-input psm file or mz
view that is missing or broken fails only the PSMs that open from it (the PSM view says why); a missing mz view (the
input could not be read again) leaves its PSMs without peaks.

Rows: the PSM rows of `ResultTables.psms` are the rows of `quantms.psm.parquet` (the inputs in order, `psm_rows`
each). A PSM's prediction is the same row of its input's psm file (checked: `psm_id`); its spectrum the row of the
input's mz view whose `id` is its `spectrum_reference` (checked): the mz rows are in the order of each spectrum's
first PSM, so the reader counts them; if the view has another number of rows (a spectrum not found), or the counted
row has another id, it finds them by their ids (once per input; a second load of the input that was already under way
retries with them too). A PSM whose `spectrum_reference` is null has no stored spectrum: ProSE leaves it null for a
second spectrum of a native ID, whose mz row is the first's (the PSM view says so); such a PSM is never matched by
another key (`run_file_name`, `scan`). A row whose `scan_start_time` is not the PSM's RT (the first of several spectra
of the PSM's native ID) is not the PSM's either. Both are read by row group (256 rows) when the PSM view opens a PSM,
and the last four row groups of each are kept (`src/lib/results/read.ts`, `SearchResult.spectra.load`). Nothing of
them is read when the search opens.

## ResultTables

| Field | Source | Verdict |
| --- | --- | --- |
| `files` | the input paths the app passed (the run view's rows are in the same order) | available |
| `psms.count` | number of rows of `quantms.psm.parquet` | available |
| `psms.file` | position of the row's input in `files` (by the run view's `psm_rows`) | derived in the UI |
| `psms.nativeId` | psm `spectrum_reference` (-qpx_extended; QPX `scan` has the scan number only) | **added in #10676** |
| `psms.rt` | psm `rt` (float32); null → NaN | available (float32) |
| `psms.mz` | psm `observed_mz` (float32) | available (float32) |
| `psms.charge` | psm `charge` | available |
| `psms.peptide` | index into `peptides`, unique by peptidoform | derived in the UI (dedupe in row order) |
| `psms.score` | Percolator's SVM score: `additional_scores` `percolator_score`; without rescoring ProSE's ln(hyperscore): `ln_hyperscore`. A hit Percolator could not rescore: −100 (as in the output) | available (by name; **all scores added in #10676**: the QPX writer itself puts only the known scores there, under OpenMS names) |
| `psms.qValue` | `additional_scores` `global_qvalue` (the PSM's main score, PSM-level: Percolator's q-value, or the target-decoy q-value of FDR:PSM > 0, computed per input file), else `percolator_qvalue`. No decoys → NaN | available; with FDR:PSM 0 and no rescoring there is none: **the app always sends FDR:PSM > 0** (the form's FDR) |
| `psms.pep` | psm `posterior_error_probability` (= `percolator_pep`); null → NaN | available |
| `psms.precursorErrorPpm` | `additional_scores` `precursor_mz_error_ppm` (ProSE's, isotope-corrected, as the web app; QPX `mass_error_ppm` is not); without it computed from `observed_mz`, `calculated_mz` and `isotope_error`: (observed − isotope × 1.0033548378 / charge − calculated) / calculated × 10⁶ | available |
| `psms.isotopeError` | psm `isotope_error` (int16, observed minus theoretical: ProSE converts from its `report:isotope_error_convention`, with either convention); null → 0 | **added in #10676** |
| `psms.deltaMass` | `additional_scores` `delta_mass` (open search only); closed search → NaN | available |
| `psms.decoy` | psm `is_decoy` | available |
| `psms.featureNames`, `psms.features` | `ln(hyperscore)` (`ln_hyperscore`); the run's extra features (provenance `extra_features`, by their `additional_scores` names) with their values from `additional_scores` (`isotope_error` with the sign of ProSE's convention, provenance `isotope_error_convention`, as Percolator saw it); PeptDeep's five from `additional_scores` when `peptdeep:enable`; the standard .pin features (below) | available, except the standard .pin features: derived in the UI |
| ↳ standard .pin features | as `PercolatorInfile::stampPinFeaturesOnHits`: `CalcMass` = `calculated_mz`; `mass` = `observed_mz`; `peplen` = length of `sequence`; `charge<N>` = (charge = N) for N in the provenance's `min_charge`..`max_charge` (widened to the PSMs'); `dm` = `observed_mz` − `isotope_error` × sign × 1.0033548378 / charge − `calculated_mz`, sign −1 when the provenance's `isotope_error_convention` is `theoretical_minus_observed` (ProSE's meta value as Percolator saw it); `absdm` = |`dm`|; `enzN`/`enzC`/`enzInt` = Percolator's cleavage rule of the provenance's `enzyme` (`PercolatorInfile::isEnz_`, a dozen enzymes) on `aa_before`/first residue, last residue/`aa_after` (`protein_mappings[0]`; QPX's `-` at a terminus taken as OpenMS' `[`/`]`, which Percolator's features were computed with) and the residues inside | derived in the UI (port of the rule table; float32 m/z: see "Precision") |
| `peptides.count` | distinct peptidoforms | derived in the UI |
| `peptides.openms` | AASequence spelling: `sequence` + `modifications` (`X(Name)`, `.(Name)X…` N-terminal, `…X.(Name)` C-terminal) | derived in the UI (used as a key and for display; the UI computes no masses from it) |
| `peptides.proforma` | ProForma with Unimod names, fixed modifications included: `sequence` + `modifications` (name, positions), as the web app's rule (`[Name]-` N-term, `X[Name]`, `-[Name]` C-term, mass-only names as `[+m]`); never the open-search shift | derived in the UI (QPX `peptidoform` is canonical ProForma with accessions) |
| `peptides.sequence` | psm `sequence` | available |
| `peptides.decoy` | psm `is_decoy` of its PSMs | available |
| `peptides.modOffsets` | CSR offsets over the modifications | derived in the UI |
| `peptides.modPosition` | `modifications[].positions[].position`: 0 → −1 (N-term), *n*+1 → length (C-term), else position − 1 | available (index change) |
| `peptides.modName` | `modifications[].name` (Unimod name; mass-only modifications as their mass) | available |
| `peptides.modUnimod` | `modifications[].accession` `UNIMOD:35` → 35; null → −1 | available |
| `peptides.modMass` | the modification's monoisotopic mass delta: from the app's modification table (Unimod accession → mass, else name → mass), or the mass of a mass-only name. The table is **generated from the pin's Unimod file (`share/OpenMS/CHEMISTRY/unimod.xml` of `native/OPENMS_COMMIT`, which ModificationsDB reads) by `scripts/unimod-table.mjs` into `src/lib/chemistry/unimod.json` (committed; regenerate with the pin)** | derived in the UI (no output carries it; the TypeScript fragment annotation needs the same table) |
| `peptides.proteinOffsets`, `peptides.protein` | `protein_mappings[].accession` of the peptide's first PSM, kept where the protein is in the proteins table (see `proteins`); none left → "below protein FDR" | derived in the UI |
| `peptides.start`, `peptides.end` | `protein_mappings[].start` / `end` (1-based, `end` inclusive → `start` − 1, `end`); the web app's check against the sequence (FASTA) | **added in #10676** |
| `proteins.count`, `proteins.accession` | the members (`pg_accessions`) of the groups of the pg view, in their order; of several inputs the pooled inference | available (pooled pg: **added in #10676**) |
| `proteins.description` | pg `pg_names` if set, else the FASTA header; a generated decoy has the description of its target (as the web app: it looks the decoy up by its target's accession) | derived in the UI (the FASTA is read anyway) |
| `proteins.sequence` | FASTA; a decoy ProSE generated: the reversal ProSE uses (`DecoyGenerator::reversePeptides` for the provenance's `enzyme`, `reverseProtein` for `enzyme_specificity` none, initial M kept with `clip_nterm_methionine`), as the web app's engine regenerated it | derived in the UI |
| `proteins.score` | best `psms.score` of the protein's PSMs | derived in the UI (as the web app) |
| `proteins.qValue` | when the protein FDR was applied (provenance `protein_fdr_applied`): the group's `additional_scores` entry named `q-value` (the score of its first protein, the protein q-value of the picked-protein FDR; the members of an indistinguishable group share it), else the group's `global_qvalue` (the q-value of the group FDR); otherwise NaN | available |
| `proteins.decoy` | the decoy marker (provenance `decoy_string`, `decoy_position`), or pg `is_decoy` of a group of one protein | available |
| `proteins.group` | index of the protein's group: groups distinct by `pg_accessions` (the pooled pg has a row per group and input). **Without protein inference (one input, no protein FDR) `-qpx_extended` writes one group per protein**, as the web app (its pooled run of one file) | available; pooled and singleton groups **added in #10676** |

## StoredSpectra

Read per PSM when the PSM view opens it (`SearchResult.spectra.load(row)`: the StoredSpectra of the row group of the
input's mz view with the PSM's spectrum, and the PredictedSpectra of the row group of its psm file with the PSM).

| Field | Source | Verdict |
| --- | --- | --- |
| `psmSpectrum` | one spectrum per mz row (`LoadedSpectra.spectrumRow` is the PSM's; PSMs of one spectrum share it) | **added in #10676** (mz view) |
| `offsets`, `mz`, `intensity` | mz `mz`, `intensity` (float32, by m/z, as the input file has them, **filtered**: the 100 most intense peaks per 100 m/z and every annotated peak; no row when the spectrum was not found, no view when the file could not be read again). The PSM view says so ("Showing the top 100 peaks per 100 m/z, plus every peak ProSE annotated", from the mz view's footer `prose_peak_top` and `prose_peak_window`; `LoadedSpectra.peakFilter`). On the examples nothing is filtered (the web app's: at most 77 peaks per spectrum; the app's E. coli run: at most 543, never 100 within 100 m/z) | **added in #10676** (mz view) |
| `precursorMz` | mz `precursors[0].selected_ion_mz` (float32; else the PSM's `observed_mz`) | available |
| `collisionEnergy` | — (the reader fills NaN) | not needed: the web app used it only as a fallback NCE for predicting in the browser; the desktop app shows ProSE's prediction, made at the file's `peptdeep_nce` |

The peak filter, measured (task 11 fix round 1 report) on an Orbitrap HCD run (iPRG2015 `JD_06232014_sample1_A`,
Q Exactive, ~1,130 points per identified MS2 spectrum, 20,716 PSMs) against the TypeScript annotation of the PSM view
(b/y/a/c/x/z, charge 1–2, 20 ppm) on the unfiltered peaks of every second target PSM: the share of its matched peaks
that the filter removes is 9.5 % at 50 per 100 m/z, **6.2 % at 100 (the default)** and 1.35 % at 300; of b/y matches
alone 1.9, 1.2 and 0.24 %; of the matched intensity 0.05, 0.001 and 0.000 %. Nearly all removed matches are points of
intensity 0 (the file has them): of the matches with intensity above 0 the filter removes 0.87 % at 50, 0.026 % at
100 and none at 300. The input's mz view of that run (fix round 2: the peaks moved there from the psm file): 90.4 MB
unfiltered, 40.8 MB at 50, 57.2 MB at 100, 82.1 MB at 300; its psm file (with the predictions) 10.3 MB; together
about what the psm file with the peaks was (99.8, 50.2, 66.6, 91.5 MB); `quantms.psm.parquet` 6.7 MB.

The PeptDeep prediction for the PSM view (the web app's `predictMS2()` result) is in the psm's
`predicted_ion_type_array` (`b3+`, `y5++`, named as the QPX `ion_type_array`; the web app writes `b3`, `y5++`),
`predicted_mz_array`, `predicted_intensity_array`: b/y of charge 1 and (precursor charge ≥ 2) 2, relative to the most
intense, > 0.01, by m/z, precursor charges 1–6 — the same rule as the web app's `predictMS2()`. **Added in #10676**, for
every written PSM, also without PeptDeep rescoring (with it, recomputed at the NCE the rescoring used); null where the
prediction failed or without ONNX Runtime. The fragment annotation of ProSE's own scoring stays in QPX `mz_array`,
`intensity_array`, `charge_array`, `ion_type_array`. The reader gives them as `PredictedSpectra` (`src/lib/results/types.ts`:
one range per PSM row of the row group, the ions named as the web app names them, `b3+` → `b3`); on both examples they
equal the web app's `predictMS2()` of each PSM's peptide at the file's NCE within 1e-5 (intensity) and float32 (m/z),
ion for ion.

## ProSEMultiSummary

| Field | Source | Verdict |
| --- | --- | --- |
| `files[].path` | the app's input path (the run view's rows are in the same order) | available |
| `files[].status` | run `search_status` | **added in #10676** (run view) |
| `files[].ms2Spectra` | run `ms2_spectra_count` | **added in #10676** (run view) |
| `files[].targetPSMs`, `decoyPSMs` | run `identified_spectra_count`, `decoy_psm_count` (after the FDR filters; with `-keep_decoys` the decoys that pass) | **added in #10676** (run view) |
| `files[].percolator` | run `rescoring_applied`, `rescoring_skipped_reason`, `rescoring_warning` (null → null); `null` when the search ran with `Search:rescore false` (`rescoring_applied` null) | **added in #10676** (run view) |
| `files[].peptdeepNce` | run `prediction_nce` (the NCE of the file's predictions) | **added in #10676** (run view) |
| `files[].precursorError`, `fragmentError` | run `precursor_error_median_ppm`, `precursor_error_mad_ppm`, `precursor_tolerance_recommended_ppm` / `fragment_…` (null: no estimate), doubles | **added in #10676** (run view) |
| `files[].secondsSearch` | run `search_seconds` | **added in #10676** (run view) |
| `search.databaseFile`, `enzyme`, `openSearch`, `chunked`, `decoyMode`, `indexedPeptides`, `indexedFragments`, `secondsIndexBuild`, `secondsTotal` | provenance `peptide_search` `database_file`, `enzyme`, `open_search`, `chunked`, `decoy_mode`, `indexed_peptides`, `indexed_fragments`, `seconds_index_build`, `seconds_total` (the time until the QPX views are written, the end of the run) | **added in #10676** (provenance) |
| `search.calibration` | provenance `calibration` | **added in #10676** (provenance) |
| `search.targetProteins`, `decoyProteins` | provenance `db_target_proteins`, `db_decoy_proteins` | **added in #10676** (provenance) |
| `proteinFdrApplied` | provenance `target_decoy_fdr` `protein_fdr_applied` | **added in #10676** (provenance) |
| `psmFdr`, `proteinFdr` | provenance `target_decoy_fdr` `psm_fdr`, `protein_fdr` | **added in #10676** (provenance) |
| `decoyString` | provenance `decoy_string` (`DECOY_`; position `decoy_position`); the web app's screens do not use it (decoys are flagged per row: `is_decoy`), but the type has it | **added in #10676** (provenance) |
| `openSearch` | provenance `open_search` | **added in #10676** (provenance) |
| `modificationAnalysis` | null in closed search; the TSVs the provenance names (`mod_analysis_delta_masses`, `mod_analysis_ptms`: of one input its own, of several the `_aggregate_across_files` ones) | available |
| ↳ `deltaMasses.totalPSMs`, `modifiedPSMs`, `unmodifiedPSMs`, `meanDeltaMass`, `medianDeltaMass` | DeltaMassStats header lines `# Total PSMs:`, `# Modified PSMs:`, `# Unmodified PSMs:`, `# Mean Delta Mass:`, `# Median Delta Mass:` | available |
| ↳ `deltaMasses.entries[]` | DeltaMassStats rows: `DeltaMass`, `Count`, `UniquePeptides`, `ChargeStates`, `Percentage`, `MappedModification`, `IsKnown` | available |
| ↳ `ptms.totalModifiedPSMs`, `unknownModificationPSMs`, `uniqueModifications` | PTMStats header lines | available |
| ↳ `ptms.entries[]` `name`, `theoreticalMass`, `observedMass`, `massDeviation`, `count`, `uniquePeptides`, `percentage`, `targetResidues` | PTMStats columns (the TSVs have six significant digits, the web app the doubles) | available |
| ↳ `ptms.entries[].chargeStates` | — (PTMStats has no charge column; the reader fills 0) | not needed: the web app's screens do not show it |
| ↳ `ptms.entries[].residueCounts` | PTMStats `ResidueFrequency` (`A:4,D:2,…`; equals the web app's) | available (the web app does not show it: `delta-mass.ts` counts every residue of the peptides) |

The modification analysis stays in the tool's TSVs (`-out_mod_analysis_dir`): it has no QPX counterpart.

## Values whose source changed with the QPX-only reader (task 11)

Before, the reader took them from OpenMS' own Parquet (OMS), the sidecar or `summary.yaml`:

| Value | Before | Now |
| --- | --- | --- |
| native ID | OMS `spectrum_reference` | psm `spectrum_reference` |
| RT, precursor m/z, `CalcMass`, `mass`, `dm`, `absdm` | OMS doubles | psm float32 (agree within 1e-7 relative, `dm` within 2e-4 Da) |
| scores, q-value, Percolator outputs, features | OMS `score`/`score_type`, `psm_metavalues` (text) | psm `additional_scores` (doubles, snake_case) |
| precursor error (ppm), delta mass | OMS `psm_metavalues` | `additional_scores` `precursor_mz_error_ppm`, `delta_mass` |
| isotope error | OMS `psm_metavalues` with the run's convention | psm `isotope_error` (observed minus theoretical) |
| proteins of a peptide, positions, flanking residues | OMS `protein_accessions` (0-based, `[`/`]` termini) | psm `protein_mappings` (1-based, `-` termini) |
| enzyme, specificity, initial-M rule, decoy marker, extra features | OMS search params | provenance view |
| proteins, descriptions, decoys, q-values, groups | OMS proteins/pg (and merged) | QPX pg (`quantms.pg.parquet`); without inference, singleton groups written by the tool instead of derived in the reader |
| peaks | sidecar (all peaks) | the QPX mz view (filtered peaks) |
| predictions | sidecar | psm columns `predicted_*` |
| per-file statistics | `summary.yaml` | run view |
| search statistics, protein FDR applied, mods pointers | `summary.yaml` | provenance view |
| PSM rows | per-input psm files | `quantms.psm.parquet` (the spectra: the per-input files, per PSM opened) |
| History's PSM count | `summary.yaml` | run view `qpx/quantms.run.parquet` |
| the user's database path the shim serves | `summary.yaml` | the shim's `database.json` |

Nothing the app displays had to stay outside QPX but the modification analysis (TSVs, as before) and the protein
sequences (FASTA, as before).

## The explicit checks

- **Pooled q-values across files, decoys kept.** The web app's PSM table pools the PSMs of all files and keeps each
  file's own q-values (Percolator per file, or target-decoy competition per file); the psm files are exactly that,
  concatenated. Decoys: one input with FDR:protein > 0 would remove them — closed by `-keep_decoys` (#10676), which
  keeps the decoy PSMs and proteins that pass, as the web app's `removeDecoys: false`.
- **Percolator features of the PSM view.** ln(hyperscore), the extra features and PeptDeep's are in `additional_scores`
  (the extra features named in the provenance's `extra_features`); the standard .pin features are derived in the UI
  with PercolatorInfile's formulas (table above). `percolator_score`, `percolator_qvalue`, `percolator_pep` are there too.
- **Per-file statistics.** MS2 spectra, target and decoy PSMs, seconds, Percolator applied or skipped (with the
  reason and the warning), the NCE: the run view.
- **Protein sequences for coverage.** No ProSE output has them; the UI reads the FASTA, and regenerates ProSE's
  generated decoys with its rule. Positions of the peptides in the proteins are in `protein_mappings`.
- **Protein groups.** The QPX pg view: of one input its own; of several the pooled inference of `-out_merged`
  (`quantms.pg.parquet`, #10676); without inference one group per protein (#10676).
- **Modification arrays and ProForma.** QPX `modifications` (name, `UNIMOD:` accession, positions with N-/C-terminal
  0/*n*+1) give names, accessions and positions; the ProForma and AASequence spellings are composed in the UI; masses
  come from the app's modification table, generated at build time from the pin's ModificationsDB/unimod.xml (no
  output has them).
- **NCE per file.** The run view's `prediction_nce` — for every file with predictions, also without PeptDeep
  rescoring (then selected by PeptDeep rescoring run on a copy of the written PSMs; `peptdeep:nce` if set).
- **Delta masses of open search.** `additional_scores` `delta_mass` per PSM; the aggregate tables in the mod TSVs.

## What the app must pass

`-out_qpx` with `-qpx_extended` (and the peak filter's `-qpx_peak_window`, `-qpx_peak_top`) and `-keep_decoys` always;
`-out_merged` for two or more inputs (the pooled proteins); FDR:PSM > 0 (q-values without Percolator);
`-out_mod_analysis_dir` in open search. Inputs must have distinct file names (stems, `a.mzML` and `a.mzML.gz`
included): ProSE refuses two inputs of the same name in different folders (exit code 6), as their per-input outputs
would overwrite each other; the app has to say so before it starts. `.mzML.gz` inputs work (their peaks equal those
of the uncompressed file). Each per-input psm file is written as soon as its input is done; the merged psm file and
the run, sample and provenance views at the end of the run. A failed re-read or prediction leaves null columns and a warning in the log, never a
failed search; with ONNX Runtime missing in a build, the `predicted_*` columns are null and the PSM view shows the
theoretical spectrum only.
