/// <reference types="node" />
// The results reader on search folders as the shim leaves them (fixtures/<case>/, made by scripts/results-fixtures.mjs
// from OpenNuXL's own test outputs): example (one input, peptides and cross-links), runs (three inputs, one without
// decoys and one that did not finish), empty (two inputs without PSMs); the input mzML is the app's example
// (src-tauri/resources/example), as it is and as an indexed, zlib-compressed copy (fixtures/spectra).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { bytesOfRange, countTargetPsms, FileNotFound, readSearch, type ByteRange, type SearchFiles, type SearchResult } from './read'
import { spectrumIndex, SpectrumError } from './mzml'

const fixtures = join(__dirname, 'fixtures')
const PLAIN = join(__dirname, '../../../src-tauri/resources/example/OpenNuXL_1_input.mzML')
const INDEXED = join(fixtures, 'spectra/OpenNuXL_1_input.indexed.mzML')

type Served = Uint8Array | string | Error | null
/** A file of `case` (or the one `override` gives: bytes, text, a rejection, null for none). */
interface Folder {
  files: SearchFiles
  /** the names and ranges asked for */
  asked: { name: string; range?: ByteRange }[]
}

/**
 * The folder of fixture `name` as the `files` contract has it. The inputs' links (`<n>__<name>`) are `mzml` (the plain
 * or indexed example; null: not there); absolute paths do not exist.
 */
function folder(name: string, { mzml = 'indexed', override = {} }: { mzml?: 'indexed' | 'plain' | null; override?: Record<string, Served> } = {}): Folder {
  const asked: Folder['asked'] = []
  const files: SearchFiles = async (file, range) => {
    asked.push({ name: file, range })
    let served: Served | undefined = override[file]
    if (served === undefined) {
      if (/^\d+__.*\.mzML$/.test(file)) served = mzml === null ? null : new Uint8Array(readFileSync(mzml === 'plain' ? PLAIN : INDEXED))
      else if (file.startsWith('/')) served = null
      else {
        try {
          served = new Uint8Array(readFileSync(join(fixtures, name, file)))
        } catch {
          served = null
        }
      }
    }
    if (served === null) throw new FileNotFound(file)
    if (typeof served !== 'string' && !(served instanceof Uint8Array)) throw served
    return bytesOfRange(typeof served === 'string' ? new TextEncoder().encode(served) : served, range)
  }
  return { files, asked }
}

const text = (path: string) => readFileSync(join(fixtures, path), 'utf8')
const XLS = 'nuxl/1__OpenNuXL_1_input_1.0000_XLs.idXML'
const PEPTIDES = 'nuxl/1__OpenNuXL_1_input_0.0000_peptides.idXML'
const OUTPUTS = 'nuxl/1__OpenNuXL_1_input.outputs.json'

let example: Promise<SearchResult> | null = null
const readExample = () => (example ??= readSearch(folder('example').files))

/** The PSM row of spectrum `id`. */
const rowOf = (r: SearchResult, id: string) => {
  const row = r.tables.psms.nativeId.indexOf(id)
  expect(row, id).toBeGreaterThanOrEqual(0)
  return row
}

