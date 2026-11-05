// The curation of PSMs: the user marks a PSM as accepted or rejected (the PSM view's buttons, keys A and R), the PSM
// table shows the mark (its Curation column) and filters by it, and the exports write it. The marks are per row of
// `tables.psms` (`ResultModel.curation`, 0 = not curated) and are kept in the search's folder as `curation.json`
// (CURATION_FILE), each PSM by what names it there (file, spectrum, peptide, adduct, charge), not by its row: a file that
// another build of the reader would read in another order still finds its PSMs. A project file holds it.

import { baseName, type ResultModel } from './model'

/** A PSM's mark: none, accepted, rejected. */
export const NONE = 0
export const ACCEPTED = 1
export const REJECTED = 2
export type Mark = typeof NONE | typeof ACCEPTED | typeof REJECTED

/** The marks as the file, the exports and the Curation column name them ('' = not curated). */
export const MARK_NAMES = ['', 'accepted', 'rejected'] as const

/** The file of the marks in the search's folder. */
export const CURATION_FILE = 'curation.json'
/** The version of its format. */
export const CURATION_SCHEMA = 1

/** What the Curation filter of the PSM table lets through. */
export type CurationFilter = 'any' | 'curated' | 'accepted' | 'rejected' | 'uncurated'

export const CURATION_FILTERS: { value: CurationFilter; label: string }[] = [
  { value: 'any', label: 'Any curation' },
  { value: 'curated', label: 'Curated' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'uncurated', label: 'Not curated' },
]

/** Whether a PSM with `mark` passes the filter. */
export function passesCuration(mark: number, filter: CurationFilter): boolean {
  switch (filter) {
    case 'curated':
      return mark !== NONE
    case 'accepted':
      return mark === ACCEPTED
    case 'rejected':
      return mark === REJECTED
    case 'uncurated':
      return mark === NONE
    default:
      return true
  }
}

/**
 * How a PSM is named in `curation.json` (`adduct`: OpenNuXL's NuXL:NA, '' for a peptide without one), with its mark
 * and the user's note (each optional; an entry has at least one of them).
 */
export type CuratedPsm = {
  file: string
  spectrum: string
  peptide: string
  adduct: string
  charge: number
  mark?: 'accepted' | 'rejected'
  note?: string
}
type PsmName = Pick<CuratedPsm, 'file' | 'spectrum' | 'peptide' | 'adduct' | 'charge'>

/** What names PSM `i` in the file. */
function describe(m: ResultModel, i: number): PsmName {
  const ps = m.tables.psms
  const k = ps.peptide[i]
  return {
    file: baseName(m.tables.files[ps.file[i]]),
    spectrum: ps.nativeId[i],
    peptide: m.tables.peptides.proforma[k],
    adduct: m.tables.peptides.adduct[k],
    charge: ps.charge[i],
  }
}

const keyOf = (p: PsmName) => `${p.file}\u0000${p.spectrum}\u0000${p.peptide}\u0000${p.adduct}\u0000${p.charge}`

/** The longest note (characters); a longer one is cut. */
export const MAX_NOTE = 2000

/** A note as it is kept: one line (line breaks and tabs become spaces), trimmed, at most MAX_NOTE characters. */
export function cleanNote(text: string): string {
  return text.replace(/[\t\r\n]+/g, ' ').trim().slice(0, MAX_NOTE)
}

/**
 * The marks (per PSM row) and notes (by PSM row) as `curation.json`: the PSMs with a mark or a note, in row order,
 * then `kept` (what the file had of PSMs that are none of this result: `readCuration`'s `unmatched`, which saving
 * does not lose).
 */
export function writeCuration(
  m: ResultModel,
  marks: Uint8Array,
  notes: ReadonlyMap<number, string> = new Map(),
  kept: readonly CuratedPsm[] = [],
): string {
  const psms: CuratedPsm[] = []
  for (let i = 0; i < marks.length; i++) {
    const marked = marks[i] === ACCEPTED || marks[i] === REJECTED
    const note = notes.get(i)
    if (!marked && !note) continue
    const entry: CuratedPsm = describe(m, i)
    if (marked) entry.mark = MARK_NAMES[marks[i]] as 'accepted' | 'rejected'
    if (note) entry.note = note
    psms.push(entry)
  }
  psms.push(...kept)
  return JSON.stringify({ schema: CURATION_SCHEMA, psms }, null, 1) + '\n'
}

/**
 * The marks of `curation.json` per PSM row of `m`, its notes by PSM row, and its PSMs that are none of the result
 * (`unmatched`, for `writeCuration` to keep). Entries that name no PSM, or have neither a mark nor a note, are left
 * out; a file that is not of this format throws.
 */
