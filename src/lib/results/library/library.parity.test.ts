/// <reference types="node" />
// The port against the real nuxl2dia.py: NuXLDIA's TextExporter rows (fixtures/, README.md there) through the port give
// nuxl2dia.py's library row by row, but for the documented differences: FragmentLossType (nuxl2dia.py: FragmenLossType,
// empty but for nucleotide-shifted ions) and the writing of integers ('3' for its '3.0').

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildLibrary, libraryTsv, LIBRARY_COLUMNS, type LibraryHit } from './library'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

/** A TSV as rows of column → value. */
function table(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = text.split('\n').filter((l) => l !== '')
  const header = lines[0].split('\t')
  return { header, rows: lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, k) => [header[k], v]))) }
}

const none = (s: string) => (s === 'none' || s === '' ? '' : s)

/** The TextExporter rows of a NuXL file as library hits (what read.ts gives of the idXML's hits). */
function hitsOf(text: string, crossLink: boolean): LibraryHit[] {
  return table(text).rows.map((r) => {
    const accessions = r.accessions.split(';')
    return {
      sequence: r.sequence,
      charge: Number(r.charge),
      mz: Number(r.mz),
      rt: Number(r['#rt']),
      ccs: r.IM === undefined || r.IM === '' ? NaN : Number(r.IM),
      crossLink,
      adduct: none(r['NuXL:NA']),
      adductMass: Number(r['NuXL:NA_MASS_z0']),
      site: Number(r['NuXL:best_localization_position']),
      siteScore: Number(r['NuXL:best_localization_score']),
      nuxlScore: Number(r['NuXL:score']),
      accessions,
      decoy: accessions.every((a) => a.trim().toUpperCase().startsWith('DECOY')),
      annotation: r.peak_annotations,
    }
  })
}

const NUMBERS = new Set(['PrecursorCharge', 'AverageExperimentalRetentionTime', 'PrecursorMz', 'FragmentSeriesNumber', 'ProductMz', 'LibraryIntensity', 'FragmentCharge'])

