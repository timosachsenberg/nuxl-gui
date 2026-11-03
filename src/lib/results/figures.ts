// The key figures above the results tables, and the size of each level (its tab's count), all at the
// search's cutoffs: what the search found, before the user filters anything.

import type { ProSEMultiSummary } from '../results/types'
import { applyFilters, defaultFilters, type Kind } from './filters'
import type { Level, ResultModel } from './model'

/**
 * The rows of a level at the search's cutoffs (the peptide FDR for peptide PSMs, the cross-link FDR for cross-links;
 * proteins: those with such a PSM, as OpenNuXL has no protein FDR), contaminants included, decoys only `withDecoys`; of one `kind` (default all:
 * 'xl' gives the cross-link PSMs, the cross-linked peptides and proteins). Computed once per model; do not modify.
 */
export function levelRows(m: ResultModel, level: Level, withDecoys: boolean, kind: Kind = 'all'): Uint32Array {
  let cache = levelCache.get(m)
  if (!cache) levelCache.set(m, (cache = new Map()))
  const key = `${level}${withDecoys ? '+decoys' : ''}/${kind}`
  let rows = cache.get(key)
  if (!rows) {
    const maxQ = level === 'proteins' ? m.proteinFdr : m.psmFdr
    rows = applyFilters(m, level, { ...defaultFilters(), maxQ, maxXlQ: m.xlFdr, kind, showDecoys: withDecoys })
    cache.set(key, rows)
  }
  return rows
}

/** The rows of `levelRows`, once per model (the key figures, the tabs and "n of total" share them). */
const levelCache = new WeakMap<ResultModel, Map<string, Uint32Array>>()

/** The number of `levelRows`. */
export function levelTotal(m: ResultModel, level: Level, withDecoys: boolean, kind: Kind = 'all'): number {
  return levelRows(m, level, withDecoys, kind).length
}

export type KeyFigures = {
  /**
   * The target proteins with a PSM at the search's cutoffs (contaminants included): the rows of the Proteins tab
   * (before the user's filters). OpenNuXL has no protein FDR and no protein groups.
   */
  proteins: number
  /** Target peptides (peptidoforms) whose best PSM is within the PSM FDR. */
  peptides: number
  /** Target PSMs within the PSM FDR of their kind (peptide PSMs at the peptide FDR, cross-links at the XL FDR). */
  psms: number
  /** Of `psms`, the cross-link PSMs. */
  xlPsms: number
  /** Of `peptides`, the cross-linked ones (`peptides.isXL`). */
  xlPeptides: number
  /** Of `proteins`, those with a cross-link PSM. */
  xlProteins: number
  /** The search's cutoffs of the peptide PSMs and of the cross-link PSMs (fractions). */
  peptideFdr: number
  xlFdr: number
  /** The MS2 spectra those PSMs identify (a spectrum counts once, should it have more than one PSM). */
  spectra: number
  /** MS2 spectra in the searched files. */
  ms2: number
  /** `spectra / ms2` (identified spectra, not PSMs: at most 1), or null without MS2 counts. */
  identifiedShareOfMs2: number | null
  /** The median absolute precursor error of those PSMs (ppm), or null. */
  medianAbsPpm: number | null
  /** Biological samples and conditions of the design. */
  samples: number
  conditions: number
}

export function keyFigures(m: ResultModel, summary: ProSEMultiSummary): KeyFigures {
  const proteins = levelRows(m, 'proteins', false)
  const psms = levelRows(m, 'psms', false)
  const ms2 = summary.files.reduce((n, f) => n + f.ms2Spectra, 0)
  const spectra = identifiedSpectra(m, psms)

  const errors = new Float64Array(psms.length)
  let n = 0
  const ppm = m.tables.psms.precursorErrorPpm
  for (const i of psms) {
    const e = ppm[i]
    if (e === e) errors[n++] = Math.abs(e)
  }
  const sorted = errors.subarray(0, n).sort()
  const median = n === 0 ? null : n % 2 === 1 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2

  return {
    proteins: proteins.length,
    peptides: levelTotal(m, 'peptides', false),
    psms: psms.length,
    xlPsms: levelTotal(m, 'psms', false, 'xl'),
    xlPeptides: levelTotal(m, 'peptides', false, 'xl'),
    xlProteins: levelTotal(m, 'proteins', false, 'xl'),
    peptideFdr: m.psmFdr,
    xlFdr: m.xlFdr,
    ms2,
    spectra,
    identifiedShareOfMs2: ms2 > 0 ? Math.min(1, spectra / ms2) : null,
    medianAbsPpm: median,
    samples: new Set(m.columnSample).size,
    conditions: m.design.conditions.length,
  }
}

/** The distinct spectra (file and native ID) of the PSM rows `psms`; a PSM without a native ID counts as one. */
function identifiedSpectra(m: ResultModel, psms: Uint32Array): number {
  const { file, nativeId } = m.tables.psms
  const seen = new Map<number, Set<string>>()
  let spectra = 0
  for (const i of psms) {
    if (nativeId[i] === '') {
      spectra++
      continue
    }
    let ids = seen.get(file[i])
    if (!ids) seen.set(file[i], (ids = new Set()))
    if (ids.has(nativeId[i])) continue
    ids.add(nativeId[i])
    spectra++
  }
  return spectra
}
