// The desktop bridge: the only module that talks to Tauri (the shim's commands and events, the
// system's dialogs, drag and drop from the file manager). Everything else of the app works with the
// plain types below, so that the screens stay the web app's and the tests need no Tauri.
//
// Commands (src-tauri/src/lib.rs): tool_info, start_search, cancel_search, read_search_file,
// inspect_files, cpu_count, example_files, save_text, save_text_with_companion, save_search_file, history_list,
// history_save_record, history_save_proteins, history_rename, history_delete, search_folder, show_search_folder,
// history_files, history_import, open_project_file,
// save_project_file, save_curation, answer_close, update_check_at_start, open_release_page. Events: search://progress, search://done, search://failed,
// project://progress, app://close-requested. The system's dialogs open one at a time (`oneDialog`). The window's
// theme (`windowTheme`, `onWindowThemeChanged`, `setWindowTheme`). The app's version (`appVersion`).

import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { oneDialog } from './dialogs'
import type { HistoryBackend, HistoryEntry } from './history/history'
import type { ByteRange, SearchFiles } from './results/read'
import { errorText } from './format/error'

/** The OpenNuXL tool the app runs: its version and where it is. */
export type ToolInfo = { version: string; path: string }

/**
 * A file the user chose, by path (never read by the page; the shim reads it where it is). A Bruker .d is a folder: its
 * size is that of its analysis.* files.
 */
export type InputFile = { path: string; name: string; size: number }

/** What New search shows of a file (`inspect_files`): sizes and counts, never contents. */
export type FileFacts = InputFile & {
  /** The spectra of an mzML's header (null: not said; always for a .raw or .d, which the shim does not count). */
  spectra: number | null
  /** The entries of a FASTA and the residues of their sequences. */
  proteins: number | null
  residues: number | null
  /** Why the file cannot be used (missing, unreadable). */
  error: string | null
  /**
   * Why OpenNuXL cannot search the file, which is there (src-tauri/src/content.rs): an mzML that is not one, is cut off
   * or has no spectra; a .d that is not a timsTOF folder (no analysis.tdf or analysis.tsf); a .raw that is a folder
   * (Waters); a FASTA without entries, with an accession twice, a protein too long. Sentences, the file named.
   */
  problem: string | null
  /** What the search treats specially (a FASTA's entries listed twice, which it searches once): sentences, not blocking. */
  warnings: string[]
}

/** A value of an OpenNuXL parameter in the request: a number, a string, a switch (a flag, or a "true"/"false" choice), a list. */
export type ParameterValue = number | string | boolean | string[] | number[]

/** The search request of the shim (src-tauri/src/args.rs `SearchRequest`, camelCase; docs/design.md §3). */
export type SearchRequest = {
  files: { id: string; path: string }[]
  database: string
  /** Append the bundled cRAP to the database, with `CON__` accessions. */
  contaminants: boolean
  settings: {
    /**
     * OpenNuXL's options by their full name (`precursor:mass_tolerance`, `NuXL:presets`; args.rs `PARAMETERS`), those
     * that differ from OpenNuXL's defaults. Never the shim's own (`-in`, `-out*`, `-threads`, the FDR and Percolator
     * options, `NuXL:decoys`).
     */
    parameters: Record<string, ParameterValue>
    /** Percolator (`-percolator_backend builtin`; false: `none`). */
    rescore: boolean
    /** `-threads`; 0: all cores. */
    threads: number
    /** The FDR of the peptide PSMs and of the cross-link PSMs, fractions in (0, 1]. */
    peptideFdr: number
    xlFdr: number
  }
}

/** A step of a running search (`search://progress`). */
export type SearchProgress = { label: string; file: number; fraction: number }

/** What `search://failed` says beyond the message (src-tauri/src/run.rs `FailedEvent`). */
export type FailureDetails = {
  /** How OpenNuXL ended: "OpenNuXL crashed (signal 11, SIGSEGV)", "OpenNuXL ended with exit code 3". */
  ended?: string
  /** OpenNuXL's last lines on stderr. */
  detail?: string
  /** Where the search's whole log was kept (`logs/last-failure.log` of the app's data). */
  log?: string
}

/** How a search ended badly (`search://failed`): OpenNuXL's message, the step and the file, and how it ended. */
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

/** The bundled example: OpenNuXL's test run (one mzML) and its FASTA. */
export function exampleFiles(): Promise<{ spectra: string[]; database: string }> {
  return invoke('example_files')
}

/**
 * The system's open dialog: spectra files (several: mzML, Thermo .raw), Bruker timsTOF .d folders (several), or a
 * database; the chosen paths ([] if cancelled). The .d folders have a dialog of their own: a file dialog cannot pick a
 * folder on Windows and Linux, and one dialog cannot pick files and folders together.
 */
