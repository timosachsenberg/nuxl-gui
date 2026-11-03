/// <reference types="node" />
// The reader against the web app: each fixture (fixtures/<case>/) is a search of the pinned ProSE tool
// in a search folder as the shim makes it (scripts/results-fixture-native.mjs), and fixtures/web-<case>.json
// is the web app's result of the same search with its WebAssembly module (scripts/results-fixture-web.mjs).
// The cases are in scripts/results-example.mjs. Where the two legitimately differ, the test says why.

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, readdirSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { parquetMetadata, parquetReadObjects } from 'hyparquet'
import { parquetWriteBuffer } from 'hyparquet-writer'
import { describe, expect, test } from 'vitest'
import { input } from '../design/fixtures'
import { resolveDesign } from '../design/model'
import { keyFigures } from './figures'
import { buildModel } from './model'
import { psmFdrFact, psmFdrNotice } from './overview'
import { bytesOfRange, FileNotFound, OldLayoutError, readSearch, ZSTD, type ByteRange } from './read'
import type { ProSEMultiSummary, ResultTables, StoredSpectra } from './types'

const fixtures = new URL('./fixtures/', import.meta.url).pathname

/**
 * The files of a search folder, as the `files` contract has it (a missing file: FileNotFound; a byte range:
 * those bytes); an absolute path (the user's FASTA of a search without contaminants) is in user/.
 */
function folder(dir: string) {
  const asked: string[] = []
  const ranges: { name: string; range: ByteRange }[] = []
  const files = async (name: string, range?: ByteRange): Promise<Uint8Array> => {
    asked.push(name)
    if (range) ranges.push({ name, range })
    const path = name.startsWith('/') ? join(dir, 'user', basename(name)) : join(dir, name)
    try {
      return bytesOfRange(new Uint8Array(readFileSync(path)), range)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFound(name)
      throw e
    }
  }
  return { files, asked, ranges }
}

/** A copy of fixture `name` to change, removed after `use`. */
async function withCopy<T>(name: string, use: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `prose-reader-${name}-`))
  try {
    cpSync(join(fixtures, name), dir, { recursive: true })
    return await use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type Json = Record<string, any>
type WebResult = { names: string[]; summary: ProSEMultiSummary; tables: Json; spectra: Json; predicted: Json }
const web = (name: string): WebResult => JSON.parse(readFileSync(join(fixtures, `web-${name}.json`), 'utf8'))

/** null (NaN in JSON) as NaN */
const num = (v: number | null) => (v === null ? NaN : v)

/** Every value of `actual` equals `expected` within `tolerance` (NaN only where NaN). */
function expectClose(label: string, actual: ArrayLike<number>, expected: ArrayLike<number | null>, tolerance: number) {
  expect(actual.length, `${label}: length`).toBe(expected.length)
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]
    const e = num(expected[i])
    if (Number.isNaN(e) || Number.isNaN(a)) {
      if (!(Number.isNaN(e) && Number.isNaN(a))) expect.fail(`${label}[${i}]: ${a}, expected ${e}`)
      continue
    }
    if (!(Math.abs(a - e) <= tolerance)) expect.fail(`${label}[${i}]: ${a}, expected ${e} (±${tolerance})`)
  }
}

/**
 * QPX has m/z and RT as float32 (the web app: doubles): equal within float32's precision, a relative 1e-7
 * (docs/parity.md).
 */
const FLOAT32 = 1e-7

/** Every value of `actual` equals `expected` within `relative` of the expected value (NaN only where NaN). */
function expectCloseRelative(label: string, actual: ArrayLike<number>, expected: ArrayLike<number | null>, relative: number) {
  expect(actual.length, `${label}: length`).toBe(expected.length)
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i]
    const e = num(expected[i])
    if (Number.isNaN(e) || Number.isNaN(a)) {
      if (!(Number.isNaN(e) && Number.isNaN(a))) expect.fail(`${label}[${i}]: ${a}, expected ${e}`)
      continue
    }
    if (!(Math.abs(a - e) <= relative * Math.abs(e))) expect.fail(`${label}[${i}]: ${a}, expected ${e} (±${relative} relative)`)
  }
}

/** As expectClose, relative to the expected value. */
function expectRelative(label: string, actual: number, expected: number, tolerance: number) {
  if (!(Math.abs(actual - expected) <= tolerance * Math.max(1e-300, Math.abs(expected)))) {
    expect.fail(`${label}: ${actual}, expected ${expected} (±${tolerance} relative)`)
  }
}

const PEPTDEEP_FEATURES = ['ms2_cosine', 'ms2_spectral_angle', 'ms2_pearson', 'ms2_frac_pred_found', 'rt_abs_error']
/** The .pin features of the precursor's m/z: QPX calculated_mz and observed_mz (float32) */
const MASS_FEATURES = ['CalcMass', 'mass']

/**
 * Percolator's scores of the web app's example with PeptDeep differ from the web app's by up to 1.4e-4: PeptDeep's
 * features differ by up to 4e-7 (ONNX Runtime, native and WebAssembly) and Percolator's training
 * carries that into its SVM. Without PeptDeep the scores agree within 4e-9 (task 4 report).
 */
const PEPTDEEP_SCORE_TOLERANCE = 2e-4

/**
 * Percolator's scores of the pinned ProSE differ from the web app's by up to 0.0096 on the web app's example: since OpenMS
 * #10721 Percolator estimates no pi0 for target-decoy competition (as the percolator executable), which changes the
 * normalisation of its scores per fold (the web app's ProSE is older).
 */
const PERCOLATOR_SCORE_TOLERANCE = 0.01

interface Tolerances {
  score: number
  /** 'differs': the PEPs are known to differ (the web app's example: test below) */
  pep?: 'differs'
  /**
   * 'conservative': the q-values of the pinned ProSE are at or above the web app's (the web app's ProSE is older):
   * without a decoy PSM they are 1/T (OpenMS #10714; the web app's 0), and Percolator's are (decoys + 1) / targets
   * without pi0, as the percolator executable's (#10721; the web app's were weighted by pi0).
   */
  qValue?: 'conservative'
}

/** Each q-value of `actual` is at or above the one of `expected` (NaN only where NaN). */
function expectAtLeast(label: string, actual: ArrayLike<number>, expected: ArrayLike<number | null>) {
  expect(actual.length, `${label}: length`).toBe(expected.length)
  for (let i = 0; i < actual.length; i++) {
    const [a, e] = [actual[i], num(expected[i])]
    if (Number.isNaN(e) || Number.isNaN(a)) {
      if (!(Number.isNaN(e) && Number.isNaN(a))) expect.fail(`${label}[${i}]: ${a}, expected ${e}`)
      continue
    }
    if (!(a >= e - 1e-12)) expect.fail(`${label}[${i}]: ${a}, expected at least ${e}`)
  }
}

/** The row of `t`'s PSMs of each of the web app's PSMs (by file and native ID); -1: none. */
function webRows(t: ResultTables, w: Json): number[] {
  const row = new Map(Array.from({ length: t.psms.count }, (_, i) => [`${t.psms.file[i]} ${t.psms.nativeId[i]}`, i]))
  return w.psms.nativeId.map((id: string, k: number) => {
    const i = row.get(`${w.psms.file[k]} ${id}`)
    return i ?? -1
  })
}

