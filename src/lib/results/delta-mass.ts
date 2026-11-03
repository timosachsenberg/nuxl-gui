// The open search's mass shifts, as the engine's modification analysis reports them: the delta-mass
// peaks (bars of the histogram, and a table of them) and the shifts it could map to known
// modifications (the mapped-PTM table).

import type { ModificationAnalysis } from '../results/types'
import { signedNumber } from '../format/number'

type Analysis = NonNullable<ModificationAnalysis>

/** What labels a shift: the modification it matches, else its mass ("−57.02"). */
export function deltaMassLabel(deltaMass: number, modification: string): string {
  return modification !== '' ? modification : signedNumber(deltaMass, 2)
}

export type ShiftBar = {
  /** Δ mass (Da). */
  x: number
  count: number
  known: boolean
  label: string
  modification: string | null
  /** Percent of the shifted PSMs. */
  percentage: number
}

/** The mass shifts for the histogram, by ascending mass. */
export function massShiftBars(a: Analysis): ShiftBar[] {
  return a.deltaMasses.entries
    .map((e) => ({
      x: e.deltaMass,
      count: e.count,
      known: e.known,
      label: deltaMassLabel(e.deltaMass, e.modification),
      modification: e.modification !== '' ? e.modification : null,
      percentage: e.percentage,
    }))
    .sort((p, q) => p.x - q.x)
}

export type ShiftRow = { mass: string; psms: number; share: string; modification: string | null; known: boolean }

const percent = (p: number) => `${p.toFixed(1)} %`

/** The mass shifts for the table, the most frequent first. */
export function massShiftRows(a: Analysis): ShiftRow[] {
  return [...a.deltaMasses.entries]
    .sort((p, q) => q.count - p.count || p.deltaMass - q.deltaMass)
    .map((e) => ({
      mass: signedNumber(e.deltaMass, 4),
      psms: e.count,
      share: percent(e.percentage),
      modification: e.modification !== '' ? e.modification : null,
      known: e.known,
    }))
}

export type PtmRow = {
  name: string
  theoretical: string
  observed: string
  /** observed − theoretical, in mDa. */
  deviation: string
  psms: number
  /** Distinct peptides among the PSMs; null if the engine reports more than there are PSMs (then it is no peptide count). */
  peptides: number | null
  share: string
  /** The residues the modification can sit on (Unimod). */
  residues: string
}

/** The shifts mapped to known modifications. (The engine's `residueCounts` count every residue of the peptides, so they are not shown.) */
export function ptmRows(a: Analysis): PtmRow[] {
  return a.ptms.entries.map((e) => ({
    name: e.name,
    theoretical: signedNumber(e.theoreticalMass, 4),
    observed: signedNumber(e.observedMass, 4),
    deviation: signedNumber(e.massDeviation * 1000, 3, { plus: false }),
    psms: e.count,
    peptides: e.uniquePeptides > e.count ? null : e.uniquePeptides,
    share: percent(e.percentage),
    residues: e.targetResidues,
  }))
}

export type ShiftSummary = {
  total: number
  shifted: number
  unmodified: number
  shareShifted: number
  /** Shifted PSMs whose shift no known modification explains. */
  unassigned: number
  /** Shifted PSMs mapped to known modifications. */
  mapped: number
  /** The counts are of the target PSMs (else the engine's, which count the decoy PSMs too). */
  targetsOnly: boolean
}

/** ProSE's limits (OpenSearchModificationAnalysis): a shift up to this (Da) is no shift. */
export const ZERO_SHIFT = 0.05
/** A PSM's shift names a mapped modification within this distance (Da) of its mass (MAX_MOD_MAPPING_TOL_). */
const MAPPING_TOLERANCE = 0.02

/**
 * The masses of the modifications the engine mapped shifts to, as it annotates its PSMs with them: the
 * theoretical mass of a modification; that of its base plus 1 Da per '+1Da' of an isotope variant ('Oxidation+1Da'),
 * which has none of its own; else the mean observed shift.
 */
function mappedMasses(a: Analysis): number[] {
  const theoretical = new Map(a.ptms.entries.map((e) => [e.name, e.theoreticalMass]))
  return a.ptms.entries.map((e) => {
    if (e.theoreticalMass !== 0 && Number.isFinite(e.theoreticalMass)) return e.theoreticalMass
    const variant = /^(.*?)((?:\+1Da)+)$/.exec(e.name)
    const base = variant ? theoretical.get(variant[1]) : undefined
    if (variant && base !== undefined && base !== 0 && Number.isFinite(base)) return base + variant[2].length / 4
    return e.observedMass
  })
}

/**
 * How many PSMs carry a shift, how many of those match a known modification and how many are unmodified.
 * `targetShifts`: the delta masses (Da; NaN: none) of the target PSMs at the search's FDR. The engine's
 * analysis counts the decoy PSMs too, so with them the counts are of the targets, as the rest of the results:
 * a shift above `ZERO_SHIFT` is a shift, and a shifted PSM is mapped when a mapped modification's mass is
 * within 0.02 Da of it (as the engine annotates its PSMs). Without them, the engine's counts.
 */
export function shiftSummary(a: Analysis, targetShifts?: ArrayLike<number>): ShiftSummary {
  if (!targetShifts) {
    const { totalPSMs, modifiedPSMs, unmodifiedPSMs } = a.deltaMasses
    return {
      total: totalPSMs,
      shifted: modifiedPSMs,
      unmodified: unmodifiedPSMs,
      shareShifted: totalPSMs > 0 ? modifiedPSMs / totalPSMs : 0,
      unassigned: a.ptms.unknownModificationPSMs,
      mapped: a.ptms.totalModifiedPSMs,
      targetsOnly: false,
    }
  }
  const masses = mappedMasses(a)
  let shifted = 0
  let unmodified = 0
  let mapped = 0
  for (let i = 0; i < targetShifts.length; i++) {
    const d = targetShifts[i]
    if (Number.isNaN(d)) continue
    if (Math.abs(d) <= ZERO_SHIFT) {
      unmodified++
      continue
    }
    shifted++
    if (masses.some((m) => Math.abs(d - m) < MAPPING_TOLERANCE)) mapped++
  }
  const total = targetShifts.length
  return {
    total,
    shifted,
    unmodified,
    shareShifted: total > 0 ? shifted / total : 0,
    unassigned: shifted - mapped,
    mapped,
    targetsOnly: true,
  }
}
