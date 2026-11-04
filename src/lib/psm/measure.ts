// The PSM view's two click tools on the observed spectrum, as in pyopenms-viewer (spectrum_panel.py) and openms-viewer
// (SpectrumWidget): "Measure" (two peaks, their Δm/z as an orange bracket) and "Label" (a text of one's own above a
// peak). This is their logic, without the page: snapping a click to a peak, the bracket's geometry, what the user made
// (per spectrum, kept by the view for the session) and, beyond the viewers, what a Δm/z may be.
//
// Snapping is the viewers' (openms-viewer's peakAt): among the peaks within 10 px of the pointer along m/z, the one
// whose top is nearest the pointer on screen, so that pointing high takes the tall neighbour; none within 10 px, none.
//
// The Δ is written with three decimals: the stored peaks are Float32 (StoredSpectra), whose spacing near m/z 1000 is
// 6e-5 (1.2e-4 above 1024), so a fourth decimal of a difference of two of them would not be sure.
//
// What a Δm/z may be: an amino acid residue (its mass in a peptide, Residue::Internal), unmodified (not one that the
// search modified with a fixed modification: such a residue does not occur, unless the modification cannot be read),
// or with one of the search's fixed or variable modifications ("Oxidation (M)": M(Oxidation)); a fragment adduct or
// nucleotide of the search, the shifts and marker ions of nuxl-theoretical.ts (the preset's fragment adducts, else
// NuXL:fragment_adducts, else OpenNuXL's; with the nucleotides OpenNuXL always has as marker ions), written "U (nt)"
// so that the nucleotides C, G, A and T are not read as the residues of the same letters; and, for a cross-link, a
// residue the nucleotide may be on with a fragment adduct ("C+U-H₂O"): the Δ between two ions of which only one has the
// cross-linked residue, one of them shifted. A Δ matches within the sum of the search's fragment tolerances at its two
// peaks (each peak may be off by its tolerance), at charge 1 or, where the view shows 2+ fragments, 2 ("≈ Y (2+)").
// One match is written "≈ Y"; several (Δs between residues of near mass, K and Q at a tolerance in Da) "≈ K / Q?", the
// closest first, at most three, the "?" saying that the Δ cannot tell them apart. Residues of the same mass are one:
// I/L.

import { adductLabel } from '$lib/format/peptide'
import { parsePeptide } from './annotate'
import type { NuxlChemistry } from './nuxl-theoretical'
import { nearest } from './plot'
import type { Tolerance } from './psm'

//------------------------------------------------------------------------------
// What the user made

/** A peak, as the tools keep it: its m/z and intensity (as shown). */
export type PeakPoint = { mz: number; intensity: number }
/** Two peaks measured, in the order they were clicked. */
export type Measurement = { a: PeakPoint; b: PeakPoint }
/** A text of the user's above a peak. */
export type UserLabel = PeakPoint & { text: string }
/** The measurements and labels of one spectrum. */
export type PsmMarks = { measurements: Measurement[]; labels: UserLabel[] }

export const NO_MARKS: PsmMarks = Object.freeze({ measurements: [], labels: [] }) as PsmMarks

/** The tool that clicks on the spectrum use, if one: they are exclusive. */
export type SpectrumTool = 'measure' | 'label' | null

/** The Δm/z of a measurement. */
export const deltaOf = (m: Measurement) => Math.abs(m.b.mz - m.a.mz)

/** A Δm/z as the bracket writes it: "Δ163.063" (three decimals: the peaks are Float32). */
export const deltaText = (delta: number) => `Δ${delta.toFixed(3)}`

/** The label of a user's peak at `mz` (the same peak: within 0.001), its index or -1. */
export function labelIndexAt(labels: UserLabel[], mz: number): number {
  return labels.findIndex((l) => Math.abs(l.mz - mz) <= 1e-3)
}

/**
 * The labels with `text` at `peak`: a new one, the peak's label changed, or, with an empty text, the peak's label
 * removed (as openms-viewer: clearing the text removes the label).
 */
export function withLabel(labels: UserLabel[], peak: PeakPoint, text: string): UserLabel[] {
  const t = text.trim()
  const at = labelIndexAt(labels, peak.mz)
  if (t === '') return at < 0 ? labels : labels.filter((_, i) => i !== at)
  if (at >= 0) return labels.map((l, i) => (i === at ? { ...l, text: t } : l))
  return [...labels, { mz: peak.mz, intensity: peak.intensity, text: t }]
}

//------------------------------------------------------------------------------
// Snapping

/**
 * The peak a click at (`px`, `py`) snaps to (an index of `mz`, sorted), or -1: of the peaks within `window` px of `px`
 * on screen along m/z, the one whose top (`topOf`) is nearest the pointer. `x` maps m/z to px, `mzAt` px to m/z.
 */
