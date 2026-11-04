// The cells of where a peptide is in its proteins (the Start, End and Protein site columns of the PSM and Peptides
// tables): the first occurrence (the Proteins column's first protein) with "+n" for the others, all of them in the
// tooltip (`results/positions.ts`).

import { parseAccession } from '$lib/results/display'
import type { ResultModel } from '$lib/results/model'
import { candidateSites, INEXACT, occurrences, proteinSites, rangeTitle, siteText } from '$lib/results/positions'

/** What `PositionCell` shows: the text, a "?" after it (as the search recorded it), "+n". */
export type PositionView = { text: string; inexact: boolean; more: number }

const shown = (m: ResultModel, protein: number) => parseAccession(m.tables.proteins.accession[protein]).id

/** The Start (or End, `end`) cell of peptide `k`; null: "–" (no protein, or the search recorded no position). */
export function rangeView(m: ResultModel, k: number, end: boolean): PositionView | null {
  const all = occurrences(m, k)
  const o = all[0]
  if (!o || o.start !== o.start) return null
  return { text: String(end ? o.end : o.start), inexact: !o.exact, more: all.length - 1 }
}

/** The tooltip of the Start and End cells: every occurrence ("Cas7 12–24; Cas5 3–15"). */
export function rangeCellTitle(m: ResultModel, k: number): string | undefined {
  return rangeTitle(m, k) || (m.peptide.proteins[k].length === 0 ? 'OpenNuXL lists no protein for this peptide' : undefined)
}

/** The Protein site cell of peptide `k` cross-linked at residue `site` (0-based; -1 none): "Cas7 K123"; null: "–". */
export function siteView(m: ResultModel, k: number, site: number): PositionView | null {
  const sites = proteinSites(m, k, site)
  const first = sites[0]
  if (!first) return null
  return { text: `${shown(m, first.protein)} ${first.residue}${first.position}`, inexact: !first.exact, more: sites.length - 1 }
}

/**
 * The tooltip of the Protein site cell: every occurrence's residue ("Cas7 K123; Cas5 K14"). A cross-link that is not
 * localized (`isXL` with `site` -1): the residues it may be on, from OpenNuXL's `siteSequence` (lower case), in each
 * protein ("Not localized. Possible residues: Cas7 Y115, K117").
 */
export function siteCellTitle(m: ResultModel, k: number, site: number, isXL: boolean, siteSequence = ''): string | undefined {
  const all = occurrences(m, k)
  if (site >= 0) {
    const sites = proteinSites(m, k, site)
    if (sites.length === 0) return undefined
    const text = sites.map((s, j) => (s ? `${shown(m, s.protein)} ${siteText(s)}` : `${shown(m, all[j].protein)} position unknown`)).join('; ')
    return sites.some((s) => s && !s.exact) ? `${text}\n${INEXACT}` : text
  }
  if (!isXL) return undefined
  const peptide = m.tables.peptides.sequence[k]
  const candidates = candidateSites(siteSequence, peptide)
  if (candidates.length === 0 || all.length === 0) return 'Not localized'
  const places = all.map((o) => {
    if (o.start !== o.start) return `${shown(m, o.protein)} position unknown`
    return `${shown(m, o.protein)} ${candidates.map((j) => `${peptide[j]}${o.start + j}${o.exact ? '' : '?'}`).join(', ')}`
  })
  const note = all.some((o) => !o.exact && o.start === o.start) ? `\n${INEXACT}` : ''
  return `Not localized. Possible residues: ${places.join('; ')}${note}`
}
