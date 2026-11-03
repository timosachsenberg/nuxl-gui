// The cross-links in the results model, its filters, key figures, sort order and CSV: peptide PSMs count at the
// peptide FDR (`psmFdr`), cross-link PSMs at the cross-link FDR (`xlFdr`), and the tables filter by kind, adduct and
// nucleotide.
import { describe, expect, it } from 'vitest'
import { csvColumns, columnSpecs } from './table-columns'
import { toCsv } from './csv'
import { keyFigures } from './figures'
import { applyFilters, crossLinkChoices, defaultFilters, initialFilters, sortRows, type FilterState } from './filters'
import { buildModel, peptideCounts, psmCutoff } from './model'
import { makeTables, syntheticDesign } from './synthetic'
import type { ProSEMultiSummary } from './types'

/**
 * Two proteins; peptide 0 linear (P1), 1 a U-H3O4P1 cross-link (P1), 2 a C cross-link (P2), 3 a U cross-link (P2).
 * PSMs and q-values: 0 (pep 0, 0.005), 1 (pep 0, 0.02), 2 (pep 1, 0.03), 3 (pep 1, 0.06), 4 (pep 2, 0.01), 5 (pep 3,
 * 0.04).
 */
function tables() {
  const t = makeTables({
    files: ['a.mzML'],
    proteins: [
      { accession: 'P1', sequence: 'AAAKCCCKDDDK', qValue: NaN },
      { accession: 'P2', sequence: 'EEEKFFFK', qValue: NaN },
    ],
    peptides: [
      { sequence: 'AAAK', proteins: [0] },
      { sequence: 'CCCK', adduct: 'U-H3O4P1', proteins: [0] },
      { sequence: 'EEEK', adduct: 'C', proteins: [1] },
      { sequence: 'FFFK', adduct: 'U', proteins: [1] },
    ],
    psms: [
      { peptide: 0, qValue: 0.005 },
      { peptide: 0, qValue: 0.02 },
      { peptide: 1, qValue: 0.03, site: 3 },
      { peptide: 1, qValue: 0.06, site: 3 },
      { peptide: 2, qValue: 0.01, fdrGroup: 'short_XL' },
      { peptide: 3, qValue: 0.04 },
    ],
  })
  const xl = t.psms.xl
  xl.adductMass.set([0, 0, 226.059, 226.059, 305.041, 324.036])
  xl.siteScore.set([NaN, NaN, 0.93, 0.5, NaN, NaN])
  return t
}

const model = (psmFdr = 0.01, xlFdr = 0.05) =>
  buildModel(tables(), syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr, xlFdr, proteinFdr: 1 })
const at = (m: ReturnType<typeof model>, more: Partial<FilterState> = {}): FilterState => ({
  ...defaultFilters(),
  maxQ: m.psmFdr,
  maxXlQ: m.xlFdr,
  ...more,
})
const list = (rows: Uint32Array) => Array.from(rows)

