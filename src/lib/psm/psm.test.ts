import { describe, expect, it } from 'vitest'
import type { PeakMatch, StoredSpectra } from '../results/types'
import { sampleTables } from '../results/fixtures'
import { makeTables } from '../results/synthetic'
import {
  errorStats,
  errorTickDigits,
  featureValue,
  fragmentError,
  fragmentTolerance,
  ionLabel,
  lossOf,
  modificationList,
  spectrumPeaks,
  svgFileName,
} from './psm'

function match(peak: number, ion: string, more: Partial<PeakMatch> = {}): PeakMatch {
  const parsed = /^([a-z])(\d+)(?:-([A-Za-z0-9]+))?(\+*)$/.exec(ion)
  return {
    peak,
    ion,
    type: parsed ? parsed[1] : 'precursor',
    ordinal: parsed ? Number(parsed[2]) : 0,
    charge: parsed ? Math.max(1, parsed[4].length) : 2,
    loss: parsed?.[3] ?? '',
    theoreticalMz: 100 + peak,
    errorPpm: 0,
    ...more,
  }
}

describe('search settings of the view', () => {
  it("takes the fragment tolerance from the search, else from OpenNuXL's defaults", () => {
    expect(fragmentTolerance({ 'fragment:mass_tolerance': 0.02, 'fragment:mass_tolerance_unit': 'Da' })).toEqual({ value: 0.02, unit: 'Da' })
    expect(fragmentTolerance({}, { 'fragment:mass_tolerance': 15, 'fragment:mass_tolerance_unit': 'ppm' })).toEqual({ value: 15, unit: 'ppm' })
    expect(fragmentTolerance({ 'fragment:mass_tolerance': 40 })).toEqual({ value: 40, unit: 'ppm' })
    expect(fragmentTolerance({})).toEqual({ value: 20, unit: 'ppm' }) // OpenNuXL's default
  })
})

describe('spectrumPeaks', () => {
  const spectra = {
    psmSpectrum: Int32Array.of(1, -1, 0),
    offsets: Uint32Array.of(0, 2, 5),
    mz: Float32Array.of(100, 200, 150, 250, 350),
    intensity: Float32Array.of(1, 2, 3, 4, 5),
    precursorMz: Float64Array.of(500, 600),
    collisionEnergy: Float32Array.of(NaN, 30),
  } as StoredSpectra

  it('gives the peaks of the spectrum of a PSM as views of the stored arrays', () => {
    const p = spectrumPeaks(spectra, 0)!
    expect(p.index).toBe(1)
    expect(Array.from(p.mz)).toEqual([150, 250, 350])
    expect(Array.from(p.intensity)).toEqual([3, 4, 5])
    expect(p.mz.buffer).toBe(spectra.mz.buffer)
    expect(p.collisionEnergy).toBe(30)
    expect(Array.from(spectrumPeaks(spectra, 2)!.mz)).toEqual([100, 200])
  })

  it('is null for a PSM whose spectrum was not stored', () => {
    expect(spectrumPeaks(spectra, 1)).toBeNull()
    expect(spectrumPeaks(spectra, 99)).toBeNull()
  })
})

describe('ion labels', () => {
  it('reads the loss of an ion from its name', () => {
    expect(lossOf('y7-H2O++')).toBe('H2O')
    expect(lossOf('b3')).toBe('')
    expect(lossOf('[M+2H-NH3]++')).toBe('NH3')
  })

  it('writes losses with subscripts', () => {
    expect(ionLabel('y7-H2O++')).toBe('y7-H₂O++')
    expect(ionLabel('b5-CH4OS')).toBe('b5-CH₄SO')
    expect(ionLabel('y3-H3PO4')).toBe('y3-H₃PO₄')
    expect(ionLabel('[M+2H]++')).toBe('[M+2H]++')
  })
})

