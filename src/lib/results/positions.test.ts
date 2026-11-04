// Where peptides and cross-links are in their proteins (positions.ts) and the Start, End, Protein site and Sequence
// columns of the PSM and Peptides tables (columns.ts: sort order, CSV), on hand-made tables and on the screenshots' set.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toCsv } from './csv'
import { applyFilters, defaultFilters, sortRows } from './filters'
import { buildModel, type ResultModel } from './model'
import { candidateSites, firstOccurrence, occurrences, peptideSite, positionText, proteinSites, psmSite, rangeTitle } from './positions'
import { bytesOfRange, FileNotFound, readSearch, type SearchFiles } from './read'
import { makeTables, syntheticDesign } from './synthetic'

// Cas7: AAAK at residues 3–6 and 11–14; GGGK at 7–10
const cas7 = 'MKAAAKGGGKAAAKRR'
const cas5 = 'PPAAAKQQ' // AAAK at 3–6

function model(): ResultModel {
  const t = makeTables({
    files: ['a.mzML'],
    proteins: [
      { accession: 'Cas7', sequence: cas7 },
      { accession: 'sp|P12345|CAS5_ECOLI', sequence: cas5 },
      { accession: 'Unknown', sequence: '' }, // no sequence: positions as recorded
      { accession: 'DECOY_Cas7', sequence: [...cas7].reverse().join(''), decoy: true },
      { accession: 'CON__P00761', sequence: 'IVGGYTCKPP' },
    ],
    peptides: [
      // 0: twice in Cas7, once in Cas5; the adduct on K
      { sequence: 'AAAK', openms: 'AAAK(NuXL:U)', adduct: 'U', mods: [{ position: 3, name: 'U' }], proteins: [{ protein: 0, start: 2 }, { protein: 0, start: 10 }, { protein: 1, start: 2 }] },
      // 1: in a protein without sequence, recorded at 0-based 20
      { sequence: 'LLKR', adduct: 'U', proteins: [{ protein: 2, start: 20 }] },
      // 2: recorded where Cas7 does not have it (GGGK is at 0-based 6)
      { sequence: 'GGGK', proteins: [{ protein: 0, start: 5 }] },
      // 3: a decoy in the reversed Cas7 (RRKAAAKGGGKAAAKM)
      { sequence: 'RRKAAA', decoy: true, proteins: [3] },
      // 4: a contaminant
      { sequence: 'IVGGYTCK', proteins: [4] },
      // 5: no position recorded (start = end = 0, below)
      { sequence: 'MKAA', proteins: [0] },
      // 6: no protein
      { sequence: 'WWWK', proteins: [] },
      // 7: a cross-link whose adduct is not on a residue (not localized)
      { sequence: 'AAAK', openms: 'AAAK', adduct: 'U-H2O', proteins: [{ protein: 0, start: 2 }, { protein: 1, start: 2 }] },
    ],
    psms: [
      { peptide: 0, site: 3 },
      { peptide: 7 }, // not localized
      { peptide: 1, site: 2 },
      { peptide: 3, site: 2 },
      { peptide: 4 },
      { peptide: 5 },
      { peptide: 6 },
      { peptide: 2 },
    ],
  })
  t.peptides.start[t.peptides.proteinOffsets[5]] = 0
  t.peptides.end[t.peptides.proteinOffsets[5]] = 0
  t.psms.xl.siteSequence[1] = 'aAAk'
  // the decoy PSM is a cross-link too
  t.psms.xl.isXL[3] = 1
  return buildModel(t, syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr: 1, proteinFdr: 1 })
}

