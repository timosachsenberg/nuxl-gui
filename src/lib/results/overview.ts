// The Overview tab: per searched file what OpenNuXL reports of its run, in plain words (its PSMs by kind, Percolator
// applied or skipped and why, its other notes), and what the cross-link PSMs carry: their adducts and the amino acids
// they are cross-linked to. Everything is counted at the search's cutoffs (`levelRows`).

import { formatPercent, formatQ } from '../format/fdr'
import type { ProSEFileStatus, ProSEFileSummary, ProSEMultiSummary } from '../results/types'
import { levelRows } from './figures'
import { baseName, type ResultModel } from './model'
import type { NuxlSummary } from './summary'

/** An engine's long text, with the short plain line the table shows (the long one goes in its tooltip). */
export type EngineNote = { short: string; full: string }

export type PercolatorStatus = {
  /** `off`: the search did not rescore (the PSMs keep NuXL's scores). */
  kind: 'applied' | 'skipped' | 'off'
  label: string
  /** Why Percolator was skipped. */
  detail: EngineNote | null
  warning: EngineNote | null
}

/** The Percolator texts we know (ProSE's and OpenNuXL's), and the shim's own notes, in short plain words. */
const SHORT_NOTES: [RegExp, string][] = [
  [/sanity check rejected the learned model/i, 'Too few confident PSMs, so scored by the best single feature'],
  [/^Only (\d+) PSMs, Percolator rescoring needs at least (\d+)/, 'Only $1 PSMs, at least $2 needed'],
  [/^No decoy PSMs for the target\/decoy competition/, 'No decoy PSMs to learn from'],
  [/^No search run .* to rescore/, 'No search run to rescore'],
  [/^Percolator failed/, 'Percolator failed'],
  // OpenNuXL's (it rescores 1000 PSMs or more)
  [/^Too few PSMs for score recalibration/, 'Too few PSMs (Percolator needs 1000)'],
  [/^Score recalibration failed/, 'Percolator failed'],
  // the shim's, of a run whose QPX mz view (the spectra of its PSMs) OpenNuXL could not write for the PSM view
  [/^The PSM view shows the annotated peaks only: the spectra of .+ could not be kept/, 'Spectra not kept: the PSM view shows the annotated peaks only'],
  // (of a search of an app before 0.7: a .raw or .d input whose spectra FileConverter could not write as mzML)
  [/^The PSM view shows the annotated peaks only: the spectra of .+ could not be converted/, 'Spectra not converted: the PSM view shows the annotated peaks only'],
]