describe('readSearch: the example', () => {
  test('one PSM row per spectrum: the peptides, then the cross-links; targets only', async () => {
    const { tables, warnings, proteinsSaved } = await readExample()
    const { psms } = tables
    expect(warnings).toEqual([])
    expect(tables.files).toEqual(['/data/OpenNuXL_1_input.mzML'])
    expect(psms.count).toBe(19)
    expect(new Set(psms.nativeId).size).toBe(19)
    expect(Array.from(psms.xl.isXL)).toEqual([...new Array(5).fill(0), ...new Array(14).fill(1)])
    expect(Array.from(psms.decoy).every((d) => d === 0)).toBe(true)
    expect(psms.xl.fdrGroup.slice(0, 5)).toEqual(new Array(5).fill('peptide'))
    expect(psms.xl.fdrGroup.slice(5)).toEqual(new Array(14).fill('XL'))
    expect(tables.peptides.count).toBe(19)
    expect(tables.proteins.count).toBe(5)
    // (History writes proteins.fasta: the descriptions came from database.fasta)
    expect(proteinsSaved).toBe(false)
  })

  test("a PSM's values: m/z, RT, charge, NuXL's score, its q-value, isotope and precursor error", async () => {
    const { psms } = (await readExample()).tables
    const i = rowOf(await readExample(), 'spectrum=9')
    expect(psms.mz[i]).toBe(712.782836914062955)
    expect(psms.rt[i]).toBe(17.7875061035156)
    expect(psms.charge[i]).toBe(2)
    expect(psms.score[i]).toBe(66.026290893554688)
    expect(psms.qValue[i]).toBe(9.772700882348042e-7)
    expect(psms.pep[i]).toBeNaN()
    expect(psms.isotopeError[i]).toBe(0)
    // OpenNuXL's precursor_mz_error_ppm agrees with CalcMass: (712.7828 − 672.7993) / 672.7993
    expect(psms.precursorErrorPpm[i]).toBe(5.942857274219292e4)
    expect(psms.deltaMass[i]).toBeNaN()
  })

  test("the cross-link: adduct, its mass, nucleotide, site and its score, NuXL's localization and annotation", async () => {
    const r = await readExample()
    const { xl } = r.tables.psms
    const i = rowOf(r, 'spectrum=9')
    expect([xl.isXL[i], xl.adduct[i], xl.adductMass[i], xl.nucleotide[i], xl.adductLength[i]]).toEqual([1, 'U-H3O4P1', 226.058973319000017, 'U', 1])
    expect([xl.site[i], xl.siteScore[i], xl.siteSequence[i]]).toEqual([8, 4.120850563049316, 'AEADNLDDkK'])
    expect(xl.annotation[i].startsWith('112.050621032714844,0.028104400262237,1,"MI:C\'+"|')).toBe(true)
    // a cross-link OpenNuXL did not localize: its adduct, no site, and its peptide without the modification
    const u = rowOf(r, 'spectrum=5')
    expect([xl.isXL[u], xl.adduct[u], xl.site[u], xl.siteScore[u], xl.siteSequence[u]]).toEqual([1, 'UU-H3O4P1', -1, NaN, ''])
    expect(r.tables.peptides.openms[r.tables.psms.peptide[u]]).toBe('VEDVHPISERPQYFSGDGK')
    // a peptide: no adduct (NuXL:NA 'none', NuXL:NT '?')
    const p = rowOf(r, 'spectrum=11')
    expect([xl.isXL[p], xl.adduct[p], xl.adductMass[p], xl.nucleotide[p], xl.site[p], xl.fdrGroup[p]]).toEqual([0, '', 0, '', -1, 'peptide'])
  })

  test('peptides: the adduct as a modification at its site, by its mass of modification_definitions; Unimod ones by name', async () => {
    const r = await readExample()
    const t = r.tables.peptides
    const k = r.tables.psms.peptide[rowOf(r, 'spectrum=9')]
    expect([t.openms[k], t.sequence[k], t.proforma[k], t.adduct[k], t.isXL[k]]).toEqual(['AEADNLDDK(NuXL:U-H3O4P1)K', 'AEADNLDDKK', 'AEADNLDDK[+226.0590]K', 'U-H3O4P1', 1])
    const mods = (k: number) =>
      Array.from({ length: t.modOffsets[k + 1] - t.modOffsets[k] }, (_, j) => {
        const m = t.modOffsets[k] + j
        return [t.modPosition[m], t.modName[m], t.modUnimod[m], t.modMass[m]]
      })
    expect(mods(k)).toEqual([[8, 'U-H3O4P1', -1, 226.05897331900002]])
    const ox = r.tables.psms.peptide[rowOf(r, 'spectrum=16')]
    expect([t.openms[ox], t.proforma[ox], t.adduct[ox]]).toEqual(['M(Oxidation)VFCLSAGK', 'M[Oxidation]VFCLSAGK', ''])
    expect(mods(ox)).toEqual([[0, 'Oxidation', 35, 15.994915]])
    const two = r.tables.psms.peptide[rowOf(r, 'spectrum=19')]
    expect([t.proforma[two], ...mods(two)]).toEqual(['AWQQLDNGSC[+532.0843]AQIR', [9, 'UU-H3O4P1', -1, 532.0842781599]])
    expect(Array.from(t.decoy).every((d) => d === 0)).toBe(true)
  })

  test("the q-values are the filtered files' scores: by target-decoy competition per group, NuXL's tie-break for cross-links", async () => {
    const r = await readExample()
    const { psms } = r.tables
    const q = (id: string) => psms.qValue[rowOf(r, id)]
    // the peptides: the decoy FDKAGEHVASGR (18.26) above YTPYLGR (15.44) and VPLIKEAEQIAWLQR (17.29)
    expect([q('spectrum=1'), q('spectrum=15'), q('spectrum=11'), q('spectrum=16'), q('spectrum=12')]).toEqual([0.2, 0.2, 0, 0, 0])
    // the cross-links have no decoy: 0, plus at most 1e-5 the lower the score
    const rows = psms.nativeId.map((_, i) => i).filter((i) => psms.xl.isXL[i])
    for (const i of rows) expect(psms.qValue[i]).toBeLessThanOrEqual(1e-5)
    const byScore = [...rows].sort((a, b) => psms.score[b] - psms.score[a])
    expect(psms.qValue[byScore[0]]).toBe(0)
    for (let k = 1; k < byScore.length; k++) expect(psms.qValue[byScore[k]]).toBeGreaterThanOrEqual(psms.qValue[byScore[k - 1]])
  })

  test('the features are the extra_features of the run, NuXL:score among them', async () => {
    const { psms } = (await readExample()).tables
    const names = psms.featureNames
    expect(names.length).toBe(43)
    expect(names.slice(0, 3)).toEqual(['missed_cleavages', 'NuXL:mass_error_p', 'NuXL:err'])
    const j = names.indexOf('NuXL:score')
    for (let i = 0; i < psms.count; i++) expect(psms.features[i * names.length + j]).toBe(psms.score[i])
    expect(psms.features.length).toBe(psms.count * names.length)
  })

  test("proteins: the hits' ProteinHits with their sequences, the FASTA's descriptions, the peptides' positions", async () => {
    const r = await readExample()
    const p = r.tables.proteins
    expect(p.accession).toEqual(['Cas7', 'Cse2', 'Cas6e', 'Cas5', 'Cse1'])
    expect(p.description[0]).toBe('CRISPR system Cascade subunit CasC OS=Escherichia coli (strain K12) GN=casC')
    expect(p.sequence[0].startsWith('MSNFINIHVLISHSPSCLNRDD')).toBe(true)
    expect(Array.from(p.decoy)).toEqual([0, 0, 0, 0, 0])
    expect(Array.from(p.qValue).every(Number.isNaN)).toBe(true)
    expect(Array.from(p.group)).toEqual([0, 1, 2, 3, 4])
    const t = r.tables.peptides
    const k = r.tables.psms.peptide[rowOf(r, 'spectrum=9')]
    const ref = t.proteinOffsets[k]
    expect([t.proteinOffsets[k + 1] - ref, p.accession[t.protein[ref]], t.start[ref], t.end[ref]]).toEqual([1, 'Cas7', 128, 138])
    expect(p.sequence[0].slice(128, 138)).toBe('AEADNLDDKK')
    // a protein's score: the best of its PSMs
    expect(p.score[0]).toBe(Math.max(...r.tables.psms.score.filter((_, i) => r.tables.peptides.protein[r.tables.peptides.proteinOffsets[r.tables.psms.peptide[i]]] === 0)))
  })

  test('the summary: per file its PSMs within the FDRs and Percolator; the NuXL extra', async () => {
    const { summary, nuxl } = await readExample()
    expect(summary.files).toEqual([
      {
        path: '/data/OpenNuXL_1_input.mzML',
        status: 'EXECUTION_OK',
        ms2Spectra: 0,
        // 3 peptide PSMs at q ≤ 0.01 and 14 cross-links
        targetPSMs: 17,
        decoyPSMs: 0,
        percolator: { applied: false, skipped: 'Too few PSMs for score recalibration. Skipped.', warning: null },
        peptdeepNce: null,
        precursorError: null,
        fragmentError: null,
        secondsSearch: 1.5,
        psmFdrApplied: true,
      },
    ])
    expect(summary).toMatchObject({ psmFdr: 0.01, proteinFdrApplied: false, openSearch: false, modificationAnalysis: null, decoyString: 'DECOY_' })
    expect(summary.search).toMatchObject({ enzyme: 'Trypsin/P', databaseFile: '/home/sachsenb/Development/OpenMS/src/tests/topp/OpenNuXL_1_input.fasta', secondsTotal: 1.5 })
    expect(nuxl).toEqual({
      xlFdr: 0.01,
      peptideFdr: 0.01,
      percolator: [false],
      percolatorScores: false,
      notes: [['Too few PSMs for score recalibration. Skipped.']],
    })
    expect(await countTargetPsms(folder('example').files)).toBe(17)
  })
})