export function chooseFiles(kind: 'spectra' | 'timsFolders' | 'database'): Promise<string[]> {
  return oneDialog<string[]>([], async () => {
    const chosen = await open(
      kind === 'spectra'
        ? {
            multiple: true,
            title: 'Add spectra files',
            filters: [{ name: 'Spectra (mzML, Thermo .raw)', extensions: ['mzML', 'mzml', 'MZML', 'raw', 'RAW'] }],
          }
        : kind === 'timsFolders'
          ? { directory: true, multiple: true, title: 'Add Bruker timsTOF .d folders' }
          : { multiple: false, title: 'Choose a FASTA database', filters: [{ name: 'FASTA', extensions: ['fasta', 'fa', 'faa'] }] },
    )
    if (chosen === null) return []
    return Array.isArray(chosen) ? chosen : [chosen]
  })
}

/**
 * Files dragged from the file manager onto the window: `over` while they are above it (true) or have
 * left (false), `drop` with their paths (files and folders, such as a .d, as the file manager gives them). Returns the
 * way to stop listening.
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

/** Where an export and its companion were written. */
export type SavedWithCompanion = { path: string; companion: string }

/**
 * Saves text where the user chooses (as `saveText`, suggesting `name`) and `companion` beside it, named after the
 * chosen file's stem and `suffix` (`lib.tsv` and `_diann_mods.txt`: `lib_diann_mods.txt`; the suffix is a plain file
 * name ending, src-tauri/src/export.rs). When the companion exists, nothing is written yet: `replace` is asked with
 * its path (the save dialog asked about the chosen file only); true writes both there (the shim kept the chosen file),
 * false writes nothing. Resolves with both paths, or null if the user cancelled.
 */
export function saveTextWithCompanion(
  name: string,
  contents: string,
  suffix: string,
  companion: string,
  replace: (companion: string) => Promise<boolean>,
): Promise<SavedWithCompanion | null> {
  type Saved = SavedWithCompanion & { status: 'written' | 'companionExists' }
  const save = (again: boolean) => invoke<Saved | null>('save_text_with_companion', { name, contents, suffix, companion, replace: again })
  return oneDialog(null, async () => {
    let saved = await save(false)
    if (saved?.status === 'companionExists') {
      if (!(await replace(saved.companion))) return null
      saved = await save(true)
    }
    return saved && { path: saved.path, companion: saved.companion }
  })
}

/**
 * The PSM curation of search `searchId`: its folder's `curation.json` (results/curation.ts), read with
 * read_search_file and written with save_curation. Null outside the desktop app (the marks then last the session).
 */
export function curationStoreFor(searchId: string): { load(): Promise<string | null>; save(text: string): Promise<void> } | null {
  if (!isDesktop()) return null
  return {
    async load() {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(await readSearchFile(searchId, 'curation.json'))
      } catch (e) {
        if ((e as { notFound?: boolean })?.notFound) return null
        throw new Error(errorText(e))
      }
    },
    save: (curation) => invoke('save_curation', { searchId, curation }),
  }
}

/** Copies a file of a search (e.g. `nuxl/run.idXML`) to where the user chooses, suggesting `suggested`. */
export function saveSearchFile(searchId: string, name: string, suggested: string): Promise<string | null> {
  return oneDialog(null, () => invoke<string | null>('save_search_file', { searchId, name, suggested }))
}

/**
 * History's disk: the Rust commands (src-tauri/src/history.rs). A project file (`<name>.nuxl`: the search folder as a
 * zip) is written by the Rust side (src-tauri/src/project.rs); an opened one and the entries of an import go as raw
 * bodies, not as JSON numbers.
 */
export const desktopBackend: HistoryBackend = {
  list: () => invoke<HistoryEntry[]>('history_list'),
  read: readSearchFile,
  saveRecord: (searchId, record) => invoke('history_save_record', { searchId, record }),
  saveProteins: (searchId, proteins) => invoke('history_save_proteins', { searchId, proteins }),
  rename: (searchId, name) => invoke('history_rename', { searchId, name }),
  delete: (searchId) => invoke('history_delete', { searchId }),
  folder: (searchId) => invoke<string>('search_folder', { searchId }),
  // the shim finds the folder by the id and opens the file manager (the page never names a path)
  reveal: (searchId) => invoke('show_search_folder', { searchId }),
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

/** The app's version (tauri.conf.json's, e.g. "0.3.0"); outside Tauri it is unknown (rejects). */
export function appVersion(): Promise<string> {
  return getVersion()
}

/**
 * Whether the automatic new-version check at start may run: false when `NUXL_NO_UPDATE_CHECK` is set (the e2e specs,
 * computers that are not to contact GitHub; src-tauri/src/update.rs). Outside Tauri: false.
 */
export async function updateCheckAtStart(): Promise<boolean> {
  if (!isDesktop()) return false
  try {
    return await invoke<boolean>('update_check_at_start')
  } catch {
    return false
  }
}

/** Opens the page of release `version` (e.g. "0.4.0") in the system's browser; the shim builds the URL itself. */
export function openReleasePage(version: string): Promise<void> {
  return invoke('open_release_page', { version })
}

/** The text of a rejection of a command (a string, or an object with a message). */
export { errorText }
