// The statistics of a search: ProSE's QPX run and provenance views (quantms.run.parquet, one row per input;
// quantms.provenance.parquet, one row per step of the search, with -qpx_extended; documented in the tool's
// documentation) and the open search's modification analysis
// (mods/*_ModificationAnalysis_{DeltaMassStats,PTMStats}.tsv) as the web app's ProSEMultiSummary
// (docs/parity.md, "ProSEMultiSummary").

import { openParquet, readObjects } from './parquet'
import type { ProSEFileSummary, ProSEMultiSummary, ProSESummary } from './types'

/** A row of the run view: one input of the search, in input order. */
export interface RunRow {
  run_accession: string
  search_status: string | null
  ms2_spectra_count: number
  identified_spectra_count: number
  decoy_psm_count: number
  /** its rows in quantms.psm.parquet */
  psm_rows: number
  /** null: the search did not rescore */
  rescoring_applied: boolean | null
  rescoring_skipped_reason: string | null
  rescoring_warning: string | null
  prediction_nce: number | null
  precursor_error_median_ppm: number | null
  precursor_error_mad_ppm: number | null
  precursor_tolerance_recommended_ppm: number | null
  fragment_error_median_ppm: number | null
  fragment_error_mad_ppm: number | null
  fragment_tolerance_recommended_ppm: number | null
  search_seconds: number
  /**
   * The PSM FDR (FDR:PSM) was applied to the run's PSMs; false: it was requested but skipped (no decoy PSM to
   * estimate it, so the PSMs have no q-value and are not filtered); null: none was requested. Undefined: the run view
   * has no such column (ProSE before it), see `toSummary`.
   */
  psm_fdr_applied?: boolean | null
}

/** The parameters of a step of the provenance view, by key. */
export type Parameters = Map<string, string>

/** What the run and provenance views say about the search. */
export interface SearchMeta {
  runs: RunRow[]
  /** the parameters of the database search (step 'peptide_search') */
  search: Parameters
  /** the parameters of the FDR filtering (step 'target_decoy_fdr') */
  fdr: Parameters
}

const RUN_COLUMNS: (keyof RunRow)[] = [
  'run_accession',
  'search_status',
  'ms2_spectra_count',
  'identified_spectra_count',
  'decoy_psm_count',
  'psm_rows',
  'rescoring_applied',
  'rescoring_skipped_reason',
  'rescoring_warning',
  'prediction_nce',
  'precursor_error_median_ppm',
  'precursor_error_mad_ppm',
  'precursor_tolerance_recommended_ppm',
  'fragment_error_median_ppm',
  'fragment_error_mad_ppm',
  'fragment_tolerance_recommended_ppm',
  'search_seconds',
]

/** The columns of the run view that a later ProSE added: read when it has them. */
const OPTIONAL_RUN_COLUMNS: (keyof RunRow)[] = ['psm_fdr_applied']

/** A number of a view (int64 as bigint); `fallback` if it is null. */
const asNumber = (v: unknown, fallback: number): number => (typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : fallback)

