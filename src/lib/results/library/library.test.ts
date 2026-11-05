/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildModel } from '../model'
import { bytesOfRange, FileNotFound, readSearch, type SearchFiles } from '../read'
import { makeTables, syntheticDesign } from '../synthetic'
import { buildLibrary, libraryHits, libraryTsv, LIBRARY_COLUMNS, type LibraryHit } from './library'

const Y = '200.1,0.5,1,"y2"|300.2,1.0,1,"y3"'

/** A cross-link hit (override what a test needs). */
const xl = (more: Partial<LibraryHit> = {}): LibraryHit => ({
  sequence: 'KDIHPK',
  charge: 2,
  mz: 522.2,
  rt: 900,
  ccs: NaN,
  crossLink: true,
  adduct: 'C-H3N1',
  adductMass: 306.0253,
  site: 0,
  siteScore: 0.5,
  nuxlScore: 1,
  accessions: ['sp|P0A7M9|RL31_ECOLI'],
  decoy: false,
  annotation: Y,
  ...more,
})
const peptide = (more: Partial<LibraryHit> = {}): LibraryHit =>
  xl({ sequence: 'WLSLR', crossLink: false, adduct: '', adductMass: NaN, site: -1, siteScore: NaN, ...more })

describe('the library', () => {
  it('leaves out decoys and the cross-links that are not localized (score 0 or none)', () => {
    const lib = buildLibrary([xl({ decoy: true }), xl({ siteScore: 0 }), xl({ siteScore: NaN, site: -1 }), xl({ sequence: 'AAK', siteScore: 1e-9 })])
    expect(lib).toMatchObject({ decoys: 1, unlocalized: 2, crossLinks: 1, peptides: 0 })
    expect(lib.precursors.map((p) => p.modified)).toEqual(['A[C-H3N1]AK'])
  })

  it("keeps a cross-link on an oxidised residue apart from the plain one, the adduct's mass its own (OpenNuXL's 'NuXL:U-H2O1~Oxidation')", () => {
    const lib = buildLibrary([
      xl({ sequence: 'PEPM(NuXL:U-H2O1~Oxidation)K', adduct: 'U-H2O1', adductMass: 306.025305, site: 3, siteScore: 0.9 }),
      xl({ sequence: 'PEPM(NuXL:U-H2O1)K', adduct: 'U-H2O1', adductMass: 306.025305, site: 3, siteScore: 0.5 }),
    ])
    expect(lib.precursors.map((p) => p.modified)).toEqual(['PEP[U-H2O1]M(UniMod:35)K', 'PEPM[U-H2O1]K'])
    expect([...lib.adducts]).toEqual([['U-H2O1', 306.025305]])
  })

  it('parses an annotation by the fragments function it is given (a cache)', () => {
    const seen: string[] = []
    const lib = buildLibrary([xl()], null, (a) => (seen.push(a), [{ type: 'y', ordinal: 2, charge: 1, mz: 200.1, intensity: 1, label: 'y2', loss: 'noloss' }]))
    expect(seen).toEqual([Y])
    expect(lib.fragments).toBe(1)
  })

  it('keeps one cross-link per peptide, adduct and charge: the best localization, then the best NuXL score', () => {
    const hits = [
      xl({ siteScore: 0.4, nuxlScore: 9, rt: 1 }),
      xl({ siteScore: 0.9, nuxlScore: 1, rt: 2, site: 1 }),
      xl({ siteScore: 0.9, nuxlScore: 2, rt: 3 }),
      xl({ adduct: 'U', rt: 4 }),
      xl({ charge: 3, rt: 5 }),
    ]
    expect(buildLibrary(hits).precursors.map((p) => [p.modified, p.charge, p.rt])).toEqual([
      ['K[C-H3N1]DIHPK', 2, 3],
      ['K[U]DIHPK', 2, 4],
      ['K[C-H3N1]DIHPK', 3, 5],
    ])
    // OpenNuXL's sequence with the adduct at another residue is the same peptide
    const other = xl({ sequence: 'KD(NuXL:C-H3N1)IHPK', site: 1, siteScore: 0.95, nuxlScore: 0, rt: 6 })
    expect(buildLibrary([...hits, other]).precursors.map((p) => [p.modified, p.charge, p.rt])).toEqual([
      ['KD[C-H3N1]IHPK', 2, 6],
      ['K[U]DIHPK', 2, 4],
      ['K[C-H3N1]DIHPK', 3, 5],
    ])
  })

  it('keeps one peptide per modified peptide and charge, the best NuXL score; the first of equal ones', () => {
    const lib = buildLibrary([
      peptide({ nuxlScore: 1, rt: 1 }),
      peptide({ nuxlScore: 3, rt: 2 }),
      peptide({ nuxlScore: 3, rt: 3 }),
      peptide({ sequence: 'WM(Oxidation)SLR', rt: 4 }),
      peptide({ charge: 3, nuxlScore: NaN, rt: 5 }),
    ])
    expect(lib.precursors.map((p) => [p.modified, p.charge, p.rt])).toEqual([
      ['WLSLR', 2, 2],
      ['WM(UniMod:35)SLR', 2, 4],
      ['WLSLR', 3, 5],
    ])
  })

  it('has the cross-links first (by localization score), then the peptides (by NuXL score)', () => {
    const lib = buildLibrary([peptide({ nuxlScore: 5 }), xl({ siteScore: 0.2, sequence: 'AK' }), xl({ siteScore: 0.8 }), peptide({ sequence: 'PEPK', nuxlScore: 9 })])
    expect(lib.precursors.map((p) => p.plain)).toEqual(['KDIHPK', 'AK', 'PEPK', 'WLSLR'])
  })

  it('leaves out a precursor without b or y fragments', () => {
    const lib = buildLibrary([peptide({ annotation: '110.07,0.2,1,"iH+"' }), peptide({ sequence: 'AK', annotation: '' })])
    expect(lib).toMatchObject({ precursors: [], withoutFragments: 2, fragments: 0 })
  })

  it("collects the adducts in the brackets with OpenNuXL's masses", () => {
    const lib = buildLibrary([xl({ adduct: 'UC-H3N1', adductMass: 611.07 }), xl({ sequence: 'AK', adduct: 'U', adductMass: NaN }), xl({ sequence: 'PK', adduct: 'U', adductMass: 324.04 })])
    expect([...lib.adducts]).toEqual([
      ['CU-H3N1', 611.07],
      ['U', 324.04],
    ])
  })

  it('converts the CCS to 1/K0 and joins the accessions, each once', () => {
    const [p] = buildLibrary([xl({ ccs: 339.687425785256, mz: 522.236040273212, accessions: ['A', 'B', 'A'] })]).precursors
    expect(p.ionMobility).toBeGreaterThan(0.5)
    expect(p.proteins).toBe('A;B')
  })
})