/** ResultTables equal the web app's: strings exactly, numbers within the tolerances. */
function expectTables(t: ResultTables, w: Json, names: string[], tol: Tolerances) {
  expect(t.files.map((f) => basename(f))).toEqual(names)
  const p = t.psms
  const wp = w.psms
  expect(p.count).toBe(wp.count)
  expect(Array.from(p.file)).toEqual(wp.file)
  expect(p.nativeId).toEqual(wp.nativeId)
  expect(Array.from(p.charge)).toEqual(wp.charge)
  expect(Array.from(p.peptide)).toEqual(wp.peptide)
  expect(Array.from(p.decoy)).toEqual(wp.decoy)
  expect(Array.from(p.isotopeError)).toEqual(wp.isotopeError)
  expectCloseRelative('psms.rt', p.rt, wp.rt, FLOAT32)
  expectCloseRelative('psms.mz', p.mz, wp.mz, FLOAT32)
  expectClose('psms.score', p.score, wp.score, tol.score)
  if (tol.qValue === 'conservative') expectAtLeast('psms.qValue', p.qValue, wp.qValue)
  else expectClose('psms.qValue', p.qValue, wp.qValue, 1e-6)
  if (tol.pep !== 'differs') expectClose('psms.pep', p.pep, wp.pep, 1e-6)
  expectClose('psms.precursorErrorPpm', p.precursorErrorPpm, wp.precursorErrorPpm, 1e-6)
  expectClose('psms.deltaMass', p.deltaMass, wp.deltaMass, 1e-6)

  expect(p.featureNames).toEqual(wp.featureNames)
  const n = p.featureNames.length
  expect(p.features.length).toBe(p.count * n)
  p.featureNames.forEach((name, j) => {
    const column = (f: ArrayLike<number | null>) => Array.from({ length: p.count }, (_, i) => num(f[i * n + j]))
    if (MASS_FEATURES.includes(name)) expectCloseRelative(`feature ${name}`, column(p.features), column(wp.features), FLOAT32)
    // the difference of two float32 m/z: within their precision, a relative 1e-7 of the m/z (2e-4 at m/z 2000)
    else if (name === 'dm' || name === 'absdm') expectClose(`feature ${name}`, column(p.features), column(wp.features), 2e-4)
    // the RT error: seconds of the RT calibration's spline over real retention times (the app's example), within 1e-4 s
    else if (name === 'rt_abs_error') expectClose(`feature ${name}`, column(p.features), column(wp.features), 1e-4)
    else expectClose(`feature ${name}`, column(p.features), column(wp.features), PEPTDEEP_FEATURES.includes(name) ? 1e-5 : 1e-6)
  })

  const pt = t.peptides
  const wt = w.peptides
  expect(pt.count).toBe(wt.count)
  expect(pt.openms).toEqual(wt.openms)
  expect(pt.proforma).toEqual(wt.proforma)
  expect(pt.sequence).toEqual(wt.sequence)
  expect(Array.from(pt.decoy)).toEqual(wt.decoy)
  expect(Array.from(pt.modOffsets)).toEqual(wt.modOffsets)
  expect(Array.from(pt.modPosition)).toEqual(wt.modPosition)
  expect(pt.modName).toEqual(wt.modName)
  expect(Array.from(pt.modUnimod)).toEqual(wt.modUnimod)
  expectClose('peptides.modMass', pt.modMass, wt.modMass, 1e-6)
  expect(Array.from(pt.proteinOffsets)).toEqual(wt.proteinOffsets)
  // proteins by accession: the order of the protein rows may differ (below)
  expect(Array.from(pt.protein, (r) => t.proteins.accession[r])).toEqual(wt.protein.map((r: number) => w.proteins.accession[r]))
  expect(Array.from(pt.start)).toEqual(wt.start)
  expect(Array.from(pt.end)).toEqual(wt.end)

  // Proteins: the same rows in another order. The native tool writes the protein hits of the pooled
  // run in the order of the merged idXML, the web app in the order of its result set; both come from
  // hashed containers. Compared by accession, groups as sets of accessions.
  const r = t.proteins
  const wr = w.proteins
  expect(r.count).toBe(wr.count)
  expect([...r.accession].sort()).toEqual([...wr.accession].sort())
  const groupOf = (accession: string[], group: ArrayLike<number>) => {
    const members = new Map<number, string[]>()
    accession.forEach((a, i) => members.set(group[i], [...(members.get(group[i]) ?? []), a]))
    return new Map(accession.map((a, i) => [a, group[i] < 0 ? '' : members.get(group[i])!.sort().join(' ')]))
  }
  const groups = groupOf(r.accession, r.group)
  const webGroups = groupOf(wr.accession, wr.group)
  r.accession.forEach((accession, i) => {
    const k = wr.accession.indexOf(accession)
    expect(r.description[i], `description of ${accession}`).toBe(wr.description[k])
    expect(r.sequence[i], `sequence of ${accession}`).toBe(wr.sequence[k])
    expect(r.decoy[i], `decoy ${accession}`).toBe(wr.decoy[k])
    expectClose(`proteins.score ${accession}`, [r.score[i]], [wr.score[k]], tol.score)
    expectClose(`proteins.qValue ${accession}`, [r.qValue[i]], [wr.qValue[k]], 1e-6)
    expect(groups.get(accession), `group of ${accession}`).toBe(webGroups.get(accession))
  })
}

/**
 * ProSEMultiSummary equals the web app's, but for the times and the paths (the app's: the user's files). `index`
 * 'differs': the sizes of the fragment index differ (the app's example: test).
 */
function expectSummary(s: ProSEMultiSummary, w: ProSEMultiSummary, index?: 'differs') {
  expect(s.files.map((f) => basename(f.path))).toEqual(w.files.map((f) => basename(f.path)))
  s.files.forEach((f, i) => {
    const e = w.files[i]
    // (psmFdrApplied: the app's; the web app has none, for applied)
    expect(f.psmFdrApplied).toBe(e.psmFdrApplied ?? true)
    expect({ ...f, path: '', secondsSearch: 0, precursorError: null, fragmentError: null, psmFdrApplied: undefined }).toEqual({
      ...e,
      psmFdrApplied: undefined,
      path: '',
      secondsSearch: 0,
      precursorError: null,
      fragmentError: null,
    })
    expect(f.secondsSearch).toBeGreaterThanOrEqual(0)
    // summary.yaml has six significant digits
    for (const key of ['precursorError', 'fragmentError'] as const) {
      const [a, b] = [f[key], e[key]]
      expect(a === null, key).toBe(b === null)
      // (an error of the simulated example's spectra, 0 within 1e-9 ppm, compares absolutely; the recommended
      // tolerance of ProSE since OpenMS #10715 is a whole number of ppm, at least 1, the web app's ProSE's was not
      // rounded)
      if (a && b) {
        for (const k of ['median', 'mad'] as const) if (Math.abs(a[k] - b[k]) > 1e-9) expectRelative(`${key}.${k}`, a[k], b[k], 1e-5)
        expect(Number.isInteger(a.recommended) && a.recommended >= 1, `${key}.recommended ${a.recommended}`).toBe(true)
        expect(a.recommended).toBeGreaterThanOrEqual(b.recommended)
      }
    }
  })
  const { secondsIndexBuild, secondsTotal, databaseFile, ...search } = s.search
  const { secondsIndexBuild: _b, secondsTotal: _t, databaseFile: webDatabase, ...webSearch } = w.search
  if (index === 'differs') {
    for (const k of ['indexedPeptides', 'indexedFragments'] as const) {
      expect(search[k], k).toBeGreaterThan(webSearch[k])
      search[k] = webSearch[k]
    }
  }
  expect(search).toEqual(webSearch)
  expect(secondsIndexBuild).toBeGreaterThanOrEqual(0)
  expect(secondsTotal).toBeGreaterThan(0)
  expect(databaseFile).not.toBe('')
  expect(webDatabase).not.toBe('')
  expect({ ...s, files: [], search: null, modificationAnalysis: null }).toEqual({ ...w, files: [], search: null, modificationAnalysis: null })
}