export function snapPeak(
  mz: ArrayLike<number>,
  x: (mz: number) => number,
  mzAt: (px: number) => number,
  topOf: (i: number) => number,
  px: number,
  py: number,
  window = 10,
): number {
  const start = nearest(mz, mzAt(px))
  if (start < 0) return -1
  let best = -1
  let bestDistance = Infinity
  const consider = (i: number) => {
    const dx = x(mz[i]) - px
    if (Math.abs(dx) > window) return false
    const dy = topOf(i) - py
    const d = dx * dx + dy * dy
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
    return true
  }
  for (let i = start; i < mz.length; i++) if (!consider(i)) break
  for (let i = start - 1; i >= 0; i--) if (!consider(i)) break
  return best
}

//------------------------------------------------------------------------------
// The brackets

/** A box on screen (y down). */
export type Box = { x0: number; x1: number; y0: number; y1: number }

/**
 * A bracket on screen: the two peaks' x and tops, where their dotted lines start (`da`, `db`: the top, or above the
 * labels the line would cross), the bar's y, the label's box.
 */
export type Bracket = { xa: number; ya: number; xb: number; yb: number; da: number; db: number; y: number; box: Box }

const overlaps = (p: Box, q: Box) => p.x0 < q.x1 && q.x0 < p.x1 && p.y0 < q.y1 && q.y0 < p.y1

/**
 * Where the brackets go: each bar `rise` px above the higher of its two peaks (never above `top`), its label centred
 * over it (`width` px); a bracket whose bar and label would meet a label of the peaks (`labels`, placed before: the
 * bracket goes over them, as in the viewers, and hides none) or a bracket placed before goes up above it, up to `top`.
 * The dotted line from a peak up to the bar starts above the labels it would cross.
 */
export function layoutBrackets(
  items: { xa: number; ya: number; xb: number; yb: number; width: number }[],
  { top, rise = 18, labels = [] }: { top: number; rise?: number; labels?: readonly Box[] },
): Bracket[] {
  const placed: Bracket[] = []
  for (const { xa, ya, xb, yb, width } of items) {
    const mid = (xa + xb) / 2
    const x0 = Math.min(xa, xb, mid - width / 2)
    const x1 = Math.max(xa, xb, mid + width / 2)
    const boxAt = (y: number): Box => ({ x0, x1, y0: y - 15, y1: y + 2 })
    let y = Math.max(top, Math.min(ya, yb) - rise)
    for (let k = 0; k < 200; k++) {
      const box = boxAt(y)
      const hit = labels.find((l) => overlaps(l, box)) ?? placed.find((p) => overlaps(p.box, box))?.box
      if (!hit) break
      const up = hit.y0 - 3
      if (up < top) {
        y = top
        break
      }
      y = up
    }
    const dropFrom = (px: number, py: number) =>
      labels.reduce((from, l) => (px >= l.x0 && px <= l.x1 && l.y1 <= py + 1 && l.y0 > y ? Math.min(from, l.y0 - 1) : from), py)
    placed.push({ xa, ya, xb, yb, da: dropFrom(xa, ya), db: dropFrom(xb, yb), y, box: boxAt(y) })
  }
  return placed
}

/** The bracket a click at (`px`, `py`) is on, the nearest, or -1: its bar (7 px either side) or its label. */
export function bracketAt(brackets: Bracket[], px: number, py: number, tolerance = 7): number {
  let best = -1
  let bestDy = Infinity
  brackets.forEach((b, i) => {
    const onBar = px >= Math.min(b.xa, b.xb) - 3 && px <= Math.max(b.xa, b.xb) + 3 && Math.abs(py - b.y) <= tolerance
    const onLabel = px >= b.box.x0 && px <= b.box.x1 && py >= b.box.y0 && py <= b.box.y1
    if (!onBar && !onLabel) return
    const dy = Math.abs(py - b.y)
    if (dy < bestDy) {
      best = i
      bestDy = dy
    }
  })
  return best
}

//------------------------------------------------------------------------------
// What a Δm/z may be

/** A mass a Δm/z may be: a residue (modified or not), a fragment adduct / nucleotide, or a residue with one. */
export type DeltaCandidate = { name: string; mass: number; kind: 'residue' | 'adduct' | 'residue+adduct' }
/** A candidate a Δ matches, at a charge, its error in m/z. */
export type DeltaMatch = DeltaCandidate & { charge: number; error: number }
/** What the Δs of a spectrum are matched against: its tolerance, the masses, the fragment charges (1 if not given). */
export type DeltaContext = { tolerance: Tolerance; candidates: readonly DeltaCandidate[]; charges?: readonly number[] }

/** The 20 amino acids (I and L as one). */
const AMINO_ACIDS = ['G', 'A', 'S', 'P', 'V', 'T', 'C', 'L', 'N', 'D', 'Q', 'K', 'E', 'M', 'H', 'F', 'R', 'Y', 'W']

/** A residue's mass in a peptide, with a modification ('M', 'Oxidation'); null if it cannot be read. */
function residueMass(code: string, mod?: string): number | null {
  try {
    const r = parsePeptide(mod ? `${code}(${mod})` : code).residues[0]
    return r && r.internalMono > 0 ? r.internalMono : null
  } catch {
    return null
  }
}

