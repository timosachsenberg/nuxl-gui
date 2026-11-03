// History and project files, without Tauri or Svelte: the record of a search (`search.json`), what is
// written to the search's folder when the search is saved, how a folder is opened again, and the
// project file (`.prose`: the folder's regular files as a zip, made and read here with fflate).
//
// The folder is the shim's (docs/parity.md for the tool's outputs); History adds
//
//   search.json     the record below, written as soon as ProSE has ended (before the results are read,
//                   from the request and the QPX run view qpx/quantms.run.parquet): a folder with it is a
//                   saved search
//   proteins.fasta  every protein of the result's protein table (accession, description, sequence;
//                   generated decoys as searched), written once the results are read, so that the search
//                   opens when the FASTA it was searched with has moved, or on another computer; the
//                   folder's database.fasta (the FASTA with the contaminants) goes then
//
// A project file holds the same files (the links to the inputs are not files and stay out). It is written
// by the Rust side, entry by entry from the folder's files to the file the user chose (src-tauri/src/project.rs;
// what it would hold is checked here first). Opening one writes its files to a fresh folder of the app, as a
// new search of History.
//
// The disk is behind `HistoryBackend` (desktop.ts: the Rust commands), so that the tests run against
// a folder in memory.

import { strToU8, unzipSync } from 'fflate'
import type { DesignResolution } from '../design/model'
import { readSearch, RUNS, type ByteRange, type SearchFiles } from '../results/read'
import type { ResultTables } from '../results/types'
import { formatBytes } from '../format/bytes'
import { errorText } from '../format/error'
import { fileSafe, resultName } from '../results/display'
import { readRuns, targetPsmsOf } from '../results/summary'
import type { EndedSearch, OpenResult } from '../search/session.svelte'
// (only the version: a named import of a JSON module leaves the rest of package.json out of the bundle)
import { version } from '../../../package.json'

/** The version of `search.json` and of the project file. A newer file is refused, not guessed at. */
export const SCHEMA_VERSION = 1

/** The version of this app (package.json), written to the records it saves. */
export const APP_VERSION: string = version

export const RECORD_FILE = 'search.json'
export const PROTEINS_FILE = 'proteins.fasta'

/** What `search.json` holds. */
export type SearchRecord = {
  schema: typeof SCHEMA_VERSION
  /** The search's folder in the app's searches. */
  id: string
  name: string
  /** ISO 8601, when the search finished. */
  createdAt: string
  /** The version of the app that saved it, and of the ProSE tool that searched. */
  appVersion: string
  toolVersion: string
  /** The names of the searched files, in the order of the design. */
  files: string[]
  /** The FASTA's file name. */
  database: string
  design: DesignResolution
  settings: {
    /** The parameters that differ from ProSE's defaults. */
    parameters: Record<string, unknown>
    /** The fixed modifications of the search (OpenMS names), which the tables do not mark. */
    fixedMods: string[]
    rescore: boolean
    peptdeep: boolean
    contaminants: boolean
    presetId?: string
  }
  /** Target PSMs within the PSM FDR: the key figure of the list. */
  psms: number
  /** The search's cutoffs (q-values). */
  psmFdr: number
  proteinFdr: number
  /** The time of the search proper, in seconds. */
  seconds: number
  /** Set (by the Rust side) on a search made of a project file: it reads only the files of its folder. */
  imported?: boolean
}

/**
 * What History lists of a search (`history_list`); a folder that cannot be opened has `error` (also one whose
 * name is no search's: `history::NOT_A_SEARCH`).
 */
export type HistoryEntry = {
  id: string
  name: string | null
  createdAt: string | null
  appVersion: string | null
  toolVersion: string | null
  files: string[]
  database: string | null
  psms: number | null
  /** The search's cutoffs (q-values). */
  psmFdr: number | null
  proteinFdr: number | null
  /** The record's settings as they are (History tells searches of one name apart by them: details.ts). */
  settings: Partial<SearchRecord['settings']> | null
  /** What the folder takes on disk. */
  bytes: number
  error: string | null
}

/** A project file or a stored search that cannot be read. The message says what is wrong with it. */
export class ProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectError'
  }
}

