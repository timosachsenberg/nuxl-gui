// The numbers behind the QC tab: the score distribution of the peptide PSMs and the cross-link PSMs, the
// precursor-error histogram and the PSMs per file. Everything is counted at the search's cutoffs (`levelRows`:
// peptide PSMs at the peptide FDR, cross-link PSMs at the cross-link FDR; OpenNuXL's filtered files hold no decoys).

import { levelRows } from './figures'
import { baseName, type ResultModel } from './model'

/**
 * The precursor-error axis spans at least ±1 ppm: no instrument resolves less, and exact masses (the
 * example's spectra) have errors of 1e-9 ppm, which would otherwise stretch the axis to ±1.5e-9.
 */
export const MIN_ERROR_RANGE_PPM = 1

/** An error below this (ppm) is numerical noise on an exact mass and counts as 0. */
const EXACT_PPM = 1e-6

/** The most bins a histogram gets: about 30 bars fit a chart of normal width. */
export const MAX_BINS = 32

/**
 * The smallest round step (1, 2, 2.5 or 5 × 10^n) that cuts `span` into at most `maxBins` bins; 1
 * without a span.
 */
export function niceStep(span: number, maxBins: number): number {
  if (!(span > 0)) return 1
  const raw = span / maxBins
  const power = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * power >= raw * (1 - 1e-9)) return Number((m * power).toPrecision(12))
  }
  return 10 * power
}

const clean = (v: number) => Number(v.toPrecision(12)) // 0.1 × 3 is 0.30000000000000004

/** Round bin edges that cover [min, max] in at most `maxBins` bins (about `maxBins` for a spread-out range). */
export function binEdges(min: number, max: number, maxBins = MAX_BINS): number[] {
  const step = niceStep(max - min, maxBins)
  const start = Math.floor(min / step + 1e-9) * step
  const n = Math.max(1, Math.ceil((max - start) / step - 1e-9))
  return Array.from({ length: n + 1 }, (_, i) => clean(start + i * step))
}

/** Edges from -R to R in round steps with 0 an edge (an even number of bins), R covering `maxAbs`. */
export function symmetricEdges(maxAbs: number, maxBins = MAX_BINS): number[] {
  const step = niceStep(2 * maxAbs, maxBins)
  const radius = Math.max(step, Math.ceil(maxAbs / step - 1e-9) * step)
  const n = Math.round((2 * radius) / step)
  return Array.from({ length: n + 1 }, (_, i) => clean(-radius + i * step))
}

/**
 * The number of `values` in each bin [edge, next edge); the last bin includes its upper edge. Values
 * outside the edges, and what is no number, are skipped.
 */
export function countInBins(values: ArrayLike<number>, edges: number[]): number[] {
  const n = edges.length - 1
  const counts = new Array<number>(Math.max(0, n)).fill(0)
  if (n < 1) return counts
  for (let k = 0; k < values.length; k++) {
    const v = values[k]
    if (!(v >= edges[0] && v <= edges[n])) continue // NaN too
    let lo = 0
    let hi = n
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (edges[mid] <= v) lo = mid
      else hi = mid
    }
    counts[lo]++
  }
  return counts
}

export type ScoreDistribution = {
  /** The score on the x axis: "Percolator score" when the search rescored, else "NuXL score". */
  scoreName: string
  edges: number[]
  /** Per bin: the target PSMs without a cross-link, and the cross-link PSMs. */
  peptides: number[]
  crossLinks: number[]
  nPeptides: number
  nCrossLinks: number
  /** PSMs at the cutoffs without a score to plot (Percolator could not rescore them). */
  unscored: number
}

/**
 * The scores of the target PSMs at the search's cutoffs, the peptide PSMs and the cross-link PSMs apart
 * (contaminants count), in shared bins. This shows what passed, not the whole distribution. `null` without a PSM
 * to plot.
 */
export function scoreDistribution(m: ResultModel): ScoreDistribution | null {
  const ps = m.tables.psms
  const peptides: number[] = []
  const crossLinks: number[] = []
  let unscored = 0
  let min = Infinity
  let max = -Infinity
  for (const i of levelRows(m, 'psms', false)) {
    const s = ps.score[i]
    // a hit Percolator could not rescore has -100 with q-value 1
    if (!Number.isFinite(s) || (s === -100 && !(ps.qValue[i] < 1))) {
      unscored++
      continue
    }
    if (s < min) min = s
    if (s > max) max = s
    ;(ps.xl.isXL[i] ? crossLinks : peptides).push(s)
  }
  if (peptides.length + crossLinks.length === 0) return null
  const edges = binEdges(min, max)
  return {
    scoreName: m.rescored ? 'Percolator score' : 'NuXL score',
    edges,
    peptides: countInBins(peptides, edges),
    crossLinks: countInBins(crossLinks, edges),
    nPeptides: peptides.length,
    nCrossLinks: crossLinks.length,
    unscored,
  }
}

export type PrecursorErrors = {
  /** Symmetric around 0, in ppm. */
  edges: number[]
  counts: number[]
  /** The PSMs in the histogram. */
  n: number
  /** The target PSMs at the cutoff (the histogram leaves out those without an error). */
  considered: number
  /** The median error (signed, ppm): the search's calibration. */
  median: number
}

/**
 * The precursor mass errors (ppm) of the target PSMs at the search's cutoffs (a cross-link's with its adduct's
 * mass). `null` without an error to plot.
 */
export function precursorErrors(m: ResultModel): PrecursorErrors | null {
  const ps = m.tables.psms
  const rows = levelRows(m, 'psms', false)
  const errors: number[] = []
  let maxAbs = 0
  for (const i of rows) {
    let e = ps.precursorErrorPpm[i]
    if (!Number.isFinite(e)) continue
    if (Math.abs(e) < EXACT_PPM) e = 0 // an exact mass: the sign of rounding noise is no information
    errors.push(e)
    maxAbs = Math.max(maxAbs, Math.abs(e))
  }
  if (errors.length === 0) return null
  const edges = symmetricEdges(Math.max(maxAbs, MIN_ERROR_RANGE_PPM))
  const sorted = Float64Array.from(errors).sort()
  const n = sorted.length
  return {
    edges,
    counts: countInBins(errors, edges),
    n,
    considered: rows.length,
    median: n % 2 === 1 ? sorted[n >> 1] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
  }
}

/** `parts`: of `count`, the peptide PSMs and the cross-link PSMs. */
export type FileCount = { file: string; count: number; parts: [number, number] }

/** The target PSMs at the search's cutoffs in each searched file, in the order of the search, peptides and cross-links apart. */
export function psmsPerFile(m: ResultModel): FileCount[] {
  const counts = new Array<number>(m.tables.files.length).fill(0)
  const xls = new Array<number>(m.tables.files.length).fill(0)
  const { file, xl } = m.tables.psms
  for (const i of levelRows(m, 'psms', false)) {
    counts[file[i]]++
    if (xl.isXL[i] === 1) xls[file[i]]++
  }
  return m.tables.files.map((path, f) => ({ file: baseName(path), count: counts[f], parts: [counts[f] - xls[f], xls[f]] }))
}