/** A long engine text as a short line: a known one in plain words, else its first sentence, cut at 80 characters. */
export function engineNote(text: string | null): EngineNote | null {
  if (text === null || text.trim() === '') return null
  const full = text.trim()
  for (const [pattern, short] of SHORT_NOTES) {
    const m = pattern.exec(full)
    if (m) return { short: m[0].replace(pattern, short), full }
  }
  const first = full.split(/(?<=\.)\s|\s\(|;\s/, 1)[0].replace(/\.$/, '')
  return { short: first.length > 80 ? `${first.slice(0, 79).trimEnd()}…` : first, full }
}

export function percolatorStatus(p: ProSEFileSummary['percolator']): PercolatorStatus {
  if (p === null) return { kind: 'off', label: 'Not used', detail: null, warning: null }
  if (p.applied) return { kind: 'applied', label: 'Rescored', detail: null, warning: engineNote(p.warning) }
  return { kind: 'skipped', label: 'Skipped', detail: engineNote(p.skipped), warning: engineNote(p.warning) }
}

const statusLabels: Record<ProSEFileStatus, string> = {
  EXECUTION_OK: 'Searched',
  INPUT_FILE_EMPTY: 'No spectra to search',
  UNEXPECTED_RESULT: 'Unexpected result',
  ILLEGAL_PARAMETERS: 'Settings not accepted',
  UNKNOWN_ERROR: 'Failed (unknown error)',
}

/** The exit status of a file's search in plain words; `ok` for a file that was searched. */
export function fileStatus(status: ProSEFileStatus): { ok: boolean; label: string } {
  return { ok: status === 'EXECUTION_OK', label: statusLabels[status] ?? 'Unknown status' }
}

/** A duration: "0.1 s", "12.3 s", "2 min 5 s". */
export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return '–'
  if (Math.round(seconds * 10) / 10 < 60) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)} min ${total % 60} s`
}

export type FileRow = {
  index: number
  /** The file's name without directories. */
  file: string
  /** The design's sample of the file, or null. */
  sample: string | null
  /** The MS2 spectra of the file; null: not reported (OpenNuXL does not report the spectra it read). */
  ms2: number | null
  /** Its target PSMs at the search's cutoffs: peptide PSMs (at the peptide FDR) and cross-link PSMs (at the XL FDR). */
  peptidePsms: number
  xlPsms: number
  percolator: PercolatorStatus
  /** OpenNuXL's other notes of the run (not the one that says why Percolator was skipped). */
  notes: EngineNote[]
  seconds: number | null
  status: { ok: boolean; label: string }
}

/** The target PSMs of each file at the search's cutoffs, by kind. */
function psmsByFile(m: ResultModel): { peptide: Uint32Array; xl: Uint32Array } {
  const n = m.tables.files.length
  const peptide = new Uint32Array(n)
  const xl = new Uint32Array(n)
  const { file, xl: cross } = m.tables.psms
  for (const i of levelRows(m, 'psms', false)) (cross.isXL[i] ? xl : peptide)[file[i]]++
  return { peptide, xl }
}

/**
 * One row per searched file, in the order of the search (the summary lists its files in that order). `nuxl` (the
 * reader's `SearchResult.nuxl`) adds OpenNuXL's notes and whether Percolator rescored a file the summary says nothing
 * about.
 */
export function fileRows(m: ResultModel, summary: ProSEMultiSummary, nuxl?: NuxlSummary): FileRow[] {
  const counts = psmsByFile(m)
  return m.tables.files.map((path, index) => {
    const f = summary.files[index]
    const designRow = m.design.rows[index]
    const percolator = f?.percolator ?? (nuxl?.percolator[index] ? { applied: true, skipped: null, warning: null } : null)
    const notes = (nuxl?.notes[index] ?? [])
      .filter((n) => n !== percolator?.skipped && n !== percolator?.warning)
      .map(engineNote)
      .filter((n): n is EngineNote => n !== null)
    return {
      index,
      file: baseName(path),
      sample: designRow ? (m.design.samples[designRow.sample]?.label ?? null) : null,
      ms2: f && f.ms2Spectra > 0 ? f.ms2Spectra : null,
      peptidePsms: counts.peptide[index],
      xlPsms: counts.xl[index],
      percolator: percolatorStatus(percolator),
      notes,
      seconds: f?.secondsSearch ?? null,
      status: f ? fileStatus(f.status) : { ok: false, label: 'No report' },
    }
  })
}

/** A cutoff as the Overview names it: "1 % (q ≤ 0.01)"; "none (1.0)" for a cutoff of 1, which keeps every target. */
export function cutoffText(q: number): string {
  return q >= 1 ? `none (${formatQ(q)})` : `${formatPercent(q)} (${formatQ(q)})`
}

/** The Overview's "Peptide FDR" and "Cross-link FDR": OpenNuXL's cutoffs, the peptide PSMs' and the cross-link PSMs'. */
export function fdrFacts(m: Pick<ResultModel, 'psmFdr' | 'xlFdr'>): { name: string; value: string; title: string }[] {
  return [
    {
      name: 'Peptide FDR',
      value: cutoffText(m.psmFdr),
      title: `PSMs without a nucleic acid cross-link count at q ≤ ${formatQ(m.psmFdr)} (OpenNuXL's FDR of the peptide PSMs, by target-decoy competition per file).`,
    },
    {
      name: 'Cross-link FDR',
      value: cutoffText(m.xlFdr),
      title: `Cross-link PSMs count at q ≤ ${formatQ(m.xlFdr)} (OpenNuXL's FDR of the cross-links, estimated per file and per FDR group).`,
    },
  ]
}

/** The sums of the file rows (a file without numbers adds nothing). */
export function totalsOf(rows: FileRow[]): { ms2: number | null; peptidePsms: number; xlPsms: number; seconds: number } {
  const totals = { ms2: null as number | null, peptidePsms: 0, xlPsms: 0, seconds: 0 }
  for (const r of rows) {
    if (r.ms2 !== null) totals.ms2 = (totals.ms2 ?? 0) + r.ms2
    totals.peptidePsms += r.peptidePsms
    totals.xlPsms += r.xlPsms
    totals.seconds += r.seconds ?? 0
  }
  return totals
}

// ---- the cross-links

/** A category of the cross-link PSMs (an adduct, an amino acid) with its PSMs. */
export type CategoryCount = { name: string; count: number }

const byCount = (a: CategoryCount, b: CategoryCount) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/**
 * The adducts of the target cross-link PSMs at the search's cross-link FDR, with their PSMs, most PSMs first (equal
 * counts by name). A cross-link without an adduct (OpenNuXL gives each one) is counted as 'none'.
 */
export function adductCounts(m: ResultModel): CategoryCount[] {
  const counts = new Map<string, number>()
  const { adduct } = m.tables.psms.xl
  for (const i of levelRows(m, 'psms', false, 'xl')) {
    const name = adduct[i] || 'none'
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].map(([name, count]) => ({ name, count })).sort(byCount)
}

/**
 * The amino acids the target cross-link PSMs at the search's cross-link FDR are cross-linked to (the residue at
 * `psms.xl.site` of the peptide), most PSMs first, and the PSMs whose cross-link is not localized.
 */
export function residueCounts(m: ResultModel): { residues: CategoryCount[]; unlocalized: number } {
  const counts = new Map<string, number>()
  let unlocalized = 0
  const { site } = m.tables.psms.xl
  const { peptide } = m.tables.psms
  const sequence = m.tables.peptides.sequence
  for (const i of levelRows(m, 'psms', false, 'xl')) {
    const residue = site[i] >= 0 ? sequence[peptide[i]][site[i]] : undefined
    if (residue === undefined) {
      unlocalized++
      continue
    }
    counts.set(residue, (counts.get(residue) ?? 0) + 1)
  }
  return { residues: [...counts].map(([name, count]) => ({ name, count })).sort(byCount), unlocalized }
}
