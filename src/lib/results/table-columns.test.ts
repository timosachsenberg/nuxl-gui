import { describe, expect, it } from 'vitest'
import { input } from '../design/fixtures'
import { resolveDesign } from '../design/model'
import { cutoffs, sampleDesign, sampleTables } from './fixtures'
import { buildModel } from './model'
import { makeTables } from './synthetic'
import { columnSpecs, csvColumns, defaultHidden, visibleSpecs } from './table-columns'

const model = (opts: { rescored?: boolean; psmFdr?: number } = {}) =>
  buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, ...cutoffs, ...opts })
const ids = (specs: { id: string }[]) => specs.map((s) => s.id)

describe('columnSpecs', () => {
  it('proteins: per-sample counts grouped by condition, then "Found in"', () => {
    const specs = columnSpecs(model(), 'proteins', { openSearch: false })
    expect(ids(specs)).toEqual([
      'accession', 'gene', 'description', 'coverage', 'peptides', 'psms',
      'sample:0', 'sample:1', 'foundIn', 'qValue', 'score', 'length', 'group',
    ])
    const samples = specs.filter((s) => s.id.startsWith('sample:'))
    expect(samples.map((s) => [s.group, s.header, s.ariaLabel, s.sortKey, s.csv])).toEqual([
      ['control', '1', 'control 1', 'sample:0', ['sample:0']],
      ['EGF', '1', 'EGF 1', 'sample:1', ['sample:1']],
    ])
    // what shows is what the CSV writes: the gene too
    const gene = specs.find((s) => s.id === 'gene')!
    expect([gene.sortKey, gene.csv]).toEqual(['gene', ['gene']])
  })

  it('says that the protein counts are at the search PSM FDR', () => {
    const specs = columnSpecs(model({ psmFdr: 0.01 }), 'proteins', { openSearch: false })
    for (const id of ['peptides', 'psms']) {
      expect(specs.find((s) => s.id === id)!.title).toBe("Counted at the search's PSM FDR (1 %, q ≤ 0.01)")
    }
    expect(specs.find((s) => s.id === 'sample:0')!.title).toBe("control 1. Counted at the search's PSM FDR (1 %, q ≤ 0.01)")
  })

  it('names the score after the rescoring', () => {
    const score = (rescored: boolean) => columnSpecs(model({ rescored }), 'psms', { openSearch: false }).find((s) => s.id === 'score')!
    expect(score(true).header).toBe('Percolator score')
    expect(score(false).header).toBe('NuXL score')
  })

  it('peptides: the best PSM q-value, counts per sample; PSMs: no sample counts', () => {
    expect(ids(columnSpecs(model(), 'peptides', { openSearch: false }))).toEqual([
      'peptide', 'adduct', 'proteins', 'psms', 'sample:0', 'sample:1', 'foundIn', 'bestQ', 'length',
    ])
    expect(ids(columnSpecs(model(), 'psms', { openSearch: false }))).toEqual([
      'peptide', 'adduct', 'site', 'proteins', 'sample', 'scan', 'charge', 'mz', 'rt', 'precursorError', 'score', 'qValue',
      'pep', 'deltaMass', 'fdrGroup', 'file', 'isotopeError',
    ])
  })

  it('NuXL: the adduct and the site export the cross-link columns', () => {
    const specs = columnSpecs(model(), 'psms', { openSearch: false })
    expect(specs.find((s) => s.id === 'adduct')!.csv).toEqual(['crossLink', 'adduct', 'adductMass', 'nucleotide'])
    expect(specs.find((s) => s.id === 'site')!.csv).toEqual(['site', 'siteScore'])
    expect(columnSpecs(model(), 'peptides', { openSearch: false }).find((s) => s.id === 'adduct')!.csv).toEqual(['adduct', 'crossLink'])
  })

  it('samples without a condition have no group', () => {
    const design = resolveDesign([input('a.mzML'), input('b.mzML')])
    const tables = makeTables({ files: ['a.mzML', 'b.mzML'], proteins: [], peptides: [], psms: [] })
    const m = buildModel(tables, design, { showTechReplicates: false, ...cutoffs })
    const samples = columnSpecs(m, 'peptides', { openSearch: false }).filter((s) => s.id.startsWith('sample:'))
    expect(samples.map((s) => [s.group, s.header])).toEqual([[undefined, 'a'], [undefined, 'b']])
  })
})

describe('defaultHidden', () => {
  it('hides the less common columns, and the mass shift of a closed search', () => {
    const m = model()
    expect(defaultHidden(columnSpecs(m, 'proteins', { openSearch: false }), m)).toEqual(['gene', 'qValue', 'score', 'length', 'group'])
    expect(defaultHidden(columnSpecs(m, 'psms', { openSearch: false }), m)).toEqual(['pep', 'deltaMass', 'fdrGroup', 'file', 'isotopeError'])
    expect(defaultHidden(columnSpecs(m, 'psms', { openSearch: true }), m)).toEqual(['pep', 'fdrGroup', 'file', 'isotopeError'])
  })

  it('shows the gene when the descriptions name one', () => {
    const tables = sampleTables()
    tables.proteins.description[0] = 'Serum albumin OS=Homo sapiens GN=ALB'
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, ...cutoffs })
    expect(defaultHidden(columnSpecs(m, 'proteins', { openSearch: false }), m)).toEqual(['qValue', 'score', 'length', 'group'])
  })
})

describe('visibleSpecs and csvColumns', () => {
  it('leave out hidden columns; "samples" hides all per-sample columns', () => {
    const specs = columnSpecs(model(), 'proteins', { openSearch: false })
    expect(ids(visibleSpecs(specs, ['gene', 'samples', 'qValue', 'score', 'length', 'group']))).toEqual([
      'accession', 'description', 'coverage', 'peptides', 'psms', 'foundIn',
    ])
    expect(csvColumns(visibleSpecs(specs, ['gene', 'qValue', 'score', 'length', 'group']))).toEqual([
      'accession', 'description', 'coverage', 'peptides', 'psms', 'sample:0', 'sample:1', 'foundIn',
    ])
    // every visible column is exported
    expect(csvColumns(visibleSpecs(specs, []))).toEqual(ids(specs))
  })

  it('write what a PSM column shows: the scan as the native ID, RT in seconds, the file', () => {
    const specs = columnSpecs(model(), 'psms', { openSearch: true })
    expect(csvColumns(visibleSpecs(specs, []))).toEqual([
      'peptide', 'crossLink', 'adduct', 'adductMass', 'nucleotide', 'site', 'siteScore', 'proteins', 'sample', 'nativeId',
      'charge', 'mz', 'rt', 'precursorErrorPpm', 'score', 'qValue', 'pep', 'deltaMass', 'fdrGroup', 'file', 'isotopeError',
    ])
  })
})
