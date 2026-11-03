import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { FileFacts, SearchRequest } from '../desktop'
import { NUXL_PARAMETERS } from '../settings/nuxl'

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

/** The shim's file facts: an mzML of 20 spectra, a FASTA of 5 proteins, by name. */
const facts = (path: string): FileFacts => {
  const name = path.split('/').pop()!
  const fasta = name.endsWith('.fasta')
  return {
    path,
    name,
    size: fasta ? 1484 : 153450,
    spectra: fasta ? null : 20,
    proteins: fasta ? 5 : null,
    residues: fasta ? 1300 : null,
    error: null,
    problem: null,
    warnings: [],
  }
}
vi.mock('../desktop', () => ({
  inspectFiles: vi.fn(async (paths: string[]) => paths.map(facts)),
  exampleFiles: vi.fn(async () => ({
    spectra: ['/app/resources/example/OpenNuXL_1_input.mzML'],
    database: '/app/resources/example/OpenNuXL_1_input.fasta',
  })),
  errorText: (e: unknown) => String(e),
}))

const { searchForm: form } = await import('./form.svelte')
const { searchPlan, searchRequest, startSearch } = await import('./plan.svelte')
const { runSearch } = await import('./session.svelte')
const { toolState } = await import('./tool.svelte')

/** The names the shim lets through: OpenNuXL's parameters of the app (settings/parameters.test.ts checks them against args.rs). */
const allowlist = new Set(NUXL_PARAMETERS.map((e) => e.name))

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
    form.choosePreset('nuxl-defaults')
    form.contaminants = true
    form.rescore = true
    form.threads = null
    Object.assign(toolState, { status: 'ready', info: { version: '3.7.0', path: '/x/OpenNuXL' }, error: null })
  })

  test("the default settings: OpenNuXL's defaults with the protocol RNA-UV (U), FDRs of 1 % apart from the parameters", async () => {
    await form.addFiles(['/runs/run.mzML', '/db/proteins.fasta'])
    await settle()
    expect(searchPlan.problem).toBeNull()
    const r = await request()
    expect(r).toEqual({
      files: [{ id: form.files[0].id, path: '/runs/run.mzML' }],
      database: '/db/proteins.fasta',
      contaminants: true,
      settings: { parameters: { 'NuXL:presets': 'RNA-UV (U)' }, rescore: true, threads: 0, peptideFdr: 0.01, xlFdr: 0.01 },
    })
    // the result's cutoffs: the peptide PSMs' FDR, no protein FDR; the record keeps both FDRs
    expect(vi.mocked(runSearch).mock.calls.at(-1)![1]).toMatchObject({
      psmFdr: 0.01,
      proteinFdr: 1,
      settings: { parameters: { 'NuXL:presets': 'RNA-UV (U)' }, rescore: true, contaminants: true, presetId: 'nuxl-defaults', peptideFdr: 0.01, xlFdr: 0.01 },
    })
  })

  test("the example: OpenMS' test run with its 10 ppm precursor tolerance", async () => {
    await form.loadExample()
    await settle()
    expect(form.isExample).toBe(true)
    expect(form.files.map((r) => [r.file.name, r.condition])).toEqual([['OpenNuXL_1_input.mzML', 'example']])
    expect(searchPlan.problem).toBeNull()
    const r = await request()
    expect(r.settings).toEqual({
      parameters: { 'NuXL:presets': 'RNA-UV (U)', 'precursor:mass_tolerance': 10 },
      rescore: true,
      threads: 0,
      peptideFdr: 0.01,
      xlFdr: 0.01,
    })
    expect(r.database).toBe('/app/resources/example/OpenNuXL_1_input.fasta')
    expect(searchPlan.line).toBe('1 file · 5 proteins + 116 cRAP + decoys')
    expect(searchPlan.note).toBe(
      "OpenMS' test run of OpenNuXL (20 spectra, 5 proteins) with its 10 ppm precursor tolerance. It has too few PSMs for Percolator, which OpenNuXL skips below 1,000 PSMs.",
    )
  })

  test('a search request carries paths, not file contents', async () => {
    await form.addFiles(['/runs/a/sample.mzML', '/runs/b/sample.mzML', '/db/human.fasta'])
    await settle()
    const r = await request()
    expect(r.files).toEqual([
      { id: form.files[0].id, path: '/runs/a/sample.mzML' },
      { id: form.files[1].id, path: '/runs/b/sample.mzML' },
    ])
    expect(r.database).toBe('/db/human.fasta')
    // plain JSON: strings, numbers, booleans, lists (no File, Blob or bytes)
    const json = JSON.stringify(r)
    expect(JSON.parse(json)).toEqual(r)
    const leaves = (v: unknown): unknown[] => (v !== null && typeof v === 'object' ? Object.values(v).flatMap(leaves) : [v])
    for (const leaf of leaves(r)) expect(['string', 'number', 'boolean']).toContain(typeof leaf)
  })

  test('sends what differs from OpenNuXL\'s defaults, by the names the shim lets through; the FDRs only as settings', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    form.setParam('peptide:enzyme', 'Lys-C')
    form.setParam('NuXL:length', 3)
    form.setParam('NuXL:scoring', 'fast')
    form.setParam('NuXL:only_xl', true)
    form.setParam('precursor:isotopes', [0, 1])
    form.setParam('peptide:clip_nterm_methionine', 'false')
    form.setParam('peptideFdr', 0.05)
    form.setParam('xlFdr', 0.1)
    // back to a default: not sent
    form.setParam('fragment:mass_tolerance', 20)
    const r = searchRequest()!
    expect(r.settings.parameters).toEqual({
      'peptide:enzyme': 'Lys-C',
      'NuXL:presets': 'RNA-UV (U)',
      'NuXL:length': 3,
      'NuXL:scoring': 'fast',
      'NuXL:only_xl': true,
      'precursor:isotopes': [0, 1],
      'peptide:clip_nterm_methionine': 'false',
    })
    expect(r.settings).toMatchObject({ peptideFdr: 0.05, xlFdr: 0.1 })
    for (const name of Object.keys(r.settings.parameters)) expect(allowlist.has(name), name).toBe(true)
    // a name OpenNuXL does not have (a preset of another version) is not sent
    form.setParam('FDR:PSM', 0.02)
    expect('FDR:PSM' in searchRequest()!.settings.parameters).toBe(false)
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

  test('the adducts of the NuXL fields go only with the custom protocol, which starts from the protocol before', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    form.setParam('NuXL:modifications', ['U:', 'U:-H2O'])
    expect(searchPlan.customProtocol).toBe(false)
    expect(searchPlan.blockedReason('NuXL:modifications')).toMatch(/^The protocol sets this/)
    expect(searchPlan.blockedReason('NuXL:length')).toBeNull()
    expect('NuXL:modifications' in searchRequest()!.settings.parameters).toBe(false)
    // the custom protocol: the fields count (the user's own stay as they are)
    form.setProtocol('none')
    expect(searchPlan.customProtocol).toBe(true)
    expect(searchPlan.blockedReason('NuXL:modifications')).toBeNull()
    // ("none" is OpenNuXL's default: not sent)
    expect(searchRequest()!.settings.parameters).toEqual({ 'NuXL:modifications': ['U:', 'U:-H2O'] })
    // with untouched fields, the custom protocol starts from the protocol chosen before
    form.choosePreset('nuxl-defaults')
    form.setProtocol('RNA-UV (UCGA)')
    form.setProtocol('none')
    expect(form.value('NuXL:can_cross_link')).toBe('UCGA')
    expect(form.value<string[]>('NuXL:modifications')).toHaveLength(10)
    const r = searchRequest()!
    expect(r.settings.parameters['NuXL:can_cross_link']).toBe('UCGA')
    for (const name of Object.keys(r.settings.parameters)) expect(allowlist.has(name), name).toBe(true)
  })

  test('Advanced: the threads (all cores by default), never a parameter', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    expect(searchRequest()!.settings.threads).toBe(0)
    form.threads = 4
    const r = searchRequest()!
    expect(r.settings.threads).toBe(4)
    expect('threads' in r.settings.parameters).toBe(false)
  })

  test('Percolator off', async () => {
    await form.addFiles(['/r/run.mzML', '/db/db.fasta'])
    await settle()
    form.rescore = false
    expect(searchRequest()!.settings.rescore).toBe(false)
    expect((await request()).settings.rescore).toBe(false)
    expect(vi.mocked(runSearch).mock.calls.at(-1)![1]).toMatchObject({ settings: { rescore: false } })
  })
})

