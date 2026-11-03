import { describe, expect, it } from 'vitest'
import type { ProSEFileSummary, ProSEMultiSummary } from '../results/types'
import { sampleDesign, sampleTables } from './fixtures'
import { buildModel } from './model'
import {
  adductCounts,
  cutoffText,
  engineNote,
  fdrFacts,
  fileRows,
  fileStatus,
  formatSeconds,
  percolatorStatus,
  residueCounts,
  totalsOf,
} from './overview'
import { makeTables, syntheticDesign } from './synthetic'

const file = (path: string, more: Partial<ProSEFileSummary> = {}): ProSEFileSummary => ({
  path,
  status: 'EXECUTION_OK',
  ms2Spectra: 1000,
  targetPSMs: 400,
  decoyPSMs: 4,
  percolator: { applied: true, skipped: null, warning: null },
  peptdeepNce: null,
  precursorError: null,
  fragmentError: null,
  secondsSearch: 12.34,
  ...more,
})

const summary = (files: ProSEFileSummary[]): ProSEMultiSummary => ({
  files,
  search: {
    databaseFile: 'db.fasta',
    enzyme: 'Trypsin',
    openSearch: false,
    calibration: false,
    chunked: false,
    decoyMode: 'auto',
    targetProteins: 100,
    decoyProteins: 100,
    indexedPeptides: 1000,
    indexedFragments: 10000,
    secondsIndexBuild: 1,
    secondsTotal: 10,
  },
  proteinFdrApplied: true,
  psmFdr: 0.01,
  proteinFdr: 0.01,
  decoyString: 'DECOY_',
  openSearch: false,
  modificationAnalysis: null,
})

describe('percolatorStatus', () => {
  it('says whether Percolator rescored the file, skipped it (and why) or was not used', () => {
    expect(percolatorStatus({ applied: true, skipped: null, warning: null })).toEqual({ kind: 'applied', label: 'Rescored', detail: null, warning: null })
    expect(percolatorStatus({ applied: false, skipped: 'Fewer than 100 PSMs.', warning: null })).toEqual({
      kind: 'skipped',
      label: 'Skipped',
      detail: { short: 'Fewer than 100 PSMs', full: 'Fewer than 100 PSMs.' },
      warning: null,
    })
    expect(percolatorStatus(null)).toEqual({ kind: 'off', label: 'Not used', detail: null, warning: null })
    expect(percolatorStatus({ applied: true, skipped: null, warning: 'Few decoys' }).warning).toEqual({ short: 'Few decoys', full: 'Few decoys' })
  })

  it("puts the engines' long texts in short plain words, the full text kept for the tooltip", () => {
    const sanity =
      "Percolator's sanity check rejected the learned model (on the held-out folds it found no target PSM at q < 0.01, or fewer than the best single feature; typical for blank runs and runs with few confident PSMs), so the PSMs are scored with that feature alone."
    expect(engineNote(sanity)).toEqual({ short: 'Too few confident PSMs, so scored by the best single feature', full: sanity })
    expect(engineNote('Only 42 PSMs, Percolator rescoring needs at least 100.')?.short).toBe('Only 42 PSMs, at least 100 needed')
    expect(engineNote("No decoy PSMs for the target/decoy competition of Percolator. A search without decoys needs …")?.short).toBe('No decoy PSMs to learn from')
    expect(engineNote('Percolator failed: out of memory')?.short).toBe('Percolator failed')
    expect(engineNote('Too few PSMs for score recalibration. Skipped.')?.short).toBe('Too few PSMs (Percolator needs 1000)')
    // an unknown one: its first sentence, at most 80 characters
    expect(engineNote('Something new happened. More text follows here.')?.short).toBe('Something new happened')
    expect(engineNote('x'.repeat(200))!.short).toHaveLength(80)
    expect(engineNote(null)).toBeNull()
    expect(engineNote('  ')).toBeNull()
  })
})

describe('fileStatus', () => {
  it('names every exit status in plain words', () => {
    expect(fileStatus('EXECUTION_OK')).toEqual({ ok: true, label: 'Searched' })
    expect(fileStatus('INPUT_FILE_EMPTY').ok).toBe(false)
    const labels = (['INPUT_FILE_EMPTY', 'UNEXPECTED_RESULT', 'ILLEGAL_PARAMETERS', 'UNKNOWN_ERROR'] as const).map((s) => fileStatus(s).label)
    expect(new Set(labels).size).toBe(4)
    for (const label of labels) expect(label).not.toMatch(/[A-Z]_[A-Z]/) // no exit code shows
  })
})

describe('formatSeconds', () => {
  it('writes a duration in seconds with one decimal, and minutes from a minute on', () => {
    expect(formatSeconds(0.114)).toBe('0.1 s')
    expect(formatSeconds(12.34)).toBe('12.3 s')
    expect(formatSeconds(59.96)).toBe('1 min 0 s')
    expect(formatSeconds(125.4)).toBe('2 min 5 s')
    expect(formatSeconds(NaN)).toBe('–')
  })
})

/**
 * Two files; peptide 0 linear, 1 a U-H3O4P1 cross-link on its K (site 3), 2 a UU-H2O cross-link (not localized), 3 a
 * U-H3O4P1 cross-link on its first residue (Y). Peptide FDR 1 %, cross-link FDR 5 %.
 */
