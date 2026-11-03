import { describe, expect, it } from 'vitest'
import type { ModificationAnalysis } from '../results/types'
import { deltaMassLabel, massShiftBars, massShiftRows, ptmRows, shiftSummary } from './delta-mass'

const analysis: NonNullable<ModificationAnalysis> = {
  deltaMasses: {
    totalPSMs: 1000,
    modifiedPSMs: 200,
    unmodifiedPSMs: 800,
    meanDeltaMass: 10,
    medianDeltaMass: 15.9949,
    entries: [
      { deltaMass: 15.9949, count: 120, uniquePeptides: 90, chargeStates: 3, percentage: 60, modification: 'Oxidation', known: true },
      { deltaMass: -57.0215, count: 60, uniquePeptides: 50, chargeStates: 2, percentage: 30, modification: '', known: false },
      { deltaMass: 79.9663, count: 20, uniquePeptides: 18, chargeStates: 2, percentage: 10, modification: 'Phospho', known: true },
    ],
  },
  ptms: {
    totalModifiedPSMs: 140,
    unknownModificationPSMs: 60,
    uniqueModifications: 2,
    entries: [
      {
        name: 'Oxidation',
        theoreticalMass: 15.994915,
        observedMass: 15.9949,
        massDeviation: -0.000015,
        count: 120,
        uniquePeptides: 90,
        chargeStates: 3,
        percentage: 85.7,
        targetResidues: 'M',
        residueCounts: { M: 110, W: 10 },
      },
      {
        name: 'Phospho',
        theoreticalMass: 79.966331,
        observedMass: 79.9663,
        massDeviation: 0,
        count: 20,
        uniquePeptides: 18,
        chargeStates: 2,
        percentage: 14.3,
        targetResidues: 'STY',
        residueCounts: {},
      },
    ],
  },
}

describe('deltaMassLabel', () => {
  it('names a known modification and writes an unknown shift as a signed mass with a real minus', () => {
    expect(deltaMassLabel(15.9949, 'Oxidation')).toBe('Oxidation')
    expect(deltaMassLabel(-57.0215, '')).toBe('−57.02')
    expect(deltaMassLabel(42.01, '')).toBe('+42.01')
  })
})

describe('massShiftBars', () => {
  it('orders the shifts by mass and marks the known ones', () => {
    const bars = massShiftBars(analysis)
    expect(bars.map((b) => b.x)).toEqual([-57.0215, 15.9949, 79.9663])
    expect(bars.map((b) => b.count)).toEqual([60, 120, 20])
    expect(bars.map((b) => b.known)).toEqual([false, true, true])
    expect(bars.map((b) => b.label)).toEqual(['−57.02', 'Oxidation', 'Phospho'])
  })
})

describe('massShiftRows', () => {
  it('lists the shifts by PSMs, with their share of the shifted PSMs', () => {
    const rows = massShiftRows(analysis)
    expect(rows.map((r) => r.mass)).toEqual(['+15.9949', '−57.0215', '+79.9663'])
    expect(rows.map((r) => r.psms)).toEqual([120, 60, 20])
    expect(rows.map((r) => r.share)).toEqual(['60.0 %', '30.0 %', '10.0 %'])
    expect(rows.map((r) => r.modification)).toEqual(['Oxidation', null, 'Phospho'])
  })
})

describe('ptmRows', () => {
  it('lists the mapped modifications with their theoretical and observed masses and the residues they can sit on', () => {
    const rows = ptmRows(analysis)
    expect(rows.map((r) => r.name)).toEqual(['Oxidation', 'Phospho'])
    expect(rows[0]).toMatchObject({ theoretical: '+15.9949', observed: '+15.9949', psms: 120, peptides: 90, share: '85.7 %' })
    expect(rows[0].deviation).toBe('−0.015') // mDa
    // the residues the modification can sit on (Unimod), not the residue counts of the peptides: those count every residue
    expect(rows[0].residues).toBe('M')
    expect(rows[1].residues).toBe('STY')
    expect(rows[1].deviation).toBe('0.000')
  })
})