/** The rows of the run view (bytes of quantms.run.parquet). Throws if a column is missing. */
export async function readRuns(bytes: Uint8Array): Promise<RunRow[]> {
  const file = openParquet(bytes)
  const names = new Set(file.tree.children.map((c) => c.element.name))
  const missing = RUN_COLUMNS.filter((c) => !names.has(c))
  if (missing.length > 0) throw new Error(`the run view has not the columns of ProSE's -qpx_extended (${missing.join(', ')})`)
  const optional = OPTIONAL_RUN_COLUMNS.filter((c) => names.has(c))
  const rows = await readObjects(file, [...RUN_COLUMNS, ...optional])
  return rows.map((r) => ({
    run_accession: String(r.run_accession ?? ''),
    search_status: typeof r.search_status === 'string' ? r.search_status : null,
    ms2_spectra_count: asNumber(r.ms2_spectra_count, 0),
    identified_spectra_count: asNumber(r.identified_spectra_count, 0),
    decoy_psm_count: asNumber(r.decoy_psm_count, 0),
    psm_rows: asNumber(r.psm_rows, 0),
    rescoring_applied: typeof r.rescoring_applied === 'boolean' ? r.rescoring_applied : null,
    rescoring_skipped_reason: typeof r.rescoring_skipped_reason === 'string' ? r.rescoring_skipped_reason : null,
    rescoring_warning: typeof r.rescoring_warning === 'string' ? r.rescoring_warning : null,
    prediction_nce: r.prediction_nce === null || r.prediction_nce === undefined ? null : asNumber(r.prediction_nce, NaN),
    precursor_error_median_ppm: r.precursor_error_median_ppm === null ? null : asNumber(r.precursor_error_median_ppm, NaN),
    precursor_error_mad_ppm: r.precursor_error_mad_ppm === null ? null : asNumber(r.precursor_error_mad_ppm, NaN),
    precursor_tolerance_recommended_ppm:
      r.precursor_tolerance_recommended_ppm === null ? null : asNumber(r.precursor_tolerance_recommended_ppm, NaN),
    fragment_error_median_ppm: r.fragment_error_median_ppm === null ? null : asNumber(r.fragment_error_median_ppm, NaN),
    fragment_error_mad_ppm: r.fragment_error_mad_ppm === null ? null : asNumber(r.fragment_error_mad_ppm, NaN),
    fragment_tolerance_recommended_ppm:
      r.fragment_tolerance_recommended_ppm === null ? null : asNumber(r.fragment_tolerance_recommended_ppm, NaN),
    search_seconds: asNumber(r.search_seconds, 0),
    ...(optional.includes('psm_fdr_applied') ? { psm_fdr_applied: typeof r.psm_fdr_applied === 'boolean' ? r.psm_fdr_applied : null } : {}),
  }))
}

/** The parameters of each step of the provenance view (bytes of quantms.provenance.parquet), by step name. */
export async function readSteps(bytes: Uint8Array): Promise<Map<string, Parameters>> {
  const file = openParquet(bytes)
  const rows = await readObjects(file, ['step_name', 'parameters'])
  const steps = new Map<string, Parameters>()
  for (const r of rows) {
    const parameters = new Map<string, string>()
    for (const p of (r.parameters as { key: string; value: string }[] | null) ?? []) parameters.set(p.key, p.value ?? '')
    steps.set(String(r.step_name), parameters)
  }
  return steps
}

/** The search's meta data from the bytes of the run and provenance views. Throws if a step is missing. */
export async function readMeta(runBytes: Uint8Array, provenanceBytes: Uint8Array): Promise<SearchMeta> {
  const [runs, steps] = await Promise.all([readRuns(runBytes), readSteps(provenanceBytes)])
  const search = steps.get('peptide_search')
  const fdr = steps.get('target_decoy_fdr')
  if (!search || !fdr) throw new Error('the provenance view has not the steps of ProSE (peptide_search, target_decoy_fdr)')
  return { runs, search, fdr }
}

/** A number parameter; `fallback` if it is missing or not a number. */
export const parameterNumber = (p: Parameters, key: string, fallback = 0): number => {
  const v = Number(p.get(key) ?? NaN)
  return p.get(key) === '' || Number.isNaN(v) ? fallback : v
}
export const parameterFlag = (p: Parameters, key: string): boolean => p.get(key) === 'true'

const STATUSES: ProSEFileSummary['status'][] = ['EXECUTION_OK', 'INPUT_FILE_EMPTY', 'UNEXPECTED_RESULT', 'UNKNOWN_ERROR', 'ILLEGAL_PARAMETERS']

/** A mass error estimate; null: none. */
function massError(median: number | null, mad: number | null, recommended: number | null): ProSESummary['run']['precursorError'] {
  if (median === null || mad === null || recommended === null) return null
  return { median, mad, recommended }
}

/**
 * The rescoring outcome of a run: null when the search did not rescore (the web app has null for a search
 * with `rescore: false`), else applied, skipped and warning.
 */
