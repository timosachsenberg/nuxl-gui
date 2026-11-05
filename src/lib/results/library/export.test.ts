import { describe, expect, it } from 'vitest'
import { buildModel } from '../model'
import { makeTables, syntheticDesign } from '../synthetic'
import { defaultLibraryFdr, exportTexts, libraryExport, libraryFileName, validLibraryFdr } from './export'

describe('the library export', () => {
  it('starts at 1 %, or at the search cutoff where that is tighter', () => {
    expect(defaultLibraryFdr({ psmFdr: 0.05, xlFdr: 0.1 })).toEqual({ peptide: 0.01, xl: 0.01 })
    expect(defaultLibraryFdr({ psmFdr: 0.005, xlFdr: 0.01 })).toEqual({ peptide: 0.005, xl: 0.01 })
  })

  it('takes FDRs above 0 up to the search cutoffs, not looser', () => {
    const m = { psmFdr: 0.05, xlFdr: 0.01 }
    expect(validLibraryFdr(m, { peptide: 0.05, xl: 0.01 })).toBe(true)
    expect(validLibraryFdr(m, { peptide: 0.001, xl: 0.005 })).toBe(true)
    expect(validLibraryFdr(m, { peptide: 0.06, xl: 0.01 })).toBe(false)
    expect(validLibraryFdr(m, { peptide: 0.01, xl: 0.02 })).toBe(false)
    expect(validLibraryFdr(m, { peptide: 0, xl: 0.01 })).toBe(false)
  })

  it('names the file by its FDRs', () => {
    expect(libraryFileName('HeLa', { peptide: 0.01, xl: 0.005 })).toBe('HeLa_library_pep1%_xl0.5%.tsv')
  })

  function model(adductMass: number) {
    const t = makeTables({
      files: ['a.mzML'],
      proteins: [{ accession: 'P1', sequence: 'MKWLSLRAKDIHPK' }],
      peptides: [
        { sequence: 'WLSLR', proteins: [0] },
        { sequence: 'KDIHPK', openms: 'K(NuXL:UC-H3N1)DIHPK', adduct: 'UC-H3N1', proteins: [0] },
      ],
      psms: [
        { peptide: 0, qValue: 0.001, annotation: '200.1,0.5,1,"y2"' },
        { peptide: 1, qValue: 0.001, site: 0, annotation: '200.1,0.5,1,"y2"' },
      ],
    })
    t.psms.xl.siteScore.set([NaN, 0.5])
    t.psms.xl.adductMass.set([0, adductMass])
    return buildModel(t, syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr: 0.01, proteinFdr: 1 })
  }

  it("declares the adducts with OpenNuXL's masses, else their formulas'", () => {
    const fdr = { peptide: 0.01, xl: 0.01 }
    const search = { parameters: { 'NuXL:presets': 'RNA-UV (UCGA)' } }
    expect(libraryExport(model(611.0666), fdr, null, search).mods).toEqual(['--mod CU-H3N1,611.066600'])
    // (no NuXL:NA_MASS_z0: C + U − H2O − NH3)
    const e = libraryExport(model(0), fdr, null, search)
    expect(e.mods).toEqual(['--mod CU-H3N1,612.050610'])
    expect(exportTexts(e).mods).toBe('--mod CU-H3N1,612.050610\n')
    // a preset whose nucleotides it does not know: no line, but named
    expect(libraryExport(model(0), fdr, null, { parameters: { 'NuXL:presets': 'none', 'NuXL:target_nucleotides': ['T=C10H15N2O8P'] } })).toMatchObject({
      mods: [],
      unknownMods: ['CU-H3N1'],
    })
  })

  it("parses a model's annotations once, whatever the FDRs of the next build", () => {
    const m = model(611.0666)
    const search = { parameters: {} }
    const first = libraryExport(m, { peptide: 0.01, xl: 0.01 }, null, search).library.precursors
    const again = libraryExport(m, { peptide: 0.005, xl: 0.01 }, null, search).library.precursors
    expect(again[0].fragments).toBe(first[0].fragments)
  })

  it('has no declarations without cross-links', () => {
    const e = libraryExport(model(0), { peptide: 0.01, xl: 0.01 }, null, { parameters: {} })
    expect(exportTexts({ ...e, mods: [] }).mods).toBe('')
    expect(exportTexts(e).tsv.split('\n')[0]).toContain('FragmentLossType')
  })
})
