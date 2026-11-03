// The desktop bridge: the only module that talks to Tauri (the shim's commands and events, the
// system's dialogs, drag and drop from the file manager). Everything else of the app works with the
// plain types below, so that the screens stay the web app's and the tests need no Tauri.
//
// Commands (src-tauri/src/lib.rs): tool_info, start_search, cancel_search, read_search_file,
// inspect_files, cpu_count, example_files, save_text, save_search_file, history_list, history_save_record,
// history_save_proteins, history_rename, history_delete, history_files, history_import, open_project_file,
// save_project_file, answer_close. Events: search://progress, search://done, search://failed,
// project://progress, app://close-requested. The system's dialogs open one at a time (`oneDialog`). The window's
// theme (`windowTheme`, `onWindowThemeChanged`, `setWindowTheme`).

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { oneDialog } from './dialogs'
import type { HistoryBackend, HistoryEntry } from './history/history'
import type { ByteRange, SearchFiles } from './results/read'
import { errorText } from './format/error'

/** The ProSE tool the app runs: its version, where it is, and whether it has ONNX Runtime (PeptDeep). */
export type ToolInfo = { version: string; path: string; onnx: boolean }

/** A file the user chose, by path (never read by the page; the shim reads it where it is). */
export type InputFile = { path: string; name: string; size: number }

/** What New search shows of a file (`inspect_files`): sizes and counts, never contents. */
export type FileFacts = InputFile & {
  /** The spectra of an mzML's header (null: not said). */
  spectra: number | null
  /** The entries of a FASTA and the residues of their sequences. */
  proteins: number | null
  residues: number | null
  /** Why the file cannot be used (missing, unreadable). */
  error: string | null
  /**
   * Why ProSE cannot search the file, which is there (src-tauri/src/content.rs): an mzML that is not one, is cut off
   * or has no spectra; a FASTA without entries, with an accession twice, a protein too long. Sentences, the file named.
   */
  problem: string | null
  /** What ProSE treats specially (a FASTA's entries listed twice, which it searches once): sentences, not blocking. */
  warnings: string[]
}

/** The search request of the shim (src-tauri/src/args.rs `SearchRequest`, camelCase). */
export type SearchRequest = {
  files: { id: string; path: string }[]
  database: string
  contaminants: boolean
  settings: {
    /** ProSE's `Search:` parameters by name without the prefix (args.rs `PARAMETERS`). */
    parameters: Record<string, unknown>
    rescore: boolean
    peptdeep: boolean
    /** `-threads`; 0: all cores. */
    threads: number
  }
}

/** A step of a running search (`search://progress`). */
export type SearchProgress = { label: string; file: number; fraction: number }

/** What `search://failed` says beyond the message (src-tauri/src/run.rs `FailedEvent`). */
export type FailureDetails = {
  /** How ProSE ended: "ProSE crashed (signal 11, SIGSEGV)", "ProSE ended with exit code 3". */
  ended?: string
  /** ProSE's last lines on stderr. */
  detail?: string
  /** Where the search's whole log was kept (`logs/last-failure.log` of the app's data). */
  log?: string
}

/** How a search ended badly (`search://failed`): ProSE's message, the step and the file, and how it ended. */
export class SearchFailed extends Error {
  constructor(
    message: string,
    readonly stage: string,
    readonly file: number,
    readonly details: FailureDetails = {},
  ) {
    super(message)
    this.name = 'SearchFailed'
  }
}

/**
 * A search that has started: its id, how it ends (the folder of its outputs), and `stop` to stop
 * listening to it (after a cancel, which sends neither done nor failed).
 */
export type RunningSearch = { searchId: string; done: Promise<{ folder: string }>; stop: () => void }

/** The app runs in Tauri (not in a plain browser, e.g. `vite dev` without the shell). */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function toolInfo(): Promise<ToolInfo> {
  return invoke<ToolInfo>('tool_info')
}

type ProgressPayload = SearchProgress & { searchId: string }
type DonePayload = { searchId: string; folder: string }
type FailedPayload = { searchId: string; message: string; stage: string; file?: number } & FailureDetails

/**
 * Starts a search. The events of the search go to `onProgress` until it ends; `done` resolves with
 * its folder or rejects with `SearchFailed`. Events are listened to before the search starts, so none
 * is missed; those of other searches are ignored. A cancelled search (`cancelSearch`) sends neither
 * done nor failed, unless it finished just before the cancel reached it (then done comes).
 */