describe('readSearch', () => {
  test('the web app\'s example reads as the web app\'s result', async () => {
    const w = web('suitability')
    const { files, asked } = folder(join(fixtures, 'suitability'))
    const { summary, tables } = await readSearch(files)

    // the counts of the web app's example with PeptDeep: 1,790 target PSMs at 1 % (895 of each replicate)
    expect(tables.psms.count).toBe(1792)
    const targets = Array.from(tables.psms.qValue).filter((q, i) => q <= 0.01 && tables.psms.decoy[i] === 0)
    expect(targets.length).toBe(1790)
    expect(tables.files).toEqual(['/data/DatabaseSuitability_1.mzML', '/data/DatabaseSuitability_2.mzML'])

    expectTables(tables, w.tables, w.names, { score: PERCOLATOR_SCORE_TOLERANCE, pep: 'differs', qValue: 'conservative' })
    expectSummary(summary, w.summary)
    expect(summary.files.map((f) => f.path)).toEqual(tables.files)
    // only relative names: the folder's files, and its database with the contaminants
    expect(asked.filter((n) => n.startsWith('/'))).toEqual([])
    expect(asked).toContain('database.fasta')
  })

  test('the app\'s example (E. coli, LTQ Orbitrap CID): the web app\'s PSMs of it read as the web app\'s', async () => {
    const w = web('example')
    const { files, asked } = folder(join(fixtures, 'example'))
    const { summary, tables } = await readSearch(files)

    // one run of 139 spectra searched as two replicates, at the example's PSM FDR of 2 % (Percolator's q-values are
    // (decoys + 1) / targets since OpenMS #10721, so the run's PSMs reach 1.2 % at best): 77 target PSMs of each, no
    // decoy within it
    expect(tables.psms.count).toBe(154)
    const targets = Array.from(tables.psms.qValue).filter((q, i) => q <= 0.02 && tables.psms.decoy[i] === 0)
    expect(targets.length).toBe(154)
    expect(Array.from(tables.psms.qValue).every((q) => q >= 1 / 77 - 1e-12)).toBe(true)
    expect(tables.files).toEqual(['/data/Ecoli_1.mzML', '/data/Ecoli_2.mzML'])
    // real data: precursor errors of a few ppm (never all 0, as the web app's simulated example), isotope errors
    const ppm = Array.from(tables.psms.precursorErrorPpm)
    expect(ppm.every((e) => Math.abs(e) < 10)).toBe(true)
    expect(ppm.filter((e) => Math.abs(e) > 1).length).toBeGreaterThan(60)
    expect(Array.from(tables.psms.isotopeError).some((e) => e !== 0)).toBe(true)

    // 112 of the web app's 120 PSMs (its older ProSE, at 1 %) are among them, the same in all but Percolator's
    // scores; the other 8 (4 of each replicate) are not reported: Percolator's ranking differs (its features since
    // OpenMS #10717, its q-values since #10721)
    const p = tables.psms
    const wp = w.tables.psms
    expect(wp.count).toBe(120)
    const rows = webRows(tables, w.tables)
    expect(rows.filter((i) => i < 0).length).toBe(8)
    expect(new Set(rows.filter((i) => i >= 0)).size).toBe(112)
    expect(p.featureNames).toEqual(wp.featureNames)
    const n = p.featureNames.length
    rows.forEach((i, k) => {
      if (i < 0) return
      const label = `PSM ${wp.nativeId[k]} of file ${wp.file[k]}`
      expect(tables.peptides.openms[p.peptide[i]], label).toBe(w.tables.peptides.openms[wp.peptide[k]])
      expect([p.charge[i], p.decoy[i], p.isotopeError[i]], label).toEqual([wp.charge[k], wp.decoy[k], wp.isotopeError[k]])
      expectCloseRelative(`rt of ${label}`, [p.rt[i]], [wp.rt[k]], FLOAT32)
      expectCloseRelative(`mz of ${label}`, [p.mz[i]], [wp.mz[k]], FLOAT32)
      expectClose(`precursorErrorPpm of ${label}`, [p.precursorErrorPpm[i]], [wp.precursorErrorPpm[k]], 1e-6)
      expectClose(`deltaMass of ${label}`, [p.deltaMass[i]], [wp.deltaMass[k]], 1e-6)
      p.featureNames.forEach((name, j) => {
        const [a, e] = [p.features[i * n + j], num(wp.features[k * n + j])]
        if (MASS_FEATURES.includes(name)) expectCloseRelative(`${name} of ${label}`, [a], [e], FLOAT32)
        else if (name === 'dm' || name === 'absdm') expectClose(`${name} of ${label}`, [a], [e], 2e-4)
        // the RT error: the RT calibration's spline, fitted on the PSMs of each search (the web app's: 60 a file)
        else if (name !== 'rt_abs_error') expectClose(`${name} of ${label}`, [a], [e], PEPTDEEP_FEATURES.includes(name) ? 1e-5 : 1e-6)
      })
    })
    // A known difference, not of the reader: the native tool indexes the whole database once for both inputs
    // (948,239 peptides), the web app's module only the peptides that the spectra's precursor windows reach (12,223).
    // Neither applied a protein FDR (the fixture asked for none, as the app's example; the web app's for 1 %, which it
    // skipped).
    expect(summary.proteinFdrApplied).toBe(false)
    expect(summary.psmFdr).toBe(0.02)
    expect(summary.files.map((f) => [f.psmFdrApplied, f.targetPSMs, f.decoyPSMs])).toEqual([
      [true, 77, 0],
      [true, 77, 0],
    ])
    expect(summary.search!.indexedPeptides).toBeGreaterThan(w.summary.search!.indexedPeptides)
    expect(summary.files.map((f) => f.path)).toEqual(tables.files)
    expect(asked.filter((n) => n.startsWith('/'))).toEqual([])
    expect(asked).toContain('database.fasta')
  })

  test('the PEP of the web app\'s example differs from the web app\'s (Percolator, one decoy per file)', async () => {
    // A known difference, not of the reader: with a single decoy PSM per file Percolator's PEP estimate is degenerate.
    // The web app's ProSE estimated pi0 and gave small PEPs; the pinned one (since OpenMS #10721 without pi0, as the
    // percolator executable) gives small PEPs too, but up to 0.05 apart (before #10721 the native tool gave every PSM
    // PEP 1). The reader passes on ProSE's QPX posterior_error_probability.
    const w = web('suitability')
    const { tables } = await readSearch(folder(join(fixtures, 'suitability')).files)
    expectClose('psms.pep', tables.psms.pep, w.tables.psms.pep, 0.05)
    expect(Array.from(tables.psms.pep).filter((p) => p === 1).length).toBe(0)
  })

  test('modified peptides read as the web app\'s', async () => {
    const w = web('mods')
    const { files, asked } = folder(join(fixtures, 'mods'))
    const { summary, tables } = await readSearch(files)
    expect(tables.peptides.openms).toContain('IALSRPNVEVVALNDPFITNDYAAYM(Oxidation)FK')
    expectTables(tables, w.tables, w.names, { score: 1e-6, qValue: 'conservative' })
    // three target PSMs and no decoy PSM: q = 1/3 (the web app's ProSE: 0)
    expect(Array.from(tables.psms.qValue)).toEqual([1 / 3, 1 / 3, 1 / 3])
    expectSummary(summary, w.summary)
    // without contaminants the search read the user's FASTA, named in the provenance (database_file)
    expect(asked.filter((n) => n.startsWith('/')).map((n) => basename(n))).toEqual(['SimpleSearchEngine_1.fasta'])
  })

  test('an open search reads as the web app\'s', async () => {
    const w = web('open')
    const { summary, tables } = await readSearch(folder(join(fixtures, 'open')).files)
    expectTables(tables, w.tables, w.names, { score: 1e-6, qValue: 'conservative' })
    expectSummary(summary, w.summary)
    expect(Array.from(tables.psms.deltaMass).some((d) => d > 15)).toBe(true)

    // the modification analysis: the TSVs have six significant digits; their PTM table has no charge
    // states (0, which the web app's screens do not show)
    const m = summary.modificationAnalysis!
    const e = w.summary.modificationAnalysis!
    expect(m).not.toBeNull()
    const { entries: deltas, ...deltaTotals } = m.deltaMasses
    const { entries: webDeltas, ...webDeltaTotals } = e.deltaMasses
    for (const [k, v] of Object.entries(webDeltaTotals)) expectRelative(`deltaMasses.${k}`, deltaTotals[k as keyof typeof deltaTotals] ?? NaN, v as number, 1e-5)
    // ProSE since OpenMS #10715 counts the target PSMs only, and a peak's unique peptides are its own (the web app's
    // ProSE gave every peak the run's unique peptides, 3 for one PSM)
    expect(m.deltaMasses.decoyPSMs).toBe(0)
    expect(e.deltaMasses.decoyPSMs).toBeUndefined()
    expect(deltas.length).toBe(webDeltas.length)
    deltas.forEach((d, i) => {
      expect(d.uniquePeptides).toBeLessThanOrEqual(d.count)
      expect({ ...d, deltaMass: 0, percentage: 0, uniquePeptides: 0 }).toEqual({ ...webDeltas[i], deltaMass: 0, percentage: 0, uniquePeptides: 0 })
      expectRelative('deltaMass', d.deltaMass, webDeltas[i].deltaMass, 1e-5)
      expectRelative('percentage', d.percentage, webDeltas[i].percentage, 1e-5)
    })
    const { entries: ptms, ...ptmTotals } = m.ptms
    const { entries: webPtms, ...webPtmTotals } = e.ptms
    expect(ptmTotals).toEqual(webPtmTotals)
    expect(ptms.length).toBe(webPtms.length)
    ptms.forEach((p, i) => {
      const q = webPtms[i]
      expect(p.chargeStates).toBe(0)
      expect({ ...p, theoreticalMass: 0, observedMass: 0, massDeviation: 0, percentage: 0, chargeStates: 0 }).toEqual({
        ...q,
        theoreticalMass: 0,
        observedMass: 0,
        massDeviation: 0,
        percentage: 0,
        chargeStates: 0,
      })
      for (const k of ['theoreticalMass', 'observedMass', 'massDeviation', 'percentage'] as const) expectRelative(k, p[k], q[k], 1e-5)
    })
  })
})

/** The peaks of spectrum `s`. */
const peaks = (sp: StoredSpectra | Json, s: number) => {
  const [from, to] = [sp.offsets[s], sp.offsets[s + 1]]
  // (float32 values: the web app's export has them with the 9 digits that keep them)
  const float32 = (a: ArrayLike<number>) => Array.from(a, Math.fround)
  return { mz: float32(sp.mz.slice(from, to)), intensity: float32(sp.intensity.slice(from, to)) }
}

