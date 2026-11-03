/// <reference types="node" />
// The fragment annotation (annotate.ts) against OpenMS: fixtures/annotations.json holds the web app's annotatePeaks (its
// 32-bit WebAssembly module, as ProSE desktop exported it: prose-gui 5ed55d7, scripts/annotation-golden.mjs) of
// spectra made for the tie rules and edge cases, with the option sets of the PSM view and others; and against
// OpenNuXL's own annotation of its peptide hits (the fragment_annotation of OpenNuXL_6_output.idXML): the plain a, b
// and y ions NuXL found on the peaks of a hit without adduct are ours, at the same m/z.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { numberColumn, readIdXML, textColumn } from '../results/idxml'
import type { PeakAnnotationResult } from '../results/types'
import { annotatePeaks, type AnnotationOptions } from './annotate'
import { classifyLabel, parseFragmentAnnotation } from './nuxl-annotation'

type Match = [number, string, string, number, number, string, number, number]
type Ion = [string, string, number, number, number]
type GoldenCase = {
  name: string
  spectrum: { embedded: number; peaks: number }
  peptide: string
  charge: number
  options: AnnotationOptions
  result: { matches: Match[]; theoretical: Ion[] } | { error: string }
}
type Golden = { module: string; spectra: { mz: number[]; intensity: number[]; float64?: boolean }[]; cases: GoldenCase[] }

const golden: Golden = JSON.parse(readFileSync(new URL('./fixtures/annotations.json', import.meta.url), 'utf8'))

/** The annotation as the golden file's tuples. */
const tuples = (r: PeakAnnotationResult) => ({
  matches: r.matches.map((m): Match => [m.peak, m.ion, m.type, m.ordinal, m.charge, m.loss, m.theoreticalMz, m.errorPpm]),
  theoretical: r.theoretical.map((t): Ion => [t.ion, t.type, t.ordinal, t.charge, t.mz]),
})

/** The first difference of two lists of tuples, or null. */
function firstDifference<T extends unknown[]>(label: string, actual: T[], expected: T[]): string | null {
  for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
    if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
      return `${label}[${i}] of ${expected.length}: ${JSON.stringify(actual[i])}, expected ${JSON.stringify(expected[i])}`
    }
  }
  return null
}

