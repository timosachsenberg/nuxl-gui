// The cells of where a peptide is in its proteins (the Start, End and Protein site columns of the PSM and Peptides
// tables): the first occurrence (the Proteins column's first protein) with "+n" for the others, all of them in the
// tooltip (`results/positions.ts`).

import { parseAccession } from '$lib/results/display'
import type { ResultModel } from '$lib/results/model'
import { candidateSites, INEXACT, occurrences, proteinSites, rangeTitle, siteText, type Occurrence } from '$lib/results/positions'

const NO_PROTEIN = 'OpenNuXL lists no protein for this peptide'

/** Residues `at` (0-based in peptide `k`) in each occurrence: "Cas7 Y115, K117; Cas5 Y3, K5". */
function placesOf(m: ResultModel, k: number, all: Occurrence[], at: number[]): string {
  const peptide = m.tables.peptides.sequence[k]
  return all
    .map((o) =>
      o.start !== o.start
        ? `${shown(m, o.protein)} position unknown`
        : `${shown(m, o.protein)} ${at.map((j) => `${peptide[j]}${o.start + j}${o.exact ? '' : '?'}`).join(', ')}`,
    )
    .join('; ')
}

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
  return rangeTitle(m, k) || (m.peptide.proteins[k].length === 0 ? NO_PROTEIN : undefined)
}

/** The Protein site cell of peptide `k` cross-linked at residue `site` (0-based; -1 none): "Cas7 K123"; null: "–". */
export function siteView(m: ResultModel, k: number, site: number): PositionView | null {
  const sites = proteinSites(m, k, site)
  const first = sites[0]
  if (!first) return null
  return { text: `${shown(m, first.protein)} ${first.residue}${first.position}`, inexact: !first.exact, more: sites.length - 1 }
}

/**
 * The tooltip of the Protein site cell: every occurrence's residue ("Cas7 K123; Cas5 K14"), and the other residues
 * OpenNuXL's localization names (`siteSequence`, lower case) as "Also possible". A cross-link that is not
 * localized (`isXL` with `site` -1): the residues it may be on, from OpenNuXL's `siteSequence` (lower case), in each
 * protein ("Not localized. Possible residues: Cas7 Y115, K117").
 */
export function siteCellTitle(m: ResultModel, k: number, site: number, isXL: boolean, siteSequence = ''): string | undefined {
  const all = occurrences(m, k)
  if (site >= 0) {
    if (all.length === 0) return NO_PROTEIN
    const sites = proteinSites(m, k, site)
    if (sites.length === 0) return undefined
    const text = sites.map((s, j) => (s ? `${shown(m, s.protein)} ${siteText(s)}` : `${shown(m, all[j].protein)} position unknown`)).join('; ')
    // OpenNuXL's localization may name other residues as likely (lower case in siteSequence): say so
    const others = candidateSites(siteSequence, m.tables.peptides.sequence[k]).filter((j) => j !== site)
    const also = others.length > 0 ? `\nAlso possible: ${placesOf(m, k, all, others)}` : ''
    return `${text}${also}${sites.some((s) => s && !s.exact) ? `\n${INEXACT}` : ''}`
  }
  if (!isXL) return undefined
  const peptide = m.tables.peptides.sequence[k]
  const candidates = candidateSites(siteSequence, peptide)
  if (candidates.length === 0 || all.length === 0) return 'Not localized'
  const note = all.some((o) => !o.exact && o.start === o.start) ? `\n${INEXACT}` : ''
  return `Not localized. Possible residues: ${placesOf(m, k, all, candidates)}${note}`
}