describe('readSearch: Percolator, the precursor error, the FDR group', () => {
  /**
   * The example with the cross-links' file changed by `edit` (and the peptides' file by `editPeptides`) and
   * outputs.json saying Percolator ran.
   */
  const percolated = (edit: (xls: string) => string, editPeptides?: (peptides: string) => string) =>
    readSearch(
      folder('example', {
        override: {
          [XLS]: edit(text(`example/${XLS}`)),
          ...(editPeptides ? { [PEPTIDES]: editPeptides(text(`example/${PEPTIDES}`)) } : {}),
          [OUTPUTS]: JSON.stringify({ ...JSON.parse(text(`example/${OUTPUTS}`)), percolator: true, notes: [] }),
        },
      }).files,
    )
  const withParams = (xls: string, params: (n: number) => string) => {
    let n = 0
    return xls.replace(/\t\t\t<\/PeptideHit>\n/g, () => `${params(n++)}\t\t\t</PeptideHit>\n`)
  }

  const svmAndPep = (offset: number) => (xls: string) =>
    withParams(
      xls,
      (n) => `\t\t\t\t<UserParam type="float" name="svm_score" value="${(n + offset) / 10}"/>\n\t\t\t\t<UserParam type="float" name="MS:1001493" value="${(n + offset) / 100}"/>\n`,
    )

  test("a rescored run: Percolator's svm score (svm_score, as NuXLFDR keeps it) and PEP (MS:1001493)", async () => {
    const r = await percolated(svmAndPep(0), svmAndPep(100))
    const { psms } = r.tables
    // the cross-links (rows 5 ..) and the peptides (rows 0 .. 4) rescored
    expect(Array.from(psms.score.subarray(5, 8))).toEqual([0, 0.1, 0.2])
    expect(Array.from(psms.pep.subarray(5, 8))).toEqual([0, 0.01, 0.02])
    expect(psms.score[0]).toBe(10)
    expect(psms.pep[0]).toBe(1)
    expect(r.summary.files[0].percolator).toEqual({ applied: true, skipped: null, warning: null })
    expect(r.nuxl.percolator).toEqual([true])
    expect(r.nuxl.percolatorScores).toBe(true)
  })

  test("Percolator's scores for only some PSMs: NuXL's score for all of them, one scale", async () => {
    const plain = await readExample()
    // the cross-links' file rescored, the peptides' not
    const r = await percolated(svmAndPep(0))
    const { psms } = r.tables
    expect(r.nuxl.percolatorScores).toBe(false)
    expect(Array.from(psms.score)).toEqual(Array.from(plain.tables.psms.score))
    expect(Array.from(r.tables.proteins.score)).toEqual(Array.from(plain.tables.proteins.score))
    // Percolator's PEP stays where it is
    expect(Array.from(psms.pep.subarray(5, 8))).toEqual([0, 0.01, 0.02])
  })

  test("OpenNuXL's precursor error unless it disagrees with the masses; NuXL:fdr_group as written", async () => {
    const r = await percolated((xls) =>
      xls
        .replace('name="precursor_mz_error_ppm" value="5.942857274219292e04"', 'name="precursor_mz_error_ppm" value="1.5"')
        .replace('name="NuXL:fdr_group" value="XL"', 'name="NuXL:fdr_group" value="short_XL"'),
    )
    const { psms } = r.tables
    const i = rowOf(r, 'spectrum=9')
    // from CalcMass and the isotope error 0
    const calc = 672.79933282252091
    expect(psms.precursorErrorPpm[i]).toBeCloseTo(((712.782836914062955 - calc) / calc) * 1e6, 6)
    expect(psms.xl.fdrGroup[i]).toBe('short_XL')
  })
})

