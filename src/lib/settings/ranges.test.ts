import { describe, expect, test } from 'vitest'
import { NUXL_PARAMETERS } from './nuxl'
import { BUILTIN_PRESETS } from './presets'
import { boundsMessage, invertedRanges, isInverted, outOfBounds, rangeMessage, rangeOf, RANGES } from './ranges'

describe('parameter ranges', () => {
  test('every range is a pair of OpenNuXL parameters, and the defaults are not inverted', () => {
    const names = new Set(NUXL_PARAMETERS.map((e) => e.name))
    for (const r of RANGES) {
      expect(names.has(r.min), r.min).toBe(true)
      expect(names.has(r.max), r.max).toBe(true)
    }
    const defaults = Object.fromEntries(NUXL_PARAMETERS.map((e) => [e.name, e.value]))
    expect(invertedRanges(defaults)).toEqual([])
  })

  test('a lowest value above the highest is inverted; equal ones are a range of one', () => {
    const charges = rangeOf('precursor:max_charge')!
    expect(isInverted(charges, { 'precursor:min_charge': 5, 'precursor:max_charge': 2 })).toBe(true)
    expect(isInverted(charges, { 'precursor:min_charge': 3, 'precursor:max_charge': 3 })).toBe(false)
    expect(rangeMessage(charges, { 'precursor:min_charge': 5, 'precursor:max_charge': 2 })).toBe(
      'Charges: the lowest (5) is above the highest (2).',
    )
    const values = { 'peptide:min_size': 40, 'peptide:max_size': 7 }
    expect(invertedRanges(values).map((r) => r.label)).toEqual(['Peptide length'])
  })

  test('a value that is not a number is no inverted range', () => {
    expect(invertedRanges({ 'precursor:min_charge': 5, 'precursor:max_charge': undefined })).toEqual([])
    expect(invertedRanges({ 'precursor:min_charge': Number.NaN, 'precursor:max_charge': 2 })).toEqual([])
  })

  test('a value outside the bounds is reported; the defaults and the built-in presets are within them', () => {
    const defaults = Object.fromEntries(NUXL_PARAMETERS.map((e) => [e.name, e.value]))
    expect(outOfBounds(defaults, NUXL_PARAMETERS)).toEqual([])
    for (const preset of BUILTIN_PRESETS) expect(outOfBounds({ ...defaults, ...preset.parameters }, NUXL_PARAMETERS), preset.id).toEqual([])
    const values = { ...defaults, 'NuXL:length': 6, 'report:top_hits': 0, 'precursor:min_charge': 1 }
    const outside = outOfBounds(values, NUXL_PARAMETERS)
    expect(outside.map((e) => e.name)).toEqual(['report:top_hits', 'NuXL:length'])
    expect(boundsMessage(outside[1], values)).toBe('NuXL:length is 6; the search takes 0 to 4.')
    expect(boundsMessage(NUXL_PARAMETERS.find((e) => e.name === 'peptide:missed_cleavages')!, { 'peptide:missed_cleavages': -1 })).toBe(
      'peptide:missed_cleavages is -1; the search takes at least 0.',
    )
    // not a number: left to its field
    expect(outOfBounds({ 'precursor:max_charge': Number.NaN, 'report:top_hits': '7' }, NUXL_PARAMETERS)).toEqual([])
  })
})
