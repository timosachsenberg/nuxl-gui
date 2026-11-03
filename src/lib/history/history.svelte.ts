// The state of History for the views: the saved searches, what became of the last save, and the actions
// of the views (open from History, save and open a project file, rename, delete). A search is saved here
// automatically: its record as soon as ProSE has ended (before its results are read, so that a search
// whose results cannot be read stays in History and can be opened again), its proteins.fasta once its
// results are read. Saving never breaks the results view, it only reports. A search that finished while it
// was being cancelled has its folder removed at once.

import { desktopBackend, errorText } from '../desktop'
import { resultName } from '../results/display'
import { forgetResult, navigate, router } from '../route.svelte'
import {
  closeResult,
  finishedWhileCancelled,
  forgetFinishedWhileCancelled,
  onFinishedWhileCancelled,
  onSearchEnded,
  onSearchFinished,
  openFinished,
  openResult,
  openStoredResult,
  type EndedSearch,
  type OpenResult,
} from '../search/session.svelte'
import { toolState } from '../search/tool.svelte'
import {
  endedRecordOf,
  exportProject,
  importProject,
  openSearch,
  ProjectError,
  proteinsFasta,
  psmsOfSearch,
  recordOf,
  type HistoryBackend,
  type HistoryEntry,
} from './history'

/** What became of the save of a finished search. */
export type SaveStatus =
  | { id: string; state: 'saving' }
  | { id: string; state: 'saved' }
  | { id: string; state: 'unsaved'; message: string }

let backend: HistoryBackend = desktopBackend

/** Uses another disk (the tests'). */
export function useBackend(next: HistoryBackend): void {
  backend = next
}

let entries = $state.raw<HistoryEntry[]>([])
let ready = $state(false)
let problem = $state<string | null>(null)
let status = $state<SaveStatus | null>(null)

export const history = {
  /** The saved searches, the latest first (a folder that cannot be opened has `error`). */
  get entries(): HistoryEntry[] {
    return entries
  },
  /** The list has been read. */
  get ready(): boolean {
    return ready
  },
  /** Why the list could not be read, or null. */
  get unavailable(): string | null {
    return problem
  },
  /** The last save of a finished search. */
  get save(): SaveStatus | null {
    return status
  },
}

const KEEP_AS_FILE = 'The results stay open here, but the search is not in History.'

/** What to tell the user about a save that did not happen. */
export function describeSaveFailure(error: unknown): string {
  return `Not saved to History (${errorText(error)}). ${KEEP_AS_FILE}`
}

/** The latest refresh: an older one that finishes later must not overwrite its list. */
let refreshes = 0

/** Reads the list of saved searches. */
export async function refreshHistory(): Promise<void> {
  const refresh = ++refreshes
  try {
    const listed = await backend.list()
    if (refresh !== refreshes) return
    entries = listed
    problem = null
  } catch (e) {
    if (refresh !== refreshes) return
    entries = []
    problem = `History could not be read (${errorText(e)}).`
  } finally {
    ready = true
  }
}

/**
 * The name of a result in History and in its project file: the one History has (it may have been
 * renamed since it was opened), else the one it was stored with, else the exports' (from its files).
 */
function nameOf(result: Pick<OpenResult, 'id' | 'design' | 'stored'>): string {
  const listed = entries.find((e) => e.id === result.id)?.name
  return listed ?? result.stored?.name ?? resultName(result.design.rows.map((r) => r.fileName))
}

const toolVersion = () => toolState.info?.version ?? 'unknown'

/** Whether History lists the search as saved (with a record it can open). */
const isListed = (id: string) => entries.some((e) => e.id === id && e.error === null)

/** The records of this session's searches whose save failed: written again by `retrySave` and `openAgain`. */
const unsavedRecords = new Map<string, string>()

let queue: Promise<unknown> = Promise.resolve()

/** Runs `work` after the saves before it (saves go one after the other). */
function queued(work: () => Promise<void>): Promise<void> {
  const run = queue.then(work)
  queue = run.catch(() => {})
  return run
}

/** Writes a record; the outcome is `history.save` (true: saved). */
async function writeRecord(id: string, record: string): Promise<boolean> {
  status = { id, state: 'saving' }
  try {
    await backend.saveRecord(id, record)
  } catch (e) {
    unsavedRecords.set(id, record)
    status = { id, state: 'unsaved', message: describeSaveFailure(e) }
    return false
  }
  unsavedRecords.delete(id)
  status = { id, state: 'saved' }
  return true
}

/**
 * Saves the record of a search whose ProSE has just ended, before its results are read: from the request
 * and the target PSMs of its QPX run view (0 if that cannot be read). Never rejects: the outcome is
 * `history.save`.
 */
export function saveEnded(search: EndedSearch): Promise<void> {
  return queued(async () => {
    let psms = 0
    try {
      psms = await psmsOfSearch(backend, search.id)
    } catch {
      // (the record is written all the same; the reader reports a summary that cannot be read)
    }
    const record = endedRecordOf(search, nameOf({ ...search, stored: undefined }), toolVersion(), psms)
    await writeRecord(search.id, JSON.stringify(record))
    await refreshHistory()
  })
}

/**
 * Completes the save of a search whose results have been read in this session: its record, if it has none
 * yet (the save when ProSE ended failed, or a result opened otherwise), then its proteins.fasta, which
 * replaces the folder's database.fasta. Saves go one after the other; this never rejects: the outcome is
 * `history.save` (a failure of proteins.fasta alone is not reported: the search is saved, opens with its
 * database, and its next opening writes proteins.fasta).
 */