describe('readSearch: several inputs', () => {
  test('the inputs in order; one without decoys (every q-value 0); one whose run did not finish', async () => {
    const r = await readSearch(folder('runs').files)
    const { psms } = r.tables
    expect(r.tables.files).toEqual(['/data/OpenNuXL_1_input.mzML', '/data/no_decoys.mzML', '/data/unfinished.mzML'])
    expect(psms.count).toBe(39)
    expect(Array.from(psms.file.subarray(0, 19)).every((f) => f === 0)).toBe(true)
    expect(Array.from(psms.file.subarray(19)).every((f) => f === 1)).toBe(true)
    // OpenNuXL_1 has no decoys: FalseDiscoveryRate gives every target q-value 0 (plus the tie-break)
    for (let i = 19; i < 39; i++) expect(psms.qValue[i]).toBeLessThanOrEqual(1e-5)
    // its run (NuXL:decoys false) has another adduct of the same peptide: a peptide row per adduct
    const keys = new Set(r.tables.peptides.openms.map((o, k) => `${o} ${r.tables.peptides.adduct[k]}`))
    expect(keys.size).toBe(r.tables.peptides.count)
    expect(r.warnings).toEqual(['unfinished.mzML: its search did not finish (the folder has no nuxl/3__unfinished.outputs.json), so it has no PSMs.'])
    expect(r.summary.files.map((f) => [f.status, f.targetPSMs, f.psmFdrApplied, f.percolator?.applied ?? null])).toEqual([
      ['EXECUTION_OK', 17, true, false],
      ['EXECUTION_OK', 20, true, false],
      ['UNKNOWN_ERROR', 0, null, null],
    ])
    expect(r.summary.search.secondsTotal).toBe(4)
    expect(r.nuxl.notes[2]).toEqual([])
    expect(r.nuxl.percolator).toEqual([false, false, false])
    expect(await countTargetPsms(folder('runs').files)).toBe(37)
  })

  test('a search without PSMs reads as an empty result', async () => {
    const r = await readSearch(folder('empty').files)
    expect([r.tables.psms.count, r.tables.peptides.count, r.tables.proteins.count]).toEqual([0, 0, 0])
    expect(r.tables.psms.xl.adduct).toEqual([])
    expect(r.proteinsSaved).toBe(true)
    expect(r.warnings).toEqual([])
    expect(r.summary.files.map((f) => f.targetPSMs)).toEqual([0, 0])
  })

  test('the preset: from search.json, else the first command line of nuxl.log', async () => {
    const record = JSON.stringify({ settings: { parameters: { 'NuXL:presets': 'RNA-UV (U)' } } })
    expect((await readSearch(folder('example', { override: { 'search.json': record } }).files)).nuxl.preset).toBe('RNA-UV (U)')
    const log = "$ OpenNuXL -in 1__a.mzML -NuXL:presets 'RNA-UV (UCGA)' -NuXL:length 2\nProgress of 'loading'\n"
    expect((await readSearch(folder('example', { override: { 'nuxl.log': log } }).files)).nuxl.preset).toBe('RNA-UV (UCGA)')
    const bare = '$ OpenNuXL -in a.mzML -NuXL:presets DNA-UV -threads 4\n'
    expect((await readSearch(folder('example', { override: { 'nuxl.log': bare } }).files)).nuxl.preset).toBe('DNA-UV')
    expect('preset' in (await readExample()).nuxl).toBe(false)
  })
})

