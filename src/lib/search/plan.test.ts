import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { FileFacts, SearchRequest } from '../desktop'

// What the New search form amounts to and what startSearch() sends to the shim (the shim's commands,
// the session and the router are replaced): the request, the footer line, the problems.

const sent: SearchRequest[] = []
vi.mock('./session.svelte', () => ({
  searchRun: { status: 'idle' },
  runSearch: vi.fn(async (request: SearchRequest) => {
    sent.push(request)
    return null
  }),
}))
vi.mock('../route.svelte', () => ({ navigate: vi.fn() }))

/** The shim's file facts: an mzML of 139 spectra, a FASTA of 4,136 proteins, by name. */
const facts = (path: string): FileFacts => {
  const name = path.split('/').pop()!
  const fasta = name.endsWith('.fasta')
  return {
    path,
    name,
    size: fasta ? 1686907 : 1152596,
    spectra: fasta ? null : 139,
    proteins: fasta ? 4136 : null,
    residues: fasta ? 1306000 : null,
    error: null,
    problem: null,
    warnings: [],
  }
}
vi.mock('../desktop', () => ({
  inspectFiles: vi.fn(async (paths: string[]) => paths.map(facts)),
  exampleFiles: vi.fn(async () => ({
    spectra: ['/data/example/Ecoli_1.mzML', '/data/example/Ecoli_2.mzML'],
    database: '/app/resources/example/Ecoli_K12_proteome.fasta',
  })),
  errorText: (e: unknown) => String(e),
}))

const { searchForm: form } = await import('./form.svelte')
const { searchPlan, searchRequest, startSearch } = await import('./plan.svelte')
const { runSearch } = await import('./session.svelte')
const { toolState } = await import('./tool.svelte')

/** The names the shim lets through (src-tauri/src/args.rs `PARAMETERS`). */
const allowlist = new Set(
  [
    ...(/pub const PARAMETERS: &\[\(&str, Kind\)\] = &\[([\s\S]*?)\];/.exec(
      readFileSync(new URL('../../../src-tauri/src/args.rs', import.meta.url), 'utf8'),
    )?.[1] ?? '').matchAll(/\("([^"]+)",\s*\w+\)/g),
  ].map((m) => m[1]),
)

const settle = () => new Promise((r) => setTimeout(r, 0))

async function request(): Promise<SearchRequest> {
  sent.length = 0
  await startSearch()
  expect(sent).toHaveLength(1)
  return sent[0]
}

