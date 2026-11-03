// Labels for people of the allowed values of some OpenNuXL parameters, the same on the page and in the
// "All parameters" dialog.

export const SCORING_LABELS: Readonly<Record<string, string>> = {
  slow: 'Slow: all losses',
  fast: 'Fast: total loss only',
}

const LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'NuXL:presets': { none: 'none (custom adducts)' },
  'NuXL:scoring': SCORING_LABELS,
  'NuXL:rescoring': { none: 'none', features: 'features (for Percolator)', native: 'native (into the score)' },
  'report:xl_fdr_groups': { auto: 'auto', on: 'on', off: 'off (one FDR over all cross-links)' },
}

/** The label of an allowed value of `parameter` (the value itself where there is none). */
export function choiceLabel(parameter: string, value: string): string {
  return LABELS[parameter]?.[value] ?? value
}