export function readCuration(m: ResultModel, text: string): { marks: Uint8Array; notes: Map<number, string>; unmatched: CuratedPsm[] } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`${CURATION_FILE} is not valid JSON.`)
  }
  const record = value as { schema?: unknown; psms?: unknown }
  if (typeof value !== 'object' || value === null || record.schema !== CURATION_SCHEMA || !Array.isArray(record.psms)) {
    throw new Error(`${CURATION_FILE} is not a curation of this app's format.`)
  }
  const rows = new Map<string, number>()
  const ps = m.tables.psms
  for (let i = 0; i < ps.count; i++) rows.set(keyOf(describe(m, i)), i)
  const marks = new Uint8Array(ps.count)
  const notes = new Map<number, string>()
  const unmatched: CuratedPsm[] = []
  for (const entry of record.psms as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const p = entry as Partial<CuratedPsm>
    if (typeof p.file !== 'string' || typeof p.spectrum !== 'string' || typeof p.peptide !== 'string' || typeof p.charge !== 'number') continue
    const mark = p.mark === 'accepted' ? ACCEPTED : p.mark === 'rejected' ? REJECTED : NONE
    const note = typeof p.note === 'string' ? cleanNote(p.note) : ''
    if (mark === NONE && !note) continue
    const name: PsmName = { file: p.file, spectrum: p.spectrum, peptide: p.peptide, adduct: typeof p.adduct === 'string' ? p.adduct : '', charge: p.charge }
    const row = rows.get(keyOf(name))
    if (row === undefined) {
      unmatched.push({ ...name, ...(mark !== NONE ? { mark: MARK_NAMES[mark] as 'accepted' | 'rejected' } : {}), ...(note ? { note } : {}) })
      continue
    }
    marks[row] = mark
    if (note) notes.set(row, note)
  }
  return { marks, notes, unmatched }
}

/** How many PSMs are accepted and rejected. */
export function countMarks(marks: Uint8Array): { accepted: number; rejected: number } {
  let accepted = 0
  let rejected = 0
  for (let i = 0; i < marks.length; i++) {
    if (marks[i] === ACCEPTED) accepted++
    else if (marks[i] === REJECTED) rejected++
  }
  return { accepted, rejected }
}

/** What the peptides have of curated PSMs: per peptide row, its accepted and its rejected PSMs. */
export type PeptideMarks = { accepted: Uint32Array; rejected: Uint32Array }

/** Counts the changes of the marks (they change in place): `peptideMarks` counts anew after one. */
let changes = 0
/** The marks of a model changed (the results view calls it after each change). */
export function curationChanged(): void {
  changes++
}

const peptideCache = new WeakMap<ResultModel, { changes: number; marks: PeptideMarks }>()

/** Per peptide: how many of its PSMs are accepted and rejected (all of its PSMs, whatever the cutoffs). */
export function peptideMarks(m: ResultModel): PeptideMarks {
  const cached = peptideCache.get(m)
  if (cached && cached.changes === changes) return cached.marks
  const n = m.tables.peptides.count
  const marks = { accepted: new Uint32Array(n), rejected: new Uint32Array(n) }
  const { peptide } = m.tables.psms
  for (let i = 0; i < m.curation.length; i++) {
    if (m.curation[i] === ACCEPTED) marks.accepted[peptide[i]]++
    else if (m.curation[i] === REJECTED) marks.rejected[peptide[i]]++
  }
  peptideCache.set(m, { changes, marks })
  return marks
}

/**
 * Whether peptide `k` passes the curation filter of the Peptides table: Curated (a PSM with a mark), Accepted (an
 * accepted PSM), Rejected (a rejected PSM), Not curated (no PSM with a mark).
 */
export function peptidePassesCuration(marks: PeptideMarks, k: number, filter: CurationFilter): boolean {
  const accepted = marks.accepted[k] > 0
  const rejected = marks.rejected[k] > 0
  switch (filter) {
    case 'curated':
      return accepted || rejected
    case 'accepted':
      return accepted
    case 'rejected':
      return rejected
    case 'uncurated':
      return !accepted && !rejected
    default:
      return true
  }
}

/** The curation filter's choices on the Peptides table. */
export const PEPTIDE_CURATION_FILTERS: { value: CurationFilter; label: string }[] = [
  { value: 'any', label: 'Any curation' },
  { value: 'curated', label: 'With a curated PSM' },
  { value: 'accepted', label: 'With an accepted PSM' },
  { value: 'rejected', label: 'With a rejected PSM' },
  { value: 'uncurated', label: 'No curated PSM' },
]