/** "Oxidation (M)" → [['Oxidation', 'M']]; terminal ones ("Acetyl (N-term)") none. */
function modifiedResidues(spec: string): [string, string][] {
  const m = /^(.+?)\s*\(([A-Z]+)\)$/.exec(spec.trim())
  if (!m) return []
  return Array.from(m[2], (code) => [m[1], code] as [string, string])
}

/** A nucleotide or fragment adduct as a Δ names it: "U-H₃PO₄ (nt)", not to be read as a residue ("C (nt)", not "C"). */
const nucleotideName = (name: string) => `${adductLabel(name)} (nt)`

/**
 * The masses a Δm/z may be, for a search with the fixed and variable modifications `fixed` and `variable` (OpenMS'
 * names, "Carbamidomethyl (C)") and the fragment adducts of `chemistry` (null: none known); `crossLinked`: the residues
 * (one-letter codes) a cross-link of the PSM may be on, which then also are candidates with each fragment adduct.
 */
export function deltaCandidates(
  fixed: readonly string[],
  variable: readonly string[],
  chemistry: NuxlChemistry | null,
  crossLinked: readonly string[] = [],
): DeltaCandidate[] {
  const out: DeltaCandidate[] = []
  const fixedSites = fixed.flatMap(modifiedResidues)
  /** The residues as they occur: the fixed modification's mass, else the residue's (also when that cannot be read). */
  const asSearched = new Map<string, { name: string; mass: number }>()
  for (const [mod, code] of fixedSites) {
    const mass = residueMass(code, mod)
    if (mass !== null && !asSearched.has(code)) asSearched.set(code, { name: `${code}(${mod})`, mass })
  }
  for (const code of AMINO_ACIDS) {
    if (asSearched.has(code)) continue
    const mass = residueMass(code)
    if (mass !== null) asSearched.set(code, { name: code === 'L' ? 'I/L' : code, mass })
  }
  for (const code of AMINO_ACIDS) {
    const r = asSearched.get(code)
    if (r) out.push({ ...r, kind: 'residue' })
  }
  for (const [mod, code] of [...fixedSites, ...variable.flatMap(modifiedResidues)]) {
    const mass = residueMass(code, mod)
    const name = `${code}(${mod})`
    if (mass !== null && !out.some((c) => c.name === name)) out.push({ name, mass, kind: 'residue' })
  }
  if (chemistry) {
    for (const [name, masses] of chemistry.markers) {
      for (const mass of masses) if (mass > 0) out.push({ name: nucleotideName(name), mass, kind: 'adduct' })
    }
    const sites = [...new Set(crossLinked.map((c) => (c === 'I' ? 'L' : c.toUpperCase())))]
    for (const code of sites) {
      const r = asSearched.get(code)
      if (!r) continue
      for (const [name, masses] of chemistry.adducts) {
        for (const mass of masses) out.push({ name: `${r.name}+${adductLabel(name)}`, mass: r.mass + mass, kind: 'residue+adduct' })
      }
    }
  }
  return out
}

/** The tolerance in Da at `mz`. */
export const toleranceDa = (tolerance: Tolerance, mz: number) => (tolerance.unit === 'Da' ? tolerance.value : (tolerance.value * mz) / 1e6)

/**
 * The candidates the Δ between the peaks at `mzA` and `mzB` matches, the closest first (one per name, kind and
 * charge): at charge z, the candidate's mass / z within the tolerances at both peaks summed.
 */
export function matchDelta(mzA: number, mzB: number, { tolerance, candidates, charges = [1] }: DeltaContext): DeltaMatch[] {
  const delta = Math.abs(mzB - mzA)
  const within = toleranceDa(tolerance, mzA) + toleranceDa(tolerance, mzB)
  const all: DeltaMatch[] = []
  for (const charge of charges) {
    for (const c of candidates) {
      const error = delta - c.mass / charge
      if (Math.abs(error) <= within) all.push({ ...c, charge, error })
    }
  }
  all.sort((p, q) => Math.abs(p.error) - Math.abs(q.error) || p.charge - q.charge)
  const out: DeltaMatch[] = []
  for (const m of all) if (!out.some((o) => o.name === m.name && o.kind === m.kind && o.charge === m.charge)) out.push(m)
  return out
}

/** A match as written: "Y", "Y (2+)". */
const matchName = (m: DeltaMatch) => (m.charge > 1 ? `${m.name} (${m.charge}+)` : m.name)

/** What the matches say after the Δ: '' (none), "≈ Y", "≈ K / Q?" (several: the closest three). */
export function matchText(matches: readonly DeltaMatch[]): string {
  if (matches.length === 0) return ''
  if (matches.length === 1) return `≈ ${matchName(matches[0])}`
  return `≈ ${matches.slice(0, 3).map(matchName).join(' / ')}?`
}

/** A measurement's label: "Δ163.063 ≈ Y". */
export function measurementText(m: Measurement, context: DeltaContext | null): string {
  const match = context ? matchText(matchDelta(m.a.mz, m.b.mz, context)) : ''
  const delta = deltaText(deltaOf(m))
  return match ? `${delta} ${match}` : delta
}