describe('readSearch: the FASTA', () => {
  test('proteins.fasta first: the search need not write it', async () => {
    const own = '>Cas7 the identified Cas7\nMSNF\n'
    const r = await readSearch(folder('example', { override: { 'proteins.fasta': own } }).files)
    expect(r.proteinsSaved).toBe(true)
    expect(r.tables.proteins.description[0]).toBe('the identified Cas7')
  })

  test("then database.fasta, then the user's FASTA (database.json); none: a warning", async () => {
    const user = folder('example', { override: { 'database.fasta': null, 'database.json': JSON.stringify({ path: '/home/me/cascade.fasta' }), '/home/me/cascade.fasta': '>Cse2 from the user\nMADE\n' } })
    const r = await readSearch(user.files)
    expect(r.tables.proteins.description[1]).toBe('from the user')
    expect(r.proteinsSaved).toBe(false)
    const none = await readSearch(folder('example', { override: { 'database.fasta': null } }).files)
    expect(none.warnings).toEqual(['The protein descriptions are not available: none of proteins.fasta (not found), database.fasta (not found) could be read.'])
    // (the sequences are the idXML's)
    expect(none.tables.proteins.sequence[0].length).toBeGreaterThan(300)
  })
})

describe('readSearch: broken folders name the file', () => {
  const broken = (override: Record<string, Served>) => readSearch(folder('example', { override }).files)

  test('a missing or broken inputs.json', async () => {
    await expect(broken({ 'inputs.json': null })).rejects.toThrow('inputs.json: inputs.json does not exist.')
    await expect(broken({ 'inputs.json': '{"a": 1}' })).rejects.toThrow('inputs.json: it is not a list of the searched files')
  })

  test('a broken outputs.json', async () => {
    await expect(broken({ [OUTPUTS]: '{' })).rejects.toThrow(`${OUTPUTS}: it is not valid JSON`)
    await expect(broken({ [OUTPUTS]: '{"fdr": {"peptide": 2, "xl": 0.01}}' })).rejects.toThrow(`${OUTPUTS}: its fdr.peptide is not a fraction`)
  })

  test('a truncated or foreign idXML', async () => {
    const xls = text(`example/${XLS}`)
    await expect(broken({ [XLS]: xls.slice(0, xls.length / 2) })).rejects.toThrow(new RegExp(`^${XLS}: the file ends inside`))
    await expect(broken({ [PEPTIDES]: '<mzML></mzML>' })).rejects.toThrow(`${PEPTIDES}: it is not an idXML file`)
    await expect(broken({ [XLS]: xls.replace('sequence="AEADNLDDK(NuXL:U-H3O4P1)K"', 'sequence="AEADNLDDK(NuXL:U-H3O4P1K"') })).rejects.toThrow(
      `${XLS}: the peptide of spectrum spectrum=9 cannot be read`,
    )
  })

  test("a peptide PSM counts at the peptide FDR only with its 'peptide q-value' below it too, as NuXLFDR filters", async () => {
    const peptides = text(`example/${PEPTIDES}`)
    // the filtered files carry FalseDiscoveryRate's peptide-level q-value on every hit
    const { tables } = await readExample()
    const p = tables.psms.xl.isXL.indexOf(0)
    expect(tables.psms.xl.peptideQValue[p]).toBe(tables.psms.qValue[p])
    // MATSGMMTELGK at PSM q-value 0, its peptide-level one 0.01: OpenNuXL at report:peptideFDR 0.01 drops it
    const at = peptides.indexOf('sequence="MATSGMMTELGK"')
    const changed = peptides.slice(0, at) + peptides.slice(at).replace('name="peptide q-value" value="0.0"', 'name="peptide q-value" value="0.01"')
    const r = await broken({ [PEPTIDES]: changed })
    expect(r.summary.files[0].targetPSMs).toBe(16)
    expect(await countTargetPsms(folder('example', { override: { [PEPTIDES]: changed } }).files)).toBe(16)
    // the cross-links' is no filter (report:xl_peptidelevel_FDR 1.0)
    const xls = text(`example/${XLS}`).replaceAll(/name="peptide q-value" value="[^"]*"/g, 'name="peptide q-value" value="0.5"')
    expect((await broken({ [XLS]: xls })).summary.files[0].targetPSMs).toBe(17)
  })

  test('a file that outputs.json names but is missing: its PSMs are left out, with a warning', async () => {
    const r = await broken({ [PEPTIDES]: null })
    expect(r.tables.psms.count).toBe(14)
    expect(r.warnings).toEqual([`OpenNuXL_1_input.mzML: ${PEPTIDES} is missing, so its peptide PSMs are not shown.`])
  })

  test('an error of the files callback other than not found fails the read, naming the file; a Tauri error object keeps its message', async () => {
    await expect(broken({ [XLS]: new Error('permission denied') })).rejects.toThrow(`${XLS}: permission denied`)
    const tauri = Object.assign(Object.create(null), { message: 'the disk is gone' }) as Error
    await expect(broken({ [OUTPUTS]: tauri })).rejects.toThrow(`${OUTPUTS}: the disk is gone`)
  })
})

