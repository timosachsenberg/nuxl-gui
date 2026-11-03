// The ranges among ProSE's parameters: a lowest and a highest value (charges, peptide length, ...). ProSE refuses
// a range whose lowest value is above its highest, so New search does not start with one; nor with a value outside
// the bounds ProSE gives a parameter (charges 1–20, ...), which ProSE refuses too (a preset may hold one).

import type { ParamEntry } from './parameters'

export type ParameterRange = {
  min: string
  max: string
  /** What the page calls it. */
  label: string
  /** A highest value that means "no limit" (peptide:max_size 0). */
  unlimited?: number
}

export const RANGES: ParameterRange[] = [
  { min: 'precursor:min_charge', max: 'precursor:max_charge', label: 'Charges' },
  { min: 'peptide:min_size', max: 'peptide:max_size', label: 'Peptide length', unlimited: 0 },
  { min: 'peptide:min_mass', max: 'peptide:max_mass', label: 'Peptide mass' },
  { min: 'fragment:min_mz', max: 'fragment:max_mz', label: 'Fragment m/z' },
  { min: 'precursor:isotope_error_min', max: 'precursor:isotope_error_max', label: 'Isotope errors' },
]

/** Whether the range has its lowest value above its highest (a value that is not a number is left to its field). */
export function isInverted(range: ParameterRange, values: Record<string, unknown>): boolean {
  const min = values[range.min]
  const max = values[range.max]
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) return false
  if (range.unlimited !== undefined && max === range.unlimited) return false
  return min > max
}

/** The ranges of `values` whose lowest value is above the highest. */
export function invertedRanges(values: Record<string, unknown>): ParameterRange[] {
  return RANGES.filter((r) => isInverted(r, values))
}

/** The range of the parameter `name`, if it is the lowest or highest value of one. */
export function rangeOf(name: string): ParameterRange | undefined {
  return RANGES.find((r) => r.min === name || r.max === name)
}

/** "Charges: the lowest (5) is above the highest (2)." */
export function rangeMessage(range: ParameterRange, values: Record<string, unknown>): string {
  return `${range.label}: the lowest (${values[range.min]}) is above the highest (${values[range.max]}).`
}

/** The parameters of `values` that are numbers outside the bounds of their ProSE entry (`min`, `max`). */
export function outOfBounds(values: Record<string, unknown>, entries: ParamEntry[]): ParamEntry[] {
  return entries.filter((e) => {
    const v = values[e.name]
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
    return (e.min !== undefined && v < e.min) || (e.max !== undefined && v > e.max)
  })
}

/** "precursor:max_charge is 30; ProSE takes 1 to 20." */
export function boundsMessage(entry: ParamEntry, values: Record<string, unknown>): string {
  const bounds =
    entry.min !== undefined && entry.max !== undefined
      ? `${entry.min} to ${entry.max}`
      : entry.min !== undefined
        ? `at least ${entry.min}`
        : `at most ${entry.max}`
  return `${entry.name} is ${values[entry.name]}; ProSE takes ${bounds}.`
}