describe('the two cutoffs', () => {
  it('count a peptide PSM at the peptide FDR and a cross-link PSM at the cross-link FDR', () => {
    const m = model(0.01, 0.05)
    expect([0, 1, 2, 4].map((i) => psmCutoff(m, i))).toEqual([0.01, 0.01, 0.05, 0.05])
    // PSM 1 (peptide, q 0.02) is above 1 %; PSM 2 (cross-link, q 0.03) is within 5 %; PSM 3 (0.06) is not
    expect(list(applyFilters(m, 'psms', at(m)))).toEqual([0, 2, 4, 5])
    expect(Array.from(m.peptide.psms)).toEqual([1, 1, 1, 1])
    expect(m.xlPsms).toBe(3)
    expect(Array.from(m.protein.psms)).toEqual([2, 2])
    expect(Array.from(m.protein.xlPsms)).toEqual([1, 2])
  })

  it('default the cross-link FDR to the peptide FDR', () => {
    const m = buildModel(tables(), syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr: 0.05, proteinFdr: 1 })
    expect(m.xlFdr).toBe(0.05)
    expect(() => buildModel(tables(), syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr: 0.05, xlFdr: 0, proteinFdr: 1 })).toThrow(
      /xlFdr/,
    )
  })

  it('tighten each kind apart, and never loosen it', () => {
    const m = model(0.01, 0.05)
    expect(list(applyFilters(m, 'psms', at(m, { maxXlQ: 0.02 })))).toEqual([0, 4])
    expect(list(applyFilters(m, 'psms', at(m, { maxQ: 0.001 })))).toEqual([2, 4, 5])
    expect(list(applyFilters(m, 'psms', at(m, { maxQ: 1, maxXlQ: 1 })))).toEqual([0, 2, 4, 5])
    // peptides by their best PSM, at the cutoff of their kind
    expect(list(applyFilters(m, 'peptides', at(m)))).toEqual([0, 1, 2, 3])
    expect(list(applyFilters(m, 'peptides', at(m, { maxXlQ: 0.02 })))).toEqual([0, 2])
  })

  it('give the peptide counts at both cutoffs, the same in the cells, the sort order and the CSV', () => {
    const m = model(0.01, 0.05)
    expect(peptideCounts(m, NaN)).toBe(m.peptide)
    const tight = peptideCounts(m, 0.01, 0.035)
    expect(Array.from(tight.psms)).toEqual([1, 1, 1, 0])
    expect(peptideCounts(m, 0.01, 0.035)).toBe(tight) // cached
    const f = at(m, { maxXlQ: 0.035 })
    const rows = applyFilters(m, 'peptides', f)
    expect(list(sortRows(m, 'peptides', rows, 'psms', 'desc', f))).toEqual([0, 1, 2])
    const csv = toCsv(m, 'peptides', rows, ['sequence', 'psms', 'adduct', 'crossLink'], f)
    expect(csv.slice(1, -1).split('\n')).toEqual(['Sequence,PSMs,Adduct,Cross-link', 'AAAK,1,,0', 'CCCK,1,U-H3O4P1,1', 'EEEK,1,C,1'])
  })
})

describe('the kind, adduct and nucleotide filters', () => {
  it('show cross-links or peptides only, on every level', () => {
    const m = model(0.01, 0.05)
    expect(list(applyFilters(m, 'psms', at(m, { kind: 'xl' })))).toEqual([2, 4, 5])
    expect(list(applyFilters(m, 'psms', at(m, { kind: 'peptide' })))).toEqual([0])
    expect(list(applyFilters(m, 'peptides', at(m, { kind: 'xl' })))).toEqual([1, 2, 3])
    expect(list(applyFilters(m, 'peptides', at(m, { kind: 'peptide' })))).toEqual([0])
    // proteins: cross-linked, a cross-link PSM within the cutoff
    expect(list(applyFilters(m, 'proteins', { ...at(m), maxQ: 1, kind: 'xl' }))).toEqual([0, 1])
    const strict = model(0.01, 0.02)
    expect(list(applyFilters(strict, 'proteins', { ...at(strict), maxQ: 1, kind: 'xl' }))).toEqual([1])
    expect(list(applyFilters(strict, 'proteins', { ...at(strict), maxQ: 1, kind: 'peptide' }))).toEqual([0])
  })

  it('filter by adduct and by nucleotide', () => {
    const m = model(0.01, 0.05)
    expect(list(applyFilters(m, 'psms', at(m, { adduct: 'U-H3O4P1' })))).toEqual([2])
    expect(list(applyFilters(m, 'psms', at(m, { nucleotide: 'U' })))).toEqual([2, 5])
    expect(list(applyFilters(m, 'peptides', at(m, { nucleotide: 'U' })))).toEqual([1, 3])
    expect(list(applyFilters(m, 'peptides', at(m, { adduct: 'C' })))).toEqual([2])
    expect(m.peptide.nucleotides).toEqual(['', 'U', 'C', 'U'])
    expect(Array.from(m.peptide.adductMass)).toEqual([NaN, 226.059, 305.041, 324.036])
  })

  it('offer the adducts and nucleotides of the PSMs within the cutoffs, most PSMs first', () => {
    const m = model(0.01, 0.05)
    expect(crossLinkChoices(m)).toEqual({
      adducts: [
        { value: 'C', psms: 1 },
        { value: 'U', psms: 1 },
        { value: 'U-H3O4P1', psms: 1 },
      ],
      nucleotides: [
        { value: 'U', psms: 2 },
        { value: 'C', psms: 1 },
      ],
    })
  })

  it('start the Peptides and PSMs tables with the cross-links, if there are any', () => {
    const m = model(0.01, 0.05)
    expect(initialFilters(m, 'psms')).toMatchObject({ kind: 'xl', maxQ: 0.01, maxXlQ: 0.05, adduct: '', nucleotide: '' })
    expect(initialFilters(m, 'peptides').kind).toBe('xl')
    expect(initialFilters(m, 'proteins').kind).toBe('all')
    const none = model(0.001, 0.001) // no cross-link within 0.1 %
    expect(initialFilters(none, 'psms').kind).toBe('all')
  })
})

