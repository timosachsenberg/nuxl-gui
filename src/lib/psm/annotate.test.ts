/// <reference types="node" />
// The fragment annotation against the web app: fixtures/annotations.json is the web app's annotatePeaks
// (its 32-bit WebAssembly module, scripts/annotation-golden.mjs) of PSMs of the results reader's
// fixtures (read here with readSearch, as the app reads them), of spectra made for the tie rules (in
// the file) and of edge cases, with the option sets of the PSM view and others. And against ProSE's own
// fragment annotation of its scoring (QPX ion_type_array).

import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { parquetReadObjects } from 'hyparquet'
import { describe, expect, test } from 'vitest'
import { bytesOfRange, FileNotFound, readSearch, type ByteRange, type SearchResult } from '../results/read'
import type { PeakAnnotationResult } from '../results/types'
import { annotatePeaks, type AnnotationOptions } from './annotate'

const results = new URL('../results/fixtures/', import.meta.url).pathname

/** The search folder of the reader's fixture `name`, as the `files` contract has it. */
function folder(name: string) {
  const dir = join(results, name)
  return async (file: string, range?: ByteRange): Promise<Uint8Array> => {
    const path = file.startsWith('/') ? join(dir, 'user', basename(file)) : join(dir, file)
    try {
      return bytesOfRange(new Uint8Array(readFileSync(path)), range)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFound(file)
      throw e
    }
  }
}

const searches = new Map<string, Promise<SearchResult>>()
const search = (name: string) => {
  if (!searches.has(name)) searches.set(name, readSearch(folder(name)))
  return searches.get(name)!
}

/** The stored peaks of PSM `row` (views of the stored arrays, as the PSM view passes them). */
async function psmPeaks(r: SearchResult, row: number): Promise<{ mz: Float32Array; intensity: Float32Array }> {
  const { spectra, spectrumRow } = await r.spectra.load(row)
  const s = spectra.psmSpectrum[spectrumRow] ?? -1
  expect(s, `row ${row} has a spectrum`).toBeGreaterThanOrEqual(0)
  const [from, to] = [spectra.offsets[s], spectra.offsets[s + 1]]
  return { mz: spectra.mz.subarray(from, to), intensity: spectra.intensity.subarray(from, to) }
}

type Match = [number, string, string, number, number, string, number, number]
type Ion = [string, string, number, number, number]
type GoldenCase = {
  name: string
  spectrum: { fixture: string; row: number; peaks: number } | { embedded: number; peaks: number }
  peptide: string
  charge: number
  options: AnnotationOptions
  result: { matches: Match[]; theoretical: Ion[] } | { error: string }
}
type Golden = { module: string; spectra: { mz: number[]; intensity: number[]; float64?: boolean }[]; cases: GoldenCase[] }

const read = (name: string): Golden => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))
const golden = read('annotations.json')
/** modifications given by mass, as the reader writes those without a name ('M[+15.9949]') */
const goldenMass = read('annotations-mass.json')

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