describe('the search request', () => {
  beforeEach(async () => {
    form.files = []
    form.database = null
    form.notices = []
    form.choosePreset('orbitrap-hcd-tryptic')
    form.contaminants = true
    form.rescore = true
    form.peptdeep = false
    form.threads = null
    Object.assign(toolState, { status: 'ready', info: { version: '3.7.0', path: '/x/ProSE', onnx: true }, error: null })
  })

  test('the form builds the arguments of the example preset', async () => {
    await form.loadExample()
    await settle()
    expect(form.isExample).toBe(true)
    // the example's protein FDR is off (0), and shown so
    expect(form.value('FDR:protein')).toBe(0)
    expect(searchPlan.problem).toBeNull()
    const r = await request()
    // the Orbitrap HCD preset, on ProSE's defaults: what differs is sent, by the shim's names (the protein FDR off is
    // ProSE's default, 0, so it is not sent)
    expect(r.settings.parameters).toEqual({
      enzyme: 'Trypsin/P',
      'modifications:variable': ['Oxidation (M)', 'Acetyl (Protein N-term)'],
      // the example's PSM FDR (the run is too small for 1 %)
      'FDR:PSM': 0.02,
      'peptide:missed_cleavages': 2,
      // the example's ion-trap fragments
      'fragment:mass_tolerance': 0.5,
      'fragment:mass_tolerance_unit': 'Da',
    })
    // the result's protein cutoff: none (every protein counts)
    expect(vi.mocked(runSearch).mock.calls.at(-1)![1]).toMatchObject({ psmFdr: 0.02, proteinFdr: 1 })
    for (const name of Object.keys(r.settings.parameters)) expect(allowlist.has(name), name).toBe(true)
    expect(r.settings).toMatchObject({ rescore: true, peptdeep: false, threads: 0 })
    expect(r.contaminants).toBe(true)
    expect(searchPlan.line).toBe(
      '2 files in 2 samples · 4,136 proteins + 116 cRAP + decoys',
    )
    expect(searchPlan.note).toBe(
      "Ion-trap example with a 0.5 Da fragment tolerance, a 2 % PSM FDR and no protein FDR: the run is too small for 1 % and for a protein FDR. It has too few PSMs for Percolator's full model.",
    )
    // a protein FDR the user sets on the example is sent, and the note no longer says there is none
    form.setParam('FDR:protein', 0.05)
    expect(searchPlan.note).toBe(
      "Ion-trap example with a 0.5 Da fragment tolerance and a 2 % PSM FDR. The run is too small for 1 %, for a protein FDR and for Percolator's full model.",
    )
    expect((await request()).settings.parameters['FDR:protein']).toBe(0.05)
    expect(vi.mocked(runSearch).mock.calls.at(-1)![1]).toMatchObject({ proteinFdr: 0.05 })
  })

  test('a search request carries paths, not file contents', async () => {
    await form.addFiles(['/runs/a/sample.mzML', '/runs/b/sample.mzML.gz', '/db/human.fasta'])
    await settle()
    const r = await request()
    expect(r.files).toEqual([
      { id: form.files[0].id, path: '/runs/a/sample.mzML' },
      { id: form.files[1].id, path: '/runs/b/sample.mzML.gz' },
    ])
    expect(r.database).toBe('/db/human.fasta')
    // plain JSON: strings, numbers, booleans, lists (no File, Blob or bytes)
    const json = JSON.stringify(r)
    expect(JSON.parse(json)).toEqual(r)
    const leaves = (v: unknown): unknown[] => (v !== null && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [v])
    for (const leaf of leaves(r)) expect(['string', 'number', 'boolean']).toContain(typeof leaf)
  })

  test('every preset sends only names the shim lets through', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    for (const preset of form.presets) {
      form.choosePreset(preset.id)
      const r = searchRequest()!
      for (const name of Object.keys(r.settings.parameters)) expect(allowlist.has(name), `${preset.id}: ${name}`).toBe(true)
    }
  })

  test('Advanced: the threads (all cores by default) and the database chunks', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    expect(searchRequest()!.settings.threads).toBe(0)
    form.threads = 4
    form.setParam('database:chunk_size', 2000)
    const r = searchRequest()!
    expect(r.settings.threads).toBe(4)
    expect(r.settings.parameters['database:chunk_size']).toBe(2000)
    expect('threads' in r.settings.parameters).toBe(false)
  })

  test('co-isolated precursors: sent when on, not with database chunks (ProSE would ignore them)', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    expect('chimeric:enabled' in searchRequest()!.settings.parameters).toBe(false)
    form.setParam('chimeric:enabled', true)
    expect(searchPlan.chimericBlocked).toBe(false)
    expect(searchRequest()!.settings.parameters['chimeric:enabled']).toBe(true)
    form.setParam('database:chunk_size', 2000)
    expect(searchPlan.chimericBlocked).toBe(true)
    expect('chimeric:enabled' in searchRequest()!.settings.parameters).toBe(false)
    // the switch stays on: without chunks it is sent again
    form.setParam('database:chunk_size', 0)
    expect(searchRequest()!.settings.parameters['chimeric:enabled']).toBe(true)
    for (const name of Object.keys(searchRequest()!.settings.parameters)) expect(allowlist.has(name), name).toBe(true)
  })

  test('without decoys there is no FDR: none is sent, nothing waits for one, and the values come back with decoys', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    form.setParam('FDR:protein', 0.05)
    form.setParam('FDR:protein_inference_PSM', 0.2)
    expect(searchPlan.fdrBlocked).toBe(false)
    form.setParam('decoys', 'ignore')
    expect(searchPlan.fdrBlocked).toBe(true)
    // a PSM FDR of 0 does not keep the search from starting then
    form.setParam('FDR:PSM', 0)
    expect(searchPlan.problem).toBeNull()
    const r = await request()
    expect(r.settings.parameters.decoys).toBe('ignore')
    for (const name of ['FDR:PSM', 'FDR:protein', 'FDR:protein_inference_PSM']) expect(name in r.settings.parameters, name).toBe(false)
    // the result has no cutoffs: every PSM and protein counts
    expect(vi.mocked(runSearch).mock.calls.at(-1)![1]).toMatchObject({ psmFdr: 1, proteinFdr: 1 })
    // decoys again: the FDR the user had (the PSM FDR of 0 waits again)
    form.setParam('decoys', 'generate')
    expect(searchPlan.problem).toBe('Set a PSM FDR above 0 %.')
    form.setParam('FDR:PSM', 0.01)
    const again = await request()
    expect(again.settings.parameters).toMatchObject({ decoys: 'generate', 'FDR:PSM': 0.01, 'FDR:protein': 0.05, 'FDR:protein_inference_PSM': 0.2 })
    expect(vi.mocked(runSearch).mock.calls.at(-1)![1]).toMatchObject({ psmFdr: 0.01, proteinFdr: 0.05 })
  })

  test('a preset without decoys but with an FDR loads with the FDR off, and says so', async () => {
    form.presets = [
      ...form.presets,
      { id: 'nodecoys', name: 'No decoys', builtin: false, parameters: { decoys: 'ignore', 'FDR:PSM': 0.01, 'FDR:protein': 0.05 } },
      { id: 'nodecoys-nofdr', name: 'Plain', builtin: false, parameters: { decoys: 'ignore' } },
    ]
    form.choosePreset('nodecoys')
    expect(searchPlan.fdrBlocked).toBe(true)
    expect(form.notices).toEqual([
      'The preset “No decoys” searches without decoys, so its PSM FDR of 1 % and protein FDR of 5 % are off: ProSE cannot ' +
        'estimate an FDR without decoys. Choose other decoys under Protein database to control the FDR.',
    ])
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    expect('FDR:PSM' in searchRequest()!.settings.parameters).toBe(false)
    form.notices = []
    form.choosePreset('nodecoys-nofdr')
    expect(form.notices).toEqual([])
    form.choosePreset('orbitrap-hcd-tryptic')
    expect(form.notices).toEqual([])
    form.presets = form.presets.filter((p) => !p.id.startsWith('nodecoys'))
  })

  test('PeptDeep needs Percolator and a ProSE with ONNX Runtime', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    form.peptdeep = true
    expect(searchRequest()!.settings.peptdeep).toBe(true)
    form.rescore = false
    expect(searchRequest()!.settings).toMatchObject({ peptdeep: false, rescore: false })
    form.rescore = true
    Object.assign(toolState, { info: { version: '3.7.0', path: '/x/ProSE', onnx: false } })
    expect(searchRequest()!.settings.peptdeep).toBe(false)
  })
})