function percolator(r: RunRow): ProSEFileSummary['percolator'] {
  if (r.rescoring_applied === null) return null
  if (!r.rescoring_applied && r.rescoring_skipped_reason === null) return null
  return { applied: r.rescoring_applied, skipped: r.rescoring_skipped_reason, warning: r.rescoring_warning }
}

/**
 * Whether ProSE applied the PSM FDR to run `r` (`ProSEFileSummary.psmFdrApplied`): the run view's psm_fdr_applied,
 * else the provenance's (target_decoy_fdr: psm_fdr_applied, of the whole search: false if some run had it skipped),
 * else, for a ProSE that reports neither, inferred: a PSM FDR was requested and no PSM of the run has a q-value
 * (`hasQValues`; ProSE skips the PSM FDR of a run without decoy PSMs and leaves the q-values out). Null: no PSM FDR
 * was requested.
 */
function psmFdrAppliedOf(r: RunRow, meta: SearchMeta, hasQValues: boolean | undefined): boolean | null {
  if (r.psm_fdr_applied !== undefined) return r.psm_fdr_applied
  if (!(parameterNumber(meta.fdr, 'psm_fdr') > 0)) return null
  // (true for the search: true for every run; false: not for some, which the PSMs tell)
  if (meta.fdr.get('psm_fdr_applied') === 'true') return true
  // (a run without PSM rows has nothing to tell, and nothing that the PSM FDR could have filtered)
  return r.psm_rows === 0 ? true : (hasQValues ?? true)
}

/**
 * The summary of the search: `paths` are the app's inputs (in order; the run view has their stems),
 * `modificationAnalysis` the parsed TSVs (null: closed search), `hasQValues` per run whether some PSM of it has a
 * q-value (for a ProSE that does not report whether it applied the PSM FDR; omitted: assumed).
 */
export function toSummary(
  meta: SearchMeta,
  paths: string[],
  modificationAnalysis: ProSESummary['modificationAnalysis'],
  hasQValues?: boolean[],
): ProSEMultiSummary {
  const s = meta.search
  const files: ProSEFileSummary[] = meta.runs.map((r, i) => ({
    path: paths[i] ?? r.run_accession,
    status: STATUSES.find((x) => x === r.search_status) ?? 'UNKNOWN_ERROR',
    ms2Spectra: r.ms2_spectra_count,
    targetPSMs: r.identified_spectra_count,
    decoyPSMs: r.decoy_psm_count,
    percolator: percolator(r),
    peptdeepNce: r.prediction_nce,
    precursorError: massError(r.precursor_error_median_ppm, r.precursor_error_mad_ppm, r.precursor_tolerance_recommended_ppm),
    fragmentError: massError(r.fragment_error_median_ppm, r.fragment_error_mad_ppm, r.fragment_tolerance_recommended_ppm),
    secondsSearch: r.search_seconds,
    psmFdrApplied: psmFdrAppliedOf(r, meta, hasQValues?.[i]),
  }))
  const openSearch = parameterFlag(s, 'open_search')
  return {
    files,
    search: {
      databaseFile: s.get('database_file') ?? '',
      enzyme: s.get('enzyme') ?? '',
      openSearch,
      calibration: parameterFlag(s, 'calibration'),
      chunked: parameterFlag(s, 'chunked'),
      decoyMode: s.get('decoy_mode') ?? '',
      targetProteins: parameterNumber(s, 'db_target_proteins'),
      decoyProteins: parameterNumber(s, 'db_decoy_proteins'),
      indexedPeptides: parameterNumber(s, 'indexed_peptides'),
      indexedFragments: parameterNumber(s, 'indexed_fragments'),
      secondsIndexBuild: parameterNumber(s, 'seconds_index_build'),
      secondsTotal: parameterNumber(s, 'seconds_total'),
    },
    proteinFdrApplied: parameterFlag(meta.fdr, 'protein_fdr_applied'),
    psmFdr: parameterNumber(meta.fdr, 'psm_fdr'),
    proteinFdr: parameterNumber(meta.fdr, 'protein_fdr'),
    decoyString: s.get('decoy_string') ?? 'DECOY_',
    openSearch,
    modificationAnalysis,
  }
}