/** The project (or stored search) was saved by a newer version of ProSE than this one. */
export class ProjectVersionError extends ProjectError {
  readonly schema: number
  constructor(schema: number, kind: 'project' | 'search' = 'project') {
    super(
      `This ${kind} was saved by a newer version of ProSE (schema ${schema}) and cannot be opened by this one ` +
        `(it reads schema ${SCHEMA_VERSION}). Open it with the latest version of ProSE.`,
    )
    this.name = 'ProjectVersionError'
    this.schema = schema
  }
}

/** The disk (desktop.ts implements it with the Rust commands; the tests with a folder in memory). */
export interface HistoryBackend {
  list(): Promise<HistoryEntry[]>
  /** A file of a search folder, or the bytes of `range` of it (rejects `{ notFound: true }` if it is not there). */
  read(id: string, name: string, range?: ByteRange): Promise<Uint8Array>
  /** Writes the record: the search is then in History (a search that has one keeps it). */
  saveRecord(id: string, record: string): Promise<void>
  /** Writes `proteins.fasta` of a saved search, and removes its `database.fasta`. */
  saveProteins(id: string, proteins: string): Promise<void>
  rename(id: string, name: string): Promise<void>
  delete(id: string): Promise<void>
  /** The regular files of the folder (no links to the inputs). */
  files(id: string): Promise<{ name: string; size: number }[]>
  /**
   * The project file of search `id` (see `exportProject`): the save dialog, suggesting `name`, then the zip
   * written there, `onProgress` told how far (0–1) as it goes. The path, or null if the user cancelled.
   */
  saveProject(id: string, name: string, onProgress?: (fraction: number) => void): Promise<string | null>
  /**
   * The open dialog for a `.prose` file and the bytes of the file chosen, or null if the user cancelled.
   * (The dialog and the read are one step in Rust: the page never names a path to read.)
   */
  openProject(): Promise<Uint8Array | null>
  /** Makes a search folder of the entries (see `frameEntries`): its new id. */
  importEntries(body: Uint8Array): Promise<string>
}

//------------------------------------------------------------------------------------------------
// The record

/** Target PSMs within the PSM FDR (a PSM without q-value counts): the "PSMs" key figure. */
export function countPsms(tables: ResultTables, psmFdr: number): number {
  const { count, decoy, qValue } = tables.psms
  let n = 0
  for (let i = 0; i < count; i++) if (!decoy[i] && !(qValue[i] > psmFdr)) n++
  return n
}

/** The record of `result` under `name`. A stored result keeps the versions that made it. */
export function recordOf(result: OpenResult, name: string, toolVersion: string): SearchRecord {
  return {
    ...endedRecordOf({ ...result, seconds: result.outcome.seconds }, name, toolVersion, countPsms(result.outcome.tables, result.psmFdr)),
    appVersion: result.stored?.appVersion ?? APP_VERSION,
    toolVersion: result.stored?.moduleVersion ?? toolVersion,
  }
}

/**
 * The record of a search whose ProSE has ended, before its results are read: from the request (`search`)
 * and the target PSMs that ProSE reports (`psms`, `psmsOfSearch`).
 */
export function endedRecordOf(search: EndedSearch, name: string, toolVersion: string, psms: number): SearchRecord {
  const s = search.settings
  return {
    schema: SCHEMA_VERSION,
    id: search.id,
    name,
    createdAt: search.createdAt,
    appVersion: APP_VERSION,
    toolVersion,
    files: search.design.rows.map((r) => r.fileName),
    database: s.database,
    design: search.design,
    settings: {
      parameters: s.parameters,
      fixedMods: s.fixedMods,
      rescore: s.rescore,
      peptdeep: s.peptdeep,
      contaminants: s.contaminants,
      ...(s.presetId !== undefined ? { presetId: s.presetId } : {}),
    },
    psms,
    psmFdr: search.psmFdr,
    proteinFdr: search.proteinFdr,
    seconds: search.seconds,
  }
}

/**
 * The target PSMs of a search by its QPX run view (the sum of `identified_spectra_count`; 0 if it says none).
 * Rejects if the file is missing or is not ProSE's run view.
 */
