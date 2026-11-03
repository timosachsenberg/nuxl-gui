// The Overview tab's per-file table: what the search reports of each file, in plain words.

import { formatPercent, formatQ } from '../format/fdr'
import type { ProSEFileStatus, ProSEFileSummary, ProSEMultiSummary } from '../results/types'
import { baseName, type ResultModel } from './model'

/** An engine's long text, with the short plain line the table shows (the long one goes in its tooltip). */
export type EngineNote = { short: string; full: string }

export type PercolatorStatus = {
  /** `off`: the search did not rescore (the PSMs keep ProSE's scores). */
  kind: 'applied' | 'skipped' | 'off'
  label: string
  /** Why Percolator was skipped. */
  detail: EngineNote | null
  warning: EngineNote | null
}

/** ProSE's Percolator texts we know, in short plain words. */
const SHORT_NOTES: [RegExp, string][] = [
  [/sanity check rejected the learned model/i, 'Too few confident PSMs, so scored by the best single feature'],
  [/^Only (\d+) PSMs, Percolator rescoring needs at least (\d+)/, 'Only $1 PSMs, at least $2 needed'],
  [/^No decoy PSMs for the target\/decoy competition/, 'No decoy PSMs to learn from'],
  [/^No search run .* to rescore/, 'No search run to rescore'],
  [/^Percolator failed/, 'Percolator failed'],
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
  /** The numbers of the search's summary; null if it has none for the file. */
  ms2: number | null
  targets: number | null
  decoys: number | null
  percolator: PercolatorStatus
  /** The collision energy PeptDeep calibrated for the file, when PeptDeep ran. */
  nce: number | null
  seconds: number | null
  status: { ok: boolean; label: string }
  /** The PSM FDR was requested but not applied to the file's PSMs (no decoy PSM): they have no q-value. */
  psmFdrSkipped: boolean
}

/** One row per searched file, in the order of the search (the summary lists its files in that order). */
export function fileRows(m: ResultModel, summary: ProSEMultiSummary): FileRow[] {
  return m.tables.files.map((path, index) => {
    const f = summary.files[index]
    const designRow = m.design.rows[index]
    return {
      index,
      file: baseName(path),
      sample: designRow ? (m.design.samples[designRow.sample]?.label ?? null) : null,
      ms2: f?.ms2Spectra ?? null,
      targets: f?.targetPSMs ?? null,
      decoys: f?.decoyPSMs ?? null,
      percolator: percolatorStatus(f?.percolator ?? null),
      nce: f?.peptdeepNce ?? null,
      seconds: f?.secondsSearch ?? null,
      status: f ? fileStatus(f.status) : { ok: false, label: 'No report' },
      psmFdrSkipped: f?.psmFdrApplied === false,
    }
  })
}

/** The files whose PSM FDR was requested but not applied (ProSE skips it for a file without decoy PSMs). */
export function psmFdrSkipped(summary: ProSEMultiSummary): ProSEFileSummary[] {
  return summary.files.filter((f) => f.psmFdrApplied === false)
}

/**
 * Whether the PSM FDR applies to none of the PSMs: every file with PSMs had it skipped (and some file has PSMs). Then
 * there are no PSM q-values to filter by.
 */
export function psmFdrAppliedToNone(summary: ProSEMultiSummary): boolean {
  const withPsms = summary.files.filter((f) => f.targetPSMs + f.decoyPSMs > 0)
  return withPsms.length > 0 && withPsms.every((f) => f.psmFdrApplied === false)
}

/**
 * The search asked for no PSM FDR: a search without decoys (decoys 'ignore'), for which the app sends no FDR (ProSE could
 * not estimate one). Its PSMs have no q-value.
 */
export function psmFdrOff(summary: ProSEMultiSummary): boolean {
  return summary.psmFdr === 0
}

const NO_DECOYS = 'The search had no decoys, so ProSE could not estimate an FDR and applied none'

/** The Overview's "PSM FDR": the cutoff, and to which files it was not applied. */
export function psmFdrFact(summary: ProSEMultiSummary): { value: string; title: string } {
  if (psmFdrOff(summary)) return { value: 'off (no decoys)', title: `${NO_DECOYS}: the PSMs have no q-value and are not FDR-controlled.` }
  const cutoff = `${formatPercent(summary.psmFdr)} (${formatQ(summary.psmFdr)})`
  const skipped = psmFdrSkipped(summary)
  const why = 'ProSE skips the PSM FDR of a file whose PSMs match no decoy: without decoys it cannot estimate the FDR.'
  if (skipped.length === 0) return { value: cutoff, title: cutoff }
  if (skipped.length === summary.files.length) {
    return { value: 'not applied (no decoy PSMs)', title: `${cutoff} was requested but not applied. ${why} The PSMs are not FDR-controlled.` }
  }
  return {
    value: `${cutoff}, not applied to ${skipped.length} of ${summary.files.length} files`,
    title: `Not applied to ${skipped.map((f) => baseName(f.path)).join(', ')}. ${why} Their PSMs are not FDR-controlled.`,
  }
}

/**
 * The notice above the results when the PSM FDR was requested but not applied to some file, or null: its PSMs have
 * no q-value and are not FDR-controlled, though they are listed.
 */
export function psmFdrNotice(summary: ProSEMultiSummary): string | null {
  if (psmFdrOff(summary)) {
    return summary.files.some((f) => f.targetPSMs > 0)
      ? `${NO_DECOYS}: its PSMs have no q-value and are not FDR-controlled. Search with decoys to control the FDR.`
      : null
  }
  const skipped = psmFdrSkipped(summary).filter((f) => f.targetPSMs > 0)
  if (skipped.length === 0) return null
  const cutoff = formatPercent(summary.psmFdr)
  const names = skipped.map((f) => baseName(f.path))
  const which =
    skipped.length === summary.files.length
      ? 'the search'
      : names.length <= 3
        ? names.join(', ')
        : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more files`
  return (
    `The PSM FDR of ${cutoff} was not applied to ${which}: no PSM matched a decoy, so ProSE could not estimate the FDR. ` +
    `${skipped.length === summary.files.length ? 'The' : 'Their'} PSMs have no q-value and are not FDR-controlled: treat them with care, ` +
    `or search with decoys (and more spectra).`
  )
}

/** The sums of the file rows (a file without numbers adds nothing). */
export function totalsOf(rows: FileRow[]): { ms2: number; targets: number; decoys: number; seconds: number } {
  const totals = { ms2: 0, targets: 0, decoys: 0, seconds: 0 }
  for (const r of rows) {
    totals.ms2 += r.ms2 ?? 0
    totals.targets += r.targets ?? 0
    totals.decoys += r.decoys ?? 0
    totals.seconds += r.seconds ?? 0
  }
  return totals
}
