// The PSM view's logic that is not NuXL's own (that is in components/psm/nuxl-psm.ts): the ion series and their
// colours, the toggles the view keeps for all PSMs, the search's fragment tolerance, the peaks of a PSM's spectrum,
// the labels of ions, the numbers of the mass error plot, the modifications and features of a PSM, and the file
// name of an exported spectrum.

import type { PeakMatch, ResultTables, StoredSpectra } from '../results/types'
import { peptideView } from '../format/peptide'
import { scanNumber } from '../results/display'

export type IonType = 'a' | 'b' | 'c' | 'x' | 'y' | 'z'
export const ION_TYPES: readonly IonType[] = ['a', 'b', 'c', 'x', 'y', 'z']
const N_TERMINAL = new Set(['a', 'b', 'c'])
export const isNTerminal = (type: string) => N_TERMINAL.has(type)

/**
 * The colours of the ion series: b and y as validated with the palette (light b #2a78d6, y #eb6834;
 * dark b #3987e5, y #e8693a); the other series (a, c, x, z, the precursor) share a strong neutral, so
 * that the chart keeps two hues and their labels tell them apart; unmatched peaks are a faint grey.
 * CSS variables of app.css, so that both themes have their own steps (and the SVG export the light ones).
 */
export const COLORS = {
  b: 'var(--ion-b)',
  y: 'var(--ion-y)',
  other: 'var(--ion-other)',
  unmatched: 'var(--ion-unmatched)',
  mod: 'var(--mod)',
} as const

/**
 * The user's choices of the spectrum (kept by the view for all PSMs): the ion types, their charges and losses
 * (`null`: automatic, nuxl-psm.ts `resolveNuxlOptions`) and the precursor peaks.
 */
export type PsmOptionState = {
  ions: IonType[]
  charges: number[] | null
  losses: string[] | null
  precursor: boolean
}

export type Tolerance = { value: number; unit: 'ppm' | 'Da' }

/** OpenNuXL's fragment tolerance (nuxl-parameters.json), for a search whose parameters and defaults have none. */
const FALLBACK_TOLERANCE: Record<string, unknown> = {
  'fragment:mass_tolerance': 20,
  'fragment:mass_tolerance_unit': 'ppm',
}

/** A search parameter: the search's value, else the given default, else OpenNuXL's. */
function parameter(name: string, parameters: Record<string, unknown>, defaults: Record<string, unknown> = {}): unknown {
  if (name in parameters) return parameters[name]
  if (name in defaults) return defaults[name]
  return FALLBACK_TOLERANCE[name]
}

/** The fragment tolerance of the search, which the annotation uses too (`fragment:mass_tolerance[_unit]`). */
export function fragmentTolerance(parameters: Record<string, unknown>, defaults?: Record<string, unknown>): Tolerance {
  const value = Number(parameter('fragment:mass_tolerance', parameters, defaults))
  const unit = parameter('fragment:mass_tolerance_unit', parameters, defaults) === 'Da' ? 'Da' : 'ppm'
  return { value: value > 0 ? value : 20, unit }
}

export type Peaks = {
  /** The spectrum's index in `StoredSpectra`. */
  index: number
  /** Views of the stored arrays (sorted by m/z). */
  mz: Float32Array
  intensity: Float32Array
  collisionEnergy: number
}

/** The peaks of the spectrum of PSM `row`, or null when the search did not keep them. */
export function spectrumPeaks(spectra: StoredSpectra, row: number): Peaks | null {
  const index = spectra.psmSpectrum?.[row] ?? -1
  if (!(index >= 0) || index + 1 >= spectra.offsets.length) return null
  const [from, to] = [spectra.offsets[index], spectra.offsets[index + 1]]
  return {
    index,
    mz: spectra.mz.subarray(from, to),
    intensity: spectra.intensity.subarray(from, to),
    collisionEnergy: spectra.collisionEnergy[index] ?? NaN,
  }
}

/** A theoretical ion (annotate.ts): its name ("y7-H2O++"), type, number, charge and m/z. */
export type TheoreticalIon = { ion: string; type: string; ordinal: number; charge: number; mz: number }

/** The loss of a theoretical ion, from its name ("y7-H2O++" → "H2O"). */
export function lossOf(ion: string): string {
  if (ion.startsWith('[')) return /-([A-Za-z0-9]+)\]/.exec(ion)?.[1] ?? ''
  return /-([A-Za-z0-9]+)\+*$/.exec(ion)?.[1] ?? ''
}