/** Every case of `golden` equals annotatePeaks' result (or both throw). */
async function expectGolden(golden: Golden) {
  {
    const failures: string[] = []
    let compared = 0
    for (const c of golden.cases) {
      let mz: ArrayLike<number>
      let intensity: ArrayLike<number>
      if ('fixture' in c.spectrum) {
        const r = await search(c.spectrum.fixture)
        ;({ mz, intensity } = await psmPeaks(r, c.spectrum.row))
        expect(mz.length, `${c.name}: the PSM's peaks`).toBe(c.spectrum.peaks)
        // the PSM's own peptide and charge (the variants change the peptide)
        if (/^(example|mods) \d+ (options|precursor)/.test(c.name)) {
          expect(r.tables.peptides.openms[r.tables.psms.peptide[c.spectrum.row]], `${c.name}: peptide`).toBe(c.peptide)
        }
      } else {
        // float32 as stored, or doubles (plain arrays) where the case is about float precision
        const s = golden.spectra[c.spectrum.embedded]
        mz = s.float64 ? s.mz : new Float32Array(s.mz)
        intensity = s.float64 ? s.intensity : new Float32Array(s.intensity)
        expect(mz.length).toBe(c.spectrum.peaks)
      }

      const expected = c.result
      if ('error' in expected) {
        expect(() => annotatePeaks(mz, intensity, c.peptide, c.charge, c.options), `${c.name}: throws (${expected.error})`).toThrow()
        compared++
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
      compared++
    }
    expect(failures, `${failures.length} of ${golden.cases.length} cases differ:\n${failures.slice(0, 20).join('\n')}`).toEqual([])
    expect(compared).toBe(golden.cases.length)
  }
}

describe('annotatePeaks', () => {
  test("equals the web module's annotatePeaks", { timeout: 60_000 }, async () => {
    expect(golden.cases.length).toBe(236)
    const psms = new Set(golden.cases.flatMap((c) => ('fixture' in c.spectrum && c.spectrum.fixture === 'suitability' ? [c.spectrum.row] : [])))
    expect(psms.size).toBeGreaterThanOrEqual(50)
    await expectGolden(golden)
  })

  test("equals the web module's annotatePeaks of modifications given by mass", { timeout: 60_000 }, async () => {
    expect(goldenMass.cases.length).toBeGreaterThanOrEqual(40)
    await expectGolden(goldenMass)
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
      // a Unimod name stays the Unimod modification, whatever mass the resolver has
      expect(annotate('PEPM(Oxidation)TIDEK', () => 99)).toEqual(annotate('PEPM(Oxidation)TIDEK'))
    })
  })

  // ProSE's annotation of its scoring: b and y ions of charges 1 to min(charge − 1, 2), the first prefix ion
  // included, no losses, matched with the search's fragment tolerance by SpectrumAlignment (ProSEAlgorithm, the PSM
  // annotations), named 'b3+', 'y5++'; QPX mz_array has the matched peaks' m/z.
  // - the web app's example (Orbitrap HCD, 20 ppm): ProSE matches against the deisotoped spectrum (fragment:deisotope
  //   'auto', on at 20 ppm): a peak one 13C spacing (charge 1, as these fragments) above another, within the
  //   tolerance, is taken as that peak's isotope and removed. Such a peak can carry one of our ions that ProSE's
  //   lacks; every other ion is the same, on the same peak.
  // - the app's example (LTQ Orbitrap CID, ion-trap fragments at 0.5 Da): no deisotoping (above 0.1 Da ProSE skips
  //   it), but ProSE scores against its peak list, which at 0.5 Da keeps about the 80 most intense peaks and 20 per
  //   100 Da (peaks:keep_n, peaks:window_top): its ions are ours, on the same peaks or (where the list left out the
  //   nearest peak) on a peak further from the ion than ours; ours besides are on peaks that list left out. The PSM
  //   view annotates every stored peak.
  test.each([
    { fixture: 'suitability', input: '1__DatabaseSuitability_1', tolerance: 20, unit: 'ppm' as const, minIons: 5000, minRows: 800 },
    { fixture: 'example', input: '1__Ecoli_1', tolerance: 0.5, unit: 'Da' as const, minIons: 500, minRows: 50 },
  ])("agrees with ProSE's own annotations for b/y ($fixture, $tolerance $unit)", { timeout: 60_000 }, async ({ fixture, input, tolerance, unit, minIons, minRows }) => {
    const r = await search(fixture)
    const bytes = readFileSync(join(results, `${fixture}/qpx/runs/${input}.psm.parquet`))
    const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const rows = (await parquetReadObjects({
      file,
      columns: ['sequence', 'charge', 'mz_array', 'ion_type_array'],
      compressors: { ZSTD: (input: Uint8Array) => new Uint8Array(zstdDecompressSync(input)) },
    })) as { sequence: string; charge: number; mz_array: number[] | null; ion_type_array: string[] | null }[]
    // the PSM rows of the first input are its QPX rows, in order
    expect(rows.length).toBeGreaterThan(minRows)
    expect(r.tables.psms.file.filter((f) => f === 0).length).toBe(rows.length)

    const C13C12_MASSDIFF_U = 1.0033548378
    const isotopeOfAnother = (peaks: Float32Array, at: number) =>
      Array.from(peaks).some((p) => p < at && Math.abs(p + C13C12_MASSDIFF_U - at) <= tolerance * 1e-6 * at)

    let ions = 0
    let same = 0
    let extra = 0
    const differences: string[] = []
    for (const [row, q] of rows.entries()) {
      const peptide = r.tables.peptides.openms[r.tables.psms.peptide[row]]
      expect(r.tables.peptides.sequence[r.tables.psms.peptide[row]]).toBe(q.sequence)
      const charge = r.tables.psms.charge[row]
      const { mz, intensity } = await psmPeaks(r, row)
      const maxCharge = charge >= 2 ? Math.min(charge - 1, 2) : 1
      const ours = annotatePeaks(mz, intensity, peptide, charge, { tolerance, unit, maxCharge, ions: ['b', 'y'] })
      const prose = (q.ion_type_array ?? []).map((name, k) => ({ ion: name.replace(/^([a-z]\d+)\+$/, '$1'), mz: Math.fround(q.mz_array![k]) }))
      const mine = ours.matches.map((m) => ({ ion: m.ion, mz: mz[m.peak] }))
      ions += prose.length
      if (JSON.stringify(mine) === JSON.stringify(prose)) {
        same++
        continue
      }
      if (unit === 'Da') {
        // each of ProSE's ions is ours, on its peak or on one at least as near to the ion's m/z
        const missing = prose.filter((p) => {
          const m = ours.matches.find((o) => o.ion === p.ion)
          return !m || (mz[m.peak] !== p.mz && Math.abs(mz[m.peak] - m.theoreticalMz) > Math.abs(p.mz - m.theoreticalMz))
        })
        if (missing.length > 0) differences.push(`row ${row} ${peptide}/${charge}: ProSE's ${JSON.stringify(missing)} not ours (${JSON.stringify(mine)})`)
        extra += mine.length - prose.length
        continue
      }
      // ProSE's ions are ours, in order and on the same peaks; ours besides are on isotope peaks
      const rest = mine.filter((m) => !prose.some((p) => p.ion === m.ion))
      const shared = mine.filter((m) => prose.some((p) => p.ion === m.ion))
      if (JSON.stringify(shared) !== JSON.stringify(prose) || !rest.every((m) => isotopeOfAnother(mz, m.mz))) {
        differences.push(`row ${row} ${peptide}/${charge}: ${JSON.stringify(mine)}, ProSE ${JSON.stringify(prose)}`)
      }
      extra += rest.length
    }
    expect(ions).toBeGreaterThan(minIons)
    expect(differences, `${differences.length} of ${rows.length} PSMs differ:\n${differences.slice(0, 10).join('\n')}`).toEqual([])
    // at 20 ppm nearly all PSMs agree ion for ion
    if (unit === 'ppm') expect(same).toBeGreaterThan(0.95 * rows.length)
    console.info(`ProSE's b/y annotation (${fixture}): ${same} of ${rows.length} PSMs the same, ${ions} ions; ${extra} ions more of ${rows.length - same} PSMs`)
  })
})