describe('positions of a peptide in its proteins', () => {
  const m = model()

  it('gives every occurrence, 1-based and inclusive, in the order of the Proteins column', () => {
    expect(occurrences(m, 0)).toEqual([
      { protein: 0, start: 3, end: 6, exact: true },
      { protein: 0, start: 11, end: 14, exact: true },
      { protein: 1, start: 3, end: 6, exact: true },
    ])
    expect(Array.from(m.peptide.proteins[0])).toEqual([0, 0, 1])
    expect(firstOccurrence(m, 0)).toEqual({ protein: 0, start: 3, end: 6, exact: true })
    expect(rangeTitle(m, 0)).toBe('Cas7 3–6; Cas7 11–14; P12345 3–6')
    // checked by hand: the residues are the peptide's
    for (const o of occurrences(m, 0)) expect(m.tables.proteins.sequence[o.protein].slice(o.start - 1, o.end)).toBe('AAAK')
  })

  it('marks a position the sequence does not confirm, and has none where nothing was recorded', () => {
    expect(occurrences(m, 1)).toEqual([{ protein: 2, start: 21, end: 24, exact: false }]) // no sequence
    expect(occurrences(m, 2)).toEqual([{ protein: 0, start: 6, end: 9, exact: false }]) // not there
    expect(positionText(21, false)).toBe('21?')
    expect(positionText(3, true)).toBe('3')
    expect(positionText(NaN, false)).toBe('')
    expect(rangeTitle(m, 1)).toMatch(/^Unknown 21–24\?\n\?: as the search recorded it/)
    expect(occurrences(m, 5)).toEqual([{ protein: 0, start: NaN, end: NaN, exact: false }])
    expect(rangeTitle(m, 5)).toBe('Cas7 position unknown')
    expect(occurrences(m, 6)).toEqual([])
    expect(firstOccurrence(m, 6)).toBeNull()
  })

  it('places decoys in their decoy protein and contaminants in theirs', () => {
    expect(occurrences(m, 3)).toEqual([{ protein: 3, start: 1, end: 6, exact: true }])
    expect(occurrences(m, 4)).toEqual([{ protein: 4, start: 1, end: 8, exact: true }])
  })

  it('puts the cross-linked residue at start + site in each occurrence', () => {
    expect(psmSite(m, 0)).toBe(3)
    expect(proteinSites(m, 0, 3)).toEqual([
      { protein: 0, residue: 'K', position: 6, exact: true },
      { protein: 0, residue: 'K', position: 14, exact: true },
      { protein: 1, residue: 'K', position: 6, exact: true },
    ])
    // without the protein's sequence: the peptide's residue, the position as recorded
    expect(proteinSites(m, 1, 2)).toEqual([{ protein: 2, residue: 'K', position: 23, exact: false }])
    expect(proteinSites(m, 5, 0)).toEqual([null])
    expect(proteinSites(m, 0, -1)).toEqual([])
    expect(proteinSites(m, 0, 4)).toEqual([]) // beyond the peptide
    expect(psmSite(m, 1)).toBe(-1)
    expect(candidateSites('aAAk', 'AAAK')).toEqual([0, 3])
    expect(candidateSites('aAA', 'AAAK')).toEqual([])
  })

  it('takes a peptide row’s site from where its sequence has the adduct', () => {
    expect(peptideSite(m, 0)).toBe(3)
    expect(peptideSite(m, 7)).toBe(-1) // the adduct is not in the sequence
    expect(peptideSite(m, 2)).toBe(-1) // no cross-link
  })
})

const csvLines = (csv: string) => csv.slice(1, -1).split('\n')

