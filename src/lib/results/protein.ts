// What the protein panel shows of one protein: the residues its peptides cover, the peptides and their
// PSMs, the modified sites and the cross-linked residues. Pure functions on the results model. Positions are 0-based [start, end) as the engine records them, and clamped to the protein's
// sequence: the engine may record a peptide beyond it (when it has no sequence or lacks the peptide).
//
// The coverage is computed by `markCovered`, which `buildModel` uses for the Coverage column of the
// table: the panel cannot disagree with it.

import { adductLabel, modTitle, peptideView, type ModInfo } from '../format/peptide'
import { psmCutoff, psmPasses, type ResultModel } from './model'

/** A stretch of a protein's sequence: residues `start` to `end - 1` (0-based). */
export type Span = { start: number; end: number }

/** The protein's peptide references: `peptide[offsets[p] .. offsets[p + 1]]` with `ref` into the peptides' protein/start/end. */
type Members = { offsets: Uint32Array; peptide: Uint32Array; ref: Uint32Array }

/**
 * Marks in `strip[0 .. length)` the residues of `protein` that its peptides with PSMs cover (1 =
 * covered; the strip is cleared first) and returns how many. A peptide counts if `peptidePsms` (per
 * peptide) is not 0; a stretch beyond `length` is cut off. A protein without a sequence or without
 * peptides has none (and the strip is left alone).
 */
export function markCovered(
  strip: Uint8Array,
  length: number,
  members: Members,
  protein: number,
  peptidePsms: Uint32Array,
  start: Uint32Array,
  end: Uint32Array,
): number {
  if (length === 0 || members.offsets[protein] === members.offsets[protein + 1]) return 0
  strip.fill(0, 0, length)
  let covered = 0
  for (let m = members.offsets[protein]; m < members.offsets[protein + 1]; m++) {
    if (peptidePsms[members.peptide[m]] === 0) continue
    const to = Math.min(end[members.ref[m]], length)
    for (let j = start[members.ref[m]]; j < to; j++) {
      if (strip[j] === 0) {
        strip[j] = 1
        covered++
      }
    }
  }
  return covered
}

/** `[start, end)` cut to a sequence of `length` residues; null if nothing of it lies within. */
export function clampSpan(start: number, end: number, length: number): Span | null {
  const s = Math.min(start, length)
  const e = Math.min(end, length)
  return e > s ? { start: s, end: e } : null
}

export type PanelPeptide = {
  /** The row of `tables.peptides`: one per peptidoform (modified forms of a sequence are separate). */
  peptide: number
  /** Where it lies in the protein (once per occurrence, by position), cut to the sequence. */
  spans: Span[]
  /** At least a residue of it lies within the protein's sequence. */
  located: boolean
  /** Its PSMs at the search's PSM FDR. */
  psms: number
}

/**
 * A modified residue of the protein. Peptide forms can put different modifications on one residue
 * (oxidation in one, a pyro-glu or an N-terminal acetyl in another): `mods` lists each of them once.
 */
export type ModifiedSite = {
  /** 0-based residue of the protein. */
  position: number
  residue: string
  /** The first of its peptides that carries a modification there. */
  peptide: number
  mods: ModInfo[]
}

/** The hover title of a modified residue: "M572: Oxidation (Unimod:35) +15.9949", every modification there. */
export function siteTitle(site: ModifiedSite): string {
  return `${site.residue}${site.position + 1}: ${site.mods.map(modTitle).join('; ')}`
}