describe('the spectra of the PSMs', () => {
  test('of an indexed mzML: by its index, the spectrum element alone by byte range', async () => {
    const f = folder('example')
    const r = await readSearch(f.files)
    const row = rowOf(r, 'spectrum=9')
    const loaded = await r.spectra.load(row)
    expect(loaded.missing).toBeNull()
    const s = loaded.spectra
    expect(s.psmSpectrum[loaded.spectrumRow]).toBe(0)
    const n = s.offsets[1]
    expect(n).toBeGreaterThan(100)
    for (let k = 1; k < n; k++) expect(s.mz[k]).toBeGreaterThanOrEqual(s.mz[k - 1])
    expect(s.precursorMz[0]).toBe(712.782836914062955)
    expect(s.collisionEnergy[0]).toBe(28)
    expect(r.spectra.predictions).toBe(false)
    expect(loaded.predicted.psmOffsets).toEqual(Uint32Array.of(0, 0))
    expect(loaded.peakFilter).toBeNull()
    // NuXL's annotation, by ascending m/z
    expect(loaded.annotation[0]).toEqual({ mz: 112.050621032714844, intensity: 0.028104400262237, charge: 1, label: "MI:C'+" })
    // the mzML only by byte range: the tail, the index, the spectrum
    const mzml = f.asked.filter((a) => a.name === '1__OpenNuXL_1_input.mzML')
    expect(mzml.every((a) => a.range !== undefined)).toBe(true)
    expect(mzml.length).toBeLessThanOrEqual(4)
    // NuXL's annotated peaks are among the file's peaks
    const mz = Array.from(s.mz.subarray(0, n))
    for (const p of loaded.annotation.slice(0, 20)) expect(mz.some((m) => Math.abs(m - p.mz) < 1e-3)).toBe(true)
  })

  test('of an mzML without index: by scanning it once, the same peaks', async () => {
    const indexed = await readExample()
    const f = folder('example', { mzml: 'plain' })
    const plain = await readSearch(f.files)
    for (const id of ['spectrum=0', 'spectrum=9', 'spectrum=19']) {
      const [a, b] = await Promise.all([indexed.spectra.load(rowOf(indexed, id)), plain.spectra.load(rowOf(plain, id))])
      expect(b.missing).toBeNull()
      expect(b.spectra.mz).toEqual(a.spectra.mz)
      expect(b.spectra.intensity).toEqual(a.spectra.intensity)
      expect(b.spectra.precursorMz).toEqual(a.spectra.precursorMz)
    }
    const scans = f.asked.filter((a) => a.name === '1__OpenNuXL_1_input.mzML' && a.range && 'offset' in a.range && a.range.offset === 0)
    expect(scans.length).toBe(1)
  })

  test('the input at the path it was searched at, when its link is gone', async () => {
    const r = await readSearch(folder('example', { mzml: null, override: { '/data/OpenNuXL_1_input.mzML': new Uint8Array(readFileSync(PLAIN)) } }).files)
    expect((await r.spectra.load(0)).missing).toBeNull()
  })

  test("without the file: no peaks and why, and NuXL's annotated peaks", async () => {
    const r = await readSearch(folder('example', { mzml: null }).files)
    const loaded = await r.spectra.load(rowOf(r, 'spectrum=9'))
    expect(loaded.missing).toBe('OpenNuXL_1_input.mzML is not at /data/OpenNuXL_1_input.mzML any more, so its spectra cannot be read.')
    expect(loaded.spectra.psmSpectrum[loaded.spectrumRow]).toBe(-1)
    expect(loaded.spectra.precursorMz[0]).toBe(712.782836914062955)
    expect(loaded.annotation.length).toBe(r.tables.psms.xl.annotation[rowOf(r, 'spectrum=9')].split('|').length)
    expect(loaded.annotation.length).toBeGreaterThan(50)
  })

  test('an imported project (the file refused), a spectrum the file lacks, MS-Numpress: no peaks and why', async () => {
    const refused = await readSearch(
      folder('example', { override: { '1__OpenNuXL_1_input.mzML': new Error('1__OpenNuXL_1_input.mzML is not a file of the search 5-0: an imported search reads only its own folder.') } }).files,
    )
    expect((await refused.spectra.load(0)).missing).toBe(
      'OpenNuXL_1_input.mzML cannot be read: 1__OpenNuXL_1_input.mzML is not a file of the search 5-0: an imported search reads only its own folder.',
    )
    const plain = readFileSync(PLAIN, 'latin1')
    const other = await readSearch(folder('example', { override: { '1__OpenNuXL_1_input.mzML': Buffer.from(plain.replace('id="spectrum=9"', 'id="spectrum=99"'), 'latin1') } }).files)
    expect((await other.spectra.load(rowOf(other, 'spectrum=9'))).missing).toBe('OpenNuXL_1_input.mzML: The file has no spectrum with the native ID spectrum=9.')
    const at = plain.indexOf('id="spectrum=9"')
    const numpress = plain.slice(0, at) + plain.slice(at).replace('accession="MS:1000576"', 'accession="MS:1002312"')
    const r = await readSearch(folder('example', { override: { '1__OpenNuXL_1_input.mzML': Buffer.from(numpress, 'latin1') } }).files)
    expect((await r.spectra.load(rowOf(r, 'spectrum=9'))).missing).toBe('OpenNuXL_1_input.mzML: Its peaks are compressed with MS-Numpress, which the app does not read.')
    expect((await r.spectra.load(rowOf(r, 'spectrum=0'))).missing).toBeNull()
  })

  test('an index that does not fit the file: the file is scanned instead', async () => {
    const indexed = readFileSync(INDEXED, 'latin1').replace(/(<offset idRef="spectrum=9">)\d+/, '$1100')
    const r = await readSearch(folder('example', { override: { '1__OpenNuXL_1_input.mzML': Buffer.from(indexed, 'latin1') } }).files)
    const loaded = await r.spectra.load(rowOf(r, 'spectrum=9'))
    expect(loaded.missing).toBeNull()
    expect(loaded.spectra.offsets[1]).toBeGreaterThan(100)
  })

  test('a file without index above the scanned limit is not scanned', async () => {
    const bytes = new Uint8Array(readFileSync(PLAIN))
    await expect(spectrumIndex(async (range) => bytesOfRange(bytes, range), { maxScanned: 1000 })).rejects.toBeInstanceOf(SpectrumError)
    const index = await spectrumIndex(async (range) => bytesOfRange(bytes, range))
    expect([index.source, index.offset.size]).toEqual(['scan', 20])
  })

  test('a row that is none rejects', async () => {
    const r = await readExample()
    await expect(r.spectra.load(-1)).rejects.toThrow('There is no PSM row -1.')
    await expect(r.spectra.load(r.tables.psms.count)).rejects.toThrow()
  })
})

describe('the spectra of the PSMs: a large file without index', () => {
  test('names the input when its file is too large to scan', async () => {
    const { MAX_SCANNED } = await import('./mzml')
    // a file that does not end within the scanned limit: a stream of spaces after the example's head
    const head = readFileSync(PLAIN).subarray(0, 5000)
    const files: SearchFiles = async (name, range) => {
      if (name !== '1__OpenNuXL_1_input.mzML') return folder('example').files(name, range)
      if (!range || !('offset' in range)) return head.subarray(0, 1)
      const length = Math.max(0, Math.min(range.length, MAX_SCANNED + 1024 - range.offset))
      const out = new Uint8Array(length).fill(32)
      if (range.offset < head.length) out.set(head.subarray(range.offset, range.offset + length))
      return out
    }
    const r = await readSearch(files)
    expect((await r.spectra.load(0)).missing).toBe('OpenNuXL_1_input.mzML: The file has no index and is larger than 256 MB, so its spectra are not looked up.')
  })
})