describe('ptmRows peptides', () => {
  it('has no peptide count where the engine reports more peptides than PSMs (it is no peptide count then)', () => {
    const odd: NonNullable<ModificationAnalysis> = {
      ...analysis,
      ptms: { ...analysis.ptms, entries: [{ ...analysis.ptms.entries[0], count: 161, uniquePeptides: 1111 }, analysis.ptms.entries[1]] },
    }
    const rows = ptmRows(odd)
    expect(rows[0].peptides).toBeNull()
    expect(rows[1].peptides).toBe(18)
    // as many peptides as PSMs is possible
    const equal = ptmRows({ ...analysis, ptms: { ...analysis.ptms, entries: [{ ...analysis.ptms.entries[0], count: 90, uniquePeptides: 90 }] } })
    expect(equal[0].peptides).toBe(90)
  })
})

describe('shiftSummary', () => {
  it('says how many PSMs carry a shift and how many are unmodified', () => {
    expect(shiftSummary(analysis)).toEqual({ total: 1000, shifted: 200, unmodified: 800, shareShifted: 0.2, unassigned: 60, mapped: 140, targetsOnly: false })
  })

  it('counts the target PSMs it is given, not the decoys the engine counts', () => {
    // unmodified (|shift| ≤ 0.05 Da), oxidised, phosphorylated, an unknown shift, one without a shift (NaN)
    const shifts = [0.001, -0.05, 15.9951, 15.98, 79.9663, -57.0215, NaN]
    const s = shiftSummary(analysis, shifts)
    expect(s).toEqual({ total: 7, shifted: 4, unmodified: 2, shareShifted: 4 / 7, mapped: 3, unassigned: 1, targetsOnly: true })
    expect(shiftSummary(analysis, [])).toMatchObject({ total: 0, shifted: 0, shareShifted: 0, targetsOnly: true })
  })

  it("maps a shift to an isotope variant ('+1Da') by its base modification's mass, else by its observed mass", () => {
    const variants: NonNullable<ModificationAnalysis> = {
      ...analysis,
      ptms: {
        ...analysis.ptms,
        entries: [
          analysis.ptms.entries[0],
          { ...analysis.ptms.entries[0], name: 'Oxidation+1Da+1Da', theoreticalMass: 0, observedMass: 17.9 },
          { ...analysis.ptms.entries[0], name: 'Unknown thing+1Da', theoreticalMass: 0, observedMass: 31.5 },
        ],
      },
    }
    // 15.9949 + 2 = 17.9949; 17.9 (the observed mean) is too far; 31.51 is near the observed mass of the last
    expect(shiftSummary(variants, [17.99, 17.9, 31.51])).toMatchObject({ shifted: 3, mapped: 2, unassigned: 1 })
  })

  it("reproduces the engine's counts of a real open search (iPRG2015 subset): 4,874 target PSMs of 4,922", async () => {
    // the engine's own counts with the decoys: 4,922 PSMs, 1,898 shifted, 1,162 mapped, 736 not; computing them from
    // all PSMs gives the same, so from the targets alone they are right too
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { parseModificationAnalysis } = await import('./summary')
    const dir = join(__dirname, 'fixtures', 'open-search-shifts')
    const a = parseModificationAnalysis(readFileSync(join(dir, 'DeltaMassStats.tsv'), 'utf8'), readFileSync(join(dir, 'PTMStats.tsv'), 'utf8'))
    const psms = readFileSync(join(dir, 'shifts.tsv'), 'utf8').trim().split('\n').map((l) => l.split('\t'))
    const all = shiftSummary(a, psms.map(([d]) => Number(d)))
    expect(all).toMatchObject({ total: a.deltaMasses.totalPSMs, shifted: a.deltaMasses.modifiedPSMs, mapped: a.ptms.totalModifiedPSMs, unassigned: a.ptms.unknownModificationPSMs })
    const targets = shiftSummary(a, psms.filter(([, decoy]) => decoy === '0').map(([d]) => Number(d)))
    expect(targets).toMatchObject({ total: 4874, shifted: 1852, unmodified: 3022, mapped: 1151, unassigned: 701 })
  })
})
