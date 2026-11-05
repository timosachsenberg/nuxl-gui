import { describe, expect, it } from 'vitest'
import { toTsv } from './csv'
import { ACCEPTED, NONE, REJECTED, cleanNote, countMarks, curationChanged, passesCuration, peptideMarks, readCuration, writeCuration } from './curation'
import { cutoffs, sampleDesign, sampleTables } from './fixtures'
import { applyFilters, defaultFilters, type FilterState } from './filters'
import { buildModel } from './model'
import { makeTables } from './synthetic'

const model = (curation?: Uint8Array) => buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, ...cutoffs, curation })
const all: FilterState = { ...defaultFilters(), showDecoys: true }

describe('curation', () => {
  it('filters by the marks', () => {
    expect([NONE, ACCEPTED, REJECTED].map((m) => passesCuration(m, 'any'))).toEqual([true, true, true])
    expect([NONE, ACCEPTED, REJECTED].map((m) => passesCuration(m, 'curated'))).toEqual([false, true, true])
    expect([NONE, ACCEPTED, REJECTED].map((m) => passesCuration(m, 'accepted'))).toEqual([false, true, false])
    expect([NONE, ACCEPTED, REJECTED].map((m) => passesCuration(m, 'rejected'))).toEqual([false, false, true])
    expect([NONE, ACCEPTED, REJECTED].map((m) => passesCuration(m, 'uncurated'))).toEqual([true, false, false])

    const marks = new Uint8Array(9)
    marks[1] = ACCEPTED
    marks[4] = REJECTED
    const m = model(marks)
    expect(Array.from(applyFilters(m, 'psms', { ...all, curation: 'curated' }))).toEqual([1, 4])
    expect(Array.from(applyFilters(m, 'psms', { ...all, curation: 'accepted' }))).toEqual([1])
    expect(Array.from(applyFilters(m, 'psms', { ...all, curation: 'rejected' }))).toEqual([4])
    expect(applyFilters(m, 'psms', { ...all, curation: 'uncurated' })).toHaveLength(7)
    // the proteins do not filter by it
    expect(applyFilters(m, 'proteins', { ...all, curation: 'accepted' })).toEqual(applyFilters(m, 'proteins', all))
    expect(countMarks(marks)).toEqual({ accepted: 1, rejected: 1 })
  })

  it('names each PSM by file, spectrum, peptide, adduct and charge, so that the marks survive another row order', () => {
    const marks = new Uint8Array(9)
    marks[0] = ACCEPTED
    marks[7] = REJECTED
    const text = writeCuration(model(), marks)
    const file = JSON.parse(text)
    expect(file).toEqual({
      schema: 1,
      psms: [
        { file: 'ctrl_a.mzML', spectrum: 'scan=1', peptide: 'M[Oxidation]KWVTF', adduct: '', charge: 2, mark: 'accepted' },
        { file: 'egf_a.mzML', spectrum: 'scan=8', peptide: 'IVGGYT', adduct: '', charge: 2, mark: 'rejected' },
      ],
    })
    expect(Array.from(readCuration(model(), text).marks)).toEqual(Array.from(marks))

    // the same PSMs in another order: the marks follow them
    const reversed = makeTables({
      files: ['ctrl_a.mzML', 'egf_a.mzML'],
      proteins: [{ accession: 'P1', sequence: 'MKWVTFIVGGYT' }],
      peptides: [
        { sequence: 'IVGGYT', proteins: [0] },
        {
          sequence: 'MKWVTF',
          proforma: 'M[Oxidation]KWVTF',
          mods: [{ position: 0, name: 'Oxidation', unimod: 35, mass: 15.9949 }],
          proteins: [0],
        },
      ],
      psms: [
        { peptide: 0, file: 1, nativeId: 'scan=8' },
        { peptide: 1, file: 0, nativeId: 'scan=1' },
        { peptide: 1, file: 0, nativeId: 'scan=2' },
      ],
    })
    const other = buildModel(reversed, sampleDesign(), { showTechReplicates: false, ...cutoffs })
    const read = readCuration(other, text)
    expect(Array.from(read.marks)).toEqual([REJECTED, ACCEPTED, NONE])
    expect(read.unmatched).toEqual([])
  })

  it('tells apart the PSMs of one spectrum and peptide with another adduct', () => {
    const tables = makeTables({
      files: ['ctrl_a.mzML', 'egf_a.mzML'],
      proteins: [{ accession: 'P1', sequence: 'PEPTIDEK' }],
      peptides: [
        { sequence: 'PEPTIDEK', adduct: 'U', proteins: [0] },
        { sequence: 'PEPTIDEK', adduct: 'U-H2O1', proteins: [0] },
      ],
      psms: [
        { peptide: 0, file: 0, nativeId: 'scan=5' },
        { peptide: 1, file: 0, nativeId: 'scan=5' },
      ],
    })
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, ...cutoffs })
    const text = writeCuration(m, Uint8Array.from([ACCEPTED, REJECTED]))
    expect(JSON.parse(text).psms.map((p: { adduct: string; mark: string }) => [p.adduct, p.mark])).toEqual([
      ['U', 'accepted'],
      ['U-H2O1', 'rejected'],
    ])
    expect(Array.from(readCuration(m, text).marks)).toEqual([ACCEPTED, REJECTED])
  })

  it('keeps what names no PSM of the result, and refuses what is not a curation', () => {
    const stranger = { file: 'x.mzML', spectrum: 'scan=99', peptide: 'PEPTIDE', adduct: 'U', charge: 3, mark: 'accepted' }
    const text = JSON.stringify({ schema: 1, psms: [stranger, { file: 'ctrl_a.mzML', mark: 'accepted' }, 7] })
    const { marks, unmatched } = readCuration(model(), text)
    expect(countMarks(marks)).toEqual({ accepted: 0, rejected: 0 })
    expect(unmatched).toEqual([stranger])
    expect(JSON.parse(writeCuration(model(), marks, new Map(), unmatched)).psms).toEqual([stranger])

    expect(() => readCuration(model(), '{')).toThrow('not valid JSON')
    expect(() => readCuration(model(), '[]')).toThrow('not a curation')
    expect(() => readCuration(model(), '{"schema":2,"psms":[]}')).toThrow('not a curation')
  })

  it('is a column of the PSM exports', () => {
    const marks = new Uint8Array(9)
    marks[1] = ACCEPTED
    marks[3] = REJECTED
    const tsv = toTsv(model(marks), 'psms', Uint32Array.from([1, 3, 0]), ['peptide', 'nativeId', 'charge', 'curation'], all)
    expect(tsv).toBe(
      'Peptide\tSpectrum\tCharge\tCuration\n' +
        'M[Oxidation]KWVTF\tscan=2\t2\taccepted\n' +
        'TFISLL\tscan=4\t2\trejected\n' +
        'M[Oxidation]KWVTF\tscan=1\t2\t\n',
    )
  })
})

