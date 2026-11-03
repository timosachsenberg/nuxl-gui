// The state of History against a disk in memory: the list, rename and delete, what a finished search
// leaves, opening, and the project file through the store. (The Rust commands have their own tests.)

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Route } from '../route'
import { openResult } from '../search/session.svelte'
import type { OpenResult } from '../search/session.svelte'
import { exampleFolder, exampleResult } from './fixtures'
import { MemoryBackend } from './memory-backend'
import {
  canRetrySave,
  dismissSaveStatus,
  history,
  openFromHistory,
  openProjectFile,
  refreshHistory,
  removeFromHistory,
  rename,
  restoreFromHistory,
  retrySave,
  saveFinished,
  saveProjectFile,
  useBackend,
} from './history.svelte'
import { ProjectError, ProjectVersionError } from './history'

// (the router reads the window's location: here only where the app goes)
const router = vi.hoisted(() => ({ route: { view: 'search' } as Route, forgotten: [] as string[] }))
vi.mock('../route.svelte', () => ({
  router,
  navigate: (next: Route) => (router.route = next),
  forgetResult: (id: string) => router.forgotten.push(id),
}))

let fixture: Record<string, Uint8Array>
let result: OpenResult

beforeAll(async () => {
  fixture = exampleFolder()
  result = await exampleResult(fixture)
}, 60000)

let disk: MemoryBackend

beforeEach(async () => {
  disk = new MemoryBackend()
  useBackend(disk)
  dismissSaveStatus()
  await refreshHistory()
})

/** A finished search `id` in the disk, saved at `createdAt`. */
async function finished(id: string, name: string, createdAt: string) {
  disk.addFolder(id, fixture)
  await saveFinished({ ...result, id, createdAt, stored: { name, appVersion: '0.1.0', moduleVersion: '3.6.0' } })
}