const SUBSCRIPT: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' }
/** How a loss formula reads: subscripts, and CH₄SO as the loss of oxidised methionine is usually written. */
function formulaLabel(formula: string): string {
  if (formula === 'CH4OS') return 'CH₄SO'
  return formula.replace(/\d/g, (d) => SUBSCRIPT[d])
}

/** An ion's label: its name with the loss in subscripts ("y7-H₂O++"). */
export function ionLabel(ion: string): string {
  if (ion.startsWith('[')) return ion
  return ion.replace(/-([A-Za-z0-9]+)(\+*)$/, (_, f: string, plus: string) => `-${formulaLabel(f)}${plus}`)
}

/** The mean and the (sample) standard deviation of the matches' errors in ppm; NaN where undefined. */
export function errorStats(matches: PeakMatch[], error: (m: PeakMatch) => number = (m) => m.errorPpm): { mean: number; sd: number; n: number } {
  const n = matches.length
  if (n === 0) return { mean: NaN, sd: NaN, n }
  const mean = matches.reduce((s, m) => s + error(m), 0) / n
  const sd = n < 2 ? NaN : Math.sqrt(matches.reduce((s, m) => s + (error(m) - mean) ** 2, 0) / (n - 1))
  return { mean, sd, n }
}

/** Decimals of the error strip's ticks, so that ±tolerance reads as the tolerance (ppm: 1; 0.5 Da: 2; 0.005 Da: 4, trimmed). */
export function errorTickDigits(tolerance: Tolerance): number {
  if (tolerance.unit === 'ppm' || !(tolerance.value > 0)) return tolerance.unit === 'ppm' ? 1 : 2
  return Math.max(2, 1 - Math.floor(Math.log10(tolerance.value)))
}

/**
 * A match's fragment mass error in the unit of the search's fragment tolerance: ppm as the annotation gives it, or
 * Da (observed minus theoretical m/z of the peak; fragments of charge 2 are m/z too, as the tolerance is applied).
 */
export function fragmentError(m: PeakMatch, mz: ArrayLike<number>, unit: Tolerance['unit']): number {
  return unit === 'Da' ? mz[m.peak] - m.theoreticalMz : m.errorPpm
}

/**
 * The modifications of peptide `k`, with their sites: "Oxidation (M7)", "Acetyl (N-term)"; the fixed
 * ones (those the tables do not mark) after the others: "Carbamidomethyl (C2, fixed)".
 */
export function modificationList(t: ResultTables['peptides'], k: number, fixedMods: string[]): string[] {
  const view = peptideView(t, k, fixedMods)
  const sequence = t.sequence[k]
  const marked: string[] = []
  const fixed: string[] = []
  for (let i = t.modOffsets[k]; i < t.modOffsets[k + 1]; i++) {
    const position = t.modPosition[i]
    const name = t.modName[i]
    const atN = position < 0
    const atC = position >= sequence.length
    const site = atN ? 'N-term' : atC ? 'C-term' : `${sequence[position]}${position + 1}`
    const shown = atN ? view.nTerm?.name === name : atC ? view.cTerm?.name === name : view.residues[position]?.mod?.name === name
    if (shown) marked.push(`${name} (${site})`)
    else fixed.push(`${name} (${site}, fixed)`)
  }
  return [...marked, ...fixed]
}

/** A feature of PSM `row` by name (`psms.featureNames`), or NaN if the search has none of that name. */
export function featureValue(names: string[], features: Float64Array, row: number, name: string): number {
  const j = names.indexOf(name)
  return j < 0 ? NaN : features[row * names.length + j]
}

/** The file name of an exported spectrum: the peptide and the scan ("AVM_Oxidation_DDFAAFVEK_scan21507.svg"). */
export function svgFileName(peptide: string, nativeId: string): string {
  const clean = (text: string) => text.replace(/[^A-Za-z0-9.-]+/g, '_').replace(/^[_.]+|[_.]+$/g, '')
  const scan = scanNumber(nativeId)
  const spectrum = scan === null ? clean(nativeId) : `scan${scan}`
  return `${clean(peptide) || 'spectrum'}_${spectrum || 'spectrum'}.svg`
}