export async function psmsOfSearch(backend: HistoryBackend, id: string): Promise<number> {
  const bytes = await backend.read(id, RUNS)
  try {
    return targetPsmsOf(await readRuns(bytes))
  } catch (e) {
    throw new Error(`${RUNS}: ${errorText(e)}`, { cause: e })
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The record in `text`. Throws a ProjectVersionError for a newer schema, a ProjectError for the rest. */
export function parseRecord(text: string, kind: 'project' | 'search' = 'search'): SearchRecord {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ProjectError(`${RECORD_FILE} is not valid JSON.`)
  }
  if (!isObject(value)) throw new ProjectError(`${RECORD_FILE} is not a search record.`)
  if (typeof value.schema !== 'number') throw new ProjectError(`${RECORD_FILE} has no schema: it is not a ProSE search record.`)
  if (value.schema > SCHEMA_VERSION) throw new ProjectVersionError(value.schema, kind)
  if (value.schema !== SCHEMA_VERSION) throw new ProjectError(`${RECORD_FILE} has the unknown schema ${value.schema}.`)
  const bad = (what: string) => new ProjectError(`${RECORD_FILE} is incomplete: ${what}.`)
  const text_ = (k: string) => {
    if (typeof value[k] !== 'string') throw bad(`${k} is missing`)
  }
  const number = (k: string) => {
    if (typeof value[k] !== 'number' || Number.isNaN(value[k])) throw bad(`${k} is missing`)
  }
  for (const k of ['id', 'name', 'createdAt', 'appVersion', 'toolVersion', 'database']) text_(k)
  for (const k of ['psms', 'psmFdr', 'proteinFdr', 'seconds']) number(k)
  if (!Array.isArray(value.files)) throw bad('files is missing')
  const design = value.design
  if (!isObject(design) || !Array.isArray(design.rows) || !Array.isArray(design.samples) || !Array.isArray(design.conditions)) {
    throw bad('design is missing')
  }
  const settings = value.settings
  if (!isObject(settings) || !isObject(settings.parameters) || !Array.isArray(settings.fixedMods)) throw bad('settings is missing')
  return value as unknown as SearchRecord
}

/** The result a record opens as (see `openStoredResult`); `outcome` is what the reader gave. */
export function resultFromRecord(record: SearchRecord, outcome: OpenResult['outcome']): Omit<OpenResult, 'id' | 'createdAt'> {
  const s = record.settings
  return {
    stored: { name: record.name, appVersion: record.appVersion, moduleVersion: record.toolVersion },
    outcome,
    design: record.design,
    psmFdr: record.psmFdr,
    proteinFdr: record.proteinFdr,
    settings: {
      parameters: s.parameters,
      fixedMods: s.fixedMods,
      database: record.database,
      rescore: s.rescore,
      peptdeep: s.peptdeep,
      contaminants: s.contaminants,
      ...(s.presetId !== undefined ? { presetId: s.presetId } : {}),
    },
  }
}

/**
 * `proteins.fasta`: every protein of the result's protein table, as searched (decoys included; those
 * ProSE generated with the sequences the reader rebuilt). The reader looks here first.
 */
export function proteinsFasta(tables: ResultTables): string {
  const { count, accession, description, sequence } = tables.proteins
  const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ')
  const lines: string[] = []
  for (let p = 0; p < count; p++) {
    const head = description[p] ? `${oneLine(accession[p])} ${oneLine(description[p])}` : oneLine(accession[p])
    lines.push(`>${head}`, sequence[p] ?? '')
  }
  return lines.length > 0 ? lines.join('\n') + '\n' : ''
}

//------------------------------------------------------------------------------------------------
// Saving and opening

/** Puts a search whose results have been read into History: its `search.json`, then its `proteins.fasta`. */
export async function saveSearch(backend: HistoryBackend, result: OpenResult, name: string, toolVersion: string): Promise<void> {
  await backend.saveRecord(result.id, JSON.stringify(recordOf(result, name, toolVersion)))
  await backend.saveProteins(result.id, proteinsFasta(result.outcome.tables))
}

/** The `files` of the results reader for a search folder. */
export function folderFiles(backend: HistoryBackend, id: string): SearchFiles {
  return (name, range) => backend.read(id, name, range)
}

/**
 * Reads a saved search from its folder: the record and the tables. Throws a ProjectError (a
 * ProjectVersionError for a newer record) that says what is wrong.
 */
export async function openSearch(
  backend: HistoryBackend,
  id: string,
): Promise<{ result: Omit<OpenResult, 'id' | 'createdAt'>; origin: { id: string; createdAt: string } }> {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await backend.read(id, RECORD_FILE))
  } catch (e) {
    throw new ProjectError(`${RECORD_FILE} cannot be read (${(e as Error)?.message ?? e}).`)
  }
  const record = parseRecord(text)
  const read = await readSearch(folderFiles(backend, id))
  // a search saved before its results could be read (or by an older version) gets its proteins.fasta now;
  // a failure leaves it as it was (it opens with its database, and the next open tries again)
  if (!read.proteinsSaved && record.imported !== true) {
    await backend.saveProteins(id, proteinsFasta(read.tables)).catch(() => {})
  }
  return {
    result: resultFromRecord(record, { ...read, seconds: record.seconds }),
    origin: { id, createdAt: record.createdAt },
  }
}