export async function startSearch(request: SearchRequest, onProgress: (p: SearchProgress) => void): Promise<RunningSearch> {
  let id: string | null = null
  // events that come before start_search has answered (the first ones, with the id still unknown)
  const early: { kind: 'progress' | 'done' | 'failed'; payload: ProgressPayload | DonePayload | FailedPayload }[] = []
  let settle: { resolve: (d: { folder: string }) => void; reject: (e: Error) => void } | null = null
  const done = new Promise<{ folder: string }>((resolve, reject) => (settle = { resolve, reject }))
  const unlisten: UnlistenFn[] = []
  const stop = () => unlisten.splice(0).forEach((u) => u())

  const handle = (kind: 'progress' | 'done' | 'failed', payload: ProgressPayload | DonePayload | FailedPayload) => {
    if (id === null) {
      early.push({ kind, payload })
      return
    }
    if (payload.searchId !== id) return
    if (kind === 'progress') {
      const p = payload as ProgressPayload
      onProgress({ label: p.label, file: p.file, fraction: p.fraction })
    } else if (kind === 'done') {
      stop()
      settle!.resolve({ folder: (payload as DonePayload).folder })
    } else {
      const f = payload as FailedPayload
      stop()
      settle!.reject(new SearchFailed(f.message, f.stage, f.file ?? -1, { ended: f.ended, detail: f.detail, log: f.log }))
    }
  }

  unlisten.push(
    await listen<ProgressPayload>('search://progress', (e) => handle('progress', e.payload)),
    await listen<DonePayload>('search://done', (e) => handle('done', e.payload)),
    await listen<FailedPayload>('search://failed', (e) => handle('failed', e.payload)),
  )
  try {
    const started = await invoke<{ searchId: string }>('start_search', { request })
    id = started.searchId
  } catch (e) {
    stop()
    throw new Error(errorText(e))
  }
  for (const { kind, payload } of early.splice(0)) handle(kind, payload)
  return { searchId: id, done, stop }
}

/** Ends a running search; resolves when its process is gone (a finished or unknown id is fine). */
export function cancelSearch(searchId: string): Promise<void> {
  return invoke('cancel_search', { searchId })
}

/** A file of a search's folder (all of it, or the bytes of `range`): the command read_search_file. */
async function readSearchFile(searchId: string, name: string, range?: ByteRange): Promise<Uint8Array> {
  const part = !range ? {} : 'tail' in range ? { tail: range.tail } : { offset: range.offset, length: range.length }
  return new Uint8Array(await invoke<ArrayBuffer>('read_search_file', { searchId, name, ...part }))
}

/**
 * The files of a search for the results reader (`readSearch`): its folder's files by relative name,
 * and the database it was searched with (its database.json) by absolute path. A missing file rejects with
 * `{ notFound: true, message }`.
 */
export function searchFiles(searchId: string): SearchFiles {
  return (name, range) => readSearchFile(searchId, name, range)
}

/** Sizes and counts of files given by path (the open dialog, drag and drop, the example). */
export function inspectFiles(paths: string[]): Promise<FileFacts[]> {
  return invoke<FileFacts[]>('inspect_files', { paths })
}

/** The cores the search's threads may use (`navigator.hardwareConcurrency` is capped by the webview). */
export function cpuCount(): Promise<number> {
  return invoke<number>('cpu_count')
}

/** The bundled example: the run as two named files, and its FASTA. */
export function exampleFiles(): Promise<{ spectra: string[]; database: string }> {
  return invoke('example_files')
}

/** The system's open dialog for spectra (several) or a database; the chosen paths ([] if cancelled). */
export function chooseFiles(kind: 'spectra' | 'database'): Promise<string[]> {
  return oneDialog<string[]>([], async () => {
    const chosen = await open(
      kind === 'spectra'
        ? { multiple: true, title: 'Add mzML files', filters: [{ name: 'mzML', extensions: ['mzML', 'mzml', 'gz'] }] }
        : { multiple: false, title: 'Choose a FASTA database', filters: [{ name: 'FASTA', extensions: ['fasta', 'fa', 'faa'] }] },
    )
    if (chosen === null) return []
    return Array.isArray(chosen) ? chosen : [chosen]
  })
}

