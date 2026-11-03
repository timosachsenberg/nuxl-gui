// ProSE's search parameters that the app may set (the shim's allowlist, src-tauri/src/args.rs
// `PARAMETERS`), with ProSE's defaults, types, descriptions and allowed values. Generated at build
// time from the pinned ProSE tool (`ProSE -write_ini`) by scripts/prose-parameters.mjs into
// prose-parameters.json and modifications.json; the web app read the same from its module at run time.
// The form is hand-made (SettingsCard): these only give its defaults and choices.

import entries from './prose-parameters.json'
import modificationNames from './modifications.json'
import type { ParamEntry } from './parameters'

/** ProSE's modification names, one residue or terminus each ("Oxidation (M)", "Acetyl (Protein N-term)"). */
export const MODIFICATION_NAMES: readonly string[] = modificationNames

/** The parameters, the modification lists with their allowed names. */
export const PROSE_PARAMETERS: ParamEntry[] = (entries as ParamEntry[]).map((e) =>
  e.name === 'modifications:fixed' || e.name === 'modifications:variable' ? { ...e, validStrings: [...modificationNames] } : e,
)
