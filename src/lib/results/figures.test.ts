import { describe, expect, it } from 'vitest'
import type { ProSEMultiSummary } from '../results/types'
import { sampleDesign, sampleTables } from './fixtures'
import { keyFigures, levelRows, levelTotal, proteinsNeeded } from './figures'
import { buildModel } from './model'

const summary = (ms2: number[], proteinFdrApplied = true) =>
  ({
    files: ms2.map((ms2Spectra, i) => ({ path: `f${i}.mzML`, ms2Spectra })),
    proteinFdrApplied,
    psmFdr: 0.01,
    proteinFdr: 0.01,
    decoyString: 'DECOY_',
    openSearch: false,
    modificationAnalysis: null,
  }) as unknown as ProSEMultiSummary

describe('keyFigures', () => {
  it("counts the targets at the search's cutoffs", () => {
    const tables = sampleTables()
    tables.psms.precursorErrorPpm.set([1, -2, 30, 3, -4, 5, NaN, 0.5, 9])
    tables.proteins.group.set([0, 0, 2, 3]) // ALBU and A1AT in one group
    // PSM FDR 1 %: PSMs 0 1 3 4 5 6 7 (q ≤ 0.01), none decoy; protein FDR 0.3 %: proteins 0 and 2
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 0.003 })
    const f = keyFigures(m, summary([20, 15]))
    expect(f.proteinGroups).toBe(2) // group 0 (ALBU) and the contaminant
    expect(f.peptides).toBe(4) // peptides 0–3; 4 is a decoy
    expect(f.psms).toBe(7)
    expect(f.ms2).toBe(35)
    expect(f.spectra).toBe(7)
    expect(f.identifiedShareOfMs2).toBeCloseTo(7 / 35)
    // |error| of PSMs 0 1 3 4 5 7: 1 2 3 4 5 0.5 → median 2.5 (NaN skipped)
    expect(f.medianAbsPpm).toBeCloseTo(2.5)
    expect(f.samples).toBe(2)
    expect(f.conditions).toBe(2)
  })

  it('counts a protein without a group (group -1) as a group of its own', () => {
    const tables = sampleTables()
    tables.proteins.group.set([-1, -1, 7, -1]) // ALBU and A1AT have none, the contaminant is in group 7
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 1, proteinFdr: 1 })
    const f = keyFigures(m, summary([20, 15]))
    expect(f.proteins).toBe(3) // ALBU, A1AT and the contaminant (the decoy is not counted)
    expect(f.proteinGroups).toBe(3) // not 2: the -1 of the first two do not make one group

    tables.proteins.group.set([-1, -1, -1, -1])
    expect(keyFigures(buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 1, proteinFdr: 1 }), summary([20])).proteinGroups).toBe(3)
  })

  it('counts the proteins of one group once, and says how many proteins there are', () => {
    const tables = sampleTables()
    tables.proteins.group.set([4, 4, 4, 3]) // ALBU, A1AT and the contaminant cannot be told apart
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 1, proteinFdr: 1 })
    const f = keyFigures(m, summary([20]))
    expect(f.proteins).toBe(3)
    expect(f.proteinGroups).toBe(1)
  })

  it('takes the share of MS2 from the identified spectra, not the PSMs (co-isolated precursors)', () => {
    const tables = sampleTables()
    // PSMs 0, 1 and 3 (file 0) are three precursors of one spectrum, PSMs 4 and 5 (file 1) two of another; PSM 7
    // (file 1) has the native ID of PSM 0, but in another file
    const shared = 'controllerType=0 controllerNumber=1 scan=17'
    for (const i of [0, 1, 3, 4, 5, 7]) tables.psms.nativeId[i] = i === 4 || i === 5 ? 'scan=99' : shared
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 0.01 })
    const f = keyFigures(m, summary([4, 2]))
    expect(f.psms).toBe(7) // PSMs 0 1 3 4 5 6 7
    expect(f.spectra).toBe(4) // {0 1 3} {4 5} 6 7
    expect(f.identifiedShareOfMs2).toBeCloseTo(4 / 6)
    // never above 100 %: MS2 counts that are too low (a summary of another run)
    expect(keyFigures(m, summary([1, 1])).identifiedShareOfMs2).toBe(1)
  })

  it('counts each PSM without a native ID as a spectrum of its own', () => {
    const tables = sampleTables()
    tables.psms.nativeId.fill('')
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 0.01 })
    expect(keyFigures(m, summary([20, 15])).spectra).toBe(7)
  })

  it('counts the PSMs without a q-value (the PSM FDR was not applied to their file)', () => {
    const tables = sampleTables()
    expect(keyFigures(buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 0.01 }), summary([20, 15])).psmsWithoutFdr).toBe(0)
    // file 1 had no decoy PSM: PSMs 2 4 5 6 7 have no q-value, and count at the search's cutoff (PSM 2 too, now)
    for (const i of [2, 4, 5, 6, 7]) tables.psms.qValue[i] = NaN
    const f = keyFigures(buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 0.01 }), summary([20, 15]))
    expect(f.psms).toBe(8)
    expect(f.psmsWithoutFdr).toBe(5)
  })

  it('has no share without MS2 counts and no error without errors', () => {
    const tables = sampleTables()
    tables.psms.precursorErrorPpm.fill(NaN)
    const m = buildModel(tables, sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 0.01 })
    const f = keyFigures(m, summary([0]))
    expect(f.identifiedShareOfMs2).toBeNull()
    expect(f.medianAbsPpm).toBeNull()
  })
})

describe('levelTotal', () => {
  it("counts a level's rows at the search's cutoff, with or without decoys", () => {
    const m = buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 1 })
    expect(levelTotal(m, 'proteins', false)).toBe(3)
    expect(levelTotal(m, 'proteins', true)).toBe(3) // the decoy protein's only PSM is at q 0.03: no identification
    expect(levelTotal(buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, psmFdr: 0.05, proteinFdr: 1 }), 'proteins', true)).toBe(4)
    expect(levelTotal(m, 'psms', false)).toBe(7)
    expect(levelTotal(m, 'peptides', true)).toBe(4) // the decoy peptide's PSM is at q 0.03
  })
})

describe('levelRows', () => {
  it('is computed once per model, level and decoy setting', () => {
    const m = buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 1 })
    const psms = levelRows(m, 'psms', false)
    expect(levelRows(m, 'psms', false)).toBe(psms)
    expect(levelRows(m, 'psms', true)).not.toBe(psms)
    const other = buildModel(sampleTables(), sampleDesign(), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 1 })
    expect(levelRows(other, 'psms', false)).not.toBe(psms)
    expect(levelRows(other, 'psms', false)).toEqual(psms)
  })
})

describe('proteinsNeeded', () => {
  it('is the number of target proteins a protein FDR needs: q-values are at least 1/(T + 1)', () => {
    expect(proteinsNeeded(0.01)).toBe(99)
    expect(proteinsNeeded(0.05)).toBe(19)
    expect(proteinsNeeded(0.02)).toBe(49)
    expect(proteinsNeeded(1)).toBe(0)
  })
})
