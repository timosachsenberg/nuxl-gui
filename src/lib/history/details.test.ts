import { describe, expect, it } from 'vitest'
import { distinguishing, entryFacts } from './details'
import type { HistoryEntry } from './history'

// What History says beside a search's name: its database, and what tells it from the searches of the same name.

function entry(id: string, name: string, more: Partial<HistoryEntry> = {}, parameters: Record<string, unknown> = {}): HistoryEntry {
  return {
    id,
    name,
    createdAt: '2026-10-24T10:00:00.000Z',
    appVersion: '0.1.3',
    toolVersion: '3.7.0',
    files: ['Ecoli_1.mzML', 'Ecoli_2.mzML'],
    database: 'Ecoli.fasta',
    psms: 120,
    psmFdr: 0.01,
    proteinFdr: 0.01,
    settings: {
      parameters: { enzyme: 'Trypsin/P', 'FDR:PSM': 0.01, ...parameters },
      fixedMods: ['Carbamidomethyl (C)'],
      rescore: true,
      peptdeep: false,
      contaminants: true,
      presetId: 'orbitrap-hcd-tryptic',
    },
    bytes: 1000,
    error: null,
    ...more,
  }
}

const texts = (map: Map<string, { text: string }[]>, id: string) => map.get(id)!.map((f) => f.text)

describe('History details', () => {
  it('says what a search is, with ProSE defaults for what the record leaves out', () => {
    const facts = entryFacts(entry('1-0', 'Ecoli', {}, { 'fragment:mass_tolerance': 0.5, 'fragment:mass_tolerance_unit': 'Da', 'chimeric:enabled': true }), (id) =>
      id === 'orbitrap-hcd-tryptic' ? 'Orbitrap HCD · tryptic' : null,
    )
    expect(facts.map((f) => f.text)).toEqual([
      'Ecoli.fasta',
      'Orbitrap HCD · tryptic',
      'Trypsin/P',
      'precursor ±10 ppm',
      'fragment 0.5 Da',
      'PSM FDR 1 %',
      'protein FDR 1 %',
      'Percolator',
      'with cRAP',
      'co-isolated precursors',
    ])
    // a broken folder has none
    expect(entryFacts(entry('2-0', 'x', { error: 'broken', settings: null }))).toEqual([])
    // a search without decoys has no FDR (its cutoffs are 1)
    const noDecoys = entryFacts(entry('3-0', 'x', { psmFdr: 1, proteinFdr: 1 }, { decoys: 'ignore' })).map((f) => f.text)
    expect(noDecoys).toContain('no PSM FDR')
    expect(noDecoys).toContain('no protein FDR')
  })

  it('tells searches of one name apart by what differs, and shows the database of every search', () => {
    const entries = [
      entry('1-0', 'Ecoli'),
      entry('2-0', 'Ecoli', {}, { 'chimeric:enabled': true }),
      entry('3-0', 'Ecoli', { proteinFdr: 1 }, { 'database:chunk_size': 2000 }),
      entry('4-0', 'Ecoli', { settings: { ...entry('', '').settings, peptdeep: true } }),
      entry('5-0', 'other', {}, { 'chimeric:enabled': true }),
      entry('6-0', 'Ecoli', { error: 'broken', settings: null, database: null, name: null }),
    ]
    const lines = distinguishing(entries)
    expect(texts(lines, '1-0')).toEqual(['Ecoli.fasta', 'protein FDR 1 %', 'Percolator'])
    expect(texts(lines, '2-0')).toEqual(['Ecoli.fasta', 'protein FDR 1 %', 'Percolator', 'co-isolated precursors'])
    expect(texts(lines, '3-0')).toEqual(['Ecoli.fasta', 'no protein FDR', 'Percolator', 'database chunks of 2000'])
    expect(texts(lines, '4-0')).toEqual(['Ecoli.fasta', 'protein FDR 1 %', 'Percolator with PeptDeep'])
    // a name of its own: the database alone
    expect(texts(lines, '5-0')).toEqual(['Ecoli.fasta'])
    // a broken folder: nothing
    expect(texts(lines, '6-0')).toEqual([])
  })

  it('says nothing more of searches that differ in nothing (their time tells them apart)', () => {
    const lines = distinguishing([entry('1-0', 'Ecoli'), entry('2-0', 'Ecoli')])
    expect(texts(lines, '1-0')).toEqual(['Ecoli.fasta'])
    expect(texts(lines, '2-0')).toEqual(['Ecoli.fasta'])
  })

  it('names other parameters plainly', () => {
    const facts = entryFacts(
      entry('1-0', 'x', {}, {
        'modifications:variable': ['Oxidation (M)', 'Phospho (S)'],
        'peptide:missed_cleavages': 1,
        'precursor:mass_tolerance_lower': 5,
        'precursor:mass_tolerance_upper': 20,
        decoys: 'ignore',
        'peptdeep:enabled': false,
      }),
    ).map((f) => f.text)
    expect(facts).toContain('precursor −5/+20 ppm')
    expect(facts).toContain('variable: Oxidation (M), Phospho (S)')
    expect(facts).toContain('1 missed cleavage')
    expect(facts).toContain('decoys ignore')
    expect(facts).toContain('peptdeep:enabled off')
    // an unknown preset by its id
    expect(entryFacts(entry('1-0', 'x'))[1].text).toBe('preset orbitrap-hcd-tryptic')
  })
})