describe('History', () => {
  test('history lists, renames and deletes', async () => {
    await finished('1-0', 'first', '2026-10-20T09:00:00.000Z')
    await finished('2-0', 'second', '2026-10-20T11:00:00.000Z')
    // the newest first, with what the list shows
    expect(history.ready).toBe(true)
    expect(history.entries.map((e) => [e.id, e.name])).toEqual([
      ['2-0', 'second'],
      ['1-0', 'first'],
    ])
    expect(history.entries[0]).toMatchObject({ files: ['Ecoli_1.mzML', 'Ecoli_2.mzML'], database: 'human.fasta', error: null })
    expect(history.entries[0].psms).toBeGreaterThan(0)
    expect(history.entries[0].bytes).toBeGreaterThan(1000)

    await rename('1-0', '  better name ')
    expect(history.entries.find((e) => e.id === '1-0')?.name).toBe('better name')
    // an empty name changes nothing
    await rename('1-0', '   ')
    expect(history.entries.find((e) => e.id === '1-0')?.name).toBe('better name')

    await removeFromHistory('2-0')
    expect(history.entries.map((e) => e.id)).toEqual(['1-0'])
    expect(disk.folders.has('2-0')).toBe(false)
  })

  test('history lists an incomplete folder with its message', async () => {
    await finished('1-0', 'good', '2026-10-20T09:00:00.000Z')
    disk.addFolder('2-0', { 'search.json': '{ broken' })
    disk.addFolder('3-0', { 'search.json': JSON.stringify({ schema: 2, id: '3-0', name: 'future' }) })
    // a finished search that was not saved (no record): listed as such, so that it can be deleted
    disk.addFolder('4-0', { 'qpx/quantms.psm.parquet': 'x' })
    await refreshHistory()
    expect(history.entries.map((e) => e.id).sort()).toEqual(['1-0', '2-0', '3-0', '4-0'])
    expect(history.entries.find((e) => e.id === '2-0')?.error).toMatch(/search\.json/)
    expect(history.entries.find((e) => e.id === '3-0')?.error).toMatch(/newer version of ProSE/)
    expect(history.entries.find((e) => e.id === '4-0')?.error).toMatch(/This search was not saved/)
    expect(history.entries.find((e) => e.id === '1-0')?.error).toBeNull()
    // opening a broken one says why; opening the good one works
    await expect(openFromHistory('2-0')).rejects.toBeInstanceOf(ProjectError)
    await expect(openFromHistory('3-0')).rejects.toBeInstanceOf(ProjectVersionError)
    await expect(openFromHistory('4-0')).rejects.toBeInstanceOf(ProjectError)
    // a broken folder can be deleted
    await removeFromHistory('2-0')
    await removeFromHistory('4-0')
    expect(history.entries.map((e) => e.id).sort()).toEqual(['1-0', '3-0'])
  })

  test('deleting the open search closes it, and Results of it goes to History', async () => {
    await finished('1-0', 'first', '2026-10-20T09:00:00.000Z')
    await finished('2-0', 'second', '2026-10-20T10:00:00.000Z')
    await openFromHistory('1-0')
    expect(router.route).toEqual({ view: 'results', id: '1-0' })
    // another search: the open one stays
    router.forgotten = []
    await removeFromHistory('2-0')
    expect(openResult.current?.id).toBe('1-0')
    expect(router.route).toEqual({ view: 'results', id: '1-0' })
    // the open one, from History: closed, and the Results link forgets it
    router.route = { view: 'history' }
    await removeFromHistory('1-0')
    expect(openResult.current).toBeNull()
    expect(router.forgotten).toEqual(['2-0', '1-0'])
    expect(router.route).toEqual({ view: 'history' })
    // from its Results (an address of it): to History
    await finished('3-0', 'third', '2026-10-20T11:00:00.000Z')
    await openFromHistory('3-0')
    await removeFromHistory('3-0')
    expect(openResult.current).toBeNull()
    expect(router.route).toEqual({ view: 'history' })
  })

  test('a list that cannot be read says so and is empty', async () => {
    disk.failures.list = 'the disk is gone'
    await refreshHistory()
    expect(history.entries).toEqual([])
    expect(history.unavailable).toMatch(/History could not be read \(the disk is gone\)/)
    disk.failures.list = undefined
    await refreshHistory()
    expect(history.unavailable).toBeNull()
  })

  test('a finished search is saved to History, and a failed save is reported, not thrown', async () => {
    disk.addFolder('1-0', fixture)
    await saveFinished({ ...result, id: '1-0' })
    expect(history.save).toEqual({ id: '1-0', state: 'saved' })
    expect(history.entries.map((e) => e.id)).toEqual(['1-0'])
    // the name of a search is that of the exports until it is renamed
    expect(history.entries[0].name).toBe('Ecoli')

    disk.addFolder('2-0', fixture)
    disk.failures.save = 'no space left'
    await saveFinished({ ...result, id: '2-0' })
    expect(history.save).toMatchObject({ id: '2-0', state: 'unsaved' })
    expect((history.save as { message: string }).message).toMatch(/Not saved to History \(no space left\)/)
    // its folder stays, listed as not saved
    expect(history.entries.map((e) => [e.id, e.error === null])).toEqual([
      ['1-0', true],
      ['2-0', false],
    ])
    // the save can be tried again while the app has the record
    expect(canRetrySave('2-0')).toBe(true)
    disk.failures.save = undefined
    await retrySave('2-0')
    expect(history.save).toEqual({ id: '2-0', state: 'saved' })
    expect(canRetrySave('2-0')).toBe(false)
    expect(history.entries.find((e) => e.id === '2-0')?.error).toBeNull()
    dismissSaveStatus()
    expect(history.save).toBeNull()
  })

  test('a saved search gets proteins.fasta in place of database.fasta; a failure there is retried on its next opening', async () => {
    disk.addFolder('7-0', fixture)
    expect(disk.folders.get('7-0')!.has('database.fasta')).toBe(true)
    disk.failures.proteins = 'busy'
    await saveFinished({ ...result, id: '7-0' })
    // saved (the record), without proteins.fasta
    expect(history.save).toEqual({ id: '7-0', state: 'saved' })
    expect(disk.folders.get('7-0')!.has('proteins.fasta')).toBe(false)
    expect(disk.folders.get('7-0')!.has('database.fasta')).toBe(true)
    disk.failures.proteins = undefined
    await openFromHistory('7-0')
    expect(disk.folders.get('7-0')!.has('proteins.fasta')).toBe(true)
    expect(disk.folders.get('7-0')!.has('database.fasta')).toBe(false)
    expect(openResult.current?.outcome.tables).toEqual(result.outcome.tables)
  })

  test('opens a saved search in Results, and an address of one after a restart', async () => {
    await finished('1-0', 'first', '2026-10-20T09:00:00.000Z')
    expect(openResult.current?.id).not.toBe('1-0')
    await openFromHistory('1-0')
    expect(openResult.current).toMatchObject({ id: '1-0', createdAt: '2026-10-20T09:00:00.000Z', stored: { name: 'first' } })
    expect(openResult.current?.outcome.tables).toEqual(result.outcome.tables)
    expect(router.route).toEqual({ view: 'results', id: '1-0' })

    // the app starts again: nothing open, the address names the search
    await finished('2-0', 'second', '2026-10-20T10:00:00.000Z')
    expect(await restoreFromHistory('2-0')).toBe(true)
    expect(openResult.current?.id).toBe('2-0')
    expect(await restoreFromHistory('9-9')).toBe(false)
  })

  test('a project saves from a search and opens again as a new search of History', async () => {
    await finished('1-0', 'first', '2026-10-20T09:00:00.000Z')
    const open = { ...result, id: '1-0', stored: { name: 'first', appVersion: '0.1.0', moduleVersion: '3.6.0' } }
    expect(await saveProjectFile(open)).toBe('/saved/first.prose')
    const bytes = disk.saved[0].bytes
    // open it (the same disk: a second copy of the search)
    disk.projects.set('/p/first.prose', bytes)
    disk.chosen = '/p/first.prose'
    expect(await openProjectFile()).toBe(true)
    expect(history.entries).toHaveLength(2)
    const copy = history.entries.find((e) => e.id !== '1-0')!
    expect(openResult.current?.id).toBe(copy.id)
    expect(router.route).toEqual({ view: 'results', id: copy.id })
    // (the project names the searched files, it does not place them)
    expect(openResult.current?.outcome.tables).toEqual({
      ...result.outcome.tables,
      files: result.outcome.tables.files.map((f) => f.split('/').pop()),
    })
    // a cancelled dialog opens nothing
    disk.chosen = null
    expect(await openProjectFile()).toBe(false)
    disk.cancelSave = true
    expect(await saveProjectFile(open)).toBeNull()
  })

  test('the project of a search that failed to save is saved to History first; if that fails, it says so', async () => {
    disk.addFolder('5-0', fixture)
    expect(await saveProjectFile({ ...result, id: '5-0' })).toBe('/saved/Ecoli.prose')
    expect(history.entries.map((e) => e.id)).toContain('5-0')
    disk.addFolder('6-0', fixture)
    disk.failures.save = 'read-only'
    await expect(saveProjectFile({ ...result, id: '6-0' })).rejects.toThrow(/Not saved to History \(read-only\)/)
  })

  test('a project of a newer version is refused with its message', async () => {
    const { strToU8, zipSync } = await import('fflate')
    disk.projects.set('/p/new.prose', zipSync({ 'search.json': strToU8(JSON.stringify({ schema: 3 })) }))
    disk.chosen = '/p/new.prose'
    await expect(openProjectFile()).rejects.toThrow(/saved by a newer version of ProSE \(schema 3\)/)
    expect(history.entries).toEqual([])
  })

  test('a disk error while opening a project is a ProjectError with its text', async () => {
    disk.chosen = '/p/absent.prose'
    await expect(openProjectFile()).rejects.toBeInstanceOf(ProjectError)
    await expect(openProjectFile()).rejects.toThrow(/cannot be read/)
  })
})