export type ProteinDetail = {
  protein: number
  /** Residues of the sequence (0 if the protein has none). */
  length: number
  /** Per residue, 1 if peptides with PSMs cover it. */
  covered: Uint8Array
  /** The share of the sequence covered: `ResultModel.protein.coverage[protein]`. */
  coverage: number
  /** The covered stretches, merged, ascending. */
  spans: Span[]
  /** Its peptides with PSMs, by their first position (those without one last) and ProForma. */
  peptides: PanelPeptide[]
  /** The peptides counted by plain sequence (the table's Peptides column). */
  sequences: number
  /** Its PSMs (the table's PSMs column). */
  psms: number
  /**
   * The modified residues, ascending; fixed modifications are not among them, nor the adduct of a cross-link,
   * which is a modification of its peptide at the cross-linked residue (those are `xlSites`).
   */
  sites: ModifiedSite[]
  /** The cross-linked residues, ascending (`crossLinkedSites`). */
  xlSites: CrossLinkedSite[]
  /** Of `psms`, the cross-link PSMs (the table's XL PSMs column). */
  xlPsms: number
}

/**
 * The panel's data for protein `p` (a row of `tables.proteins`). `fixedMods` are the search's fixed
 * modifications (OpenMS names), which are not sites.
 */
export function proteinDetail(m: ResultModel, p: number, fixedMods: string[]): ProteinDetail {
  const pt = m.tables.peptides
  const sequence = m.tables.proteins.sequence[p]
  const length = sequence.length
  const covered = new Uint8Array(length)
  const count = markCovered(covered, length, m.protein.members, p, m.peptide.psms, pt.start, pt.end)

  const spans: Span[] = []
  for (let j = 0; j < length; j++) {
    if (covered[j] === 0) continue
    let k = j
    while (k < length && covered[k] === 1) k++
    spans.push({ start: j, end: k })
    j = k
  }

  // the peptides with PSMs, once each (the references of one peptide are adjacent)
  const { offsets, peptide: members, ref } = m.protein.members
  const byPeptide = new Map<number, PanelPeptide>()
  /** the unclamped start of each occurrence, for the modified sites */
  const starts = new Map<number, number[]>()
  for (let i = offsets[p]; i < offsets[p + 1]; i++) {
    const k = members[i]
    const psms = m.peptide.psms[k]
    if (psms === 0) continue
    let entry = byPeptide.get(k)
    if (!entry) {
      entry = { peptide: k, spans: [], located: false, psms }
      byPeptide.set(k, entry)
      starts.set(k, [])
    }
    const span = clampSpan(pt.start[ref[i]], pt.end[ref[i]], length)
    if (span) {
      entry.spans.push(span)
      entry.located = true
      starts.get(k)!.push(span.start)
    }
  }
  const first = (e: PanelPeptide) => (e.located ? e.spans.reduce((a, s) => Math.min(a, s.start), Infinity) : Infinity)
  const peptides = [...byPeptide.values()]
  for (const e of peptides) e.spans.sort((a, b) => a.start - b.start)
  peptides.sort(
    (a, b) =>
      first(a) - first(b) || // Infinity - Infinity is NaN, which falls through
      (pt.proforma[a.peptide] < pt.proforma[b.peptide] ? -1 : pt.proforma[a.peptide] > pt.proforma[b.peptide] ? 1 : a.peptide - b.peptide),
  )

  // the modified residues: the marked modifications of the peptides, at their place in the protein
  const sites = new Map<number, ModifiedSite>()
  for (const e of peptides) {
    if (!e.located) continue
    const view = peptideView(pt, e.peptide, fixedMods)
    if (!view.nTerm && !view.cTerm && !view.residues.some((r) => r.mod)) continue
    const size = pt.sequence[e.peptide].length
    const adduct = pt.isXL[e.peptide] ? pt.adduct[e.peptide] : ''
    for (const at of starts.get(e.peptide)!) {
      const add = (position: number, mod: ModInfo | undefined) => {
        if (!mod || position < 0 || position >= length) return
        // a cross-link's adduct: a cross-linked site, not a modified one
        if (adduct !== '' && mod.name === adduct) return
        const site = sites.get(position)
        if (!site) sites.set(position, { position, residue: sequence[position], peptide: e.peptide, mods: [mod] })
        else if (!site.mods.some((x) => x.name === mod.name && x.unimod === mod.unimod && x.mass === mod.mass)) site.mods.push(mod)
      }
      add(at, view.nTerm)
      view.residues.forEach((r, j) => add(at + j, r.mod))
      add(at + size - 1, view.cTerm)
    }
  }

  const distinct = new Set<string>()
  let psms = 0
  for (const e of peptides) {
    distinct.add(pt.sequence[e.peptide])
    psms += e.psms
  }

  return {
    protein: p,
    length,
    covered,
    coverage: length === 0 ? 0 : count / length,
    spans,
    peptides,
    sequences: distinct.size,
    psms,
    sites: [...sites.values()].sort((a, b) => a.position - b.position),
    xlSites: crossLinkedSites(m, p),
    xlPsms: m.protein.xlPsms[p],
  }
}

