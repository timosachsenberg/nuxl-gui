// OpenNuXL's options that the app may set (the shim's allowlist, src-tauri/src/args.rs `PARAMETERS`), with
// OpenNuXL's defaults, types, descriptions and allowed values. Generated at build time from the OpenMS pin
// (`registerOptionsAndFlags_` of OpenNuXL.cpp) by scripts/nuxl-parameters.mjs into nuxl-parameters.json; the
// modification names (OpenMS' ModificationsDB) are in modifications.json. The form is hand-made (SettingsCard):
// these give its defaults and choices, and the "All parameters" dialog.

import entries from './nuxl-parameters.json'
import modificationNames from './modifications.json'
import type { ParamEntry } from './parameters'

/** OpenMS' modification names, one residue or terminus each ("Oxidation (M)", "Acetyl (Protein N-term)"). */
export const MODIFICATION_NAMES: readonly string[] = modificationNames

/**
 * The bounds the form holds the numbers to (OpenNuXL registers none: these are what makes sense to search with).
 * A value outside them stops the search (ranges.ts `outOfBounds`).
 */
const BOUNDS: Readonly<Record<string, { min?: number; max?: number }>> = {
  'precursor:mass_tolerance': { min: 0 },
  'precursor:min_charge': { min: 1 },
  'precursor:max_charge': { min: 1 },
  'fragment:mass_tolerance': { min: 0 },
  'modifications:variable_max_per_peptide': { min: 0 },
  'peptide:min_size': { min: 1 },
  'peptide:max_size': { min: 1 },
  'peptide:missed_cleavages': { min: 0 },
  'report:top_hits': { min: 1 },
  'NuXL:length': { min: 0, max: 4 },
  'NuXL:decoy_factor': { min: 1 },
  'NuXL:filter_small_peptide_mass': { min: 0 },
  'NuXL:marker_ions_tolerance': { min: 0 },
  window_size: { min: 0 },
  peak_count: { min: 1 },
}

/** The parameters, the modification lists with their allowed names, the numbers with their bounds. */
export const NUXL_PARAMETERS: ParamEntry[] = (entries as ParamEntry[]).map((e) => ({
  ...e,
  ...BOUNDS[e.name],
  ...(e.name === 'modifications:fixed' || e.name === 'modifications:variable' ? { validStrings: [...modificationNames] } : {}),
}))