describe('peaks and predictions belong to their PSM', () => {
  // (the web app's example's spectra have at most 77 peaks: the peak filter, 100 per 100 m/z and the annotated ones, keeps them all)
  test('the peaks and the precursor of each PSM are the web app\'s, read by row group of its input\'s file', async () => {
    const w = web('suitability')
    const { files, ranges } = folder(join(fixtures, 'suitability'))
    const { spectra, tables } = await readSearch(files)
    // nothing of the inputs' psm and mz files is read until a PSM is opened
    expect(ranges.filter((r) => !r.name.startsWith('qpx/quantms.'))).toEqual([])
    for (let i = 0; i < tables.psms.count; i++) {
      const { spectra: sp, spectrumRow } = await spectra.load(i)
      const s = sp.psmSpectrum[spectrumRow] ?? -1
      const ws = w.spectra.psmSpectrum[i]
      expect(s >= 0, `row ${i} has peaks`).toBe(ws >= 0)
      expect(peaks(sp, s), `peaks of row ${i}`).toEqual(peaks(w.spectra, ws))
      expectCloseRelative(`precursorMz of row ${i}`, [sp.precursorMz[s]], [w.spectra.precursorMz[ws]], FLOAT32)
      // the collision energy is not read (docs/parity.md: the predictions are ProSE's)
      expect(Number.isNaN(sp.collisionEnergy[s])).toBe(true)
    }
    // the footer of each input's psm file and mz view once, then the columns of each row group once (the last few
    // are kept)
    const read = ranges.filter((r) => !r.name.startsWith('qpx/quantms.'))
    const tails = read.filter((r) => 'tail' in r.range)
    expect(tails.map((r) => r.name)).toEqual([
      'qpx/runs/1__DatabaseSuitability_1.psm.parquet',
      'qpx/runs/1__DatabaseSuitability_1.mz.parquet',
      'qpx/runs/2__DatabaseSuitability_2.psm.parquet',
      'qpx/runs/2__DatabaseSuitability_2.mz.parquet',
    ])
    // 896 PSMs and spectra of each input in row groups of 256: 4 of the psm file, 4 of the mz view
    expect(read.length - tails.length).toBe(16)
  })

  test('the app\'s example: the peaks (with their intensities) and predictions of each PSM are the web app\'s', async () => {
    const w = web('example')
    const { spectra, tables } = await readSearch(folder(join(fixtures, 'example')).files)
    const wp = w.predicted
    // the PSMs of both (the test above), each with the web app's row
    const shared = webRows(tables, w.tables).flatMap((i, k) => (i < 0 ? [] : [[i, k]]))
    expect(shared.length).toBe(112)
    for (const [i, k] of shared) {
      const { spectra: sp, spectrumRow, predicted, row } = await spectra.load(i)
      const s = sp.psmSpectrum[spectrumRow] ?? -1
      const ws = w.spectra.psmSpectrum[k]
      expect(s >= 0 && ws >= 0, `row ${i} has peaks`).toBe(true)
      // (no peak filtered: at most 543 peaks per spectrum, never 100 within 100 m/z)
      expect(peaks(sp, s), `peaks of row ${i}`).toEqual(peaks(w.spectra, ws))
      expect(new Set(peaks(sp, s).intensity).size, `intensities of row ${i}`).toBeGreaterThan(10)
      const [from, to] = [predicted.psmOffsets[row], predicted.psmOffsets[row + 1]]
      const [wf, wt] = [wp.psmOffsets[k], wp.psmOffsets[k + 1]]
      expect(to - from, `row ${i} has a prediction`).toBeGreaterThan(0)
      expect(predicted.ion.slice(from, to), `ions of row ${i}`).toEqual(wp.ion.slice(wf, wt))
      expectClose(`m/z of row ${i}`, predicted.mz.slice(from, to), wp.mz.slice(wf, wt), 1e-3)
      expectClose(`intensity of row ${i}`, predicted.intensity.slice(from, to), wp.intensity.slice(wf, wt), 1e-5)
    }
  })

  test('the predictions of each PSM are the web app\'s predictMS2 of its peptide', async () => {
    const w = web('suitability')
    const { spectra, tables } = await readSearch(folder(join(fixtures, 'suitability')).files)
    expect(spectra.predictions).toBe(true)
    const wp = w.predicted
    for (let i = 0; i < tables.psms.count; i++) {
      const { predicted, row } = await spectra.load(i)
      const [from, to] = [predicted.psmOffsets[row], predicted.psmOffsets[row + 1]]
      const [wf, wt] = [wp.psmOffsets[i], wp.psmOffsets[i + 1]]
      expect(to - from, `row ${i} has a prediction`).toBeGreaterThan(0)
      expect(predicted.ion.slice(from, to), `ions of row ${i}`).toEqual(wp.ion.slice(wf, wt))
      expectClose(`m/z of row ${i}`, predicted.mz.slice(from, to), wp.mz.slice(wf, wt), 1e-3)
      expectClose(`intensity of row ${i}`, predicted.intensity.slice(from, to), wp.intensity.slice(wf, wt), 1e-5)
    }
  })

  test('the peak filter of the mz view\'s footer is passed on, for the PSM view\'s note', async () => {
    const example = await readSearch(folder(join(fixtures, 'suitability')).files)
    expect((await example.spectra.load(0)).peakFilter).toEqual({ top: 100, window: 100 })
    await withCopy('mods', async (dir) => {
      const path = join(dir, 'qpx', 'runs', '1__SimpleSearchEngine_1.mz.parquet')
      writeFileSync(path, await withFooter(new Uint8Array(readFileSync(path)), (f) => f.set('prose_peak_top', '0')))
      expect((await (await readSearch(folder(dir).files)).spectra.load(0)).peakFilter).toBeNull()
    })
  })

  test('the mz view\'s rows are found by the ids when a PSM\'s spectrum is not in it', async () => {
    const { spectra: own } = await readSearch(folder(join(fixtures, 'suitability')).files)
    await withCopy('suitability', async (dir) => {
      // the spectrum of PSM row 1 left out: the rows are no longer in the order of the PSMs
      const left = (await readSearch(folder(dir).files)).tables.psms.nativeId[1]
      await changeRows(dir, 'qpx/runs/1__DatabaseSuitability_1.mz.parquet', (rows) => rows.filter((r) => r.id !== left))
      const { spectra } = await readSearch(folder(dir).files)
      expect((await spectra.load(1)).spectrumRow).toBe(-1)
      for (const row of [0, 2, 500, 895]) {
        const [a, b] = [await spectra.load(row), await own.load(row)]
        expect(Array.from(a.spectra.mz.subarray(a.spectra.offsets[a.spectrumRow], a.spectra.offsets[a.spectrumRow + 1]))).toEqual(
          Array.from(b.spectra.mz.subarray(b.spectra.offsets[b.spectrumRow], b.spectra.offsets[b.spectrumRow + 1])),
        )
      }
    })
  })

  test('an input\'s psm file of other rows fails the PSM, not the search', async () => {
    await withCopy('suitability', async (dir) => {
      // the psm files of the two inputs swapped: as many rows, other PSMs (psm_id)
      const [a, b] = ['1__DatabaseSuitability_1', '2__DatabaseSuitability_2'].map((stem) => join(dir, 'qpx', 'runs', `${stem}.psm.parquet`))
      const bytes = readFileSync(a)
      cpSync(b, a)
      writeFileSync(b, bytes)
      const { spectra } = await readSearch(folder(dir).files)
      await expect(spectra.load(0)).rejects.toThrow('qpx/runs/1__DatabaseSuitability_1.psm.parquet: its row 0 is another PSM than the search\'s (psm_id)')
    })
  })

  test('an mz view whose rows are not in the order of the PSMs is read by its ids', async () => {
    const { spectra: own, tables } = await readSearch(folder(join(fixtures, 'suitability')).files)
    await withCopy('suitability', async (dir) => {
      // as many rows as spectra, in another order: the order of the PSMs gives the wrong rows, the ids the right ones
      await changeRows(dir, 'qpx/runs/2__DatabaseSuitability_2.mz.parquet', (rows) => rows.reverse())
      const { spectra } = await readSearch(folder(dir).files)
      for (const row of [896, 897, 1500, tables.psms.count - 1]) {
        const [a, b] = [await spectra.load(row), await own.load(row)]
        const peaks = (l: typeof a) => Array.from(l.spectra.mz.subarray(l.spectra.offsets[l.spectrumRow], l.spectra.offsets[l.spectrumRow + 1]))
        expect(a.spectrumRow).toBeGreaterThanOrEqual(0)
        expect(peaks(a)).toEqual(peaks(b))
      }
    })
  })

  test('two loads at once of an input whose mz rows are not in the PSMs\' order both find their spectra', async () => {
    const { spectra: own } = await readSearch(folder(join(fixtures, 'suitability')).files)
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/runs/2__DatabaseSuitability_2.mz.parquet', (rows) => rows.reverse())
      const { spectra } = await readSearch(folder(dir).files)
      // (the first PSMs of the input, opened one after the other while the earlier loads still run)
      const rows = Array.from({ length: 8 }, (_, i) => 896 + i)
      const loaded = await Promise.all(rows.map((row) => spectra.load(row)))
      const peaks = (l: (typeof loaded)[number]) =>
        Array.from(l.spectra.mz.subarray(l.spectra.offsets[l.spectrumRow], l.spectra.offsets[l.spectrumRow + 1]))
      for (const [i, row] of rows.entries()) {
        expect(loaded[i].spectrumRow, `row ${row}`).toBeGreaterThanOrEqual(0)
        expect(peaks(loaded[i]), `row ${row}`).toEqual(peaks(await own.load(row)))
      }
    })
  })

  test('a PSM without a native ID (QPX spectrum_reference null) has no spectrum, the others theirs', async () => {
    const { spectra: own } = await readSearch(folder(join(fixtures, 'suitability')).files)
    await withCopy('suitability', async (dir) => {
      // (ProSE leaves it null for a second spectrum of a native ID: the mz view has the first's row, never this one's)
      const id = (await readSearch(folder(dir).files)).tables.psms.nativeId[1]
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => {
        rows[1].spectrum_reference = null
      })
      await changeRows(dir, 'qpx/runs/1__DatabaseSuitability_1.mz.parquet', (rows) => rows.filter((r) => r.id !== id))
      const { spectra, tables } = await readSearch(folder(dir).files)
      expect(tables.psms.nativeId[1]).toBe('')
      expect((await spectra.load(1)).spectrumRow).toBe(-1)
      // the prediction is still the PSM's
      const one = await spectra.load(1)
      expect(one.predicted.psmOffsets[one.row + 1]).toBeGreaterThan(one.predicted.psmOffsets[one.row])
      for (const row of [0, 2, 500, 895]) {
        const [a, b] = [await spectra.load(row), await own.load(row)]
        expect(a.spectrumRow, `row ${row}`).toBeGreaterThanOrEqual(0)
        expect(Array.from(a.spectra.mz.subarray(a.spectra.offsets[a.spectrumRow], a.spectra.offsets[a.spectrumRow + 1]))).toEqual(
          Array.from(b.spectra.mz.subarray(b.spectra.offsets[b.spectrumRow], b.spectra.offsets[b.spectrumRow + 1])),
        )
      }
    })
  })

  test('a PSM whose native ID\'s row is another spectrum (at another RT) has no spectrum', async () => {
    await withCopy('suitability', async (dir) => {
      // (as when two spectra share a native ID: the mz view has the first's)
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => {
        rows[0].rt = 1234.5
      })
      const { spectra } = await readSearch(folder(dir).files)
      expect((await spectra.load(0)).spectrumRow).toBe(-1)
      expect((await spectra.load(1)).spectrumRow).toBeGreaterThanOrEqual(0)
    })
  })

  test('a search of app 0.1.x (per-input files next to quantms.*) reads its peaks and predictions', async () => {
    // what a PSM opens: its peaks, precursor and prediction
    const opened = async (files: ReturnType<typeof folder>['files']) => {
      const { spectra, tables } = await readSearch(files)
      const out: { peaks: unknown; precursorMz: unknown; ion: unknown[]; mz: number[]; intensity: number[] }[] = []
      for (let i = 0; i < tables.psms.count; i++) {
        const { spectra: sp, spectrumRow, predicted, row } = await spectra.load(i)
        const s = sp.psmSpectrum[spectrumRow] ?? -1
        const [from, to] = [predicted.psmOffsets[row], predicted.psmOffsets[row + 1]]
        out.push({
          peaks: s >= 0 ? peaks(sp, s) : null,
          precursorMz: s >= 0 ? sp.precursorMz[s] : null,
          ion: predicted.ion.slice(from, to),
          mz: Array.from(predicted.mz.slice(from, to)),
          intensity: Array.from(predicted.intensity.slice(from, to)),
        })
      }
      return out
    }
    const expected = await opened(folder(join(fixtures, 'example')).files)
    expect(expected.length).toBeGreaterThan(0)
    // the fixture has peaks (mz file) and predictions (psm file) to compare, so the fallback must find both files
    expect(expected.some((e) => e.peaks !== null)).toBe(true)
    expect(expected.some((e) => e.ion.length > 0)).toBe(true)
    await withCopy('example', async (dir) => {
      // the layout of 0.1.x: the per-input files next to quantms.*, no runs/
      for (const f of readdirSync(join(dir, 'qpx', 'runs'))) renameSync(join(dir, 'qpx', 'runs', f), join(dir, 'qpx', f))
      rmSync(join(dir, 'qpx', 'runs'), { recursive: true })
      const { files, asked } = folder(dir)
      expect(await opened(files)).toEqual(expected)
      expect(asked.some((n) => /^qpx\/[12]__.*\.(psm|mz)\.parquet$/.test(n))).toBe(true)
    })
  })

  test('an input\'s psm file that is missing or of other rows fails the PSM, not the search', async () => {
    await withCopy('suitability', async (dir) => {
      rmSync(join(dir, 'qpx', 'runs', '2__DatabaseSuitability_2.psm.parquet'))
      cpSync(join(dir, 'qpx', 'quantms.pg.parquet'), join(dir, 'qpx', 'runs', '1__DatabaseSuitability_1.psm.parquet'))
      const { spectra, tables } = await readSearch(folder(dir).files)
      expect(tables.psms.count).toBe(1792)
      await expect(spectra.load(1000)).rejects.toThrow('qpx/runs/2__DatabaseSuitability_2.psm.parquet does not exist')
      await expect(spectra.load(0)).rejects.toThrow(/qpx\/runs\/1__DatabaseSuitability_1.psm.parquet: \d+ rows, but qpx\/quantms.psm.parquet has 896 of this input/)
      await expect(spectra.load(5000)).rejects.toThrow('There is no PSM row 5000.')
      // without its mz view (its spectra could not be read again) a PSM has its prediction, no peaks
      cpSync(join(fixtures, 'suitability', 'qpx', 'runs', '1__DatabaseSuitability_1.psm.parquet'), join(dir, 'qpx', 'runs', '1__DatabaseSuitability_1.psm.parquet'))
      rmSync(join(dir, 'qpx', 'runs', '1__DatabaseSuitability_1.mz.parquet'))
      const loaded = await (await readSearch(folder(dir).files)).spectra.load(0)
      expect(loaded.spectrumRow).toBe(-1)
      expect(loaded.predicted.psmOffsets[loaded.row + 1]).toBeGreaterThan(loaded.predicted.psmOffsets[loaded.row])
    })
  })
})