describe('the library against nuxl2dia.py (NuXLDIA, timsTOF EXP1 slice)', () => {
  const hits = [...hitsOf(fixture('EXP1_slice_XLs.unknown'), true), ...hitsOf(fixture('EXP1_slice_peptides.unknown'), false)]
  const library = buildLibrary(hits)
  const ours = table(libraryTsv(library))
  const theirs = table(fixture('EXP1_slice_nuxl2dia.tsv'))

  it('has its columns, in its order, FragmentLossType spelled right', () => {
    expect(theirs.header).toEqual(LIBRARY_COLUMNS.map((c) => (c === 'FragmentLossType' ? 'FragmenLossType' : c)))
    expect(ours.header).toEqual([...LIBRARY_COLUMNS])
  })

  // nuxl2dia.py sorts the peptides by NuXL:score with pandas' default (unstable) sort: of PSMs of one peptide and charge
  // with the same best score it keeps any one; the port the first. Those precursors are compared apart.
  const precursorOf = (r: Record<string, string>) => `${r.ModifiedPeptideSequence}/${r.PrecursorCharge}`
  const tied = new Map<string, number[]>()
  {
    const groups = new Map<string, LibraryHit[]>()
    for (const h of hits.filter((h) => !h.crossLink)) {
      const key = `${h.sequence}/${h.charge}`
      groups.set(key, [...(groups.get(key) ?? []), h])
    }
    for (const group of groups.values()) {
      const best = Math.max(...group.map((h) => h.nuxlScore))
      const top = group.filter((h) => h.nuxlScore === best)
      if (top.length > 1) tied.set(`${buildLibrary(top.slice(0, 1)).precursors[0]?.modified}/${top[0].charge}`, top.map((h) => h.rt))
    }
  }

  it('has its rows, in its order, with its values', () => {
    expect(ours.rows.length + theirs.rows.length).toBeGreaterThan(0)
    expect(library.precursors.length).toBe(new Set(theirs.rows.map(precursorOf)).size)
    const mine = ours.rows.filter((r) => !tied.has(precursorOf(r)))
    const expectedRows = theirs.rows.filter((r) => !tied.has(precursorOf(r)))
    expect(mine.length).toBe(expectedRows.length)
    expect(mine.length).toBeGreaterThan(500)
    mine.forEach((row, k) => {
      const expected = expectedRows[k]
      for (const column of LIBRARY_COLUMNS) {
        const what = `${precursorOf(row)} ${row.Annotation}, ${column}`
        if (column === 'FragmentLossType') {
          // theirs: 'unknown' for a shifted ion, else empty; ours: the same 'unknown', else what the label says
          if (expected.FragmenLossType === 'unknown') expect(row[column], what).toBe('unknown')
          else expect(row[column], what).toMatch(/^(noloss|H2O|NH3|unknown)$/)
        } else if (column === 'PrecursorIonMobility') {
          // (the same formula; the last digit may differ)
          expect(Number(row[column]), what).toBeCloseTo(Number(expected[column]), 12)
        } else if (NUMBERS.has(column)) {
          // (pandas' fast float parser may read a long decimal 1 ulp off where JavaScript rounds it correctly)
          const [a, b] = [Number(row[column]), Number(expected[column])]
          expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(2 * Number.EPSILON * Math.abs(b))
        } else {
          expect(row[column], what).toBe(expected[column])
        }
      }
    })
  })

  it('keeps one of the tied PSMs where nuxl2dia.py keeps another: the first', () => {
    // (here: DDAARANQRLDNM(Oxidation)ATK and FEVKGPK; of the first, nuxl2dia.py keeps the second of the two)
    expect([...tied.keys()]).toEqual(['DDAARANQRLDNM(UniMod:35)ATK/3', 'FEVKGPK/2'])
    for (const [key, rts] of tied) {
      const rtOf = (rows: Record<string, string>[]) => [...new Set(rows.filter((r) => precursorOf(r) === key).map((r) => Number(r.AverageExperimentalRetentionTime)))]
      expect(rtOf(ours.rows)).toEqual([rts[0]])
      expect(rts).toContain(rtOf(theirs.rows)[0])
      expect(rtOf(theirs.rows)).toHaveLength(1)
    }
  })

  it('names the losses that nuxl2dia.py leaves empty', () => {
    const empty = ours.rows.filter((_, k) => theirs.rows[k].FragmenLossType === '')
    const byLoss = (l: string) => empty.filter((r) => r.FragmentLossType === l).map((r) => r.Annotation)
    expect(byLoss('noloss').every((a) => /^[by]\d+\+*$/.test(a))).toBe(true)
    expect(byLoss('H2O').every((a) => /^[by]\d+-H2O1\+*$/.test(a))).toBe(true)
    expect(byLoss('NH3').every((a) => /^[by]\d+-H3N1\+*$/.test(a))).toBe(true)
    // e.g. 'y4-C1H2N1O1+', and what nuxl2dia.py's '+C/+U/+G/+A' rule misses
    expect(byLoss('unknown').every((a) => !/^[by]\d+(-H2O1|-H3N1)?\+*$/.test(a))).toBe(true)
    expect(byLoss('noloss').length).toBeGreaterThan(0)
  })

  it('leaves out what nuxl2dia.py leaves out', () => {
    // (a hit with a target protein too is no decoy: 'DECOY_sp|P46890|YBAE_ECOLI;sp|P02359|RS7_ECOLI' stays)
    expect(library.decoys).toBe(0)
    expect(ours.rows.some((r) => r.ProteinId === 'DECOY_sp|P46890|YBAE_ECOLI;sp|P02359|RS7_ECOLI')).toBe(true)
    expect(library.unlocalized).toBeGreaterThan(0)
    expect(library.crossLinks).toBe(new Set(theirs.rows.filter((r) => r.ModifiedPeptideSequence.includes('[')).map((r) => `${r.ModifiedPeptideSequence}/${r.PrecursorCharge}`)).size)
  })
})
