// A search that finishes as it is cancelled has its folder removed at once (the app never saves it),
// through the session's real flow with a fake shim.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchRequest } from '../desktop'
import { MemoryBackend } from './memory-backend'

const fake = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(async () => {}) }))

vi.mock('../desktop', () => ({
  SearchFailed: class extends Error {},
  startSearch: fake.start,
  cancelSearch: fake.cancel,
  searchFiles: () => async () => new Uint8Array(),
  errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  desktopBackend: {},
}))
vi.mock('../results/read', () => ({ readSearch: vi.fn() }))
vi.mock('../route.svelte', () => ({ navigate: () => {} }))

const { cancelSearch, finishedWhileCancelled, runSearch, searchRun } = await import('../search/session.svelte')
const { initHistory, useBackend, refreshHistory, history } = await import('./history.svelte')

const request: SearchRequest = {
  files: [{ id: 'f1', path: '/runs/a.mzML' }],
  database: '/db/human.fasta',
  contaminants: false,
  settings: { parameters: {}, rescore: true, peptdeep: false, threads: 0 },
}
const meta = {
  design: { rows: [], samples: [], conditions: [] } as never,
  psmFdr: 0.01,
  proteinFdr: 0.01,
  settings: { parameters: {}, fixedMods: [], database: 'human.fasta', rescore: true, peptdeep: false, contaminants: false },
}
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('a search that finishes while it is cancelled', () => {
  let disk: MemoryBackend
  beforeEach(() => {
    disk = new MemoryBackend()
    useBackend(disk)
    searchRun.status = 'idle'
  })

  it('has its folder deleted right away, and is not in History', async () => {
    initHistory()
    await refreshHistory()
    disk.addFolder('19-0', { 'qpx/quantms.psm.parquet': 'x' })
    let finish!: (d: { folder: string }) => void
    const done = new Promise<{ folder: string }>((r) => (finish = r))
    fake.start.mockImplementationOnce(async () => ({ searchId: '19-0', done, stop: () => {} }))
    const run = runSearch(request, meta)
    await settle()
    cancelSearch()
    // the shim had already moved the folder into place when the cancel came
    finish({ folder: '/data/searches/19-0' })
    await run
    await settle()
    await settle()
    expect(disk.folders.has('19-0')).toBe(false)
    expect(finishedWhileCancelled()).not.toContain('19-0')
    await refreshHistory()
    expect(history.entries).toEqual([])
  })

  it('stays in the list when the folder cannot be deleted yet; the next attempt removes it', async () => {
    disk.addFolder('20-0', { 'qpx/quantms.psm.parquet': 'x' })
    disk.failures.delete = 'busy'
    let finish!: (d: { folder: string }) => void
    const done = new Promise<{ folder: string }>((r) => (finish = r))
    fake.start.mockImplementationOnce(async () => ({ searchId: '20-0', done, stop: () => {} }))
    const run = runSearch(request, meta)
    await settle()
    cancelSearch()
    finish({ folder: '/data/searches/20-0' })
    await run
    await settle()
    await settle()
    expect(disk.folders.has('20-0')).toBe(true)
    expect(finishedWhileCancelled()).toContain('20-0')
    disk.failures.delete = undefined
    const { removeCancelled } = await import('./history.svelte')
    await removeCancelled()
    expect(disk.folders.has('20-0')).toBe(false)
    expect(finishedWhileCancelled()).not.toContain('20-0')
  })
})