/** The target PSMs of a search by its run view (the sum of identified_spectra_count); 0 if it says none. */
export function targetPsmsOf(runs: RunRow[]): number {
  return runs.reduce((n, r) => n + (Number.isFinite(r.identified_spectra_count) ? r.identified_spectra_count : 0), 0)
}

//------------------------------------------------------------------------------
// The modification analysis

/** The header values ('# Total PSMs: 3') and the rows of a ModificationAnalysis TSV. */
function parseTsv(tsv: string): { header: Map<string, string>; rows: Record<string, string>[] } {
  const header = new Map<string, string>()
  const lines = tsv.split(/\r?\n/)
  let i = 0
  for (; i < lines.length && lines[i].startsWith('#'); i++) {
    const m = /^#\s*([^:]+):\s*(.*)$/.exec(lines[i])
    if (m) header.set(m[1].trim(), m[2].trim())
  }
  const columns = (lines[i] ?? '').split('\t')
  const rows = lines
    .slice(i + 1)
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const cells = l.split('\t')
      return Object.fromEntries(columns.map((c, j) => [c, cells[j] ?? '']))
    })
  return { header, rows }
}

const toNumber = (s: string | undefined) => (s === undefined || s === '' ? NaN : Number(s))

/** 'A:4,D:2' → { A: 4, D: 2 } */
function residueCounts(s: string | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pair of (s ?? '').split(',')) {
    const [residue, count] = pair.split(':')
    if (residue && count !== undefined) out[residue.trim()] = Number(count)
  }
  return out
}

/**
 * The modification analysis of the TSVs (six significant digits). The PTM table has no charge states:
 * chargeStates is 0 (the web app's screens do not show it).
 */
export function parseModificationAnalysis(deltaMassStats: string, ptmStats: string): NonNullable<ProSESummary['modificationAnalysis']> {
  const d = parseTsv(deltaMassStats)
  const p = parseTsv(ptmStats)
  return {
    deltaMasses: {
      totalPSMs: toNumber(d.header.get('Total PSMs')),
      modifiedPSMs: toNumber(d.header.get('Modified PSMs')),
      unmodifiedPSMs: toNumber(d.header.get('Unmodified PSMs')),
      // ProSE since OpenMS #10715 counts the target PSMs only and says how many decoy PSMs it left out
      ...(d.header.has('Decoy PSMs') ? { decoyPSMs: toNumber(d.header.get('Decoy PSMs')) } : {}),
      meanDeltaMass: toNumber(d.header.get('Mean Delta Mass')),
      medianDeltaMass: toNumber(d.header.get('Median Delta Mass')),
      entries: d.rows.map((r) => ({
        deltaMass: toNumber(r.DeltaMass),
        count: toNumber(r.Count),
        uniquePeptides: toNumber(r.UniquePeptides),
        chargeStates: toNumber(r.ChargeStates),
        percentage: toNumber(r.Percentage),
        modification: r.MappedModification ?? '',
        known: r.IsKnown === 'true',
      })),
    },
    ptms: {
      totalModifiedPSMs: toNumber(p.header.get('Total Modified PSMs')),
      unknownModificationPSMs: toNumber(p.header.get('Unknown Modification PSMs')),
      uniqueModifications: toNumber(p.header.get('Unique Modifications')),
      entries: p.rows.map((r) => ({
        name: r.Name ?? '',
        theoreticalMass: toNumber(r.TheoreticalMass),
        observedMass: toNumber(r.ObservedMass),
        massDeviation: toNumber(r.MassDeviation),
        count: toNumber(r.Count),
        uniquePeptides: toNumber(r.UniquePeptides),
        chargeStates: 0,
        percentage: toNumber(r.Percentage),
        targetResidues: r.TargetResidues ?? '',
        residueCounts: residueCounts(r.ResidueFrequency),
      })),
    },
  }
}