describe('the footer', () => {
  beforeEach(() => {
    form.files = []
    form.database = null
    form.notices = []
    form.choosePreset('nuxl-defaults')
    Object.assign(toolState, { status: 'ready', info: { version: '3.7.0', path: '/x/OpenNuXL' }, error: null })
  })

  test('says what is missing, and why the search cannot start', async () => {
    expect(searchPlan.line).toBe('No spectra yet')
    expect(searchPlan.problem).toBe('Add mzML files to start.')
    await form.addFiles(['/r/run.mzML'])
    expect(searchPlan.line).toBe('1 file · no database yet')
    expect(searchPlan.problem).toBe('Choose a FASTA database to start.')
    await form.addFiles(['/db/db.fasta'])
    await settle()
    expect(searchPlan.line).toBe('1 file · 5 proteins + 116 cRAP + decoys')
    expect(searchPlan.canStart).toBe(true)
    form.contaminants = false
    expect(searchPlan.line).toBe('1 file · 5 proteins + decoys')
    form.contaminants = true
    form.setParam('modifications:variable', ['Oxidation (M)', 'Nonsense (Q)'])
    expect(searchPlan.problem).toMatch(/^Unknown modification: Nonsense \(Q\)\. OpenMS does not know this name/)
    form.setParam('modifications:variable', ['Phospho (S)'])
    expect(searchPlan.problem).toBeNull()
    // the FDRs cannot be off
    form.setParam('peptideFdr', 0)
    expect(searchPlan.problem).toBe('Set a peptide FDR above 0 %.')
    form.setParam('peptideFdr', 0.01)
    form.setParam('xlFdr', 0)
    expect(searchPlan.problem).toBe('Set a cross-link FDR above 0 %.')
    form.setParam('xlFdr', 0.01)
    // a value outside the form's bounds (a preset may hold one)
    form.setParam('NuXL:length', 6)
    expect(searchPlan.problem).toBe('NuXL:length is 6; the search takes 0 to 4.')
    form.setParam('NuXL:length', 2)
    form.setParam('precursor:min_charge', 6)
    expect(searchPlan.problem).toBe('Charges: the lowest (6) is above the highest (5).')
    form.setParam('precursor:min_charge', 2)
    expect(searchPlan.problem).toBeNull()
    Object.assign(toolState, { status: 'failed', info: null, error: 'NUXL_BIN is set to /x, which is not a file.' })
    expect(searchPlan.problem).toBe('OpenNuXL cannot be run: NUXL_BIN is set to /x, which is not a file.')
  })

  test('Remove all and Start over: no files (Start over: no database either), the settings as they were', async () => {
    await form.addFiles(['/r/a.mzML', '/r/b.mzML', '/db/db.fasta'])
    await settle()
    form.setParam('fragment:mass_tolerance', 0.5)
    form.rescore = false
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
    expect(form.presetId).toBe('nuxl-defaults')
    expect(form.value('fragment:mass_tolerance')).toBe(0.5)
    expect(form.rescore).toBe(false)
    form.rescore = true
  })

  test("the example's precursor tolerance goes back to the preset's when its files go", async () => {
    const tolerance = () => [form.value('precursor:mass_tolerance'), form.value('precursor:mass_tolerance_unit')]
    form.setParam('precursor:mass_tolerance', 4)
    await form.loadExample()
    await settle()
    expect(tolerance()).toEqual([10, 'ppm'])
    expect(form.exampleSettingsInForce).toEqual(['precursor tolerance'])
    // the example's settings are not the user's changes (another preset would not discard them)
    expect(form.edited).toBe(false)
    // Start over: OpenNuXL's 6 ppm again (the other settings stay)
    form.setParam('xlFdr', 0.05)
    form.startOver()
    expect(tolerance()).toEqual([6, 'ppm'])
    expect(form.value('xlFdr')).toBe(0.05)
    // Undo brings back the files, the database and the example's tolerance
    expect(form.removed?.files).toHaveLength(1)
    form.undoRemove()
    await settle()
    expect(form.isExample).toBe(true)
    expect(tolerance()).toEqual([10, 'ppm'])
    expect(form.removed).toBeNull()
    // own files added to the example's: the example's settings end
    await form.addFiles(['/runs/mine.mzML'])
    expect(tolerance()).toEqual([6, 'ppm'])
    // a tolerance the user set after loading the example stays
    form.removeAllFiles()
    await form.loadExample()
    await settle()
    form.setParam('precursor:mass_tolerance', 8)
    expect(form.exampleSettingsInForce).toEqual([])
    form.removeAllFiles()
    expect(tolerance()).toEqual([8, 'ppm'])
    // another database ends them too
    await form.loadExample()
    await settle()
    await form.setDatabase('/db/human.fasta')
    expect(tolerance()).toEqual([6, 'ppm'])
    form.setParam('xlFdr', 0.01)
  })

  test("leaving the example gives back the preset's tolerance", async () => {
    form.presets = [...form.presets, { id: 'mine', name: 'Mine', builtin: false, parameters: { 'precursor:mass_tolerance': 0.02, 'precursor:mass_tolerance_unit': 'Da' } }]
    form.choosePreset('mine')
    await form.loadExample()
    await settle()
    expect(form.value('precursor:mass_tolerance_unit')).toBe('ppm')
    form.startOver()
    expect([form.value('precursor:mass_tolerance'), form.value('precursor:mass_tolerance_unit')]).toEqual([0.02, 'Da'])
    form.presets = form.presets.filter((p) => p.id !== 'mine')
  })

  test('the example stays the example when nothing joins; Undo keeps a tolerance set after the removal', async () => {
    await form.loadExample()
    await settle()
    // a vendor file only, or an mzML that cannot be read: no row joins, the example's settings stay
    await form.addFiles(['/r/run.raw'])
    expect(form.value('precursor:mass_tolerance')).toBe(10)
    const facts = vi.mocked((await import('../desktop')).inspectFiles)
    facts.mockImplementationOnce(async (paths: string[]) =>
      paths.map((p) => ({ path: p, name: p.split('/').pop()!, size: 0, spectra: null, proteins: null, residues: null, error: 'not an mzML', problem: null, warnings: [] })),
    )
    await form.addFiles(['/r/broken.mzML'])
    expect(form.isExample).toBe(true)
    expect(form.exampleSettingsInForce).toEqual(['precursor tolerance'])
    // Start over, then the user sets 5 ppm, then Undo: the files come back, the user's 5 ppm stays
    form.startOver()
    expect(form.exampleSettingsInForce).toEqual([])
    form.setParam('precursor:mass_tolerance', 5)
    form.undoRemove()
    await settle()
    expect(form.isExample).toBe(true)
    expect(form.value('precursor:mass_tolerance')).toBe(5)
    expect(form.exampleSettingsInForce).toEqual([])
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
    expect(form.database?.proteins).toBe(5)
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

  test('files that are not plain mzML or FASTA are reported, not added: compressed mzML and raw files say what to do', async () => {
    await form.addFiles(['/r/run.raw', '/r/run.mzML', '/r/other.mzML.gz', '/r/notes.txt'])
    expect(form.files.map((r) => r.file.name)).toEqual(['run.mzML'])
    expect(form.notices).toHaveLength(3)
    expect(form.notices[0]).toMatch(/^other\.mzML\.gz is compressed\. OpenNuXL reads plain mzML only/)
    expect(form.notices[1]).toMatch(/^run\.raw: Thermo raw files cannot be searched directly\./)
    expect(form.notices[2]).toMatch(/^Not an mzML file: notes\.txt\./)
  })
})