describe('numbers', () => {
  it('gives the mean and the standard deviation of the errors', () => {
    const s = errorStats([match(0, 'b2', { errorPpm: 1 }), match(1, 'b3', { errorPpm: -1 }), match(2, 'b4', { errorPpm: 3 })])
    expect(s.mean).toBeCloseTo(1)
    expect(s.sd).toBeCloseTo(2)
    expect(errorStats([match(0, 'b2', { errorPpm: 2 })]).sd).toBeNaN()
    // in Da: observed minus theoretical m/z of the peak (match() puts the theoretical m/z at 100 + peak)
    const mz = Float32Array.of(100.25, 101, 101.5)
    const da = [match(0, 'b2'), match(1, 'b3'), match(2, 'y2++')]
    expect(da.map((m) => fragmentError(m, mz, 'Da'))).toEqual([0.25, 0, -0.5])
    expect(fragmentError(match(0, 'b2', { errorPpm: 7 }), mz, 'ppm')).toBe(7)
    // the strip's ticks read as the tolerance
    expect(errorTickDigits({ value: 20, unit: 'ppm' })).toBe(1)
    expect(errorTickDigits({ value: 0.5, unit: 'Da' })).toBe(2)
    expect(errorTickDigits({ value: 0.02, unit: 'Da' })).toBe(3)
    expect(errorTickDigits({ value: 0.005, unit: 'Da' })).toBe(4)
    expect(errorTickDigits({ value: 0.0025, unit: 'Da' })).toBe(4)
    expect(Number((0.0025).toFixed(errorTickDigits({ value: 0.0025, unit: 'Da' })))).not.toBe(0)
    expect(errorStats(da, (m) => fragmentError(m, mz, 'Da')).mean).toBeCloseTo(-0.25 / 3, 6)
    expect(errorStats([]).mean).toBeNaN()
  })

  it('lists the modifications with their sites, the fixed ones last', () => {
    const t = sampleTables().peptides
    expect(modificationList(t, 0, [])).toEqual(['Oxidation (M1)'])
    expect(modificationList(t, 0, ['Oxidation (M)'])).toEqual(['Oxidation (M1, fixed)'])
    expect(modificationList(t, 1, [])).toEqual([])
    const terminal = makeTables({
      files: ['a.mzML'],
      proteins: [{ accession: 'P1', sequence: 'ACDK' }],
      peptides: [
        {
          sequence: 'ACDK',
          mods: [
            { position: 1, name: 'Carbamidomethyl' },
            { position: -1, name: 'Acetyl' },
          ],
          proteins: [0],
        },
      ],
      psms: [{ peptide: 0, file: 0 }],
    }).peptides
    expect(modificationList(terminal, 0, ['Carbamidomethyl (C)'])).toEqual(['Acetyl (N-term)', 'Carbamidomethyl (C2, fixed)'])
  })

  it('reads a feature of a PSM by name; NaN when the search has none', () => {
    const names = ['ln(hyperscore)', 'ms2_cosine']
    const features = Float64Array.of(1, 0.5, 2, 0.9)
    expect(featureValue(names, features, 1, 'ms2_cosine')).toBe(0.9)
    expect(featureValue(names, features, 0, 'ms2_spectral_angle')).toBeNaN()
  })

  it('names an exported spectrum after its peptide and scan', () => {
    expect(svgFileName('AVM[Oxidation]DDFAAFVEK', 'controllerType=0 controllerNumber=1 scan=21507')).toBe(
      'AVM_Oxidation_DDFAAFVEK_scan21507.svg',
    )
    expect(svgFileName('[+15.9949]?PEPTIDEK', 'index=12')).toBe('15.9949_PEPTIDEK_scan12.svg')
    expect(svgFileName('PEPTIDEK', 'frame=5 scan=3 extra')).toBe('PEPTIDEK_scan3.svg')
    expect(svgFileName('PEPTIDEK', 'some id/with:chars')).toBe('PEPTIDEK_some_id_with_chars.svg')
  })
})