// ---- cross-linked residues

/** A residue of the protein that cross-link PSMs put the nucleic acid on. */
export type CrossLinkedSite = {
  /** 0-based residue of the protein. */
  position: number
  /** Its amino acid (one letter). */
  residue: string
  /** Its cross-link PSMs. */
  psms: number
  /** The adducts of those PSMs with their PSMs, most PSMs first (equal ones by name). */
  adducts: { adduct: string; psms: number }[]
}

/** A site as the panel names it: "K123". */
export const siteLabel = (site: CrossLinkedSite) => `${site.residue}${site.position + 1}`

/** "K123 (U-H₃PO₄ ×3, UU-H₂O ×1)": the site with the adducts of its PSMs. */
export function crossLinkTitle(site: CrossLinkedSite): string {
  return `${siteLabel(site)} (${site.adducts.map((a) => `${adductLabel(a.adduct) || 'no adduct'} ×${a.psms}`).join(', ')})`
}

/** Per peptide: its localized cross-link PSMs within the search's cutoffs (decoys left out), once per model. */
const localized = new WeakMap<ResultModel, Map<number, number[]>>()

function localizedPsms(m: ResultModel): Map<number, number[]> {
  let byPeptide = localized.get(m)
  if (!byPeptide) {
    byPeptide = new Map()
    const ps = m.tables.psms
    const limits = { peptide: m.psmFdr, xl: m.xlFdr }
    for (let i = 0; i < ps.count; i++) {
      if (!ps.xl.isXL[i] || ps.xl.site[i] < 0 || ps.decoy[i] || !psmPasses(m, i, limits)) continue
      const rows = byPeptide.get(ps.peptide[i])
      if (rows) rows.push(i)
      else byPeptide.set(ps.peptide[i], [i])
    }
    localized.set(m, byPeptide)
  }
  return byPeptide
}

/**
 * The cross-linked residues of protein `p`: where its cross-link PSMs within the search's cross-link FDR put the
 * nucleic acid (the peptide's start in the protein plus the PSM's site, `psms.xl.site`), ascending. A PSM whose
 * cross-link is not localized has no site; a peptide that occurs twice in the protein gives a site at each place. A
 * peptide whose place in the protein is unknown (start = end = 0: no start in the idXML, not found in the sequence)
 * gives no site, nor does a site beyond the protein's sequence (the search recorded the peptide there); without a
 * sequence the residue is the peptide's.
 */
