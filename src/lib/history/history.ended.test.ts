// A search as it ends, through the session's real flow with a fake shim and History on a disk in memory:
// its record is saved as soon as ProSE has ended (before the results are read), proteins.fasta once they
// are read; a search whose results cannot be read stays in History and opens again; Cancel after ProSE's
// end does not lose the search; a record that cannot be written is listed as not saved and saved again.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchRequest } from '../desktop'
import type { SearchFiles } from '../results/read'
import type { MemoryBackend as Disk } from './memory-backend'

const fake = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(async () => {}),
  read: vi.fn(),
  disk: null as Disk | null,
}))

vi.mock('../desktop', () => ({
  SearchFailed: class extends Error {},
  startSearch: fake.start,
  cancelSearch: fake.cancel,
  // the shim's files of a search: the disk's
  searchFiles: (id: string) => (name: string) => fake.disk!.read(id, name),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  desktopBackend: {},
}))
vi.mock('../results/read', async (importOriginal) => ({ ...(await importOriginal<typeof import('../results/read')>()), readSearch: fake.read }))
vi.mock('../route.svelte', () => ({ navigate: () => {} }))

const actual = await vi.importActual<typeof import('../results/read')>('../results/read')
const { exampleFolder, exampleResult } = await import('./fixtures')
const { MemoryBackend } = await import('./memory-backend')
const { cancelSearch, openResult, runSearch, searchRun } = await import('../search/session.svelte')
const { canRetrySave, dismissSaveStatus, history, initHistory, openAgain, refreshHistory, retrySave, useBackend } = await import('./history.svelte')

const request: SearchRequest = {
  files: [
    { id: 'f1', path: '/data/Ecoli_1.mzML' },
    { id: 'f2', path: '/data/Ecoli_2.mzML' },
  ],
  database: '/db/human.fasta',
  contaminants: true,
  settings: { parameters: {}, rescore: true, peptdeep: false, threads: 0 },
}

let fixture: Record<string, Uint8Array>
let meta: Omit<Awaited<ReturnType<typeof exampleResult>>, 'id' | 'createdAt' | 'outcome'>
let disk: Disk

beforeAll(async () => {
  fake.read.mockImplementation((files: SearchFiles) => actual.readSearch(files))
  fixture = exampleFolder()
  const { design, psmFdr, proteinFdr, settings } = await exampleResult(fixture)
  meta = { design, psmFdr, proteinFdr, settings }
  initHistory()
}, 60000)

beforeEach(async () => {
  disk = new MemoryBackend()
  fake.disk = disk
  useBackend(disk)
  dismissSaveStatus()
  searchRun.status = 'idle'
  fake.cancel.mockClear()
  await refreshHistory()
})

const settle = () => new Promise((r) => setTimeout(r, 0))
const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)

/** The search `id` started in the fake shim, its folder as ProSE leaves it; `finish` sends its done. */
function started(id: string) {
  disk.addFolder(id, fixture)
  let finish!: () => void
  const done = new Promise<{ folder: string }>((resolve) => (finish = () => resolve({ folder: `/data/searches/${id}` })))
  fake.start.mockImplementationOnce(async () => ({ searchId: id, done, stop: () => {} }))
  return { finish }
}

describe('a search as it ends', () => {
  it('is saved to History as soon as ProSE has ended, from the request and the footer of its QPX psm file; proteins.fasta follows the read', async () => {
    const search = started('30-0')
    let atRead: { record: boolean; proteins: boolean; listed: boolean } | null = null
    fake.read.mockImplementationOnce(async (files: SearchFiles) => {
      const folder = disk.folders.get('30-0')!
      atRead = { record: folder.has('search.json'), proteins: folder.has('proteins.fasta'), listed: history.entries.some((e) => e.id === '30-0') }
      return actual.readSearch(files)
    })
    const run = runSearch(request, meta)
    await settle()
    search.finish()
    expect(await run).toBe('30-0')
    // when the results were read, the search was in History already (an app closed meanwhile keeps it)
    expect(atRead).toEqual({ record: true, proteins: false, listed: true })
    const record = JSON.parse(text(disk.folders.get('30-0')!.get('search.json')))
    // the PSMs of the footer: 77 target PSMs in each of the two files
    expect(record).toMatchObject({ id: '30-0', name: 'Ecoli', psms: 154, files: ['Ecoli_1.mzML', 'Ecoli_2.mzML'], database: 'human.fasta' })
    expect(record.seconds).toBeGreaterThanOrEqual(0)
    await settle()
    await settle()
    // the results read: proteins.fasta in place of database.fasta
    const folder = disk.folders.get('30-0')!
    expect(folder.has('proteins.fasta')).toBe(true)
    expect(folder.has('database.fasta')).toBe(false)
    expect(history.save).toEqual({ id: '30-0', state: 'saved' })
    expect(history.entries.find((e) => e.id === '30-0')).toMatchObject({ psms: 154, error: null })
  })

  it('cannot be cancelled once ProSE has ended (the done won): it is saved and opened, its folder kept', async () => {
    const search = started('31-0')
    const run = runSearch(request, meta)
    await settle()
    search.finish()
    await settle()
    expect(searchRun.toolEnded).toBe(true)
    cancelSearch()
    expect(searchRun.status).not.toBe('cancelled')
    expect(fake.cancel).not.toHaveBeenCalled()
    expect(await run).toBe('31-0')
    expect(searchRun.status).toBe('done')
    await settle()
    await settle()
    expect(disk.folders.has('31-0')).toBe(true)
    expect(disk.folders.get('31-0')!.has('search.json')).toBe(true)
    expect(history.entries.map((e) => e.id)).toContain('31-0')
  })

  it('whose results cannot be read stays in History, and opens again', async () => {
    const search = started('32-0')
    fake.read.mockRejectedValueOnce(new Error('qpx/1__Ecoli_1.psm.parquet: not a Parquet file'))
    const run = runSearch(request, meta)
    await settle()
    search.finish()
    expect(await run).toBeNull()
    expect(searchRun.status).toBe('failed')
    expect(searchRun.failure).toMatchObject({ context: 'While reading the results', searchId: '32-0' })
    await refreshHistory()
    expect(history.entries.find((e) => e.id === '32-0')).toMatchObject({ error: null, psms: 154 })
    expect(disk.folders.get('32-0')!.has('proteins.fasta')).toBe(false)
    // opened again (from the error, or from History): read, shown, and its proteins.fasta written now
    await openAgain('32-0')
    expect(openResult.current?.id).toBe('32-0')
    expect(disk.folders.get('32-0')!.has('proteins.fasta')).toBe(true)
    expect(disk.folders.get('32-0')!.has('database.fasta')).toBe(false)
  })

  it('whose record cannot be written is listed as not saved, and saved when tried again', async () => {
    const search = started('33-0')
    disk.failures.save = 'read-only'
    const run = runSearch(request, meta)
    await settle()
    search.finish()
    expect(await run).toBe('33-0')
    await settle()
    await settle()
    expect(history.save).toMatchObject({ id: '33-0', state: 'unsaved' })
    expect(history.entries.find((e) => e.id === '33-0')?.error).toMatch(/This search was not saved/)
    expect(canRetrySave('33-0')).toBe(true)
    disk.failures.save = undefined
    await retrySave('33-0')
    expect(history.save).toEqual({ id: '33-0', state: 'saved' })
    expect(history.entries.find((e) => e.id === '33-0')).toMatchObject({ error: null })
    expect(disk.folders.get('33-0')!.has('proteins.fasta')).toBe(true)
  })
})
