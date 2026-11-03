import { describe, expect, it } from 'vitest'
import { distinguishing, entryFacts } from './details'
import type { HistoryEntry } from './history'

// What History says beside a search's name: its database, and what tells it from the searches of the same name.

function entry(id: string, name: string, more: Partial<HistoryEntry> = {}, parameters: Record<string, unknown> = {}): HistoryEntry {
  return {
    id,
    name,
    createdAt: '2026-10-24T10:00:00.000Z',
    appVersion: '0.1.0',
    toolVersion: '3.6.0',
    files: ['XL_1.mzML', 'XL_2.mzML'],
    database: 'Cascade.fasta',
    psms: 120,
    psmFdr: 0.01,
    proteinFdr: 1,
    settings: {
      parameters: { 'NuXL:presets': 'RNA-UV (U)', ...parameters },
      fixedMods: ['Carbamidomethyl (C)'],
      rescore: true,
      contaminants: true,
      presetId: 'nuxl-defaults',
      peptideFdr: 0.01,
      xlFdr: 0.01,
    },
    bytes: 1000,
    error: null,
    ...more,
  }
}

const texts = (map: Map<string, { text: string }[]>, id: string) => map.get(id)!.map((f) => f.text)
const settings = entry('', '').settings!

describe('History details', () => {
  it("says what a search is, with OpenNuXL's defaults for what the record leaves out", () => {
    const facts = entryFacts(entry('1-0', 'XL', {}, { 'fragment:mass_tolerance': 0.5, 'fragment:mass_tolerance_unit': 'Da', 'NuXL:length': 3 }), (id) =>
      id === 'nuxl-defaults' ? 'NuXL defaults' : null,
    )
    expect(facts.map((f) => f.text)).toEqual([
      'Cascade.fasta',
      'NuXL defaults',
      'RNA-UV (U)',
      'Trypsin/P',
      'precursor ±6 ppm',
      'fragment 0.5 Da',
      'peptide FDR 1 %',
      'XL FDR 1 %',
      'Percolator',
      'with cRAP',
      'adducts of up to 3 nucleotides',
    ])
    // a broken folder has none
    expect(entryFacts(entry('2-0', 'x', { error: 'broken', settings: null }))).toEqual([])
    // the default protocol ('none') is no fact; an FDR of 1 filters nothing
    const plain = entryFacts(entry('3-0', 'x', { settings: { ...settings, parameters: {}, xlFdr: 1 } })).map((f) => f.text)
    expect(plain).not.toContain('none')
    expect(plain).toContain('no XL FDR')
  })

  it('tells searches of one name apart by what differs, and shows the database of every search', () => {
    const entries = [
      entry('1-0', 'XL'),
      entry('2-0', 'XL', {}, { 'NuXL:scoring': 'fast' }),
      entry('3-0', 'XL', { settings: { ...settings, xlFdr: 0.05 } }),
      entry('4-0', 'XL', { settings: { ...settings, rescore: false } }),
      entry('5-0', 'other', {}, { 'NuXL:scoring': 'fast' }),
      entry('6-0', 'XL', { error: 'broken', settings: null, database: null, name: null }),
    ]
    const lines = distinguishing(entries)
    expect(texts(lines, '1-0')).toEqual(['Cascade.fasta', 'XL FDR 1 %', 'Percolator'])
    expect(texts(lines, '2-0')).toEqual(['Cascade.fasta', 'XL FDR 1 %', 'Percolator', 'fast scoring'])
    expect(texts(lines, '3-0')).toEqual(['Cascade.fasta', 'XL FDR 5 %', 'Percolator'])
    expect(texts(lines, '4-0')).toEqual(['Cascade.fasta', 'XL FDR 1 %', 'no rescoring'])
    // a name of its own: the database alone
    expect(texts(lines, '5-0')).toEqual(['Cascade.fasta'])
    // a broken folder: nothing
    expect(texts(lines, '6-0')).toEqual([])
  })

  it('says nothing more of searches that differ in nothing (their time tells them apart)', () => {
    const lines = distinguishing([entry('1-0', 'XL'), entry('2-0', 'XL')])
    expect(texts(lines, '1-0')).toEqual(['Cascade.fasta'])
    expect(texts(lines, '2-0')).toEqual(['Cascade.fasta'])
  })

  it('names other parameters plainly', () => {
    const facts = entryFacts(
      entry('1-0', 'x', {}, {
        'modifications:variable': ['Oxidation (M)', 'Phospho (S)'],
        'peptide:missed_cleavages': 1,
        'precursor:mass_tolerance': 10,
        'NuXL:decoys': false,
      }),
    ).map((f) => f.text)
    expect(facts).toContain('precursor ±10 ppm')
    expect(facts).toContain('variable: Oxidation (M), Phospho (S)')
    expect(facts).toContain('1 missed cleavage')
    expect(facts).toContain('NuXL:decoys off')
    // an unknown preset by its id
    expect(entryFacts(entry('1-0', 'x'))[1].text).toBe('preset nuxl-defaults')
    // a record without the FDRs of its settings (an older one): the peptides' from psmFdr
    const old = entryFacts(entry('2-0', 'x', { settings: { parameters: {}, fixedMods: [], rescore: true, contaminants: true } })).map((f) => f.text)
    expect(old).toContain('peptide FDR 1 %')
  })
})