function crossLinked() {
  const tables = makeTables({
    files: ['a.mzML', 'b.mzML'],
    proteins: [{ accession: 'P1', sequence: 'AAAKCCCKDDDKYEEK', qValue: NaN }],
    peptides: [
      { sequence: 'AAAK', proteins: [0] },
      { sequence: 'CCCK', adduct: 'U-H3O4P1', proteins: [{ protein: 0, start: 4 }] },
      { sequence: 'DDDK', adduct: 'UU-H2O', proteins: [{ protein: 0, start: 8 }] },
      { sequence: 'YEEK', adduct: 'U-H3O4P1', proteins: [{ protein: 0, start: 12 }] },
    ],
    psms: [
      { peptide: 0, file: 0, qValue: 0.005 },
      { peptide: 0, file: 1, qValue: 0.02 }, // above the peptide FDR
      { peptide: 1, file: 0, qValue: 0.01, site: 3 },
      { peptide: 1, file: 1, qValue: 0.03, site: 3 },
      { peptide: 1, file: 1, qValue: 0.2, site: 3 }, // above the cross-link FDR
      { peptide: 2, file: 1, qValue: 0.04 },
      { peptide: 3, file: 1, qValue: 0.01, site: 0 },
    ],
  })
  return buildModel(tables, syntheticDesign(['a.mzML', 'b.mzML']), { showTechReplicates: false, psmFdr: 0.01, xlFdr: 0.05, proteinFdr: 1 })
}

describe('fileRows', () => {
  const m = buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 0.01 })

  it('lists every searched file, with its sample and what the search says of it', () => {
    const rows = fileRows(m, summary([file('/input/0/ctrl_a.mzML'), file('/input/1/egf_a.mzML', { percolator: null, ms2Spectra: 700 })]))
    expect(rows.map((r) => r.file)).toEqual(['ctrl_a.mzML', 'egf_a.mzML'])
    expect(rows.map((r) => r.sample)).toEqual(['control 1', 'EGF 1'])
    expect(rows[0]).toMatchObject({ ms2: 1000, seconds: 12.34, notes: [] })
    expect(rows[0].percolator.kind).toBe('applied')
    expect(rows[1]).toMatchObject({ ms2: 700 })
    expect(rows[1].percolator.kind).toBe('off')
  })

  it('has no MS2 count where the summary has none (OpenNuXL does not report it)', () => {
    expect(fileRows(m, summary([file('/input/0/ctrl_a.mzML', { ms2Spectra: 0 })]))[0].ms2).toBeNull()
  })

  it('keeps the order of the search and tolerates a missing summary file', () => {
    expect(fileRows(m, summary([file('/input/0/ctrl_a.mzML')])).map((r) => r.file)).toEqual(['ctrl_a.mzML', 'egf_a.mzML'])
    expect(fileRows(m, summary([file('/input/0/ctrl_a.mzML')]))[1].ms2).toBeNull()
  })

  it('counts the peptide PSMs and the cross-link PSMs of each file at their cutoffs', () => {
    const x = crossLinked()
    const rows = fileRows(x, summary([file('a.mzML'), file('b.mzML')]))
    expect(rows.map((r) => [r.peptidePsms, r.xlPsms])).toEqual([
      [1, 1],
      [0, 3],
    ])
  })

  it("says why OpenNuXL skipped Percolator, and lists its other notes", () => {
    const x = crossLinked()
    const skipped = 'Too few PSMs for score recalibration. Skipped.'
    const rows = fileRows(x, summary([file('a.mzML', { percolator: { applied: false, skipped, warning: null } }), file('b.mzML', { percolator: null })]), {
      xlFdr: 0.05,
      peptideFdr: 0.01,
      percolator: [false, true],
      notes: [[skipped, 'The database had decoys of its own. They were left out.'], []],
    })
    expect(rows[0].percolator).toMatchObject({ kind: 'skipped', detail: { short: 'Too few PSMs (Percolator needs 1000)', full: skipped } })
    expect(rows[0].notes.map((n) => n.short)).toEqual(['The database had decoys of its own'])
    // the summary says nothing of file 2, OpenNuXL's record says it was rescored
    expect(rows[1].percolator.kind).toBe('applied')
  })
})

describe('totalsOf', () => {
  it('adds up the files', () => {
    const x = crossLinked()
    const rows = fileRows(x, summary([file('a.mzML', { ms2Spectra: 0 }), file('b.mzML', { ms2Spectra: 500, secondsSearch: 1 })]))
    expect(totalsOf(rows)).toEqual({ ms2: 500, peptidePsms: 1, xlPsms: 4, seconds: 13.34 })
    expect(totalsOf(fileRows(x, summary([file('a.mzML', { ms2Spectra: 0 })]))).ms2).toBeNull()
  })
})

describe('the cross-links of the overview', () => {
  it('counts the cross-link PSMs per adduct at the cross-link FDR, most first', () => {
    expect(adductCounts(crossLinked())).toEqual([
      { name: 'U-H3O4P1', count: 3 },
      { name: 'UU-H2O', count: 1 },
    ])
  })

  it('counts the cross-linked amino acids, and the PSMs whose cross-link is not localized', () => {
    expect(residueCounts(crossLinked())).toEqual({
      residues: [
        { name: 'K', count: 2 },
        { name: 'Y', count: 1 },
      ],
      unlocalized: 1,
    })
  })

  it('has none without cross-links', () => {
    expect(adductCounts(buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, psmFdr: 1, proteinFdr: 1 }))).toEqual([])
  })
})

describe('the FDRs of the overview', () => {
  it('names the peptide FDR and the cross-link FDR', () => {
    const facts = fdrFacts({ psmFdr: 0.01, xlFdr: 0.05 })
    expect(facts.map((f) => [f.name, f.value])).toEqual([
      ['Peptide FDR', '1 % (q ≤ 0.01)'],
      ['Cross-link FDR', '5 % (q ≤ 0.05)'],
    ])
    expect(cutoffText(1)).toMatch(/^none/)
  })
})