/** The top-level column names of a Parquet file's schema. */
function topColumns(metadata: ReturnType<typeof parquetMetadata>): string[] {
  const names: string[] = []
  const skip = (i: number): number => {
    let next = i + 1
    for (let k = 0; k < (metadata.schema[i].num_children ?? 0); k++) next = skip(next)
    return next
  }
  for (let k = 0, i = 1; k < (metadata.schema[0].num_children ?? 0); k++) {
    names.push(metadata.schema[i].name)
    i = skip(i)
  }
  return names
}

/**
 * A Parquet file with `rows` in the schema of `bytes` (hyparquet-writer, Zstandard as ProSE's: Node's zlib), with
 * the footer key-value metadata of `bytes` changed by `footer`.
 */
function rewrite(
  bytes: Uint8Array,
  rows: Record<string, unknown>[],
  footer: (kv: Map<string, string>) => void = () => {},
  rowGroupSize = 100_000,
): Uint8Array {
  const metadata = parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  const kv = new Map((metadata.key_value_metadata ?? []).map((e) => [e.key, e.value ?? '']))
  footer(kv)
  const columnData = topColumns(metadata).map((name) => ({ name, data: rows.map((r) => r[name]) as never[] }))
  return new Uint8Array(
    parquetWriteBuffer({
      columnData,
      schema: metadata.schema,
      rowGroupSize,
      codec: 'ZSTD',
      compressors: { ZSTD: (input: Uint8Array) => new Uint8Array(zstdCompressSync(input)) },
      kvMetadata: [...kv].map(([key, value]) => ({ key, value })),
    }),
  )
}

async function rowsOf(bytes: Uint8Array): Promise<Record<string, unknown>[]> {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return parquetReadObjects({ file, compressors: { ZSTD } })
}

/** `bytes` with its own rows and its footer changed by `change`. */
async function withFooter(bytes: Uint8Array, change: (kv: Map<string, string>) => void): Promise<Uint8Array> {
  return rewrite(bytes, await rowsOf(bytes), change)
}

/** Rewrites the file `name` of `dir` with its rows changed by `change` (which may also drop or add rows). */
async function changeRows(dir: string, name: string, change: (rows: Record<string, any>[]) => Record<string, any>[] | void) {
  const path = join(dir, name)
  const bytes = new Uint8Array(readFileSync(path))
  const rows = await rowsOf(bytes)
  writeFileSync(path, rewrite(bytes, change(rows) ?? rows))
}

/** Sets parameters of the step `step` of the provenance view of `dir`. */
const setParameters = (dir: string, step: string, values: Record<string, string>) =>
  changeRows(dir, 'qpx/quantms.provenance.parquet', (rows) => {
    const row = rows.find((r) => r.step_name === step)!
    for (const [key, value] of Object.entries(values)) {
      const p = row.parameters.find((e: { key: string }) => e.key === key)
      if (p) p.value = value
      else row.parameters.push({ key, value })
    }
  })