describe('the key figures', () => {
  it('count the cross-link PSMs, peptides and proteins next to all of them', () => {
    const m = model(0.01, 0.05)
    const summary = { files: [{ ms2Spectra: 100 }], psmFdr: 0.01 } as unknown as ProSEMultiSummary
    expect(keyFigures(m, summary)).toMatchObject({
      psms: 4,
      xlPsms: 3,
      peptides: 4,
      xlPeptides: 3,
      proteins: 2,
      xlProteins: 2,
      peptideFdr: 0.01,
      xlFdr: 0.05,
    })
  })
})

describe('the cross-link columns', () => {
  it('sort and write the adduct, the site and the FDR group', () => {
    const m = model(1, 1)
    const all = at(m)
    const rows = applyFilters(m, 'psms', all)
    expect(list(sortRows(m, 'psms', rows, 'site', 'asc', all))).toEqual([2, 3, 0, 1, 4, 5]) // unlocalized last
    expect(list(sortRows(m, 'psms', rows, 'adduct', 'asc', all))).toEqual([4, 5, 2, 3, 0, 1]) // none last
    const specs = columnSpecs(m, 'psms').filter((s) => ['peptide', 'adduct', 'site', 'fdrGroup'].includes(s.id))
    const csv = toCsv(m, 'psms', Uint32Array.from([2, 4, 0]), csvColumns(specs), all)
    expect(csv.slice(1, -1).split('\n')).toEqual([
      'Peptide,Cross-link,Adduct,Adduct mass (Da),Nucleotide,Site,Site score,FDR group',
      'CCCK,1,U-H3O4P1,226.059,U,K4,0.93,XL',
      'EEEK,1,C,305.041,C,,,short_XL',
      'AAAK,0,,,,,,peptide',
    ])
  })
})

describe("the peptides' peptide-level q-value", () => {
  /**
   * NuXLFDR filters the peptide PSMs at report:peptideFDR t on their 'peptide q-value' (dropped at t or more) and on
   * their PSM q-value (kept at most t); the cross-links only on the PSM q-value (report:xl_peptidelevel_FDR 1.0).
   * Two peptides of PSM q-value 0.005: one of peptide q-value 0.004, one of 0.01; a cross-link of peptide q-value 0.2.
   */
  function withPeptideQ() {
    const t = makeTables({
      files: ['a.mzML'],
      proteins: [{ accession: 'P1', sequence: 'AAAKCCCKDDDK', qValue: NaN }],
      peptides: [
        { sequence: 'AAAK', proteins: [0] },
        { sequence: 'DDDK', proteins: [0] },
        { sequence: 'CCCK', adduct: 'U', proteins: [0] },
      ],
      psms: [
        { peptide: 0, qValue: 0.005, peptideQValue: 0.004 },
        { peptide: 1, qValue: 0.005, peptideQValue: 0.01 },
        { peptide: 2, qValue: 0.005, peptideQValue: 0.2 },
      ],
    })
    return buildModel(t, syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr: 0.01, xlFdr: 0.01, proteinFdr: 1 })
  }

  it('keeps a peptide PSM at the peptide FDR only below it, as OpenNuXL; a cross-link whatever its own', () => {
    const m = withPeptideQ()
    const f = { ...defaultFilters(), maxQ: 0.01, maxXlQ: 0.01 }
    expect(list(applyFilters(m, 'psms', f))).toEqual([0, 2])
    expect(list(applyFilters(m, 'peptides', f))).toEqual([0, 2])
    expect(Array.from(m.peptide.psms)).toEqual([1, 0, 1])
    expect(Array.from(m.peptide.bestPeptideQ)).toEqual([0.004, 0.01, NaN])
    // a tighter limit applies to both q-values; a looser search cutoff keeps both
    expect(list(applyFilters(m, 'psms', { ...f, maxQ: 0.004 }))).toEqual([2])
    const loose = buildModel(m.tables, syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr: 0.05, xlFdr: 0.01, proteinFdr: 1 })
    expect(list(applyFilters(loose, 'psms', { ...f, maxQ: 0.05 }))).toEqual([0, 1, 2])
  })
})
