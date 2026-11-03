import { describe, expect, test } from 'vitest'
import { PROSE_PARAMETERS } from './prose'
import { BUILTIN_PRESETS } from './presets'
import { boundsMessage, invertedRanges, isInverted, outOfBounds, rangeMessage, rangeOf, RANGES } from './ranges'

describe('parameter ranges', () => {
  test('every range is a pair of ProSE parameters, and the defaults are not inverted', () => {
    const names = new Set(PROSE_PARAMETERS.map((e) => e.name))
    for (const r of RANGES) {
      expect(names.has(r.min), r.min).toBe(true)
      expect(names.has(r.max), r.max).toBe(true)
    }
    const defaults = Object.fromEntries(PROSE_PARAMETERS.map((e) => [e.name, e.value]))
    expect(invertedRanges(defaults)).toEqual([])
  })

  test('a lowest value above the highest is inverted; equal ones are a range of one', () => {
    const charges = rangeOf('precursor:max_charge')!
    expect(isInverted(charges, { 'precursor:min_charge': 5, 'precursor:max_charge': 2 })).toBe(true)
    expect(isInverted(charges, { 'precursor:min_charge': 3, 'precursor:max_charge': 3 })).toBe(false)
    expect(rangeMessage(charges, { 'precursor:min_charge': 5, 'precursor:max_charge': 2 })).toBe(
      'Charges: the lowest (5) is above the highest (2).',
    )
    const values = { 'peptide:min_size': 40, 'peptide:max_size': 7, 'fragment:min_mz': 2000, 'fragment:max_mz': 150 }
    expect(invertedRanges(values).map((r) => r.label)).toEqual(['Peptide length', 'Fragment m/z'])
  })

  test('a highest value of "no limit", or a value that is not a number, is no inverted range', () => {
    expect(invertedRanges({ 'peptide:min_size': 7, 'peptide:max_size': 0 })).toEqual([])
    expect(invertedRanges({ 'precursor:min_charge': 5, 'precursor:max_charge': undefined })).toEqual([])
    expect(invertedRanges({ 'precursor:min_charge': Number.NaN, 'precursor:max_charge': 2 })).toEqual([])
  })

  test("a value outside ProSE's bounds is reported; the defaults and the built-in presets are within them", () => {
    const defaults = Object.fromEntries(PROSE_PARAMETERS.map((e) => [e.name, e.value]))
    expect(outOfBounds(defaults, PROSE_PARAMETERS)).toEqual([])
    for (const preset of BUILTIN_PRESETS) expect(outOfBounds({ ...defaults, ...preset.parameters }, PROSE_PARAMETERS), preset.id).toEqual([])
    const values = { ...defaults, 'precursor:max_charge': 30, 'report:top_hits': 0, 'percolator:max_train_psms': 7 }
    const outside = outOfBounds(values, PROSE_PARAMETERS)
    expect(outside.map((e) => e.name)).toEqual(['precursor:max_charge', 'report:top_hits'])
    expect(boundsMessage(outside[0], values)).toBe('precursor:max_charge is 30; ProSE takes 1 to 20.')
    expect(boundsMessage(PROSE_PARAMETERS.find((e) => e.name === 'peptide:missed_cleavages')!, { 'peptide:missed_cleavages': -1 })).toBe(
      'peptide:missed_cleavages is -1; ProSE takes at least 0.',
    )
    // not a number: left to its field
    expect(outOfBounds({ 'precursor:max_charge': Number.NaN, 'report:top_hits': '7' }, PROSE_PARAMETERS)).toEqual([])
  })
})