export function saveFinished(result: OpenResult): Promise<void> {
  return queued(async () => {
    if (!isListed(result.id)) await refreshHistory()
    if (!isListed(result.id) && !(await writeRecord(result.id, JSON.stringify(recordOf(result, nameOf(result), toolVersion()))))) return
    await backend.saveProteins(result.id, proteinsFasta(result.outcome.tables)).catch(() => {})
    await refreshHistory()
  })
}

/** Whether the save of search `id` failed in this session and can be tried again (`retrySave`). */
export function canRetrySave(id: string): boolean {
  return unsavedRecords.has(id)
}

/**
 * Tries the failed save of search `id` again: its record, and, when its result is open, its
 * proteins.fasta. The outcome is `history.save`.
 */
export function retrySave(id: string): Promise<void> {
  const open = openResult.current
  if (open?.id === id) return saveFinished(open)
  const record = unsavedRecords.get(id)
  if (record === undefined) return Promise.resolve()
  return queued(async () => {
    await writeRecord(id, record)
    await refreshHistory()
  })
}

/**
 * Opens search `id` again after its results could not be read: its record is saved first if that had
 * failed, then the results are read again and shown (Results). Throws what is wrong, as `openFromHistory`.
 */
export async function openAgain(id: string): Promise<void> {
  if (unsavedRecords.has(id)) {
    await retrySave(id)
    if (unsavedRecords.has(id)) throw new ProjectError((status?.state === 'unsaved' && status.message) || 'The search is not saved to History.')
  }
  await openFromHistory(id)
}

/** Removes the folders of the searches that finished while they were cancelled. */
export async function removeCancelled(): Promise<void> {
  for (const id of [...finishedWhileCancelled()]) {
    try {
      await backend.delete(id)
      forgetFinishedWhileCancelled(id)
    } catch {
      // (it stays in the list; the sweep at the next start removes it after a while)
    }
  }
}

let started = false

/** Starts History: saves the searches that end and finish, removes the cancelled ones, reads the list. */
export function initHistory(): void {
  if (started) return
  started = true
  onSearchEnded((search) => saveEnded(search))
  onSearchFinished((result) => void saveFinished(result))
  onFinishedWhileCancelled(() => void removeCancelled())
  void removeCancelled()
  void refreshHistory()
}

/** Shows a saved search in Results and returns its id. Throws a ProjectError that says what is wrong. */
async function show(id: string): Promise<void> {
  const { result, origin } = await openSearch(backend, id)
  openStoredResult(result, origin)
  navigate({ view: 'results', id })
}

/**
 * Opens a saved search in Results; the one already open is just shown, one of this session that finished
 * while the user was elsewhere comes from memory (`openFinished`).
 */
export async function openFromHistory(id: string): Promise<void> {
  if (openResult.current?.id === id || openFinished(id)) {
    navigate({ view: 'results', id })
    return
  }
  await show(id)
}

/** Reopens the search of an address (`#/results/<id>`), e.g. after a restart; false if History does not have it. */
export async function restoreFromHistory(id: string): Promise<boolean> {
  if (openResult.current?.id === id || openFinished(id)) return true
  if (!ready) await refreshHistory()
  if (!entries.some((e) => e.id === id)) return false
  const { result, origin } = await openSearch(backend, id)
  openStoredResult(result, origin)
  return true
}

/**
 * Asks for a project file (the open dialog), makes a saved search of it and opens it in Results.
 * Resolves with false if the user cancelled. Throws a ProjectError (a ProjectVersionError for a newer
 * file) that says what is wrong.
 */
export async function openProjectFile(): Promise<boolean> {
  let id: string | null
  try {
    id = await importProject(backend)
  } catch (e) {
    if (e instanceof ProjectError) throw e
    throw new ProjectError(errorText(e))
  }
  if (id === null) return false
  await refreshHistory()
  await show(id)
  return true
}

/**
 * Saves `result` as a project file where the user chooses (the save dialog), `onProgress` told how far the
 * writing is (0–1). A search that is not in History yet (its save failed) is saved first. Resolves with the
 * path, or null if the user cancelled.
 */
export async function saveProjectFile(result: OpenResult, onProgress?: (fraction: number) => void): Promise<string | null> {
  if (!isListed(result.id)) await refreshHistory()
  if (!isListed(result.id)) {
    await saveFinished(result)
    if (status?.state === 'unsaved' && status.id === result.id) throw new ProjectError(status.message)
  }
  return exportProject(backend, result.id, nameOf(result), onProgress)
}

/**
 * Deletes search `id` from History. If it is the open result, it is closed (its spectra, read as PSMs are
 * opened, are gone), the "Results" link no longer leads to it, and Results of it goes to History.
 */
export async function removeFromHistory(id: string): Promise<void> {
  await backend.delete(id)
  closeResult(id)
  forgetResult(id)
  if (router.route.view === 'results' && router.route.id === id) navigate({ view: 'history' })
  await refreshHistory()
}

/** Renames a saved search; an open result of it takes the name (Export › Project writes it, see `nameOf`). */
export async function rename(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (trimmed === '') return
  await backend.rename(id, trimmed)
  await refreshHistory()
}

/** Forgets the notice about the last save. */
export function dismissSaveStatus(): void {
  status = null
}