describe('missing and broken files', () => {
  const example = ['1__DatabaseSuitability_1', '2__DatabaseSuitability_2']

  test('a corrupt Parquet file fails the read, naming the file', async () => {
    await withCopy('suitability', async (dir) => {
      const path = join(dir, 'qpx', 'quantms.psm.parquet')
      const bytes = readFileSync(path)
      writeFileSync(path, bytes.subarray(0, bytes.length >> 1))
      await expect(readSearch(folder(dir).files)).rejects.toThrow('qpx/quantms.psm.parquet:')
    })
  })

  test('an error of the files callback other than not found fails the read, naming the file', async () => {
    const { files } = folder(join(fixtures, 'suitability'))
    const failing = (name: string) => (name.endsWith('.pg.parquet') ? Promise.reject(new Error('permission denied')) : files(name))
    await expect(readSearch(failing)).rejects.toThrow('qpx/quantms.pg.parquet: permission denied')
  })

  test('a rejection that is no Error (a Tauri command error object) keeps its message', async () => {
    const { files } = folder(join(fixtures, 'suitability'))
    const failing = (name: string) => (name.endsWith('.pg.parquet') ? Promise.reject({ message: 'permission denied' }) : files(name))
    await expect(readSearch(failing)).rejects.toThrow('qpx/quantms.pg.parquet: permission denied')
    const odd = (name: string) => (name.endsWith('.pg.parquet') ? Promise.reject({ code: 13 }) : files(name))
    await expect(readSearch(odd)).rejects.toThrow('qpx/quantms.pg.parquet: {"code":13}')
  })

  test('a QPX psm file without the columns of -qpx_extended fails the read, naming the file', async () => {
    await withCopy('mods', async (dir) => {
      // a plain QPX psm view: no spectrum_reference, isotope_error, protein_mappings (two of its columns suffice here)
      writeFileSync(
        join(dir, 'qpx', 'quantms.psm.parquet'),
        new Uint8Array(parquetWriteBuffer({ columnData: [{ name: 'sequence', data: ['PEPTIDE'] }, { name: 'charge', data: [2] }] })),
      )
      await expect(readSearch(folder(dir).files)).rejects.toThrow("qpx/quantms.psm.parquet: the QPX psm view has not the columns of ProSE's -qpx_extended")
    })
  })

  test('a search folder of an earlier layout fails the read with a clear message', async () => {
    await withCopy('mods', async (dir) => {
      // QPX files without the run and provenance views (the first QPX-only layout)
      rmSync(join(dir, 'qpx', 'quantms.run.parquet'))
      rmSync(join(dir, 'qpx', 'quantms.provenance.parquet'))
      await expect(readSearch(folder(dir).files)).rejects.toThrow(OldLayoutError)
      // summary.yaml without any QPX psm file
      rmSync(join(dir, 'qpx', 'quantms.psm.parquet'))
      rmSync(join(dir, 'qpx', 'runs', '1__SimpleSearchEngine_1.psm.parquet'))
      writeFileSync(join(dir, 'summary.yaml'), 'shared:\n  enzyme: "Trypsin"\nper_file: []\n')
      await expect(readSearch(folder(dir).files)).rejects.toThrow('saved by an earlier version of ProSE Desktop')
      // no results at all
      rmSync(join(dir, 'summary.yaml'))
      await expect(readSearch(folder(dir).files)).rejects.toThrow('The search folder has no results of ProSE')
    })
  })

  test('an input whose search failed has no PSMs, and its status', async () => {
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/quantms.run.parquet', (rows) => {
        Object.assign(rows[1], { search_status: 'INPUT_FILE_EMPTY', psm_rows: 0n, identified_spectra_count: 0n, decoy_psm_count: 0n })
      })
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => rows.slice(0, 896))
      rmSync(join(dir, 'qpx', 'runs', `${example[1]}.psm.parquet`))
      const { tables, summary, warnings } = await readSearch(folder(dir).files)
      expect(tables.psms.count).toBe(896)
      expect(Array.from(tables.psms.file).every((f) => f === 0)).toBe(true)
      expect(summary.files.map((f) => f.status)).toEqual(['EXECUTION_OK', 'INPUT_FILE_EMPTY'])
      expect(warnings).toEqual([])
    })
  })

  test('a search in which every input failed reads, with the statuses of its inputs', async () => {
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/quantms.run.parquet', (rows) => {
        for (const r of rows) Object.assign(r, { search_status: 'UNKNOWN_ERROR', psm_rows: 0n, identified_spectra_count: 0n })
      })
      await changeRows(dir, 'qpx/quantms.psm.parquet', () => [])
      for (const e of example) rmSync(join(dir, 'qpx', 'runs', `${e}.psm.parquet`))
      const { tables, summary } = await readSearch(folder(dir).files)
      expect(tables.psms.count).toBe(0)
      expect(summary.files.map((f) => f.status)).toEqual(['UNKNOWN_ERROR', 'UNKNOWN_ERROR'])
    })
  })

  test('an input whose search reports PSMs but has no rows is named in a warning', async () => {
    // (its psm file could not be written: ProSE leaves its rows out of quantms.psm.parquet)
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/quantms.run.parquet', (rows) => {
        rows[1].psm_rows = 0n
      })
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => rows.slice(0, 896))
      const { tables, warnings } = await readSearch(folder(dir).files)
      expect(tables.psms.count).toBe(896)
      expect(warnings).toEqual([
        'DatabaseSuitability_2.mzML: ProSE reports 895 target PSMs for it, but its results are not in the search folder, so its PSMs are not shown.',
      ])
    })
  })

  test('rows that the run view does not account for fail the read', async () => {
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => rows.slice(0, 1000))
      await expect(readSearch(folder(dir).files)).rejects.toThrow('qpx/quantms.psm.parquet: 1000 rows, but qpx/quantms.run.parquet gives its inputs 1792.')
    })
  })

  test('an empty result (no PSMs, no proteins) reads', async () => {
    await withCopy('mods', async (dir) => {
      await changeRows(dir, 'qpx/quantms.psm.parquet', () => [])
      await changeRows(dir, 'qpx/quantms.pg.parquet', () => [])
      await changeRows(dir, 'qpx/quantms.run.parquet', (rows) => {
        rows[0].psm_rows = 0n
        rows[0].identified_spectra_count = 0n
      })
      const { tables, spectra, summary, warnings } = await readSearch(folder(dir).files)
      expect(tables.psms.count).toBe(0)
      expect(tables.peptides.count).toBe(0)
      expect(tables.proteins.count).toBe(0)
      expect(tables.psms.featureNames).toEqual(['ln(hyperscore)'])
      expect(Array.from(tables.peptides.modOffsets)).toEqual([0])
      await expect(spectra.load(0)).rejects.toThrow('There is no PSM row 0.')
      expect(summary.files.length).toBe(1)
      expect(warnings).toEqual([])
    })
  })

  test("ProSE's output of a search in which no PSM passes the FDR reads as an empty result", async () => {
    // fixtures/empty: two inputs with the protein FDR and Percolator, the files as ProSE writes them (header only)
    const { tables, summary, warnings } = await readSearch(folder(join(fixtures, 'empty')).files)
    expect(tables.files).toEqual(['/data/DatabaseSuitability_1.mzML', '/data/DatabaseSuitability_2.mzML'])
    expect(tables.psms.count).toBe(0)
    expect(tables.peptides.count).toBe(0)
    expect(tables.proteins.count).toBe(0)
    expect(Array.from(tables.peptides.modOffsets)).toEqual([0])
    expect(Array.from(tables.peptides.proteinOffsets)).toEqual([0])
    expect(summary.files.map((f) => [f.status, f.ms2Spectra, f.targetPSMs, f.decoyPSMs])).toEqual([
      ['EXECUTION_OK', 2789, 0, 0],
      ['EXECUTION_OK', 2789, 0, 0],
    ])
    expect(summary.proteinFdrApplied).toBe(false)
    expect(warnings).toEqual([])
  })

  test('a search whose PSM FDR ProSE skipped (no decoy PSM) says so, also from a ProSE that does not report it', async () => {
    // fixtures/no-psm-fdr: the app's example run against three random proteins, PSM FDR 1 %: one PSM, no decoy PSM,
    // so ProSE skipped the PSM FDR and the PSM has no q-value (the pin: no psm_fdr_applied, inferred from that)
    const { tables, summary } = await readSearch(folder(join(fixtures, 'no-psm-fdr')).files)
    expect(tables.psms.count).toBe(1)
    expect(tables.psms.qValue[0]).toBeNaN()
    expect(summary.psmFdr).toBe(0.01)
    expect(summary.files.map((f) => f.psmFdrApplied)).toEqual([false])
    // a search that applied it: every input has q-values
    const applied = await readSearch(folder(join(fixtures, 'suitability')).files)
    expect(applied.summary.files.map((f) => f.psmFdrApplied)).toEqual([true, true])
  })

  test('a search without decoys (no FDR) reads with PSMs without q-values, and says so', async () => {
    // fixtures/no-decoys: the app's example run once, decoys 'ignore', no FDR sent (the app's request then)
    const { tables, summary } = await readSearch(folder(join(fixtures, 'no-decoys')).files)
    expect(tables.psms.count).toBe(119)
    expect(Array.from(tables.psms.qValue).every(Number.isNaN)).toBe(true)
    expect(Array.from(tables.psms.decoy).every((d) => d === 0)).toBe(true)
    expect(tables.proteins.count).toBeGreaterThan(0)
    expect(Array.from(tables.proteins.qValue).every(Number.isNaN)).toBe(true)
    // no FDR requested: the PSM FDR is 0 and not "not applied" (null), the protein FDR not applied
    expect([summary.psmFdr, summary.proteinFdr, summary.proteinFdrApplied]).toEqual([0, 0, false])
    expect(summary.files.map((f) => [f.psmFdrApplied, f.targetPSMs, f.decoyPSMs])).toEqual([[null, 119, 0]])
    expect(summary.search!.decoyProteins).toBe(0)
    // Percolator needs decoys: it said why it did not rescore
    expect(summary.files[0].percolator).toMatchObject({ applied: false, skipped: expect.stringContaining('No decoy PSMs') })
    // the results: every PSM counts, none is FDR-controlled, and the Overview says why
    const model = buildModel(tables, resolveDesign([input('Ecoli_MS2_small.mzML')]), { showTechReplicates: false, psmFdr: 1, proteinFdr: 1 })
    const figures = keyFigures(model, summary)
    expect([figures.psms, figures.psmsWithoutFdr, figures.fdrOff]).toEqual([119, 119, true])
    expect(psmFdrFact(summary).value).toBe('off (no decoys)')
    expect(psmFdrNotice(summary)).toMatch(/^The search had no decoys, so ProSE could not estimate an FDR and applied none/)
  })

  test("the run view's psm_fdr_applied, else the provenance's, says whether the PSM FDR was applied", async () => {
    /** the run view of `dir` with the column psm_fdr_applied (the pinned ProSE's; added to an older one's) */
    const withColumn = async (dir: string, values: (boolean | null)[]) => {
      const path = join(dir, RUN_VIEW)
      const bytes = new Uint8Array(readFileSync(path))
      const metadata = parquetMetadata(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
      const rows = await rowsOf(bytes)
      const has = topColumns(metadata).includes('psm_fdr_applied')
      const schema = has
        ? metadata.schema
        : [{ ...metadata.schema[0], num_children: (metadata.schema[0].num_children ?? 0) + 1 }, ...metadata.schema.slice(1)]
      if (!has) schema.push({ name: 'psm_fdr_applied', type: 'BOOLEAN', repetition_type: 'OPTIONAL' })
      const columnData = topColumns(metadata)
        .filter((name) => name !== 'psm_fdr_applied')
        .map((name) => ({ name, data: rows.map((r) => r[name]) as never[] }))
      columnData.splice(has ? topColumns(metadata).indexOf('psm_fdr_applied') : columnData.length, 0, {
        name: 'psm_fdr_applied',
        data: values as never[],
      })
      const compressors = { ZSTD: (input: Uint8Array) => new Uint8Array(zstdCompressSync(input)) }
      writeFileSync(path, new Uint8Array(parquetWriteBuffer({ columnData, schema, codec: 'ZSTD', compressors })))
    }
    const RUN_VIEW = 'qpx/quantms.run.parquet'
    // the column wins over the PSMs' q-values (and its null: no PSM FDR requested)
    for (const value of [true, null]) {
      await withCopy('no-psm-fdr', async (dir) => {
        await withColumn(dir, [value])
        expect((await readSearch(folder(dir).files)).summary.files[0].psmFdrApplied).toBe(value)
      })
    }
    await withCopy('suitability', async (dir) => {
      await withColumn(dir, [false, true])
      expect((await readSearch(folder(dir).files)).summary.files.map((f) => f.psmFdrApplied)).toEqual([false, true])
    })
    // without the column: the provenance's (true for the search), else inferred from the q-values
    await withCopy('no-psm-fdr', async (dir) => {
      await setParameters(dir, 'target_decoy_fdr', { psm_fdr_applied: 'true' })
      expect((await readSearch(folder(dir).files)).summary.files[0].psmFdrApplied).toBe(true)
      await setParameters(dir, 'target_decoy_fdr', { psm_fdr_applied: 'false' })
      expect((await readSearch(folder(dir).files)).summary.files[0].psmFdrApplied).toBe(false)
      // no PSM FDR requested
      await setParameters(dir, 'target_decoy_fdr', { psm_fdr: '0' })
      expect((await readSearch(folder(dir).files)).summary.files[0].psmFdrApplied).toBeNull()
    })
  })

  test("a PSM whose proteins all failed the protein FDR keeps its .pin features but enzN and enzC", async () => {
    // one input with the protein FDR: ProSE removes the references to the proteins that failed it, so the PSM has
    // no protein mappings left (the PSMs of the iPRG2015 subset showed empty features)
    const before = await readSearch(folder(join(fixtures, 'suitability')).files)
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => {
        rows[0].protein_mappings = []
      })
      const { tables } = await readSearch(folder(dir).files)
      const { featureNames, features } = tables.psms
      expect(featureNames).toEqual(before.tables.psms.featureNames)
      const n = featureNames.length
      const kept = ['CalcMass', 'mass', 'peplen', 'charge2', 'charge3', 'enzInt', 'dm', 'absdm']
      for (const name of featureNames) {
        const j = featureNames.indexOf(name)
        const [value, was] = [features[j], before.tables.psms.features[j]]
        if (name === 'enzN' || name === 'enzC') expect(value, name).toBeNaN()
        else expect(value, name).toBe(was)
        if (kept.includes(name)) expect(value, name).not.toBeNaN()
      }
      // the other PSMs are as they were
      expect(Array.from(features.subarray(n))).toEqual(Array.from(before.tables.psms.features.subarray(n)))
    })
  })

  test('an open search without its mod-analysis folder reads, without the analysis', async () => {
    await withCopy('open', async (dir) => {
      rmSync(join(dir, 'mods'), { recursive: true })
      const { summary, tables } = await readSearch(folder(dir).files)
      expect(summary.openSearch).toBe(true)
      expect(summary.modificationAnalysis).toBeNull()
      expect(tables.psms.count).toBe(3)
    })
  })

  test('one input without protein inference: a group per protein, as the tool writes them', async () => {
    // mods: one input, no protein FDR, so no inference; -qpx_extended writes a group of its own for each protein
    const { files, asked } = folder(join(fixtures, 'mods'))
    const { tables, summary } = await readSearch(files)
    expect(summary.proteinFdrApplied).toBe(false)
    expect(asked).toContain('qpx/quantms.pg.parquet')
    expect(tables.proteins.count).toBe(3)
    expect(Array.from(tables.proteins.group)).toEqual([0, 1, 2])
    expect(Array.from(tables.proteins.qValue).every(Number.isNaN)).toBe(true)
  })
})

