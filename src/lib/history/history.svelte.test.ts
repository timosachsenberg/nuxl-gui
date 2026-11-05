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
  chooseLocation,
  dismissSaveStatus,
  history,
  openFromHistory,
  openProjectFile,
  refreshHistory,
  removeFromHistory,
  refreshLocation,
  rename,
  restoreFromHistory,
  retrySave,
  revealSearch,
  searchFolderPath,
  saveFinished,
  saveProjectFile,
  searchesFolder,
  useBackend,
  useDefaultLocation,
} from './history.svelte'
import { ProjectError, ProjectVersionError, type SearchesLocation } from './history'

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
  test('Show search folder asks the shim by the id, and says when the search is gone', async () => {
    await finished('1-0', 'first', '2026-10-20T09:00:00.000Z')
    await revealSearch('1-0')
    expect(disk.revealed).toEqual(['1-0'])
    expect(await searchFolderPath('1-0')).toBe('/data/searches/1-0')
    await expect(revealSearch('9-9')).rejects.toThrow('The search 9-9 does not exist.')
    expect(disk.revealed).toEqual(['1-0'])
  })

  test('history lists, renames and deletes', async () => {
    await finished('1-0', 'first', '2026-10-20T09:00:00.000Z')
    await finished('2-0', 'second', '2026-10-20T11:00:00.000Z')
    // the newest first, with what the list shows
    expect(history.ready).toBe(true)
    expect(history.entries.map((e) => [e.id, e.name])).toEqual([
      ['2-0', 'second'],
      ['1-0', 'first'],
    ])
    expect(history.entries[0]).toMatchObject({ files: ['OpenNuXL_1_input.mzML'], database: 'OpenNuXL_1_input.fasta', error: null })
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
    disk.addFolder('4-0', { 'inputs.json': 'x' })
    await refreshHistory()
    expect(history.entries.map((e) => e.id).sort()).toEqual(['1-0', '2-0', '3-0', '4-0'])
    expect(history.entries.find((e) => e.id === '2-0')?.error).toMatch(/search\.json/)
    expect(history.entries.find((e) => e.id === '3-0')?.error).toMatch(/newer version of NuXL Desktop/)
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
    expect(history.entries[0].name).toBe('OpenNuXL_1_input')

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
    expect(await saveProjectFile(open)).toBe('/saved/first.nuxl')
    const bytes = disk.saved[0].bytes
    // open it (the same disk: a second copy of the search)
    disk.projects.set('/p/first.nuxl', bytes)
    disk.chosen = '/p/first.nuxl'
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
    expect(await saveProjectFile({ ...result, id: '5-0' })).toBe('/saved/OpenNuXL_1_input.nuxl')
    expect(history.entries.map((e) => e.id)).toContain('5-0')
    disk.addFolder('6-0', fixture)
    disk.failures.save = 'read-only'
    await expect(saveProjectFile({ ...result, id: '6-0' })).rejects.toThrow(/Not saved to History \(read-only\)/)
  })

  test('a project of a newer version is refused with its message', async () => {
    const { strToU8, zipSync } = await import('fflate')
    disk.projects.set('/p/new.nuxl', zipSync({ 'search.json': strToU8(JSON.stringify({ schema: 3 })) }))
    disk.chosen = '/p/new.nuxl'
    await expect(openProjectFile()).rejects.toThrow(/saved by a newer version of NuXL Desktop \(schema 3\)/)
    expect(history.entries).toEqual([])
  })

  test('a disk error while opening a project is a ProjectError with its text', async () => {
    disk.chosen = '/p/absent.nuxl'
    await expect(openProjectFile()).rejects.toBeInstanceOf(ProjectError)
    await expect(openProjectFile()).rejects.toThrow(/cannot be read/)
  })
})

describe('where searches are saved', () => {
  const own: SearchesLocation = { folder: '/data/searches', isDefault: true, defaultFolder: '/data/searches' }
  const mine: SearchesLocation = { folder: '/mnt/big/NuXL', isDefault: false, defaultFolder: '/data/searches' }

  /** The disk with folders to choose: the dialog gives `answer` (null: cancelled; an Error: the shim refused). */
  function withFolders(answer: () => SearchesLocation | null | Error) {
    let current = own
    Object.assign(disk, {
      location: async () => current,
      chooseLocation: async () => {
        const next = answer()
        if (next instanceof Error) throw next
        if (next) current = next
        return next
      },
      defaultLocation: async () => (current = own),
    })
    return vi.spyOn(disk, 'list')
  }

  test("is read, changed to a folder of the user's and back, and History is read again after each change", async () => {
    let answer: SearchesLocation | null | Error = mine
    const lists = withFolders(() => answer)
    await refreshLocation()
    expect(searchesFolder.location).toEqual(own)
    expect(await chooseLocation()).toBe(true)
    expect(searchesFolder.location).toEqual(mine)
    expect(lists).toHaveBeenCalledTimes(1)
    // cancelled: nothing changes
    answer = null
    expect(await chooseLocation()).toBe(false)
    expect(searchesFolder.location).toEqual(mine)
    expect(lists).toHaveBeenCalledTimes(1)
    expect(await useDefaultLocation()).toBe(true)
    expect(searchesFolder.location).toEqual(own)
    expect(lists).toHaveBeenCalledTimes(2)
    expect(searchesFolder.problem).toBeNull()
    expect(searchesFolder.busy).toBe(false)
  })

  test("a folder the shim refuses says why, and the folder stays", async () => {
    withFolders(() => new Error('/mnt/big holds other files or folders ("notes.txt").'))
    await refreshLocation()
    expect(await chooseLocation()).toBe(false)
    expect(searchesFolder.location).toEqual(own)
    expect(searchesFolder.problem).toBe('/mnt/big holds other files or folders ("notes.txt").')
  })

  test('a disk without folders to choose has no location', async () => {
    await refreshLocation()
    expect(searchesFolder.location).toBeNull()
    expect(await chooseLocation()).toBe(false)
    expect(await useDefaultLocation()).toBe(false)
  })
})