describe("the library's TSV", () => {
  it('has the columns, one row per fragment, empty fields for none, LF line ends and no BOM', () => {
    const tsv = libraryTsv(buildLibrary([xl({ annotation: '200.1,0.5,1,"y2"|300.2,1.0,1,"b3-H2O1+"' })]))
    const lines = tsv.split('\n')
    expect(tsv.charCodeAt(0)).not.toBe(0xfeff)
    expect(tsv).not.toContain('\r')
    expect(lines[0]).toBe(LIBRARY_COLUMNS.join('\t'))
    expect(lines[0].split('\t')).toContain('FragmentLossType')
    expect(lines.slice(1)).toEqual([
      'K[C-H3N1]DIHPK\t2\t900\t\tKDIHPK\t522.2\tsp|P0A7M9|RL31_ECOLI\ty2\t2\t200.1\t0.5\t1\ty\t\tnoloss',
      'K[C-H3N1]DIHPK\t2\t900\t\tKDIHPK\t522.2\tsp|P0A7M9|RL31_ECOLI\tb3-H2O1+\t3\t300.2\t1\t1\tb\t\tH2O',
      '',
    ])
  })

  it('writes the iRT of a fit', () => {
    const tsv = libraryTsv(buildLibrary([xl()], { slope: 0.1, intercept: -50, points: 10 }))
    expect(tsv.split('\n')[1].split('\t')[13]).toBe('40')
  })
})

