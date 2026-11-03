// The searches of the results reader's fixtures, as both fixture scripts run them:
// results-fixture-native.mjs with the ProSE tool (in a search folder as the shim makes it) and
// results-fixture-web.mjs with the web app's WebAssembly module (as the web app's engine calls it).
//
// The data: the app's example and cRAP (RESOURCES, default the app's src-tauri/resources) and OpenMS' TOPP test
// data (OPENMS_TOPP, default the pin's `src/tests/topp`).

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const RESOURCES = process.env.RESOURCES ?? resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/resources')
const OPENMS_TOPP = process.env.OPENMS_TOPP ?? '/scratch/sachsenb/openms-desktop/src/tests/topp'

/** The peak filter of the shim (src-tauri/src/args.rs PEAK_WINDOW, PEAK_TOP). */
export const PEAK_WINDOW = 100
export const PEAK_TOP = 100

/** The cRAP the shim bundles (src-tauri/resources/fasta/crap.fasta), the web app's. */
export const CRAP = resolve(RESOURCES, 'fasta/crap.fasta')

/** The preset `orbitrap-hcd-tryptic` (prose-pages app/src/lib/settings/presets.ts). */
const ORBITRAP = {
  enzyme: 'Trypsin/P',
  'peptide:enzyme_specificity': 'full',
  'peptide:missed_cleavages': 2,
  'modifications:fixed': ['Carbamidomethyl (C)'],
  'modifications:variable': ['Oxidation (M)', 'Acetyl (Protein N-term)'],
  'FDR:PSM': 0.01,
  'FDR:protein': 0.01,
  'precursor:min_charge': 2,
  'precursor:max_charge': 5,
  'peptide:min_size': 7,
  'peptide:max_size': 40,
  'precursor:mass_tolerance_lower': 10,
  'precursor:mass_tolerance_upper': 10,
  'precursor:mass_tolerance_unit': 'ppm',
  'fragment:mass_tolerance': 20,
  'fragment:mass_tolerance_unit': 'ppm',
  'peptdeep:instrument': 'QE',
}

/**
 * name → { mzML: the file searched, names: the inputs (the file under each name), fasta, contaminants,
 * parameters, rescore, peptdeep }
 */
