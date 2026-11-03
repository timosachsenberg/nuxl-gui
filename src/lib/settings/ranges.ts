// The ranges among OpenNuXL's parameters: a lowest and a highest value (charges, peptide length). A range whose
// lowest value is above its highest finds nothing, so New search does not start with one; nor with a value outside
// the bounds the form gives a parameter (charges from 1, the longest adduct 0–4, ...: nuxl.ts), which a preset may hold.

import type { ParamEntry } from './parameters'

export type ParameterRange = {
  min: string
  max: string
  /** What the page calls it. */
  label: string
}

export const RANGES: ParameterRange[] = [
  { min: 'precursor:min_charge', max: 'precursor:max_charge', label: 'Charges' },
  { min: 'peptide:min_size', max: 'peptide:max_size', label: 'Peptide length' },
]

/** Whether the range has its lowest value above its highest (a value that is not a number is left to its field). */
export function isInverted(range: ParameterRange, values: Record<string, unknown>): boolean {
  const min = values[range.min]
  const max = values[range.max]
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) return false
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

/** The parameters of `values` that are numbers outside the bounds of their entry (`min`, `max`). */
export function outOfBounds(values: Record<string, unknown>, entries: ParamEntry[]): ParamEntry[] {
  return entries.filter((e) => {
    const v = values[e.name]
    if (typeof v !== 'number' || !Number.isFinite(v)) return false
    return (e.min !== undefined && v < e.min) || (e.max !== undefined && v > e.max)
  })
}

/** "NuXL:length is 6; the search takes 0 to 4." */
export function boundsMessage(entry: ParamEntry, values: Record<string, unknown>): string {
  const bounds =
    entry.min !== undefined && entry.max !== undefined
      ? `${entry.min} to ${entry.max}`
      : entry.min !== undefined
        ? `at least ${entry.min}`
        : `at most ${entry.max}`
  return `${entry.name} is ${values[entry.name]}; the search takes ${bounds}.`
}
