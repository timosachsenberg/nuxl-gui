// The search of this session: its progress while it runs, its error, and the result it opened. Kept
// outside the views, so that a search goes on (with its progress in the footer, or in the top bar on
// other views) while the user looks elsewhere. The search runs in the ProSE tool through the shim
// (desktop.ts); when it is done, its folder is read into the web app's result types (results/read.ts).

import type { DesignResolution } from '../design/model'
import {
  cancelSearch as cancelInShim,
  errorText,
  SearchFailed,
  searchFiles,
  startSearch,
  type RunningSearch,
  type SearchProgress,
  type SearchRequest,
} from '../desktop'
import { readSearch, type SearchResult } from '../results/read'
import { releaseResultsView } from '../results/view.svelte'
import { describeFailure, type Failure } from './failure'

/** What a search gave: the reader's result and how long the search took. */
export type SearchOutcome = SearchResult & {
  /** The time from the start of ProSE to its end (s). */
  seconds: number
}

/** A finished search, open in this session (History keeps it: history/history.svelte.ts). */
export type OpenResult = {
  /** The search's id (its folder in the app's searches). */
  id: string
  createdAt: string
  outcome: SearchOutcome
  design: DesignResolution
  /** The search's cutoffs (q-values). */
  psmFdr: number
  proteinFdr: number
  /** Set for a result opened from History or a project file: its name there and who made it. */
  stored?: { name: string; appVersion: string; moduleVersion: string }
  settings: {
    /** The parameters that differ from ProSE's defaults. */
    parameters: Record<string, unknown>
    /** The fixed modifications of the search (OpenMS names), which the tables do not mark. */
    fixedMods: string[]
    /** The FASTA's file name. */
    database: string
    rescore: boolean
    peptdeep: boolean
    contaminants: boolean
    presetId?: string
  }
}

/**
 * A search whose ProSE has ended successfully, before its results are read: History saves its record from
 * this at once (history.svelte.ts), so that a search whose results then cannot be read is not lost.
 */
export type EndedSearch = Omit<OpenResult, 'outcome' | 'stored'> & {
  /** The time from the start of ProSE to its end (s). */
  seconds: number
}

export type RunStatus = 'idle' | 'running' | 'done' | 'failed' | 'cancelled'

export const searchRun = $state<{
  status: RunStatus
  label: string
  /** The input file of the step (-1 outside the files). */
  file: number
  /** The names of the files of the running (or last) search. */
  files: string[]
  /** 0–1 overall, as the shim reports it. */
  fraction: number
  /** The threads the search runs with ("all cores" or a number). */
  threads: number
  /** When the fraction last moved, when the search started, and now (performance.now(); ticks while running). */
  movedAt: number
  startedAt: number
  now: number
  /** What went wrong: the stage and file, the message, ProSE's raw text. */
  failure: Failure | null
  /**
   * ProSE has ended (successfully) and the results are being read: the search is complete and saved, so it
   * can no longer be cancelled (Cancel is hidden).
   */
  toolEnded: boolean
}>({
  status: 'idle',
  label: '',
  file: -1,
  files: [],
  fraction: 0,
  threads: 0,
  movedAt: 0,
  startedAt: 0,
  now: 0,
  failure: null,
  toolEnded: false,
})

/** No move of the fraction for this long: the progress turns indeterminate (Percolator sends no progress). */
export const STALL_MS = 2000

/** "16 threads", "all threads" (0: all cores, as ProSE's -threads 0). */
export function threadsLabel(threads: number): string {
  return threads > 0 ? `${threads} ${threads === 1 ? 'thread' : 'threads'}` : 'all threads'
}