describe('the footer', () => {
  beforeEach(() => {
    form.files = []
    form.database = null
    form.notices = []
    form.choosePreset('orbitrap-hcd-tryptic')
    Object.assign(toolState, { status: 'ready', info: { version: '3.7.0', path: '/x/ProSE', onnx: true }, error: null })
  })

  test('says what is missing, and why the search cannot start', async () => {
    expect(searchPlan.line).toBe('No spectra yet')
    expect(searchPlan.problem).toBe('Add mzML files to start.')
    await form.addFiles(['/r/run.mzML'])
    expect(searchPlan.line).toBe('1 file · no database yet')
    expect(searchPlan.problem).toBe('Choose a FASTA database to start.')
    await form.addFiles(['/db/db.fasta'])
    await settle()
    expect(searchPlan.line).toBe('1 file · 4,136 proteins + 116 cRAP + decoys')
    expect(searchPlan.canStart).toBe(true)
    form.setParam('modifications:variable', ['Oxidation (M)', 'Nonsense (Q)'])
    expect(searchPlan.problem).toMatch(/^Unknown modification: Nonsense \(Q\)\. ProSE does not know this name/)
    form.setParam('modifications:variable', ['Phospho (S)'])
    expect(searchPlan.problem).toBeNull()
    // the protein FDR off (0) is a setting, not a problem; the PSM FDR cannot be off
    form.setParam('FDR:protein', 0)
    expect(searchPlan.problem).toBeNull()
    form.setParam('FDR:PSM', 0)
    expect(searchPlan.problem).toBe('Set a PSM FDR above 0 %.')
    form.setParam('FDR:PSM', 0.01)
    // a value ProSE refuses (a preset may hold one)
    form.setParam('precursor:max_charge', 30)
    expect(searchPlan.problem).toBe('precursor:max_charge is 30; ProSE takes 1 to 20.')
    form.setParam('precursor:max_charge', 5)
    expect(searchPlan.problem).toBeNull()
    Object.assign(toolState, { status: 'failed', info: null, error: 'PROSE_BIN is set to /x, which is not a file.' })
    expect(searchPlan.problem).toBe('ProSE cannot be run: PROSE_BIN is set to /x, which is not a file.')
  })

  test('Remove all and Start over: no files (Start over: no database either), the settings as they were', async () => {
    await form.addFiles(['/r/a.mzML', '/r/b.mzML', '/db/db.fasta'])
    await settle()
    form.choosePreset('open-search')
    form.setParam('fragment:mass_tolerance', 0.5)
    form.peptdeep = true
    form.notices.push('a notice about the files')
    form.removeAllFiles()
    expect(form.files).toEqual([])
    expect(form.notices).toEqual([])
    expect(form.database?.file.name).toBe('db.fasta')
    await form.addFiles(['/r/a.mzML'])
    form.startOver()
    expect(form.files).toEqual([])
    expect(form.database).toBeNull()
    expect(searchPlan.line).toBe('No spectra yet')
    expect(form.presetId).toBe('open-search')
    expect(form.value('fragment:mass_tolerance')).toBe(0.5)
    expect(form.peptdeep).toBe(true)
    form.peptdeep = false
  })

  test("the example's fragment tolerance, PSM FDR and protein FDR go back to the preset's when its files go", async () => {
    const own = () => [form.value('fragment:mass_tolerance'), form.value('fragment:mass_tolerance_unit'), form.value('FDR:protein')]
    const psmFdr = () => form.value('FDR:PSM')
    // the example's protein FDR is off, whatever it was
    form.setParam('FDR:protein', 0.05)
    await form.loadExample()
    await settle()
    expect(own()).toEqual([0.5, 'Da', 0])
    expect(psmFdr()).toBe(0.02)
    // Start over: the preset's 20 ppm and 1 % again (the other settings stay)
    form.peptdeep = true
    form.startOver()
    expect(own()).toEqual([20, 'ppm', 0.01])
    expect(psmFdr()).toBe(0.01)
    expect(form.peptdeep).toBe(true)
    form.peptdeep = false
    // Undo brings back the files, the database and the example's tolerance and protein FDR
    expect(form.removed?.files).toHaveLength(2)
    form.undoRemove()
    await settle()
    expect(form.isExample).toBe(true)
    expect(own()).toEqual([0.5, 'Da', 0])
    expect(psmFdr()).toBe(0.02)
    expect(form.removed).toBeNull()
    // own files added to the example's: the example's settings end
    await form.addFiles(['/runs/mine.mzML'])
    expect(own()).toEqual([20, 'ppm', 0.01])
    // a tolerance the user set after loading the example stays, the protein FDR still goes back (and Start over's
    // tooltip names only what goes back)
    await form.loadExample()
    await settle()
    expect(form.exampleSettingsInForce).toEqual(['fragment tolerance', 'PSM FDR', 'protein FDR'])
    form.setParam('fragment:mass_tolerance', 0.3)
    expect(form.exampleSettingsInForce).toEqual(['PSM FDR', 'protein FDR'])
    form.removeAllFiles()
    expect(own()).toEqual([0.3, 'Da', 0.01])
    expect(form.exampleSettingsInForce).toEqual([])
    // a PSM FDR the user set stays
    await form.loadExample()
    await settle()
    form.setParam('FDR:PSM', 0.05)
    expect(form.exampleSettingsInForce).toEqual(['fragment tolerance', 'protein FDR'])
    form.removeAllFiles()
    expect(psmFdr()).toBe(0.05)
    form.setParam('FDR:PSM', 0.01)
    // a protein FDR the user set stays, the tolerance goes back
    await form.loadExample()
    await settle()
    form.setParam('FDR:protein', 0.05)
    expect(form.exampleSettingsInForce).toEqual(['fragment tolerance', 'PSM FDR'])
    form.removeAllFiles()
    expect(own()).toEqual([20, 'ppm', 0.05])
    // another database ends them too
    await form.loadExample()
    await settle()
    await form.setDatabase('/db/human.fasta')
    expect(own()).toEqual([20, 'ppm', 0.01])
  })

  test("leaving the example gives back the preset's protein FDR, or ProSE's default when the preset has none", async () => {
    // a preset without a protein FDR (a user preset saved from the defaults): ProSE's 0, off
    form.presets = [...form.presets, { id: 'mine', name: 'Mine', builtin: false, parameters: { 'FDR:PSM': 0.01 } }]
    form.choosePreset('mine')
    await form.loadExample()
    await settle()
    expect(form.value('FDR:protein')).toBe(0)
    form.startOver()
    expect(form.value('FDR:protein')).toBe(0)
    expect('FDR:protein' in form.overrides).toBe(false)
    form.presets = form.presets.filter((p) => p.id !== 'mine')
  })

  test('the example stays the example when nothing joins; Undo keeps a tolerance set after the removal', async () => {
    await form.loadExample()
    await settle()
    // a vendor file only, or an mzML that cannot be read: no row joins, the example's settings stay
    await form.addFiles(['/r/run.raw'])
    expect(form.value('fragment:mass_tolerance')).toBe(0.5)
    const facts = vi.mocked((await import('../desktop')).inspectFiles)
    facts.mockImplementationOnce(async (paths: string[]) =>
      paths.map((p) => ({ path: p, name: p.split('/').pop()!, size: 0, spectra: null, proteins: null, residues: null, error: 'not an mzML', problem: null, warnings: [] })),
    )
    await form.addFiles(['/r/broken.mzML'])
    expect(form.isExample).toBe(true)
    expect(form.value('fragment:mass_tolerance')).toBe(0.5)
    expect(form.exampleSettingsInForce).toEqual(['fragment tolerance', 'PSM FDR', 'protein FDR'])
    // Start over, then the user sets 10 ppm, then Undo: the files come back, the user's 10 ppm stays, the example's
    // protein FDR (off) comes back
    form.startOver()
    expect(form.exampleSettingsInForce).toEqual([])
    expect(form.value('FDR:protein')).toBe(0.01)
    form.setParam('fragment:mass_tolerance', 10)
    form.undoRemove()
    await settle()
    expect(form.isExample).toBe(true)
    expect([form.value('fragment:mass_tolerance'), form.value('fragment:mass_tolerance_unit')]).toEqual([10, 'ppm'])
    expect(form.value('FDR:protein')).toBe(0)
    expect(form.exampleSettingsInForce).toEqual(['PSM FDR', 'protein FDR'])
    // and the other way round: a protein FDR set after the removal stays, the example's tolerance comes back
    await form.loadExample()
    await settle()
    form.startOver()
    form.setParam('FDR:protein', 0.001)
    form.undoRemove()
    await settle()
    expect([form.value('fragment:mass_tolerance'), form.value('fragment:mass_tolerance_unit'), form.value('FDR:protein')]).toEqual([0.5, 'Da', 0.001])
  })

  test('Undo counts a database again whose count the removal cut short', async () => {
    await form.addFiles(['/r/a.mzML'])
    let release: () => void = () => {}
    const facts = vi.mocked((await import('../desktop')).inspectFiles)
    const real = facts.getMockImplementation()!
    facts.mockImplementationOnce((paths: string[]) => new Promise((resolve) => (release = () => resolve(real(paths)))))
    const counting = form.setDatabase('/db/slow.fasta')
    expect(form.database?.proteins).toBeNull()
    form.startOver()
    release()
    await counting
    form.undoRemove()
    await settle()
    expect(form.database?.file.name).toBe('slow.fasta')
    expect(form.database?.proteins).toBe(4136)
  })

  test('Remove all and Start over wait while files or the example are loading', async () => {
    await form.addFiles(['/r/a.mzML', '/db/db.fasta'])
    await settle()
    const loading = form.loadExample()
    expect(form.busy).toBe(true)
    form.startOver()
    form.removeAllFiles()
    await loading
    await settle()
    expect(form.isExample).toBe(true)
    expect(form.removed).toBeNull()
  })

  test('files that are neither mzML nor FASTA are reported, not added', async () => {
    await form.addFiles(['/r/run.raw', '/r/run.mzML'])
    expect(form.files.map((r) => r.file.name)).toEqual(['run.mzML'])
    expect(form.notices[0]).toMatch(/^Not an mzML file: run\.raw\./)
  })
})