export function crossLinkedSites(m: ResultModel, p: number): CrossLinkedSite[] {
  const byPeptide = localizedPsms(m)
  if (byPeptide.size === 0) return []
  const pt = m.tables.peptides
  const ps = m.tables.psms
  const sequence = m.tables.proteins.sequence[p]
  const { offsets, peptide: members, ref } = m.protein.members
  const sites = new Map<number, { residue: string; psms: number; adducts: Map<string, number> }>()
  for (let r = offsets[p]; r < offsets[p + 1]; r++) {
    const k = members[r]
    const rows = byPeptide.get(k)
    if (!rows) continue
    const start = pt.start[ref[r]]
    if (!(pt.end[ref[r]] > start)) continue
    for (const i of rows) {
      const at = ps.xl.site[i]
      const position = start + at
      if (sequence.length > 0 && position >= sequence.length) continue
      let site = sites.get(position)
      if (!site) sites.set(position, (site = { residue: sequence[position] ?? pt.sequence[k][at] ?? '?', psms: 0, adducts: new Map() }))
      site.psms++
      site.adducts.set(ps.xl.adduct[i], (site.adducts.get(ps.xl.adduct[i]) ?? 0) + 1)
    }
  }
  return [...sites]
    .sort((a, b) => a[0] - b[0])
    .map(([position, s]) => ({
      position,
      residue: s.residue,
      psms: s.psms,
      adducts: [...s.adducts]
        .map(([adduct, psms]) => ({ adduct, psms }))
        .sort((a, b) => b.psms - a.psms || (a.adduct < b.adduct ? -1 : a.adduct > b.adduct ? 1 : 0)),
    }))
}

const siteCounts = new WeakMap<ResultModel, Uint32Array>()

/** Per protein: its cross-linked residues (`crossLinkedSites(m, p).length`), the table's XL sites column; once per model. */
export function proteinXlSites(m: ResultModel): Uint32Array {
  let counts = siteCounts.get(m)
  if (!counts) {
    counts = new Uint32Array(m.tables.proteins.count)
    if (localizedPsms(m).size > 0) {
      for (let p = 0; p < counts.length; p++) if (m.protein.xlPsms[p] > 0) counts[p] = crossLinkedSites(m, p).length
    }
    siteCounts.set(m, counts)
  }
  return counts
}

// ---- PSMs

const psmIndexes = new WeakMap<ResultModel, { offsets: Uint32Array; psm: Uint32Array }>()

/** The PSM rows of every peptide in one array (CSR), in table order: built once per model. */
function psmsByPeptide(m: ResultModel) {
  let index = psmIndexes.get(m)
  if (!index) {
    const { peptide, count } = m.tables.psms
    const offsets = new Uint32Array(m.tables.peptides.count + 1)
    for (let i = 0; i < count; i++) offsets[peptide[i] + 1]++
    for (let k = 0; k < m.tables.peptides.count; k++) offsets[k + 1] += offsets[k]
    const cursor = offsets.slice(0, m.tables.peptides.count)
    const psm = new Uint32Array(count)
    for (let i = 0; i < count; i++) psm[cursor[peptide[i]]++] = i
    psmIndexes.set(m, (index = { offsets, psm }))
  }
  return index
}

/** Best q-value first, a PSM without one last; equal ones in table order. */
function byQValue(q: Float64Array) {
  return (a: number, b: number) => {
    const x = q[a]
    const y = q[b]
    if (x === y || (x !== x && y !== y)) return a - b
    if (x !== x) return 1
    if (y !== y) return -1
    return x - y || a - b
  }
}

/**
 * The PSMs of peptide `k` within the search's cutoff of their kind (the peptide FDR, or the cross-link FDR for a
 * cross-link: those the tables count), best q-value first.
 */
export function peptidePsms(m: ResultModel, k: number): Uint32Array {
  const { offsets, psm } = psmsByPeptide(m)
  const q = m.tables.psms.qValue
  const rows = psm.slice(offsets[k], offsets[k + 1]).filter((i) => !(q[i] > psmCutoff(m, i)))
  return rows.sort(byQValue(q))
}

/** All PSMs of the protein's peptides (`detail.peptides`), best q-value first: as many as the table's PSMs column. */
export function proteinPsms(m: ResultModel, detail: ProteinDetail): Uint32Array {
  const parts = detail.peptides.map((e) => peptidePsms(m, e.peptide))
  const rows = new Uint32Array(parts.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of parts) {
    rows.set(part, at)
    at += part.length
  }
  return rows.sort(byQValue(m.tables.psms.qValue))
}