class ProgressView {
  running = $derived(searchRun.status === 'running')
  /** Indeterminate while the fraction does not move: starting ProSE, Percolator, reading the results. */
  indeterminate = $derived(
    this.running && (searchRun.fraction === 0 || searchRun.now - searchRun.movedAt > STALL_MS),
  )
  percent = $derived(Math.round(searchRun.fraction * 100))
  elapsed = $derived.by(() => {
    const s = Math.max(0, Math.floor((searchRun.now - searchRun.startedAt) / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  })
  /** The step, with its file when the search has several ("File 2 of 6 · Post-processing PSMs…"). */
  label = $derived.by(() => {
    const label = searchRun.label.replace(/\.\.\.$/, '…')
    const { file } = searchRun
    const n = searchRun.files.length
    if (n > 1 && file >= 0 && file < n && !label.includes(`of ${n})`)) return `File ${file + 1} of ${n} · ${label}`
    return label
  })
  /** "16 threads", "all threads". */
  threads = $derived(threadsLabel(searchRun.threads))
}

export const searchProgress = new ProgressView()

// raw: the result's columns are large and never change, so they are not made deeply reactive
let open = $state.raw<OpenResult | null>(null)

export const openResult = {
  get current(): OpenResult | null {
    return open
  },
}

/**
 * A search of this session that finished while the user was elsewhere (`runSearch`'s `keepOpen`): the open
 * result stayed open, and this one opens from memory when it is shown (`openFinished`). One at most.
 */
let held: OpenResult | null = null

/**
 * Opens a result that did not come from this session's search (History, a project file) in
 * place of the open one, whose view and caches are released. A stored search keeps its `id` and
 * `createdAt` (`origin`), so that its address stays the same. Returns the id.
 */
export function openStoredResult(result: Omit<OpenResult, 'id' | 'createdAt'>, origin: { id: string; createdAt: string }): string {
  releaseResultsView()
  open = { ...result, id: origin.id, createdAt: origin.createdAt }
  // (a held search opens from History now, read again: it is not kept twice)
  held = null
  return origin.id
}

/**
 * Opens search `id` if it is the one that finished while the user was elsewhere (`held`), in place of the
 * open result; false otherwise.
 */
export function openFinished(id: string): boolean {
  if (held === null || held.id !== id) return false
  releaseResultsView()
  open = held
  held = null
  return true
}

/**
 * Closes search `id` (deleted from History): the open result, if it is that search (its view and caches are
 * released), and a held one. Returns whether it was open.
 */
export function closeResult(id: string): boolean {
  if (held?.id === id) held = null
  if (open?.id !== id) return false
  releaseResultsView()
  open = null
  return true
}

/**
 * Called with every search of this session whose ProSE has ended successfully, before its results are read;
 * the read waits for the listeners (History writes the search's record).
 */
type EndedListener = (search: EndedSearch) => Promise<void> | void
const endedListeners = new Set<EndedListener>()

/** Registers `listener` for the searches whose ProSE ends from now on; returns the way to remove it. */
export function onSearchEnded(listener: EndedListener): () => void {
  endedListeners.add(listener)
  return () => endedListeners.delete(listener)
}

/** Called with every search that finished in this session (not with failed or cancelled ones). */
type FinishedListener = (result: OpenResult) => void
const finishedListeners = new Set<FinishedListener>()

/** Registers `listener` for the searches that finish from now on; returns the way to remove it. */
export function onSearchFinished(listener: FinishedListener): () => void {
  finishedListeners.add(listener)
  return () => finishedListeners.delete(listener)
}

/** The run in flight: a cancelled or replaced run ignores what its promises bring later. */
let runId = 0
/**
 * The search of the run in flight, once the shim has started it and the run is still the current one
 * (cancelling then goes through the shim). Never a search of an earlier, cancelled run.
 */
let current: RunningSearch | null = null
/** Ends the wait for the running search's end (a cancelled search sends neither done nor failed). */
let abandon: (() => void) | null = null

/** How long the events of a cancelled search are still listened to after the shim has ended it. */
const LATE_DONE_MS = 2000

/** Searches that finished as they were cancelled: their folders exist (History removes them). */
const finishedCancelled: string[] = []
const cancelledListeners = new Set<(searchId: string) => void>()

/**
 * Registers `listener` for the searches that finish while they are cancelled (History removes their
 * folders at once); returns the way to remove it.
 */
export function onFinishedWhileCancelled(listener: (searchId: string) => void): () => void {
  cancelledListeners.add(listener)
  return () => cancelledListeners.delete(listener)
}

/**
 * The ids of the searches that finished while they were being cancelled (the shim had already moved
 * their folder into place). Their results are not opened; History removes their folders at once (history.svelte.ts `removeCancelled`).
 */
export function finishedWhileCancelled(): readonly string[] {
  return finishedCancelled
}

/** Forgets a search of `finishedWhileCancelled` (its folder has been dealt with). */
export function forgetFinishedWhileCancelled(searchId: string): void {
  const at = finishedCancelled.indexOf(searchId)
  if (at >= 0) finishedCancelled.splice(at, 1)
}

/**
 * Ends a search the user cancelled, in the shim. Its events are listened to until the shim has ended
 * it and a moment more: a done that comes then (the search had finished as the cancel came) is
 * recorded in `finishedWhileCancelled`.
 */
function endCancelled(search: RunningSearch): void {
  search.done.then(
    () => {
      if (!finishedCancelled.includes(search.searchId)) finishedCancelled.push(search.searchId)
      for (const listener of cancelledListeners) {
        try {
          listener(search.searchId)
        } catch {
          // (a listener must not break the cancel)
        }
      }
    },
    () => {},
  )
  void cancelInShim(search.searchId)
    .catch(() => {})
    .finally(() => setTimeout(search.stop, LATE_DONE_MS))
}
let clock: ReturnType<typeof setInterval> | undefined

function startClock() {
  clearInterval(clock)
  searchRun.now = performance.now()
  clock = setInterval(() => (searchRun.now = performance.now()), 250)
}

function stopClock() {
  clearInterval(clock)
  clock = undefined
}

/** The label of the step after ProSE: its outputs are read into the result. */
export const READING_RESULTS = 'Reading the results...'

/**
 * Runs a search in the ProSE tool. Resolves with the id of the opened result, or null if the search
 * failed or was cancelled (`searchRun` says which). When it finishes, its result becomes the open one,
 * unless `keepOpen` says that the user is elsewhere (another result, a PSM): then a result that is open
 * stays open, and the finished one waits in memory until it is shown (`openFinished`).
 */
export async function runSearch(
  request: SearchRequest,
  meta: Omit<OpenResult, 'id' | 'createdAt' | 'outcome'>,
  keepOpen: () => boolean = () => false,
): Promise<string | null> {
  if (searchRun.status === 'running') return null
  const id = ++runId
  current = null
  const now = performance.now()
  Object.assign(searchRun, {
    status: 'running',
    label: 'Starting ProSE...',
    file: -1,
    files: request.files.map((f) => f.path.split(/[\\/]/).pop() ?? f.path),
    fraction: 0,
    threads: request.settings.threads,
    movedAt: now,
    startedAt: now,
    failure: null,
    toolEnded: false,
  })
  startClock()
  // when the tool last reported (a step without reports, like Percolator, leaves a long silence)
  let reportedAt = now
  const onProgress = (p: SearchProgress) => {
    if (id !== runId || searchRun.status !== 'running') return
    reportedAt = performance.now()
    searchRun.label = p.label
    searchRun.file = p.file
    if (p.fraction > searchRun.fraction) {
      searchRun.fraction = p.fraction
      searchRun.movedAt = performance.now()
    }
  }
  const fail = (failure: Failure) => Object.assign(searchRun, { status: 'failed', failure })
  try {
    const started = await startSearch(request, onProgress)
    if (id !== runId) {
      // cancelled while the shim was starting it (another run may be the current one by now)
      endCancelled(started)
      return null
    }
    current = started
    const abandoned = new Promise<null>((resolve) => (abandon = () => resolve(null)))
    if ((await Promise.race([started.done, abandoned])) === null) return null
    const seconds = (performance.now() - now) / 1000
    // a cancel that came too late (the search had finished): the user asked to stop, so it stays cancelled
    if (id !== runId) return null
    // ProSE has ended: the search is complete, and from here on it is kept, not cancelled
    Object.assign(searchRun, { label: READING_RESULTS, file: -1, toolEnded: true })
    const createdAt = new Date().toISOString()
    const ended: EndedSearch = { ...meta, id: started.searchId, createdAt, seconds }
    // History saves the search's record before its results are read (a listener's failure is its own to report)
    await Promise.allSettled([...endedListeners].map(async (listener) => listener(ended)))
    let result: SearchResult
    try {
      result = await readSearch(searchFiles(started.searchId))
    } catch (e) {
      // the search stays in History, where it can be opened again (SearchError offers it)
      fail({ context: 'While reading the results', summary: errorText(e), detail: null, searchId: started.searchId })
      return null
    }
    const finished: OpenResult = { ...meta, id: started.searchId, createdAt, outcome: { ...result, seconds } }
    if (open !== null && keepOpen()) {
      held = finished
    } else {
      releaseResultsView() // the previous result's view, model and caches
      open = finished
      held = null
    }
    searchRun.status = 'done'
    for (const listener of finishedListeners) {
      try {
        listener(finished)
      } catch {
        // a listener must not turn a finished search into a failed one
      }
    }
    return finished.id
  } catch (e) {
    if (id !== runId) return null
    if (e instanceof SearchFailed) {
      const file = e.file >= 0 ? e.file : searchRun.file
      fail(
        describeFailure(
          { label: e.stage || searchRun.label, file, files: searchRun.files, silentMs: performance.now() - reportedAt },
          e.message,
          e.details,
        ),
      )
    } else {
      // the shim refused the request (a file that cannot be read, ProSE not found)
      fail({ context: 'Before the search', summary: errorText(e), detail: null })
    }
    return null
  } finally {
    if (id === runId) {
      stopClock()
      abandon = null
      current = null
    }
  }
}

/**
 * Cancels the running search: the run ends at once (a search finishing meanwhile is not opened), and
 * the shim ends ProSE and removes its folder. Once ProSE has ended (`toolEnded`: its results are being
 * read) there is nothing to cancel: the search is complete and saved, and this does nothing.
 */
export function cancelSearch(): void {
  if (searchRun.status !== 'running' || searchRun.toolEnded) return
  runId++
  stopClock()
  searchRun.status = 'cancelled'
  abandon?.()
  abandon = null
  if (current !== null) endCancelled(current)
  current = null
}

/** Forgets a finished search's error or cancellation (e.g. when the form changes). */
export function clearRunMessage(): void {
  if (searchRun.status === 'failed' || searchRun.status === 'cancelled') {
    Object.assign(searchRun, { status: 'idle', failure: null })
  }
}