/**
 * Files dragged from the file manager onto the window: `over` while they are above it (true) or have
 * left (false), `drop` with their paths. Returns the way to stop listening.
 */
export async function onFileDrop(handlers: { over: (on: boolean) => void; drop: (paths: string[]) => void }): Promise<() => void> {
  if (!isDesktop()) return () => {}
  return getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload
    if (p.type === 'enter' || p.type === 'over') handlers.over(true)
    else if (p.type === 'leave') handlers.over(false)
    else if (p.type === 'drop') {
      handlers.over(false)
      handlers.drop(p.paths)
    }
  })
}

/**
 * Saves text (CSV, design.tsv, SVG) where the user chooses in the system's save dialog, suggesting
 * `name`. Resolves with the path, or null if the user cancelled.
 */
export function saveText(name: string, contents: string): Promise<string | null> {
  return oneDialog(null, () => invoke<string | null>('save_text', { name, contents }))
}

/** Copies a file of a search (e.g. `merged.idXML`) to where the user chooses, suggesting `suggested`. */
export function saveSearchFile(searchId: string, name: string, suggested: string): Promise<string | null> {
  return oneDialog(null, () => invoke<string | null>('save_search_file', { searchId, name, suggested }))
}

/**
 * History's disk: the Rust commands (src-tauri/src/history.rs). A project file is written by the Rust side
 * (src-tauri/src/project.rs); an opened one and the entries of an import go as raw bodies, not as JSON numbers.
 */
export const desktopBackend: HistoryBackend = {
  list: () => invoke<HistoryEntry[]>('history_list'),
  read: readSearchFile,
  saveRecord: (searchId, record) => invoke('history_save_record', { searchId, record }),
  saveProteins: (searchId, proteins) => invoke('history_save_proteins', { searchId, proteins }),
  rename: (searchId, name) => invoke('history_rename', { searchId, name }),
  delete: (searchId) => invoke('history_delete', { searchId }),
  files: (searchId) => invoke('history_files', { searchId }),
  // the dialog and the writing are one command: the zip goes to disk entry by entry, `project://progress` says how far
  saveProject: (searchId, name, onProgress) =>
    oneDialog(null, async () => {
      const unlisten = onProgress
        ? await listen<{ searchId: string; written: number; total: number }>('project://progress', (e) => {
            if (e.payload.searchId === searchId) onProgress(e.payload.total > 0 ? e.payload.written / e.payload.total : 1)
          })
        : null
      try {
        return await invoke<string | null>('save_project_file', { searchId, name })
      } finally {
        unlisten?.()
      }
    }),
  // the dialog and the read are one command: the page never names a path (cancelled: an empty body)
  openProject: () =>
    oneDialog(null, async () => {
      const bytes = new Uint8Array(await invoke<ArrayBuffer>('open_project_file'))
      return bytes.length === 0 ? null : bytes
    }),
  importEntries: (body) => invoke<string>('history_import', body),
}

/**
 * The window's close button while a search runs: the app keeps the window and asks (`app://close-requested`);
 * `handler` shows the question. Returns the way to stop listening.
 */
export async function onCloseRequested(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  return listen('app://close-requested', () => handler())
}

/** The window's theme as the system gives it (null outside Tauri, or when it cannot be read). */
export async function windowTheme(): Promise<'light' | 'dark' | null> {
  if (!isDesktop()) return null
  try {
    return await getCurrentWindow().theme()
  } catch {
    return null
  }
}

/** Changes of the window's theme (the system's, or the one `setWindowTheme` sets). Returns the way to stop listening. */
export async function onWindowThemeChanged(handler: (theme: 'light' | 'dark') => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  return getCurrentWindow().onThemeChanged(({ payload }) => handler(payload))
}

/**
 * The theme of the window itself (its title bar, the system's dialogs): light or dark, or null to follow
 * the system again. A failure is ignored (the page has its theme either way).
 */
export async function setWindowTheme(theme: 'light' | 'dark' | null): Promise<void> {
  if (!isDesktop()) return
  try {
    await getCurrentWindow().setTheme(theme)
  } catch {
    // e.g. a platform without it
  }
}

/** The answer to a close request: close (the running search ends), or keep the window. */
export function answerClose(close: boolean): Promise<void> {
  return invoke('answer_close', { close })
}

/** The text of a rejection of a command (a string, or an object with a message). */
export { errorText }
