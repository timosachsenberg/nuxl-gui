import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { FileFacts } from '../desktop'

// What New search checks of its inputs before a search starts (the shim's commands, the session and the router are
// replaced): files ProSE cannot search, the same file twice, design cells and ranges that are not valid, and what
// Remove all, Start over and Undo bring back.

vi.mock('./session.svelte', () => ({ searchRun: { status: 'idle' }, runSearch: vi.fn(async () => null) }))
vi.mock('../route.svelte', () => ({ navigate: vi.fn() }))

/** What the shim says of a path beyond the plain facts (`problem`, `warnings`), by file name. */
const special = new Map<string, Partial<FileFacts>>()

const facts = (path: string): FileFacts => {
  const name = path.split('/').pop()!
  const fasta = name.endsWith('.fasta')
  return {
    path,
    name,
    size: 1000,
    spectra: fasta ? null : 139,
    proteins: fasta ? 4136 : null,
    residues: fasta ? 1306000 : null,
    error: null,
    problem: null,
    warnings: [],
    ...special.get(name),
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
const { searchPlan } = await import('./plan.svelte')
const { toolState } = await import('./tool.svelte')

const settle = () => new Promise((r) => setTimeout(r, 0))

/** Files and a database that can be searched. */
async function ready(files = ['/r/a.mzML', '/r/b.mzML']) {
  await form.addFiles([...files, '/db/db.fasta'])
  await settle()
  expect(searchPlan.problem).toBeNull()
}

describe('the inputs of New search', () => {
  beforeEach(() => {
    special.clear()
    form.files = []
    form.database = null
    form.notices = []
    form.removed = null
    form.invalidCells = {}
    form.choosePreset('orbitrap-hcd-tryptic')
    Object.assign(toolState, { status: 'ready', info: { version: '3.7.0', path: '/x/ProSE', onnx: true }, error: null })
  })

  test('the same path is added once, in one go or again later; files of one name from two folders stay apart', async () => {
    await form.addFiles(['/r/a.mzML', '/r/a.mzML', '/r/b.mzML'])
    expect(form.files.map((r) => r.file.path)).toEqual(['/r/a.mzML', '/r/b.mzML'])
    expect(form.notices).toEqual(['a.mzML is in the list already, so it was not added again: one file is searched once.'])
    await form.addFiles(['/r/b.mzML', '/r/a.mzML', '/other/a.mzML'])
    expect(form.files.map((r) => r.file.path)).toEqual(['/r/a.mzML', '/r/b.mzML', '/other/a.mzML'])
    expect(form.notices[1]).toBe('b.mzML, a.mzML are in the list already, so they were not added again: one file is searched once.')
    // the same path while the first is still being inspected
    form.files = []
    await Promise.all([form.addFiles(['/r/c.mzML']), form.addFiles(['/r/c.mzML'])])
    expect(form.files.map((r) => r.file.path)).toEqual(['/r/c.mzML'])
    // two files of one name are both searched: the notice says so, and does not hold the search
    await form.addFiles(['/r/a.mzML', '/other/a.mzML', '/db/db.fasta'])
    await settle()
    expect(form.design.notices.find((n) => n.kind === 'duplicateFile')?.message).toMatch(/^2 files are named a\.mzML/)
    expect(searchPlan.problem).toBeNull()
  })

  test('a file ProSE cannot search joins the table marked, and the search waits until it is removed', async () => {
    special.set('trunc.mzML', { problem: 'trunc.mzML is incomplete: it ends before its closing </mzML> tag.' })
    special.set('fake.mzML', { spectra: null, problem: 'fake.mzML is not an mzML file: it is not XML.' })
    await ready()
    await form.addFiles(['/r/trunc.mzML'])
    expect(form.files.find((r) => r.file.name === 'trunc.mzML')?.problem).toMatch(/is incomplete/)
    expect(searchPlan.canStart).toBe(false)
    expect(searchPlan.problem).toBe('trunc.mzML is incomplete: it ends before its closing </mzML> tag. Remove it to start the search.')
    await form.addFiles(['/r/fake.mzML'])
    expect(searchPlan.problem).toBe('2 files cannot be searched (see Spectra). Remove them to start the search.')
    for (const name of ['trunc.mzML', 'fake.mzML']) form.removeFile(form.files.find((r) => r.file.name === name)!.id)
    expect(searchPlan.problem).toBeNull()
  })

  test('a database ProSE cannot search holds the search; what it treats specially does not', async () => {
    special.set('empty.fasta', { proteins: 0, residues: 0, problem: 'empty.fasta is empty.' })
    special.set('lower.fasta', {
      warnings: ['lower.fasta lists 3 entries twice, with the same accession and sequence (the first: P1), e.g. the file was added twice: ProSE searches each protein once.'],
    })
    await ready()
    await form.setDatabase('/db/empty.fasta')
    expect(form.database?.problem).toBe('empty.fasta is empty.')
    expect(searchPlan.problem).toBe('empty.fasta is empty. Choose another FASTA file.')
    await form.setDatabase('/db/lower.fasta')
    expect(form.database?.warnings).toHaveLength(1)
    expect(searchPlan.problem).toBeNull()
  })

  test('the search waits while files are added and the database is counted', async () => {
    await ready()
    const inspect = vi.mocked((await import('../desktop')).inspectFiles)
    let release: () => void = () => {}
    inspect.mockImplementationOnce((paths: string[]) => new Promise((resolve) => (release = () => resolve(paths.map(facts)))))
    const adding = form.addFiles(['/r/c.mzML'])
    expect(searchPlan.problem).toBe('Adding files…')
    release()
    await adding
    inspect.mockImplementationOnce((paths: string[]) => new Promise((resolve) => (release = () => resolve(paths.map(facts)))))
    const counting = form.setDatabase('/db/other.fasta')
    expect(searchPlan.problem).toBe('Counting the proteins of the database…')
    release()
    await counting
    expect(searchPlan.problem).toBeNull()
  })

  test('a design cell that is not valid holds the search until it is corrected or its row goes', async () => {
    await ready()
    const [a, b] = form.files
    form.setInvalidCell(b.id, 'fraction', 'Fraction of b.mzML', 'abc')
    form.setInvalidCell(a.id, 'replicate', 'Replicate of a.mzML', '0')
    expect(searchPlan.problem).toBe('Replicate of a.mzML (and 1 more): “0” is not a whole number of at least 1. Correct it, or empty the cell.')
    form.setInvalidCell(a.id, 'replicate', 'Replicate of a.mzML', null)
    expect(searchPlan.problem).toMatch(/^Fraction of b\.mzML: “abc”/)
    form.removeFile(b.id)
    expect(searchPlan.problem).toBeNull()
  })

  test('a range whose lowest value is above its highest holds the search', async () => {
    await ready()
    form.setParam('precursor:min_charge', 5)
    form.setParam('precursor:max_charge', 2)
    expect(searchPlan.inverted.map((r) => r.label)).toEqual(['Charges'])
    expect(searchPlan.problem).toBe('Charges: the lowest (5) is above the highest (2).')
    form.setParam('precursor:max_charge', 5)
    form.setParam('fragment:min_mz', 2500)
    expect(searchPlan.problem).toBe('Fragment m/z: the lowest (2500) is above the highest (2000).')
    form.setParam('fragment:min_mz', 150)
    expect(searchPlan.canStart).toBe(true)
  })

  test('Remove all, then Start over, then Undo brings back the files and the database', async () => {
    await ready()
    form.notices.push('a notice')
    form.removeAllFiles()
    expect(form.removed?.files).toHaveLength(2)
    form.startOver()
    expect(form.files).toEqual([])
    expect(form.database).toBeNull()
    expect(form.removed?.files).toHaveLength(2)
    expect(form.removed?.database?.file.name).toBe('db.fasta')
    form.undoRemove()
    await settle()
    expect(form.files.map((r) => r.file.name)).toEqual(['a.mzML', 'b.mzML'])
    expect(form.database?.file.name).toBe('db.fasta')
    expect(form.notices).toEqual(['a notice'])
    expect(searchPlan.problem).toBeNull()
  })

  test("the example's own settings are no edits that another preset would discard; the user's are", async () => {
    await form.loadExample()
    await settle()
    expect(form.modified).toBe(true)
    expect(form.edited).toBe(false)
    form.setParam('peptide:missed_cleavages', 3)
    expect(form.edited).toBe(true)
    form.choosePreset('timstof-tryptic')
    expect(form.edited).toBe(false)
    expect(form.modified).toBe(false)
  })
})
