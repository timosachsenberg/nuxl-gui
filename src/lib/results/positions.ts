// Where a peptide and its cross-linked residue are in its proteins, as the PSM and Peptides tables show it:
// 1-based, inclusive positions ("Start" 12, "End" 24), one per occurrence of the peptide (a peptide may be in several
// proteins, and twice in one), in the order of `peptide.proteins` (the Proteins column's order).
//
// A position is exact when the protein's sequence has the peptide there. When the sequence is unknown ('') or lacks
// the peptide, read.ts keeps the position the search recorded: it is shown with a "?" ("12?") and called "as recorded"
// in the tooltips. When the search recorded none (start = end = 0), the occurrence has no position: "–" in a cell,
// empty in the CSV.

import { parseAccession } from './display'
import type { ResultModel } from './model'

/** One occurrence of a peptide in a protein. */
export type Occurrence = {
  /** Row of `tables.proteins`. */
  protein: number
  /** The first residue, 1-based; NaN: the search recorded no position. */
  start: number
  /** The last residue, 1-based, inclusive; NaN with `start`. */
  end: number
  /** The protein's sequence has the peptide at `start`; false: the position as the search recorded it, or none. */
  exact: boolean
}

/** The occurrence of reference `r` (an index into `tables.peptides.protein/start/end`) of peptide `k`. */
function occurrenceAt(m: ResultModel, k: number, r: number): Occurrence {
  const pt = m.tables.peptides
  const protein = pt.protein[r]
  const s0 = pt.start[r]
  const e0 = pt.end[r]
  if (!(e0 > s0)) return { protein, start: NaN, end: NaN, exact: false }
  const sequence = m.tables.proteins.sequence[protein]
  const peptide = pt.sequence[k]
  const exact = sequence.length > 0 && e0 - s0 === peptide.length && sequence.startsWith(peptide, s0)
  return { protein, start: s0 + 1, end: e0, exact }
}

/** The occurrences of peptide `k` in its proteins, in the order of `peptide.proteins`; [] for a peptide without protein. */
export function occurrences(m: ResultModel, k: number): Occurrence[] {
  const offsets = m.tables.peptides.proteinOffsets
  const all: Occurrence[] = []
  for (let r = offsets[k]; r < offsets[k + 1]; r++) all.push(occurrenceAt(m, k, r))
  return all
}

/** The first occurrence of peptide `k` (the one the cells show and the columns sort by), or null. */
export function firstOccurrence(m: ResultModel, k: number): Occurrence | null {
  const offsets = m.tables.peptides.proteinOffsets
  return offsets[k + 1] > offsets[k] ? occurrenceAt(m, k, offsets[k]) : null
}

/** A position as the cells and the CSV write it: "12", "12?" (as recorded), '' (none). */
export function positionText(at: number, exact: boolean): string {
  return at === at ? `${at}${exact ? '' : '?'}` : ''
}

/** An accession as the tables show it ("P02768", "Cas7"). */
const shown = (m: ResultModel, protein: number) => parseAccession(m.tables.proteins.accession[protein]).id

/** "Cas7 12–24; Cas5 3–15?" with "(?: as recorded …)" explained once: the tooltip of the Start and End cells. */
export function rangeTitle(m: ResultModel, k: number): string {
  const all = occurrences(m, k)
  if (all.length === 0) return ''
  const text = all.map((o) => `${shown(m, o.protein)} ${o.start === o.start ? `${o.start}–${o.end}${o.exact ? '' : '?'}` : 'position unknown'}`).join('; ')
  return all.some((o) => !o.exact && o.start === o.start) ? `${text}\n${INEXACT}` : text
}

/** What a "?" after a position means. */
export const INEXACT = '?: as the search recorded it; the protein’s sequence is unknown or does not have the peptide there'

// ---- the cross-linked residue in the protein

/** The cross-linked residue of an occurrence: its letter and 1-based position in the protein. */
export type ProteinSite = { protein: number; residue: string; position: number; exact: boolean }

/**
 * Residue `site` (0-based in peptide `k`) in each occurrence of the peptide, in the order of `occurrences`; null for
 * an occurrence without position. The letter is the protein's where the position is exact, else the peptide's.
 */
export function proteinSites(m: ResultModel, k: number, site: number): (ProteinSite | null)[] {
  const peptide = m.tables.peptides.sequence[k]
  if (!(site >= 0 && site < peptide.length)) return []
  return occurrences(m, k).map((o) => {
    if (o.start !== o.start) return null
    const position = o.start + site
    const residue = (o.exact ? m.tables.proteins.sequence[o.protein][position - 1] : undefined) ?? peptide[site]
    return { protein: o.protein, residue, position, exact: o.exact }
  })
}

/** "K123", "K123?" (as recorded). */
export const siteText = (s: ProteinSite) => `${s.residue}${s.position}${s.exact ? '' : '?'}`

/** "Cas7 K123" (the accession as the tables show it). */
export const proteinSiteLabel = (m: ResultModel, s: ProteinSite) => `${shown(m, s.protein)} ${siteText(s)}`

/**
 * The cross-linked residue of PSM `i` in the peptide (`psms.xl.site`, 0-based); -1 for a PSM whose cross-link is
 * not localized or that is no cross-link.
 */
export function psmSite(m: ResultModel, i: number): number {
  const xl = m.tables.psms.xl
  return xl.isXL[i] ? xl.site[i] : -1
}

/**
 * The cross-linked residue of peptide `k` (a row of the Peptides table, unique by the OpenMS string and the adduct):
 * the residue that has the adduct as a modification (OpenNuXL writes a localized adduct into the sequence); -1 for a
 * peptide without cross-link or whose adduct is not on a residue.
 */
export function peptideSite(m: ResultModel, k: number): number {
  const pt = m.tables.peptides
  if (!pt.isXL[k] || pt.adduct[k] === '') return -1
  for (let j = pt.modOffsets[k]; j < pt.modOffsets[k + 1]; j++) {
    if (pt.modName[j] === pt.adduct[k] && pt.modPosition[j] >= 0 && pt.modPosition[j] < pt.sequence[k].length) return pt.modPosition[j]
  }
  return -1
}

/**
 * The candidate residues of a cross-link that is not localized (lower case in OpenNuXL's `siteSequence`, 'YTPyLGR'):
 * their 0-based positions in the peptide; [] when it names none or does not fit the peptide.
 */
export function candidateSites(siteSequence: string, peptide: string): number[] {
  if (siteSequence.length !== peptide.length) return []
  const at: number[] = []
  for (let j = 0; j < siteSequence.length; j++) if (siteSequence[j] !== siteSequence[j].toUpperCase()) at.push(j)
  return at
}

/** The sort key of a protein site: the accession as shown, then the position (natural order); '' none (last). */
export function siteSortKey(m: ResultModel, s: ProteinSite | null | undefined): string {
  return s ? `${shown(m, s.protein).toLowerCase()}\u0000${String(s.position).padStart(9, '0')}` : ''
}