//------------------------------------------------------------------------------------------------
// Project files

/** `<name>.prose`, the name reduced to letters (of any script), digits, `-`, `_` and `.` (`fileSafe`). */
export function projectFileName(name: string): string {
  const safe = fileSafe(name)
  return `${safe.length >= 1 ? safe : 'prose-results'}.prose`
}

/** The name a result has in project files and exports when History has none for it. */
export function defaultName(result: OpenResult): string {
  return resultName(result.design.rows.map((r) => r.fileName))
}

/** Files that deflate does not shrink (Parquet is compressed already): stored as they are (`project.rs` `stored`). */
export const STORE = /\.(parquet|gz|zst)$/i
/** The deflate level of the other files: the quickest (they are small). */
export const LEVEL = 1

/**
 * Files of the folder that a project leaves out: the database copy (`proteins.fasta` has the sequences)
 * and the tool's log (its first line is the full command line, with paths of this computer). As `project.rs` `LEFT_OUT`.
 */
export const LEFT_OUT: ReadonlySet<string> = new Set(['database.fasta', 'database.json', 'prose.log'])

/**
 * `inputs.json` as a project holds it: the files by name only, not the paths of this computer.
 * (The reader takes the names of the searched files from it.)
 */
export function withoutPaths(inputs: Uint8Array): Uint8Array {
  let records: unknown
  try {
    records = JSON.parse(new TextDecoder().decode(inputs))
  } catch {
    throw new ProjectError('inputs.json cannot be read, so the project cannot be made.')
  }
  if (!Array.isArray(records)) throw new ProjectError('inputs.json is not a list of the searched files, so the project cannot be made.')
  const reduced = records.map((r) => {
    if (!isObject(r)) throw new ProjectError('inputs.json is not a list of the searched files, so the project cannot be made.')
    const name = typeof r.name === 'string' ? r.name : String(r.path ?? '').split(/[\\/]/).pop()
    return { ...r, path: name }
  })
  return strToU8(JSON.stringify(reduced, null, 2))
}

/**
 * Makes a project file of the search folder `id`: its regular files as a zip, `search.json` first,
 * without the database copy and with the searched files by name only (what is shared is the results,
 * not where the files were on this computer). What it would hold is checked first, before the save dialog;
 * the backend then asks where and writes it there (the Rust side, entry by entry), `onProgress` told how far
 * (0–1). Resolves with the path where the user saved it, or null if the user cancelled.
 */