describe('values the reader computes or picks', () => {
  test('the protein q-value is the pg row\'s additional_scores entry q-value, whatever its position', async () => {
    const { tables } = await readSearch(folder(join(fixtures, 'suitability')).files)
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/quantms.pg.parquet', (rows) => {
        for (const r of rows) r.additional_scores = [{ score_name: 'other_score', score_value: 42, higher_better: true }, ...(r.additional_scores ?? [])]
      })
      const changed = (await readSearch(folder(dir).files)).tables
      expect(Array.from(changed.proteins.qValue)).toEqual(Array.from(tables.proteins.qValue))
      expect(Array.from(tables.proteins.qValue).some((q) => q > 0 && q < 1)).toBe(true)
    })
  })

  test("the tool's protein_mappings: 1-based positions and flanking residues of the peptide in the FASTA", async () => {
    const bytes = new Uint8Array(readFileSync(join(fixtures, 'suitability', 'qpx', 'quantms.psm.parquet')))
    const rows = await rowsOf(bytes)
    const fasta = new Map<string, string>()
    let id = ''
    for (const line of readFileSync(join(fixtures, 'suitability', 'database.fasta'), 'utf8').split('\n')) {
      if (line.startsWith('>')) {
        id = line.slice(1).split(/\s/)[0]
        fasta.set(id, '')
      } else fasta.set(id, fasta.get(id)! + line.trim())
    }
    let checked = 0
    for (const r of rows) {
      const sequence = String(r.sequence)
      for (const m of r.protein_mappings as { accession: string; start: number; end: number; aa_before: string; aa_after: string }[]) {
        const protein = fasta.get(m.accession)
        if (protein === undefined) continue // a decoy ProSE generated
        expect(protein.slice(m.start - 1, m.end), `${sequence} in ${m.accession}`).toBe(sequence)
        expect(m.aa_before).toBe(m.start === 1 ? '-' : protein[m.start - 2])
        expect(m.aa_after).toBe(m.end === protein.length ? '-' : protein[m.end])
        checked++
      }
    }
    expect(checked).toBeGreaterThan(1000)
  })

  test('without precursor_mz_error_ppm the precursor error is computed from the m/z and the isotope error', async () => {
    const { tables } = await readSearch(folder(join(fixtures, 'suitability')).files)
    await withCopy('suitability', async (dir) => {
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => {
        for (const r of rows) r.additional_scores = r.additional_scores.filter((s: { score_name: string }) => s.score_name !== 'precursor_mz_error_ppm')
      })
      const computed = (await readSearch(folder(dir).files)).tables
      // float32 m/z: within about 0.1 ppm (docs/parity.md, "Precision")
      expectClose('precursorErrorPpm', computed.psms.precursorErrorPpm, Array.from(tables.psms.precursorErrorPpm), 0.12)
    })
  })

  test("the isotope error is QPX's; its feature and dm have the sign of ProSE's convention, as Percolator saw them", async () => {
    await withCopy('suitability', async (dir) => {
      // row 0 at its 13C peak: observed minus theoretical +1
      await changeRows(dir, 'qpx/quantms.psm.parquet', (rows) => {
        rows[0].isotope_error = 1
        for (const s of rows[0].additional_scores) if (s.score_name === 'isotope_error') s.score_value = 1
      })
      const read = async () => {
        const { tables } = await readSearch(folder(dir).files)
        const p = tables.psms
        const at = (name: string) => p.features[p.featureNames.indexOf(name)]
        return { isotope: p.isotopeError[0], feature: at('isotope_error'), dm: at('dm'), charge: p.charge[0] }
      }
      const observed = await read()
      expect([observed.isotope, observed.feature]).toEqual([1, 1])
      await setParameters(dir, 'peptide_search', { isotope_error_convention: 'theoretical_minus_observed' })
      const theoretical = await read()
      expect([theoretical.isotope, theoretical.feature]).toEqual([1, -1])
      // dm: the observed mass corrected by +1 and by −1 13C spacing
      expect(theoretical.dm - observed.dm).toBeCloseTo((2 * 1.0033548378) / observed.charge, 4)
    })
  })
})

describe('protein sequences', () => {
  test('come from proteins.fasta first', async () => {
    const w = web('mods')
    await withCopy('mods', async (dir) => {
      // the identified proteins only, in place of the database
      cpSync(join(dir, 'user', 'SimpleSearchEngine_1.fasta'), join(dir, 'proteins.fasta'))
      rmSync(join(dir, 'user'), { recursive: true })
      const { files, asked } = folder(dir)
      const { tables, warnings } = await readSearch(files)
      expect(asked.filter((n) => n.endsWith('.fasta'))).toEqual(['proteins.fasta'])
      expectTables(tables, w.tables, w.names, { score: 1e-6, qValue: 'conservative' })
      expect(warnings).toEqual([])
    })
  })

  test('then from the database: the folder\'s database.fasta, else the user\'s FASTA', async () => {
    const example = folder(join(fixtures, 'suitability'))
    await readSearch(example.files)
    expect(example.asked.filter((n) => n.endsWith('.fasta'))).toEqual(['proteins.fasta', 'database.fasta'])
    const mods = folder(join(fixtures, 'mods'))
    await readSearch(mods.files)
    expect(mods.asked.filter((n) => n.endsWith('.fasta')).map((n) => basename(n))).toEqual([
      'proteins.fasta',
      'database.fasta',
      'SimpleSearchEngine_1.fasta',
    ])
  })

  test('are left out with a warning when there is no FASTA', async () => {
    await withCopy('mods', async (dir) => {
      rmSync(join(dir, 'user'), { recursive: true })
      const { tables, warnings } = await readSearch(folder(dir).files)
      expect(tables.proteins.count).toBe(3)
      expect(tables.proteins.sequence).toEqual(['', '', ''])
      // the descriptions of the pg view (none in this search)
      expect(tables.proteins.description).toEqual(['', '', ''])
      // the peptides keep the positions the search recorded
      expect(Array.from(tables.peptides.end)).toEqual(web('mods').tables.peptides.end)
      expect(warnings.length).toBe(1)
      expect(warnings[0]).toMatch(/protein sequences are not available.*proteins\.fasta \(not found\).*database\.fasta \(not found\).*SimpleSearchEngine_1\.fasta \(not found\)/)
    })
  })
})

