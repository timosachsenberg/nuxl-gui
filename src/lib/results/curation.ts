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

/** How a PSM is named in `curation.json` (`adduct`: OpenNuXL's NuXL:NA, '' for a peptide without one). */
export type CuratedPsm = { file: string; spectrum: string; peptide: string; adduct: string; charge: number; mark: 'accepted' | 'rejected' }

/** What names PSM `i` in the file. */
function describe(m: ResultModel, i: number): Omit<CuratedPsm, 'mark'> {
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

const keyOf = (p: Omit<CuratedPsm, 'mark'>) => `${p.file}\u0000${p.spectrum}\u0000${p.peptide}\u0000${p.adduct}\u0000${p.charge}`

/**
 * The marks of `marks` (per PSM row) as `curation.json`: the curated PSMs, in row order, then `kept` (what the file
 * had of PSMs that are none of this result: `readCuration`'s `unmatched`, which saving does not lose).
 */
export function writeCuration(m: ResultModel, marks: Uint8Array, kept: readonly CuratedPsm[] = []): string {
  const psms: CuratedPsm[] = []
  for (let i = 0; i < marks.length; i++) {
    if (marks[i] === ACCEPTED || marks[i] === REJECTED) psms.push({ ...describe(m, i), mark: MARK_NAMES[marks[i]] as CuratedPsm['mark'] })
  }
  psms.push(...kept)
  return JSON.stringify({ schema: CURATION_SCHEMA, psms }, null, 1) + '\n'
}

/**
 * The marks of `curation.json` per PSM row of `m`, and its PSMs that are none of the result (`unmatched`, for
 * `writeCuration` to keep). Entries that are not a curated PSM are left out; a file that is not of this format throws.
 */
export function readCuration(m: ResultModel, text: string): { marks: Uint8Array; unmatched: CuratedPsm[] } {
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
  const unmatched: CuratedPsm[] = []
  for (const entry of record.psms as unknown[]) {
    const p = entry as Partial<CuratedPsm>
    if (typeof p !== 'object' || p === null) continue
    const mark = p.mark === 'accepted' ? ACCEPTED : p.mark === 'rejected' ? REJECTED : NONE
    if (mark === NONE || typeof p.file !== 'string' || typeof p.spectrum !== 'string' || typeof p.peptide !== 'string' || typeof p.charge !== 'number') {
      continue
    }
    if (typeof p.adduct !== 'string') p.adduct = ''
    const row = rows.get(keyOf(p as CuratedPsm))
    if (row === undefined) unmatched.push(p as CuratedPsm)
    else marks[row] = mark
  }
  return { marks, unmatched }
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