describe('annotatePeaks', () => {
  test("equals the web module's annotatePeaks", () => {
    expect(golden.cases.length).toBe(46)
    const failures: string[] = []
    for (const c of golden.cases) {
      // float32 as stored, or doubles (plain arrays) where the case is about float precision
      const s = golden.spectra[c.spectrum.embedded]
      const mz = s.float64 ? s.mz : new Float32Array(s.mz)
      const intensity = s.float64 ? s.intensity : new Float32Array(s.intensity)
      expect(mz.length).toBe(c.spectrum.peaks)
      const expected = c.result
      if ('error' in expected) {
        expect(() => annotatePeaks(mz, intensity, c.peptide, c.charge, c.options), `${c.name}: throws (${expected.error})`).toThrow()
        continue
      }
      let actual: ReturnType<typeof tuples>
      try {
        actual = tuples(annotatePeaks(mz, intensity, c.peptide, c.charge, c.options))
      } catch (e) {
        failures.push(`${c.name} (${c.peptide}, ${JSON.stringify(c.options)}): throws ${String(e)}`)
        continue
      }
      const difference =
        firstDifference('theoretical', actual.theoretical, expected.theoretical) ?? firstDifference('matches', actual.matches, expected.matches)
      if (difference !== null) failures.push(`${c.name} (${c.peptide}, ${JSON.stringify(c.options)}): ${difference}`)
    }
    expect(failures, `${failures.length} of ${golden.cases.length} cases differ:\n${failures.slice(0, 20).join('\n')}`).toEqual([])
  })

  describe('modifications given by mass or by an unknown name', () => {
    const p = { mz: new Float32Array(golden.spectra[0].mz), intensity: new Float32Array(golden.spectra[0].intensity) }
    const all: AnnotationOptions = { tolerance: 0.05, unit: 'Da', maxCharge: 2, ions: ['a', 'b', 'c', 'x', 'y', 'z'], losses: true, precursor: true }
    const annotate = (peptide: string, mass?: (name: string) => number | undefined) => annotatePeaks(p.mz, p.intensity, peptide, 3, all, mass)

    test('M[+15.9949] annotates as M(Oxidation): the same ions and losses', () => {
      const spelled = annotate('PEPM[+15.9949]TIDEK')
      expect(spelled).toEqual(annotate('PEPM(Oxidation)TIDEK'))
      expect(spelled.theoretical.some((t) => t.ion.includes('-CH4OS'))).toBe(true)
      expect(annotate('PEPM[147.0354]TIDEK')).toEqual(annotate('PEPM(Oxidation)TIDEK')) // the residue's mass
    })

    test('an unmatched mass, K[+123.4567], shifts the ions that have the residue and has no losses', () => {
      const plain = annotate('PEPTIDEK')
      const shifted = annotate('PEPTIDEK[+123.4567]')
      const by = (r: PeakAnnotationResult, type: string) =>
        new Map(r.theoretical.filter((t) => t.type === type && !t.ion.includes('-')).map((t) => [t.ion, t.mz]))
      // b ions (without the C-terminal K) as they were; y ions (all with it) shifted by the delta per charge
      expect(by(shifted, 'b')).toEqual(by(plain, 'b'))
      for (const [ion, mz] of by(plain, 'y')) {
        const charge = ion.match(/\+*$/)![0].length || 1
        expect(by(shifted, 'y').get(ion)! - mz).toBeCloseTo(123.4567 / charge, 9)
      }
      // K's ammonia loss goes with the modification: no ion loses NH3 (PEPTIDE has none)
      expect(plain.theoretical.some((t) => /^[a-z]\d+-NH3/.test(t.ion))).toBe(true)
      expect(shifted.theoretical.some((t) => /^[a-z]\d+-NH3/.test(t.ion))).toBe(false)
      // the precursor's water and ammonia losses from its mass, the delta included
      const precursor = (r: PeakAnnotationResult, ion: string) => r.theoretical.find((t) => t.ion === ion)!.mz
      expect(precursor(shifted, '[M+2H]++') - precursor(plain, '[M+2H]++')).toBeCloseTo(123.4567 / 2, 9)
      expect(precursor(shifted, '[M+2H-H2O]++') - precursor(plain, '[M+2H-H2O]++')).toBeCloseTo(123.4567 / 2, 9)
      expect(precursor(shifted, '[M+2H-NH3]++') - precursor(plain, '[M+2H-NH3]++')).toBeCloseTo(123.4567 / 2, 9)
    })

    test('a terminal [+42.0106] is Acetyl', () => {
      expect(annotate('.[+42.0106]PEPTIDEK')).toEqual(annotate('.(Acetyl)PEPTIDEK'))
      expect(annotate('[+42.0106]PEPTIDEK')).toEqual(annotate('.(Acetyl)PEPTIDEK'))
      expect(annotate('PEPTIDEK.[-0.9840]')).toEqual(annotate('PEPTIDEK.(Amidated)'))
    })

    test('an unknown name annotates with the mass the results give it, and throws without', () => {
      const masses: Record<string, number> = { MyTag: 123.4567, MyTerm: 100.1234 }
      const mass = (name: string) => masses[name]
      expect(annotate('PEPTIDEK(MyTag)', mass)).toEqual(annotate('PEPTIDEK[+123.4567]'))
      expect(annotate('.(MyTerm)PEPTIDEK', mass)).toEqual(annotate('.[+100.1234]PEPTIDEK'))
      expect(annotate('PEPTIDEK.(MyTerm)', mass)).toEqual(annotate('PEPTIDEK.[+100.1234]'))
      expect(() => annotate('PEPTIDEK(MyTag)')).toThrow(/MyTag/)
      expect(() => annotate('PEPTIDEK(Other)', mass)).toThrow(/Other/)
      // OpenNuXL's adducts: 'NuXL:U-H3O4P1' with the mass the result tables give 'U-H3O4P1'
      expect(annotate('PEPTIDEK(NuXL:U-H3O4P1)', (name) => (name === 'U-H3O4P1' ? 226.058973 : undefined))).toEqual(annotate('PEPTIDEK[+226.058973]'))
      // a Unimod name stays the Unimod modification, whatever mass the resolver has
      expect(annotate('PEPM(Oxidation)TIDEK', () => 99)).toEqual(annotate('PEPM(Oxidation)TIDEK'))
    })
  })

  // OpenNuXL annotates the plain ions of a hit on its (deisotoped, charge-reduced) spectrum at the search's fragment
  // tolerance (20 ppm); its fragment_annotation has the observed peaks' m/z. Annotating those peaks with the hit's
  // peptide, every plain a, b and y ion NuXL named is ours, on the same peak.
  test("agrees with OpenNuXL's annotation of the plain a, b and y ions of its peptide hits", () => {
    const id = readIdXML(new Uint8Array(readFileSync(new URL('../results/fixtures/nuxl/OpenNuXL_6_output.idXML', import.meta.url))))
    const { hits } = id
    const isXL = numberColumn(hits.params, 'NuXL:isXL', hits.count)
    const decoy = textColumn(hits.params, 'target_decoy', hits.count)
    const annotation = textColumn(hits.params, 'fragment_annotation', hits.count)
    let compared = 0
    let ions = 0
    const differences: string[] = []
    for (let h = 0; h < hits.count; h++) {
      // peptides without adduct (unmodified or oxidized), targets
      if (isXL[h] !== 0 || decoy[h] !== 'target' || hits.sequence[h].includes('NuXL:')) continue
      const peaks = parseFragmentAnnotation(annotation[h])
      const plain = peaks
        .map((p, k) => ({ k, p, ion: classifyLabel(p.label, p.charge) }))
        .filter(({ ion }) => ['a', 'b', 'y'].includes(ion.kind) && ion.shift === '' && ion.loss === '')
      if (plain.length === 0) continue
      const charge = hits.charge[h]
      const result = annotatePeaks(
        peaks.map((p) => p.mz),
        peaks.map((p) => p.intensity),
        hits.sequence[h],
        charge,
        { tolerance: 20, unit: 'ppm', maxCharge: charge, ions: ['a', 'b', 'y'] },
      )
      for (const { k, p, ion } of plain) {
        const name = `${ion.kind}${ion.ordinal}${ion.charge > 1 ? '+'.repeat(ion.charge) : ''}`
        const ours = result.matches.find((m) => m.ion === name)
        ions++
        if (!ours || ours.peak !== k || Math.abs(ours.errorPpm) > 20) differences.push(`${hits.sequence[h]}/${charge} ${p.label} at ${p.mz}: ${JSON.stringify(ours)}`)
      }
      compared++
    }
    expect(compared).toBeGreaterThanOrEqual(30)
    expect(ions).toBeGreaterThan(300)
    expect(differences, differences.slice(0, 10).join('\n')).toEqual([])
  })
})