export async function exportProject(
  backend: HistoryBackend,
  id: string,
  name: string,
  onProgress?: (fraction: number) => void,
): Promise<string | null> {
  const listed = await backend.files(id)
  if (!listed.some((f) => f.name === RECORD_FILE)) {
    throw new ProjectError(`The search is not saved to History (it has no ${RECORD_FILE}), so there is no project to make.`)
  }
  const kept = listed.filter((f) => !LEFT_OUT.has(f.name))
  // what the project would hold, before anything is read: within what a project opens with (MAX_UNPACKED)
  // and what a zip without zip64 can hold (MAX_ZIP; the app writes no zip64)
  const total = kept.reduce((n, f) => n + f.size, 0)
  if (total > MAX_UNPACKED || kept.length > MAX_ZIP_ENTRIES) throw tooLargeForAProject(total, kept.length)
  // inputs.json (small) is checked too: it cannot fail once the user has chosen where
  if (kept.some((f) => f.name === 'inputs.json')) withoutPaths(await backend.read(id, 'inputs.json'))
  return backend.saveProject(id, projectFileName(name), onProgress)
}

/** The most a zip without zip64 holds: 4 GiB less a byte, and 65,535 entries. */
export const MAX_ZIP = 2 ** 32 - 1
export const MAX_ZIP_ENTRIES = 0xffff

/** Why a search makes no project file: it is too large for one. */
function tooLargeForAProject(bytes: number, files: number): ProjectError {
  const what = files > MAX_ZIP_ENTRIES ? `${files} files` : formatBytes(bytes)
  return new ProjectError(
    `This search is too large for a project file: its results take ${what}, and a project file holds at most ` +
      `${formatBytes(MAX_UNPACKED)}. That is the most ProSE can open. A larger zip, over 4 GB or 65,535 files, needs ` +
      'the zip64 format, which ProSE does not write. The search stays in History on this computer.',
  )
}

/** The most a project may unpack to (the zip is read into memory). */
export const MAX_UNPACKED = 3 * 1024 ** 3

/**
 * Whether `name` is a plain relative name inside the folder: parts separated by `/`, none of them
 * empty, `.` or `..`; no `\`, no `:`, no absolute path, no control characters (as the Rust side checks).
 */
export function isPlainName(name: string): boolean {
  return (
    name !== '' &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.includes(':') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/.test(name) &&
    name.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

type CentralEntry = { name: string; link: boolean; encrypted: boolean; size: number }

/** A name as fflate reads it from the zip: UTF-8 if the entry says so, else Latin-1. */
function entryName(bytes: Uint8Array, utf8: boolean): string {
  return utf8 ? new TextDecoder().decode(bytes) : Array.from(bytes, (b) => String.fromCharCode(b)).join('')
}

/**
 * The entries of the zip's central directory (name, size, whether it is a symbolic link: what fflate does
 * not tell). Throws a ProjectError if the directory cannot be read, or if the file has a zip64 locator
 * (such files are not supported: fflate and this reader could then take different directories).
 */
function centralDirectory(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) {
      eocd = at
      break
    }
  }
  const broken = () => new ProjectError('This file is not a project file: its zip directory cannot be read.')
  const zip64 = () => new ProjectError('This project file uses the zip64 format, which is not supported.')
  if (eocd < 0) throw broken()
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === 0x07064b50) throw zip64()
  const count = view.getUint16(eocd + 10, true)
  const size = view.getUint32(eocd + 12, true)
  const offset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw zip64()
  const entries: CentralEntry[] = []
  let at = offset
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw broken()
    const madeBy = view.getUint16(at + 4, true)
    const flags = view.getUint16(at + 8, true)
    const uncompressed = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const attributes = view.getUint32(at + 38, true)
    if (at + 46 + nameLength > bytes.length) throw broken()
    entries.push({
      name: entryName(bytes.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0),
      // made on Unix (host 3) with the mode of a symbolic link in the upper half of the attributes
      link: madeBy >> 8 === 3 && ((attributes >>> 16) & 0xf000) === 0xa000,
      encrypted: (flags & 1) !== 0,
      size: uncompressed,
    })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * The files of a project file, checked before anything is written: a zip with `.prose`'s plain names
 * (no `..`, no absolute path, no link, no name twice, no file that is also a folder), within the size
 * limit (`maxUnpacked`, the sum of the sizes the zip declares, checked again as fflate unpacks it), and a
 * `search.json` of this schema. The zip's directory is read here and by fflate, and the two must agree
 * (names and sizes), so that what is checked is what is unpacked. Throws a ProjectError (a
 * ProjectVersionError for a newer schema).
 */