export const CASES = {
  // The app's example (src/lib/search/form.svelte.ts `EXAMPLE`, src-tauri/src/files.rs): OpenMS' Ecoli_MS2_small.mzML
  // (LTQ Orbitrap XL, CID) searched as two replicates, the E. coli K-12 proteins with the contaminants (the form's
  // default), the default preset with the example's fragment tolerance of 0.5 Da, decoys generated (the FASTA has
  // none), Percolator and PeptDeep, and, as the app's example, no protein FDR (FDR:protein 0). The web app's fixture
  // (web-example.json) was made at the preset's 1 %, which ProSE then skipped (no decoy protein in the merged result),
  // so its proteins have no q-value either. Since OpenMS #10707 (protein inference on more PSMs) ProSE applies that FDR.
  example: {
    mzML: resolve(RESOURCES, 'example/Ecoli_MS2_small.mzML'),
    names: ['Ecoli_1.mzML', 'Ecoli_2.mzML'],
    fasta: resolve(RESOURCES, 'example/Ecoli_K12_proteome.fasta'),
    contaminants: true,
    parameters: { ...ORBITRAP, 'fragment:mass_tolerance': 0.5, 'fragment:mass_tolerance_unit': 'Da', 'FDR:PSM': 0.02, 'FDR:protein': 0 },
    rescore: true,
    peptdeep: true,
  },
  // The web app's example (prose-pages app/src/lib/search/form.svelte.ts `EXAMPLE`), the reader's comparison with the
  // web app: OpenMS' simulated DatabaseSuitability_in_spec.mzML (the web app's app/public/example has the same files)
  // searched as two replicates, its FASTA with the contaminants, the default preset with the web example's protein
  // FDR of 5 % (49 proteins), Percolator and PeptDeep.
  suitability: {
    mzML: resolve(OPENMS_TOPP, 'THIRDPARTY/DatabaseSuitability_in_spec.mzML'),
    names: ['DatabaseSuitability_1.mzML', 'DatabaseSuitability_2.mzML'],
    fasta: resolve(OPENMS_TOPP, 'THIRDPARTY/DatabaseSuitability_database.fasta'),
    contaminants: true,
    parameters: { ...ORBITRAP, 'FDR:protein': 0.05 },
    rescore: true,
    peptdeep: true,
  },
  // Modified peptides (the web app's example has none): ProSE's TOPP test data of ProSE_1 (SimpleSearchEngine_1),
  // with its settings (Trypsin, 5 ppm, 0.1 Da, Carbamidomethyl (C) fixed, Oxidation (M) variable), the
  // N-terminal acetylation of the preset, generated decoys and the FDR filters off (0 filters nothing:
  // the shim requires FDR:PSM > 0, so 1).
  mods: {
    mzML: resolve(OPENMS_TOPP, 'SimpleSearchEngine_1.mzML'),
    names: ['SimpleSearchEngine_1.mzML'],
    fasta: resolve(OPENMS_TOPP, 'SimpleSearchEngine_1.fasta'),
    contaminants: false,
    parameters: {
      enzyme: 'Trypsin',
      'peptide:missed_cleavages': 1,
      'modifications:fixed': ['Carbamidomethyl (C)'],
      'modifications:variable': ['Oxidation (M)', 'Acetyl (Protein N-term)'],
      'FDR:PSM': 1,
      'precursor:mass_tolerance_lower': 5,
      'precursor:mass_tolerance_upper': 5,
      'precursor:mass_tolerance_unit': 'ppm',
      'fragment:mass_tolerance': 0.1,
      'fragment:mass_tolerance_unit': 'Da',
    },
    rescore: false,
    peptdeep: false,
  },
  // An open search (the modification analysis, delta masses): the data of `mods` with the settings of the
  // preset `open-search` (±500 Da, no variable modifications, isotope errors 0).
  open: {
    mzML: resolve(OPENMS_TOPP, 'SimpleSearchEngine_1.mzML'),
    names: ['SimpleSearchEngine_1.mzML'],
    fasta: resolve(OPENMS_TOPP, 'SimpleSearchEngine_1.fasta'),
    contaminants: false,
    parameters: {
      enzyme: 'Trypsin',
      'peptide:missed_cleavages': 1,
      'modifications:fixed': ['Carbamidomethyl (C)'],
      'modifications:variable': [],
      'FDR:PSM': 1,
      'precursor:mass_tolerance_lower': 500,
      'precursor:mass_tolerance_upper': 500,
      'precursor:mass_tolerance_unit': 'Da',
      'precursor:isotope_error_min': 0,
      'precursor:isotope_error_max': 0,
      'fragment:mass_tolerance': 0.1,
      'fragment:mass_tolerance_unit': 'Da',
    },
    rescore: false,
    peptdeep: false,
  },
  // A search in which no PSM passes the FDR (as a search on the wrong database): ProSE's TOPP test database
  // ProSE_empty.fasta, whose decoys (DECOY_, reused by decoys auto) are the real proteins of `suitability` and its targets
  // their reversed sequences, so the spectra match decoys only. Two inputs (the merged files) with the PSM and protein
  // FDR at 1 % and Percolator. No web counterpart: the reader's test checks that it reads as an empty result.
  empty: {
    mzML: resolve(OPENMS_TOPP, 'THIRDPARTY/DatabaseSuitability_in_spec.mzML'),
    names: ['DatabaseSuitability_1.mzML', 'DatabaseSuitability_2.mzML'],
    fasta: resolve(OPENMS_TOPP, 'ProSE_empty.fasta'),
    contaminants: false,
    parameters: { ...ORBITRAP, 'FDR:protein': 0.01 },
    rescore: true,
    peptdeep: false,
  },
  // A search without decoys (the database card's Decoys: None, ProSE's decoys 'ignore'): the app sends no FDR then (the
  // form turns both off; ProSE would skip them), so the PSMs have no q-values and Percolator cannot rescore them (the
  // run view says why). The app's example run, once, with the contaminants.
  'no-decoys': {
    mzML: resolve(RESOURCES, 'example/Ecoli_MS2_small.mzML'),
    names: ['Ecoli_MS2_small.mzML'],
    fasta: resolve(RESOURCES, 'example/Ecoli_K12_proteome.fasta'),
    contaminants: true,
    parameters: {
      ...ORBITRAP,
      'fragment:mass_tolerance': 0.5,
      'fragment:mass_tolerance_unit': 'Da',
      decoys: 'ignore',
      'FDR:PSM': null,
      'FDR:protein': null,
    },
    rescore: true,
    peptdeep: false,
  },
}

export function getCase(name) {
  const c = CASES[name]
  if (!c) throw new Error(`no fixture case ${name} (${Object.keys(CASES).join(', ')})`)
  return c
}