describe('the position columns', () => {
  const m = model()
  const all = { ...defaultFilters(), showDecoys: true, kind: 'all' as const }

  it('write every occurrence to the CSV, aligned with the Proteins column', () => {
    const rows = applyFilters(m, 'psms', all)
    const lines = csvLines(toCsv(m, 'psms', rows, ['sequence', 'proteins', 'proteinStart', 'proteinEnd', 'proteinSite'], all))
    expect(lines[0]).toBe('Sequence,Proteins,Protein start,Protein end,Protein site')
    expect(lines.slice(1)).toEqual([
      'AAAK,Cas7;Cas7;sp|P12345|CAS5_ECOLI,3;11;3,6;14;6,Cas7 K6;Cas7 K14;sp|P12345|CAS5_ECOLI K6',
      'AAAK,Cas7;sp|P12345|CAS5_ECOLI,3;3,6;6,', // not localized
      'LLKR,Unknown,21?,24?,Unknown K23?',
      'RRKAAA,DECOY_Cas7,1,6,DECOY_Cas7 K3',
      'IVGGYTCK,CON__P00761,1,8,',
      'MKAA,Cas7,,,',
      'WWWK,,,,',
      'GGGK,Cas7,6?,9?,',
    ])
    const peptides = csvLines(toCsv(m, 'peptides', applyFilters(m, 'peptides', all), ['peptide', 'proteinStart', 'proteinSite'], all))
    expect(peptides[0]).toBe('Peptide,Protein start,Protein site')
    expect(peptides).toContain('AAAK,3;11;3,Cas7 K6;Cas7 K14;sp|P12345|CAS5_ECOLI K6')
  })

  it('sort by the first occurrence, rows without position last', () => {
    const rows = applyFilters(m, 'psms', all)
    const peptideOf = (sorted: Uint32Array) => Array.from(sorted, (i) => m.tables.peptides.sequence[m.tables.psms.peptide[i]])
    expect(peptideOf(sortRows(m, 'psms', rows, 'proteinStart', 'asc', all))).toEqual(['RRKAAA', 'IVGGYTCK', 'AAAK', 'AAAK', 'GGGK', 'LLKR', 'MKAA', 'WWWK'])
    expect(peptideOf(sortRows(m, 'psms', rows, 'proteinEnd', 'desc', all))).toEqual(['LLKR', 'GGGK', 'IVGGYTCK', 'AAAK', 'AAAK', 'RRKAAA', 'MKAA', 'WWWK'])
    // the protein site: by the accession as shown, then the position
    expect(peptideOf(sortRows(m, 'psms', rows, 'proteinSite', 'asc', all)).slice(0, 3)).toEqual(['AAAK', 'RRKAAA', 'LLKR'])
    expect(peptideOf(sortRows(m, 'psms', rows, 'sequence', 'asc', all))[0]).toBe('AAAK')
  })

  it('find a peptide by its stripped sequence', () => {
    const found = applyFilters(m, 'psms', { ...all, text: 'gggk' })
    expect(Array.from(found, (i) => m.tables.psms.peptide[i])).toEqual([2])
  })
})

// ---- the screenshots' set, checked against its FASTA by hand

const screens = join(__dirname, 'fixtures/screens')
const files: SearchFiles = async (file, range) => {
  if (/^\d+__.*\.mzML$/.test(file) || file.startsWith('/')) throw new FileNotFound(file)
  try {
    return bytesOfRange(new Uint8Array(readFileSync(join(screens, file))), range)
  } catch {
    throw new FileNotFound(file)
  }
}

describe('positions in the screenshots’ set', () => {
  it('agree with the FASTA', async () => {
    const t = (await readSearch(files)).tables
    const m = buildModel(t, syntheticDesign(t.files.map((f) => f.split('/').pop()!)), { showTechReplicates: false, psmFdr: 1, proteinFdr: 1 })
    const all = { ...defaultFilters(), showDecoys: true, kind: 'all' as const }
    const csv = csvLines(toCsv(m, 'psms', applyFilters(m, 'psms', all), ['peptide', 'proteinStart', 'proteinEnd', 'site', 'proteinSite'], all))
    // read off the FASTA: Cas7 has AEADNLDDKK at 129–138 (its K137 the cross-linked one), Cse2 AWQQLDNGSCAQIR at
    // 13–26 (C22), Cas5 YTPYLGR at 142–148 (Y145), Cse1 ALYTFAEGFK at 395–404 (F403)
    expect(csv).toContain('AEADNLDDK[+306.0253]K,129,138,K9,Cas7 K137')
    expect(csv).toContain('AWQQLDNGSC[+324.0359]AQIR,13,26,C10,Cse2 C22')
    expect(csv).toContain('YTPY[+653.0884]LGR,142,148,Y4,Cas5 Y145')
    expect(csv).toContain('ALYTFAEGF[+324.0359]K,395,404,F9,Cse1 F403')
    // a cross-link that is not localized has no protein site
    expect(csv).toContain('VEDVHPISERPQYFSGDGK,136,154,,')
    const fasta = readFileSync(join(screens, 'database.fasta'), 'utf8')
    const cas7 = /^>Cas7 .*\n([A-Z\n]+)/m.exec(fasta)![1].replaceAll('\n', '')
    expect(cas7.slice(128, 138)).toBe('AEADNLDDKK')
    expect(cas7[136]).toBe('K')
  })
})