export function unpackProject(bytes: Uint8Array, maxUnpacked = MAX_UNPACKED): { name: string; data: Uint8Array }[] {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ProjectError('This file is not a project file: it is not a zip file.')
  }
  const directory = centralDirectory(bytes)
  if (directory.some((e) => e.link)) throw new ProjectError('This project file contains a link, which a project never has. It is not opened.')
  if (directory.some((e) => e.encrypted)) throw new ProjectError('This project file is encrypted.')
  const tooLarge = () => new ProjectError(`This project file unpacks to more than ${formatBytes(maxUnpacked)}, which is too much to open.`)
  const declared = new Map<string, number>()
  for (const e of directory) {
    if (declared.has(e.name)) throw new ProjectError(`The project file has the name ${JSON.stringify(e.name)} twice. It is not opened.`)
    declared.set(e.name, e.size)
  }
  if (directory.reduce((n, e) => n + e.size, 0) > maxUnpacked) throw tooLarge()
  // what fflate sees, entry by entry, as it unpacks: the same names and sizes, in total within the limit
  const seen = new Map<string, number>()
  let total = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (seen.has(f.name)) throw new ProjectError(`The project file has the name ${JSON.stringify(f.name)} twice. It is not opened.`)
        seen.set(f.name, f.originalSize)
        total += f.originalSize
        if (total > maxUnpacked) throw tooLarge()
        return !f.name.endsWith('/')
      },
    })
  } catch (e) {
    if (e instanceof ProjectError) throw e
    throw new ProjectError(`This file is not a project file: it cannot be unzipped (${(e as Error)?.message ?? e}).`)
  }
  if (seen.size !== declared.size || [...seen].some(([name, size]) => declared.get(name) !== size)) {
    throw new ProjectError('This project file is damaged: its zip directory is not consistent. It is not opened.')
  }
  const entries: { name: string; data: Uint8Array }[] = []
  let actual = 0
  for (const [name, data] of Object.entries(files)) {
    if (!isPlainName(name)) throw new ProjectError(`The project file has a file name that is not a plain name inside the folder (${JSON.stringify(name)}). It is not opened.`)
    actual += data.length
    if (actual > maxUnpacked) throw tooLarge()
    entries.push({ name, data })
  }
  const names = new Set(entries.map((e) => e.name))
  for (const { name } of entries) {
    const parts = name.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (names.has(parts.slice(0, i).join('/'))) throw new ProjectError(`The project file has ${parts.slice(0, i).join('/')} as a file and as a folder.`)
    }
  }
  const record = entries.find((e) => e.name === RECORD_FILE)
  if (!record) throw new ProjectError(`This file is not a ProSE project: it has no ${RECORD_FILE}.`)
  parseRecord(new TextDecoder().decode(record.data), 'project')
  return entries
}

/**
 * The body of `history_import`: the entries, each `[u32 BE name length][name][u64 BE data length][data]`
 * (the Rust side parses the same layout, `history::frame`).
 */
export function frameEntries(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const named = entries.map((e) => ({ name: strToU8(e.name), data: e.data }))
  let size = 0
  for (const e of named) size += 4 + e.name.length + 8 + e.data.length
  const out = new Uint8Array(size)
  const view = new DataView(out.buffer)
  let at = 0
  for (const e of named) {
    view.setUint32(at, e.name.length)
    out.set(e.name, at + 4)
    at += 4 + e.name.length
    view.setBigUint64(at, BigInt(e.data.length))
    out.set(e.data, at + 8)
    at += 8 + e.data.length
  }
  return out
}

/**
 * Opens the dialog for a `.prose` file (in Rust, which reads the file) and makes a search of it in History. Resolves with the new
 * search's id, or null if the user cancelled. Throws a ProjectError that says what is wrong.
 */
export async function importProject(backend: HistoryBackend): Promise<string | null> {
  const bytes = await backend.openProject()
  return bytes === null ? null : importProjectBytes(backend, bytes)
}

/** As `importProject`, for the bytes of a project file. */
export async function importProjectBytes(backend: HistoryBackend, bytes: Uint8Array): Promise<string> {
  return backend.importEntries(frameEntries(unpackProject(bytes)))
}