describe('toTsv', () => {
  it('writes no byte order mark, never quotes, and puts a space for a tab or line break', () => {
    const tables = makeTables({
      files: ['ctrl_a.mzML', 'egf_a.mzML'],
      proteins: [{ accession: 'P1', description: 'one\ttwo, "three"\nfour', sequence: 'PEPTIDEK' }],
      peptides: [{ sequence: 'PEPTIDEK', proteins: [0] }],
      psms: [{ peptide: 0, file: 0 }],
    })
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, ...cutoffs })
    expect(toTsv(m, 'proteins', Uint32Array.from([0]), ['accession', 'description', 'psms'], all)).toBe(
      'Accession\tDescription\tPSMs\nP1\tone two, "three" four\t1\n',
    )
  })
})

describe('notes and the peptides', () => {
  it('keeps a note with or without a mark, one line', () => {
    const marks = new Uint8Array(9)
    marks[0] = ACCEPTED
    const notes = new Map([
      [0, 'clear y ions'],
      [2, 'check the site'],
    ])
    const text = writeCuration(model(), marks, notes)
    const psms = JSON.parse(text).psms
    expect(psms.map((p: { spectrum: string; mark?: string; note?: string }) => [p.spectrum, p.mark, p.note])).toEqual([
      ['scan=1', 'accepted', 'clear y ions'],
      ['scan=3', undefined, 'check the site'],
    ])
    const read = readCuration(model(), text)
    expect(read.marks[0]).toBe(ACCEPTED)
    expect(read.marks[2]).toBe(NONE)
    expect([...read.notes]).toEqual([...notes])
    expect(cleanNote('  two\nlines\tand a tab ')).toBe('two lines and a tab')
    // in the exports
    const m = model(marks)
    m.curationNotes.set(0, 'clear y ions')
    expect(toTsv(m, 'psms', Uint32Array.from([0, 1]), ['nativeId', 'curation', 'curationNote'], all)).toBe(
      'Spectrum\tCuration\tCuration note\nscan=1\taccepted\tclear y ions\nscan=2\t\t\n',
    )
  })

  it('counts the curated PSMs of each peptide and filters the peptides by them', () => {
    const marks = new Uint8Array(9)
    marks[0] = ACCEPTED // peptide 0
    marks[2] = REJECTED // peptide 0
    marks[4] = REJECTED // peptide 2
    const m = model(marks)
    const pm = peptideMarks(m)
    expect(Array.from(pm.accepted)).toEqual([1, 0, 0, 0, 0])
    expect(Array.from(pm.rejected)).toEqual([1, 0, 1, 0, 0])
    expect(Array.from(applyFilters(m, 'peptides', { ...all, curation: 'accepted' }))).toEqual([0])
    expect(Array.from(applyFilters(m, 'peptides', { ...all, curation: 'rejected' }))).toEqual([0, 2])
    expect(Array.from(applyFilters(m, 'peptides', { ...all, curation: 'curated' }))).toEqual([0, 2])
    expect(Array.from(applyFilters(m, 'peptides', { ...all, curation: 'uncurated' }))).toEqual([1, 3, 4])
    expect(toTsv(m, 'peptides', Uint32Array.from([0]), ['peptide', 'acceptedPsms', 'rejectedPsms'], all)).toBe(
      'Peptide\tAccepted PSMs\tRejected PSMs\nM[Oxidation]KWVTF\t1\t1\n',
    )
    // a change in place counts once announced
    marks[1] = ACCEPTED
    curationChanged()
    expect(peptideMarks(m).accepted[0]).toBe(2)
  })
})
