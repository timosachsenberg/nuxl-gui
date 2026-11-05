// The statistics of a search: what the shim records of each run of OpenNuXL (nuxl/<stem>.outputs.json,
// docs/design.md §2) and what the reader counts, as the web app's ProSEMultiSummary that the screens show
// (Overview: per file its status, PSMs, Percolator), with NuXL's own values next to it (`NuxlSummary`).

import type { ProSEFileSummary, ProSEMultiSummary } from './types'

/** `nuxl/<stem>.outputs.json`: the files of a finished run of OpenNuXL (docs/design.md §2). */
export interface RunOutputs {
  input: number
  /** OpenNuXL's -out (every PSM, before any FDR filter) */
  all: string | null
  /** the cross-links' filtered file of the highest threshold (every target cross-link with its q-value); null: none */
  xls: string | null
  /** the peptides' filtered file (every target peptide PSM with its q-value); null: none */
  peptides: string | null
  proteins: string | null
  report: string | null
  /** Percolator rescored the run, and the files are its (`_perc_`) */
  percolator: boolean
  /** OpenNuXL's warnings worth showing (e.g. that it skipped Percolator) */
  notes: string[]
  /** how long the run took; NaN: not recorded */
  seconds: number
  /** the search's cutoffs (fractions): the peptide PSMs and the cross-link PSMs are filtered at these */
  fdr: { peptide: number; xl: number }
  /**
   * the QPX mz view of the spectra of the run's PSMs (OpenNuXL's `-out_qpx`, `nuxl/<stem>.mz.parquet`, relative to
   * the search folder), from which the PSM view reads the peaks of every input; null: OpenNuXL could not write it (its
   * notes say why); undefined: a search of an app before 0.7, which has none (its peaks: `spectra`, else the input)
   */
  mz?: string | null
  /**
   * app versions before 0.7: the spectra of a Thermo .raw or Bruker .d input as mzML (the shim's FileConverter run
   * after the search, `nuxl/<stem>.spectra.mzML`, relative to the search folder), which the PSM view reads instead of
   * the input; null: an mzML input (absent in its outputs.json), or a .raw/.d whose spectra could not be converted
   */
  spectra: string | null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const fraction = (v: unknown, name: string): number => {
  if (typeof v !== 'number' || !(v > 0 && v <= 1)) throw new Error(`its fdr.${name} is not a fraction in (0, 1]`)
  return v
}

/** The record of outputs.json's text. Throws (without the file's name) if it is not one. */
export function parseOutputs(json: string): RunOutputs {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (e) {
    throw new Error(`it is not valid JSON (${(e as Error).message})`, { cause: e })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('it is not a record of a run')
  const r = value as Record<string, unknown>
  const fdr = (typeof r.fdr === 'object' && r.fdr !== null ? r.fdr : {}) as Record<string, unknown>
  return {
    input: typeof r.input === 'number' ? r.input : -1,
    all: text(r.all),
    xls: text(r.xls),
    peptides: text(r.peptides),
    proteins: text(r.proteins),
    report: text(r.report),
    percolator: r.percolator === true,
    notes: Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === 'string') : [],
    seconds: typeof r.seconds === 'number' ? r.seconds : NaN,
    fdr: { peptide: fraction(fdr.peptide, 'peptide'), xl: fraction(fdr.xl, 'xl') },
    ...('mz' in r ? { mz: text(r.mz) } : {}),
    spectra: text(r.spectra),
  }
}

/** OpenNuXL's notes that say why Percolator did not rescore a run ("Too few PSMs for score recalibration. Skipped."). */
const PERCOLATOR_NOTE = /score recalibration|percolator/i

/**
 * The Percolator outcome of a run: applied; skipped, with OpenNuXL's note why; null (not used: rescoring was off,
 * or the run did not finish).
 */
export function percolatorOf(outputs: RunOutputs | null): ProSEFileSummary['percolator'] {
  if (!outputs) return null
  if (outputs.percolator) return { applied: true, skipped: null, warning: null }
  const note = outputs.notes.find((n) => PERCOLATOR_NOTE.test(n))
  return note === undefined ? null : { applied: false, skipped: note, warning: null }
}

/** NuXL's values of a search, next to the ProSE-shaped summary (`SearchResult.nuxl`). */
export interface NuxlSummary {
  /** the search's cross-link FDR (a fraction): the cross-link PSMs (psms.xl.isXL 1) count at q ≤ xlFdr */
  xlFdr: number
  /** the search's peptide FDR: the peptide PSMs count at q ≤ peptideFdr */
  peptideFdr: number
  /** per input file: Percolator rescored its run */
  percolator: boolean[]
  /**
   * `psms.score` is Percolator's (svm_score): every run was rescored. Else it is NuXL's (NuXL:score) for every PSM,
   * so that the scores of a search where Percolator rescored only some runs are on one scale. Missing: as `percolator`
   * says (all rescored).
   */
  percolatorScores?: boolean
  /** per input file: OpenNuXL's notes of its run ([] for a run that did not finish) */
  notes: string[][]
  /** the NuXL preset of the search ('RNA-UV (U)'), if the folder says it */
  preset?: string
}

/** What the reader counts of each input for the summary. */
export interface InputCounts {
  path: string
  outputs: RunOutputs | null
  /** target PSMs within the search's FDRs (peptides and cross-links) */
  targetPsms: number
}

/** What the reader knows of the search as a whole. */
export interface SearchFacts {
  databaseFile: string
  enzyme: string
  decoyString: string
}

/** The summary of the search (inputs in order). */
export function toSummary(inputs: InputCounts[], facts: SearchFacts): ProSEMultiSummary {
  const files: ProSEFileSummary[] = inputs.map((k) => ({
    path: k.path,
    // a run without outputs.json did not finish (failed, cancelled): its status is unknown to the reader
    status: k.outputs ? 'EXECUTION_OK' : 'UNKNOWN_ERROR',
    // (OpenNuXL does not report the MS2 spectra it read)
    ms2Spectra: 0,
    targetPSMs: k.targetPsms,
    // the filtered files hold no decoys
    decoyPSMs: 0,
    percolator: percolatorOf(k.outputs),
    peptdeepNce: null,
    precursorError: null,
    fragmentError: null,
    secondsSearch: k.outputs && Number.isFinite(k.outputs.seconds) ? k.outputs.seconds : 0,
    psmFdrApplied: k.outputs ? true : null,
  }))
  const first = inputs.find((k) => k.outputs)?.outputs
  return {
    files,
    search: {
      databaseFile: facts.databaseFile,
      enzyme: facts.enzyme,
      openSearch: false,
      calibration: false,
      chunked: false,
      decoyMode: '',
      targetProteins: 0,
      decoyProteins: 0,
      indexedPeptides: 0,
      indexedFragments: 0,
      secondsIndexBuild: 0,
      secondsTotal: files.reduce((s, f) => s + f.secondsSearch, 0),
    },
    proteinFdrApplied: false,
    // the peptide FDR is the PSM FDR of the screens; the cross-link FDR is `nuxl.xlFdr`
    psmFdr: first?.fdr.peptide ?? 1,
    proteinFdr: 0,
    decoyString: facts.decoyString,
    openSearch: false,
    modificationAnalysis: null,
  }
}

/** The target PSMs of a search by its summary (the sum over its files); 0 if it says none. */
export function targetPsmsOf(summary: ProSEMultiSummary): number {
  return summary.files.reduce((n, f) => n + (Number.isFinite(f.targetPSMs) ? f.targetPSMs : 0), 0)
}