describe("the library's PSMs", () => {
  /** Three peptides: a peptide (0), a cross-link (1) and one of a decoy protein (2). */
  function model() {
    const t = makeTables({
      files: ['a.mzML'],
      proteins: [
        { accession: 'P1', sequence: 'MKWLSLRAKDIHPK' },
        { accession: 'DECOY_P2', sequence: 'PEPTIDEK', decoy: true },
      ],
      peptides: [
        { sequence: 'WLSLR', proteins: [0] },
        { sequence: 'KDIHPK', openms: 'K(NuXL:C-H3N1)DIHPK', adduct: 'C-H3N1', proteins: [0] },
        { sequence: 'PEPTIDEK', proteins: [1] },
      ],
      psms: [
        { peptide: 0, qValue: 0.005, peptideQValue: 0.004, annotation: Y },
        { peptide: 0, qValue: 0.005, peptideQValue: 0.02, annotation: Y },
        { peptide: 1, qValue: 0.009, site: 0, annotation: Y },
        { peptide: 1, qValue: 0.03, site: 0, annotation: Y },
        { peptide: 2, qValue: 0.001, annotation: Y },
      ],
    })
    t.psms.xl.siteScore.set([NaN, NaN, 0.7, 0.7, NaN])
    t.psms.xl.nuxlScore.set([3, 4, 5, 6, 7])
    t.psms.xl.ccs.set([NaN, NaN, 340, 340, NaN])
    t.psms.xl.adductMass.set([0, 0, 306.0253, 306.0253, 0])
    return buildModel(t, syntheticDesign(['a.mzML']), { showTechReplicates: false, psmFdr: 0.05, xlFdr: 0.05, proteinFdr: 1 })
  }

  it("are those within the export's FDRs, a peptide PSM by its peptide-level q-value too", () => {
    const hits = libraryHits(model(), { peptide: 0.01, xl: 0.01 })
    expect(hits.map((h) => [h.sequence, h.nuxlScore])).toEqual([
      ['WLSLR', 3],
      ['K(NuXL:C-H3N1)DIHPK', 5],
      ['PEPTIDEK', 7],
    ])
    expect(libraryHits(model(), { peptide: 0.05, xl: 0.05 })).toHaveLength(5)
  })

  it("have the PSMs' facts; a hit of decoy proteins only is a decoy", () => {
    const hits = libraryHits(model(), { peptide: 0.01, xl: 0.01 })
    expect(hits[1]).toMatchObject({ crossLink: true, adduct: 'C-H3N1', adductMass: 306.0253, site: 0, siteScore: 0.7, ccs: 340, accessions: ['P1'], decoy: false })
    expect(hits[0]).toMatchObject({ crossLink: false, adductMass: NaN, decoy: false })
    expect(hits[2]).toMatchObject({ accessions: ['DECOY_P2'], decoy: true })
    expect(buildLibrary(hits)).toMatchObject({ peptides: 1, crossLinks: 1, decoys: 1 })
  })
})

describe('the library of OpenNuXL outputs (the example search: the adduct in the sequence)', () => {
  const fixtures = join(__dirname, '../fixtures/example')
  const files: SearchFiles = async (name, range) => {
    try {
      return bytesOfRange(new Uint8Array(readFileSync(join(fixtures, name))), range)
    } catch {
      throw new FileNotFound(name)
    }
  }

  it('has each localized cross-link once, its adduct in brackets, never twice', async () => {
    const r = await readSearch(files)
    const m = buildModel(r.tables, syntheticDesign(['OpenNuXL_1_input.mzML']), { showTechReplicates: false, psmFdr: 1, xlFdr: 1, proteinFdr: 1 })
    const lib = buildLibrary(libraryHits(m, { peptide: 1, xl: 1 }))
    expect(lib.crossLinks).toBeGreaterThan(5)
    const xls = lib.precursors.filter((p) => p.crossLink)
    for (const p of xls) {
      expect(p.modified, p.modified).not.toContain('NuXL:')
      expect(p.modified.match(/\[/g), p.modified).toHaveLength(1)
      expect(p.adduct, p.modified).not.toBe('')
    }
    expect(xls.map((p) => p.modified)).toContain('AEADNLDDK[U-H3O4P1]K')
    // the masses are OpenNuXL's
    expect(lib.adducts.get('U-H3O4P1')).toBeCloseTo(226.058973319, 9)
    // a cross-link of localization score 0 (VEDVHPISERPQYFSGDGK's) is left out
    expect(lib.unlocalized).toBeGreaterThan(0)
    // the NuXL score, not Percolator's
    expect(libraryHits(m, { peptide: 1, xl: 1 }).every((h) => Number.isFinite(h.nuxlScore))).toBe(true)
    expect(libraryTsv(lib).split('\n').length).toBe(lib.fragments + 2)
  })
})