/**
 * A search folder of one input with `n` PSMs: the rows of the web app's example's first file, repeated, each with its
 * own psm_id and scores, in the schema of the tool's QPX psm files (quantms.psm.parquet, and the input's file
 * with the spectra in row groups of 256 rows), with the run view for one input.
 */
async function writeLargeFolder(dir: string, n: number): Promise<void> {
  const source = join(fixtures, 'suitability')
  const stem = '1__DatabaseSuitability_1'
  const read = (p: string) => new Uint8Array(readFileSync(join(source, p)))
  const id = (i: number) => BigInt(i + 1) * 7919n
  // the scores of every row its own (as in a real search, where they are hardly ever repeated: Arrow writes
  // them without a dictionary)
  type Score = { score_name: string; score_value: number; higher_better: boolean | null }
  const many = async (file: string) => {
    const qpx = (await rowsOf(read(file))).slice(0, 896)
    return Array.from({ length: n }, (_, i) => {
      const r = qpx[i % qpx.length]
      return {
        ...r,
        psm_id: id(i),
        additional_scores: (r.additional_scores as Score[]).map((sc) => ({ ...sc, score_value: sc.score_value + i * 1e-9 })),
      }
    })
  }
  mkdirSync(join(dir, 'qpx', 'runs'), { recursive: true })
  writeFileSync(join(dir, 'qpx/quantms.psm.parquet'), rewrite(read('qpx/quantms.psm.parquet'), await many('qpx/quantms.psm.parquet')))
  writeFileSync(join(dir, `qpx/runs/${stem}.psm.parquet`), rewrite(read(`qpx/runs/${stem}.psm.parquet`), await many(`qpx/runs/${stem}.psm.parquet`), () => {}, 256))
  const runs = (await rowsOf(read('qpx/quantms.run.parquet'))).slice(0, 1)
  Object.assign(runs[0], { psm_rows: BigInt(n), identified_spectra_count: BigInt(n) })
  writeFileSync(join(dir, 'qpx/quantms.run.parquet'), rewrite(read('qpx/quantms.run.parquet'), runs))
  // (the spectra of the repeated PSMs: the web app's example's, as their native IDs repeat)
  for (const f of ['qpx/quantms.pg.parquet', 'qpx/quantms.provenance.parquet', `qpx/runs/${stem}.mz.parquet`, 'database.fasta']) {
    cpSync(join(source, f), join(dir, f))
  }
  await setParameters(dir, 'target_decoy_fdr', { protein_fdr_applied: 'false' })
  const inputs = JSON.parse(readFileSync(join(source, 'inputs.json'), 'utf8')).slice(0, 1)
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(inputs))
}

describe('performance', () => {
  test('reads a 150k-PSM fixture in under 3 s, and the spectrum of a PSM in under 300 ms', async () => {
    const N = 150_000
    const dir = mkdtempSync(join(tmpdir(), 'prose-reader-150k-'))
    try {
      await writeLargeFolder(dir, N)
      // (the files in memory, as the app reads the bytes asked for only: the times are the reader's)
      const own = folder(dir).files
      const cache = new Map<string, Uint8Array>()
      const files = async (name: string, range?: ByteRange) => {
        if (!cache.has(name)) cache.set(name, await own(name))
        return bytesOfRange(cache.get(name)!, range)
      }
      await files('qpx/runs/1__DatabaseSuitability_1.psm.parquet')
      const started = performance.now()
      const { tables, spectra } = await readSearch(files)
      const seconds = (performance.now() - started) / 1000
      console.log(`150k PSMs read in ${seconds.toFixed(2)} s`)
      expect(tables.psms.count).toBe(N)
      expect(seconds).toBeLessThan(3)
      // the first PSM opened reads the footer of its file; the others their row group only
      for (const row of [N - 1, 70_000, 70_001, 3]) {
        const t = performance.now()
        const { spectra: sp, spectrumRow } = await spectra.load(row)
        const ms = performance.now() - t
        console.log(`the spectrum of PSM ${row} read in ${ms.toFixed(0)} ms`)
        expect(sp.psmSpectrum[spectrumRow]).toBeGreaterThanOrEqual(0)
        expect(ms).toBeLessThan(300)
      }
    } finally {
      if (process.env.KEEP_150K) cpSync(dir, process.env.KEEP_150K, { recursive: true })
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)

  // On demand: the time to open a real search folder (PROSE_SEARCH_DIR, as the shim makes it) and to read the
  // spectra of PSMs as the PSM view does, one after the other at random (the first reads its input's footer).
  //   PROSE_SEARCH_DIR=/scratch/x npx vitest run src/lib/results/read.test.ts -t 'a real search'
  test.runIf(Boolean(process.env.PROSE_SEARCH_DIR))('opens a real search and reads the spectra of its PSMs', async () => {
    // (the files in memory, as the app reads the bytes asked for only: the times are the reader's)
    const own = folder(process.env.PROSE_SEARCH_DIR!).files
    const cache = new Map<string, Uint8Array>()
    const files = async (name: string, range?: ByteRange) => {
      if (!cache.has(name)) cache.set(name, await own(name))
      return bytesOfRange(cache.get(name)!, range)
    }
    await files(`qpx/runs/${JSON.parse(readFileSync(join(process.env.PROSE_SEARCH_DIR!, 'inputs.json'), 'utf8'))[0].stem}.psm.parquet`)
    let started = performance.now()
    const { tables, spectra } = await readSearch(files)
    console.log(
      `REAL ${tables.psms.count} PSMs opened in ${((performance.now() - started) / 1000).toFixed(2)} s; RSS ${(process.memoryUsage().rss / 2 ** 30).toFixed(2)} GB`,
    )
    const times: number[] = []
    let random = 12345
    for (let k = 0; k < 50; k++) {
      random = (random * 1103515245 + 12345) % 2147483648
      const row = random % tables.psms.count
      started = performance.now()
      const { spectra: sp, spectrumRow } = await spectra.load(row)
      times.push(performance.now() - started)
      expect(spectrumRow < 0 || sp.psmSpectrum[spectrumRow] >= 0).toBe(true)
    }
    const sorted = [...times].sort((a, b) => a - b)
    console.log(`REAL spectra: first ${times[0].toFixed(0)} ms, median ${sorted[25].toFixed(0)} ms, max of the others ${Math.max(...times.slice(1)).toFixed(0)} ms`)
  }, 600_000)

  // On demand: search folders of PROSE_LARGE_PSMS PSMs (default 500k, 1M, 2M, 4M) in PROSE_LARGE_DIR/<id>/,
  // saved searches (with search.json) that e2e/large.spec.ts opens in the app to measure the largest result
  // that opens in WebKit. Each is read here too, in Node, with its time.
  //   PROSE_LARGE_DIR=/scratch/x NODE_OPTIONS=--max-old-space-size=60000 npx vitest run src/lib/results/read.test.ts -t 'large search folders'
  test.runIf(Boolean(process.env.PROSE_LARGE_DIR))('writes large search folders for the measurement in the app', async () => {
    const counts = (process.env.PROSE_LARGE_PSMS ?? '500000,1000000,2000000,4000000').split(',').map(Number)
    for (const n of counts) {
      const id = `9000-${n}`
      const dir = join(process.env.PROSE_LARGE_DIR!, id)
      rmSync(dir, { recursive: true, force: true })
      await writeLargeFolder(dir, n)
      const record = {
        schema: 1,
        id,
        name: `Synthetic ${n.toLocaleString('en')} PSMs`,
        createdAt: '2026-10-21T12:00:00.000Z',
        appVersion: '0.1.0',
        toolVersion: 'synthetic',
        files: ['DatabaseSuitability_1.mzML'],
        database: 'DatabaseSuitability_database.fasta',
        design: resolveDesign([{ id: 'f0', fileName: 'DatabaseSuitability_1.mzML', fileSize: 6_518_159 }]),
        settings: { parameters: {}, fixedMods: [], rescore: false, peptdeep: false, contaminants: false },
        psms: n,
        psmFdr: 1,
        proteinFdr: 0.05,
        seconds: 0,
      }
      writeFileSync(join(dir, 'search.json'), JSON.stringify(record))
      const started = performance.now()
      const { tables } = await readSearch(folder(dir).files)
      console.log(`LARGE ${n} PSMs: read in Node in ${((performance.now() - started) / 1000).toFixed(1)} s`)
      expect(tables.psms.count).toBe(n)
    }
  }, 4 * 3600_000)
})
