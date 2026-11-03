// The PSM view's NuXL logic, without the page: NuXL's own annotation of a PSM's peaks (the `fragment_annotation` of
// its hit, psm/nuxl-annotation.ts) placed on the observed peaks, what the toggles show of it, its colours, the
// fragment ladder and the ion table from it, the linear peptide of a cross-link (for the theoretical spectrum of the
// mirror's lower half), the mass errors of the unshifted ions, the cross-link header and the features in groups.
//
// NuXL labels its ions as 'y5+', "b3+U'-H2O+" (shifted by a fragment of the cross-linked nucleotide), 'MI:U-H3PO4+'
// (a marker ion), '[M+2H]+U-H3PO4++' (the precursor), 'iY+' (immonium), 'HT' (an internal fragment).

import type { PsmOptionState, IonType, TheoreticalIon, Tolerance } from '$lib/psm/psm'
import { ION_TYPES, isNTerminal, lossOf } from '$lib/psm/psm'
import { classifyLabel, type NuxlIon, type NuxlPeak } from '$lib/psm/nuxl-annotation'
import { nearest } from '$lib/psm/plot'
import type { PeakMatch } from '$lib/results/types'

/** How a peak of NuXL's annotation is drawn: its colour (and legend entry). */
export type Category = 'prefix' | 'suffix' | 'shifted' | 'marker' | 'precursor' | 'immonium' | 'internal' | 'other'

/**
 * The colours: a/b/c ions blue and x/y/z orange, as the ion series of ProSE desktop; an ion shifted by the
 * nucleotide the colour of the cross-link (--mod, as the cross-linked residue is marked); marker ions of the
 * nucleotides violet; precursor, immonium and internal fragments the strong neutral (their labels tell them apart).
 * CSS variables of app.css, so that each theme has its own steps (the SVG export the light ones).
 */
export const CATEGORY_COLORS: Record<Category, string> = {
  prefix: 'var(--ion-b)',
  suffix: 'var(--ion-y)',
  shifted: 'var(--mod)',
  marker: 'var(--ion-marker, #8b5cf6)',
  precursor: 'var(--ion-other)',
  immonium: 'var(--ion-other)',
  internal: 'var(--ion-other)',
  other: 'var(--ion-other)',
}

/** The legend's entries, in this order: one per colour. */
export const LEGEND: { categories: Category[]; text: string; color: string }[] = [
  { categories: ['prefix'], text: 'a/b/c ions', color: CATEGORY_COLORS.prefix },
  { categories: ['suffix'], text: 'x/y/z ions', color: CATEGORY_COLORS.suffix },
  { categories: ['shifted'], text: 'shifted ions', color: CATEGORY_COLORS.shifted },
  { categories: ['marker'], text: 'marker ions', color: CATEGORY_COLORS.marker },
  { categories: ['precursor', 'immonium', 'internal', 'other'], text: 'other ions', color: CATEGORY_COLORS.other },
]

/** The colour of a theoretical ion of type `type` (a to z, or 'precursor'). */
export function typeColor(type: string): string {
  if (type === 'precursor') return CATEGORY_COLORS.precursor
  return isNTerminal(type) ? CATEGORY_COLORS.prefix : CATEGORY_COLORS.suffix
}

const SEQUENCE_KINDS = new Set<string>(ION_TYPES)
export const isSequenceIon = (ion: NuxlIon) => SEQUENCE_KINDS.has(ion.kind)

/** The category of a classified label. */
export function categoryOf(ion: NuxlIon): Category {
  if (isSequenceIon(ion)) return ion.shift !== '' ? 'shifted' : isNTerminal(ion.kind) ? 'prefix' : 'suffix'
  if (ion.kind === 'unknown') return 'other'
  return ion.kind as Category
}

const SUBSCRIPT: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' }

/**
 * How a NuXL label reads: its formulas with subscripts and without counts of one ("y1-H2O1+" is "y1-H₂O+", "MI:U-H3PO4+"
 * is "MI:U-H₃PO₄+"); the ion number stays as it is.
 */
export function nuxlLabel(label: string): string {
  const head = /^[abcxyz]\d+/.exec(label)?.[0] ?? ''
  const rest = label
    .slice(head.length)
    .replace(/([A-Z][a-z]?)(\d+)/g, (_, element: string, n: string) => (n === '1' ? element : element + n.replace(/\d/g, (d) => SUBSCRIPT[d])))
  return head + rest
}

/** A formula as its element counts in a fixed order ('H3N1' and 'NH3' are both 'H3N'); '' stays ''. */
export function canonicalFormula(formula: string): string {
  if (formula === '') return ''
  const counts = new Map<string, number>()
  for (const part of formula.split('-')) {
    for (const [, element, n] of part.matchAll(/([A-Z][a-z]?)(\d*)/g)) counts.set(element, (counts.get(element) ?? 0) + (n === '' ? 1 : Number(n)))
  }
  return [...counts.keys()]
    .sort()
    .map((e) => `${e}${counts.get(e) === 1 ? '' : counts.get(e)}`)
    .join('')
}

/** The loss toggles: water, ammonia, and the others NuXL annotates (C₁H₂N₂, CO with water, ...). */
export const LOSS_TOGGLES = [
  { id: 'H2O', label: 'H₂O loss' },
  { id: 'NH3', label: 'NH₃ loss' },
  { id: 'other', label: 'other losses' },
] as const
export type LossToggle = (typeof LOSS_TOGGLES)[number]['id']

/** The toggle of a loss ('' none). */
export function lossToggle(loss: string): '' | LossToggle {
  if (loss === '') return ''
  const f = canonicalFormula(loss)
  return f === 'H2O' ? 'H2O' : f === 'H3N' ? 'NH3' : 'other'
}

/** A peak of NuXL's annotation, placed on a peak of the spectrum shown. */
export type NuxlMatch = {
  /** the index of its peak in the spectrum shown */
  peak: number
  /** NuXL's label, as written */
  label: string
  /** as it reads ("y1-H₂O+") */
  text: string
  ion: NuxlIon
  category: Category
  loss: '' | LossToggle
  /** NuXL's m/z and relative intensity */
  mz: number
  intensity: number
}

/** Within `tolerance` of each other: `observed` and `annotated` m/z. */
function within(observed: number, annotated: number, tolerance: Tolerance): boolean {
  const d = Math.abs(observed - annotated)
  return tolerance.unit === 'Da' ? d <= tolerance.value : (d / annotated) * 1e6 <= tolerance.value
}

/**
 * NuXL's annotated peaks on the spectrum shown: each on the observed peak nearest its m/z within the fragment
 * tolerance (`mz` sorted, as read), or, without observed peaks (`mz` null), on its own peak (the spectrum shown is
 * then the annotation's). `unplaced`: annotated peaks without an observed peak within the tolerance.
 */
export function placeAnnotation(annotation: NuxlPeak[], mz: ArrayLike<number> | null, tolerance: Tolerance): { matches: NuxlMatch[]; unplaced: number } {
  const matches: NuxlMatch[] = []
  let unplaced = 0
  annotation.forEach((p, i) => {
    let peak = i
    if (mz) {
      peak = nearest(mz, p.mz)
      if (peak < 0 || !within(mz[peak], p.mz, tolerance)) return void unplaced++
    }
    const ion = classifyLabel(p.label, p.charge)
    matches.push({
      peak,
      label: p.label,
      text: nuxlLabel(p.label),
      ion,
      category: categoryOf(ion),
      loss: isSequenceIon(ion) ? lossToggle(ion.loss) : '',
      mz: p.mz,
      intensity: p.intensity,
    })
  })
  return { matches, unplaced }
}

/** The toggles' choices for one PSM. */
export type NuxlOptions = {
  ions: IonType[]
  charges: number[]
  losses: LossToggle[]
  /** the ions shifted by the nucleotide */
  shifted: boolean
  marker: boolean
  immonium: boolean
  internal: boolean
  precursor: boolean
}

/** The choices of the page alone (the view keeps the others for all PSMs). */
export type LocalToggles = Pick<NuxlOptions, 'shifted' | 'marker' | 'immonium' | 'internal'>

/**
 * The fragment charges of a PSM of precursor `charge`: 1+ to the highest charge of a sequence ion NuXL annotated, at
 * least 2+ (for precursors of 2+ or more), at most the precursor's.
 */
export function nuxlCharges(charge: number, matches: NuxlMatch[]): number[] {
  let top = Math.min(2, charge)
  for (const m of matches) if (isSequenceIon(m.ion) && m.ion.charge > top) top = m.ion.charge
  top = Math.max(1, Math.min(top, Math.max(1, charge)))
  return Array.from({ length: top }, (_, i) => i + 1)
}

/**
 * The choices for a PSM: the user's ion types; their charges among those the PSM has, else all of them; their losses,
 * else all (NuXL's annotation is shown as NuXL made it).
 */
export function resolveNuxlOptions(user: PsmOptionState, local: LocalToggles, charges: number[]): NuxlOptions {
  const chosen = (user.charges ?? charges).filter((c) => charges.includes(c))
  const ids = LOSS_TOGGLES.map((l) => l.id as LossToggle)
  return {
    ions: [...user.ions],
    charges: chosen.length > 0 || user.charges?.length === 0 ? chosen : [1],
    losses: user.losses ? ids.filter((l) => user.losses!.includes(l)) : ids,
    precursor: user.precursor,
    ...local,
  }
}

/** The annotated peaks the toggles show. */
export function visibleNuxl(matches: NuxlMatch[], o: NuxlOptions): NuxlMatch[] {
  return matches.filter((m) => {
    switch (m.ion.kind) {
      case 'marker':
        return o.marker
      case 'immonium':
        return o.immonium
      case 'internal':
      case 'unknown':
        return o.internal
      case 'precursor':
        return o.precursor
    }
    if (!(o.ions as string[]).includes(m.ion.kind) || !o.charges.includes(m.ion.charge)) return false
    if (m.ion.shift !== '' && !o.shifted) return false
    return m.loss === '' || o.losses.includes(m.loss)
  })
}

const CATEGORY_ORDER: Record<Category, number> = { prefix: 0, suffix: 1, shifted: 2, precursor: 3, marker: 4, immonium: 5, internal: 6, other: 7 }

/** The ions of one peak shown. */
export type NuxlGroup = {
  peak: number
  mz: number
  intensity: number
  matches: NuxlMatch[]
  /** "y3+ / b3+U'-H₂O+" */
  label: string
  /** that of its first ion */
  category: Category
  color: string
}

/** The annotated peaks grouped by peak, by m/z: one label per peak; unshifted sequence ions first. */
export function groupNuxl(matches: NuxlMatch[], mz: ArrayLike<number>, intensity: ArrayLike<number>): NuxlGroup[] {
  const byPeak = new Map<number, NuxlMatch[]>()
  for (const m of matches) {
    const list = byPeak.get(m.peak)
    if (list) {
      if (!list.some((x) => x.label === m.label)) list.push(m)
    } else byPeak.set(m.peak, [m])
  }
  const groups: NuxlGroup[] = []
  for (const [peak, list] of byPeak) {
    list.sort(
      (p, q) =>
        CATEGORY_ORDER[p.category] - CATEGORY_ORDER[q.category] ||
        (p.loss === '' ? 0 : 1) - (q.loss === '' ? 0 : 1) ||
        p.ion.ordinal - q.ion.ordinal ||
        p.ion.charge - q.ion.charge ||
        p.label.localeCompare(q.label),
    )
    groups.push({
      peak,
      mz: mz[peak],
      intensity: intensity[peak],
      matches: list,
      label: list.map((m) => m.text).join(' / '),
      category: list[0].category,
      color: CATEGORY_COLORS[list[0].category],
    })
  }
  return groups.sort((p, q) => p.mz - q.mz || p.peak - q.peak)
}

/** The legend of what is shown: an entry for each colour among `categories`, in the fixed order. */
export function legendOf(categories: Iterable<Category>): { color: string; text: string }[] {
  const shown = new Set(categories)
  return LEGEND.filter((l) => l.categories.some((c) => shown.has(c))).map(({ color, text }) => ({ color, text }))
}

/**
 * The linear peptide of a PSM, as OpenMS writes it: without its nucleic acid adduct (OpenNuXL writes a localized one as
 * the modification 'NuXL:<adduct>' of its residue: 'DY(NuXL:U-H3O4P1)HTVLGAR' is 'DYHTVLGAR').
 */
export function linearPeptide(openms: string): string {
  return openms
    .replace(/^\.\(NuXL:[^)]*\)/, '')
    .replace(/\.\(NuXL:[^)]*\)$/, '')
    .replace(/\(NuXL:[^)]*\)/g, '')
}

/** Per type, number, charge and loss: the key of a sequence ion. */
const ionKey = (type: string, ordinal: number, charge: number, loss: string) => `${type}${ordinal}/${charge}/${canonicalFormula(loss)}`

/** A mass error of the strip under the spectrum: a match with its colour. */
export type ColoredMatch = PeakMatch & { color: string }

/**
 * The fragment mass errors of the unshifted sequence ions NuXL annotated: the m/z of their peak against that of the
 * same ion (type, number, charge, loss) of the linear peptide's theoretical spectrum (`theoretical`, with losses).
 * Shifted and other ions have no theoretical m/z here.
 */
export function massErrors(matches: NuxlMatch[], theoretical: TheoreticalIon[], mz: ArrayLike<number>): ColoredMatch[] {
  const byKey = new Map<string, TheoreticalIon>()
  for (const t of theoretical) if (t.type !== 'precursor') byKey.set(ionKey(t.type, t.ordinal, t.charge, lossOf(t.ion)), t)
  const out: ColoredMatch[] = []
  for (const m of matches) {
    if (!isSequenceIon(m.ion) || m.ion.shift !== '') continue
    const t = byKey.get(ionKey(m.ion.kind, m.ion.ordinal, m.ion.charge, m.ion.loss))
    if (!t) continue
    out.push({
      peak: m.peak,
      ion: m.text,
      type: m.ion.kind,
      ordinal: m.ion.ordinal,
      charge: m.ion.charge,
      loss: m.ion.loss,
      theoreticalMz: t.mz,
      errorPpm: ((mz[m.peak] - t.mz) / t.mz) * 1e6,
      color: CATEGORY_COLORS[m.category],
    })
  }
  return out.sort((p, q) => p.theoreticalMz - q.theoreticalMz)
}

/** A cleavage of the ladder from one end: the best unshifted series that explains it (b over a, c; y over x, z), and whether a shifted ion does. */
export type Cut = { type: string | null; shifted: boolean } | null

/**
 * The fragment ladder from NuXL's annotation shown: per cleavage (between residue i and i + 1) what explains it from
 * the N-terminus (`n`) and from the C-terminus (`c`).
 */
export function nuxlLadder(matches: NuxlMatch[], length: number): { n: Cut[]; c: Cut[] } {
  const cuts = Math.max(0, length - 1)
  const n: Cut[] = new Array(cuts).fill(null)
  const c: Cut[] = new Array(cuts).fill(null)
  const mark = (list: Cut[], i: number, type: string, shifted: boolean, best: string) => {
    if (i < 0 || i >= cuts) return
    const old = list[i] ?? { type: null, shifted: false }
    if (shifted) list[i] = { ...old, shifted: true }
    else list[i] = { ...old, type: old.type === best ? best : old.type === null || type === best ? type : old.type }
  }
  for (const m of matches) {
    if (!isSequenceIon(m.ion)) continue
    const shifted = m.ion.shift !== ''
    if (isNTerminal(m.ion.kind)) mark(n, m.ion.ordinal - 1, m.ion.kind, shifted, 'b')
    else mark(c, length - 1 - m.ion.ordinal, m.ion.kind, shifted, 'y')
  }
  return { n, c }
}

export type NuxlIonColumn = { type: IonType; charge: number; shifted: boolean; header: string }
export type NuxlIonCell = {
  /** the ion's label ("b3+", "b3+U'-H₂O+") */
  ion: string
  mz: number
  /** NuXL annotated it */
  matched: boolean
  /** all the shifted ions of this number, for its tooltip */
  title?: string
  /** a shifted ion's shift as it reads ("+U-H₃PO₄"), and how many more shifted ions of its number there are */
  shift?: string
  more?: number
}
export type NuxlIonTable = {
  /** The columns left of the residue (N-terminal ions) and right of it (C-terminal ions). */
  n: NuxlIonColumn[]
  c: NuxlIonColumn[]
  rows: { index: number; n: (NuxlIonCell | null)[]; c: (NuxlIonCell | null)[] }[]
}

const SUPERSCRIPT_CHARGE: Record<number, string> = { 1: '⁺', 2: '²⁺', 3: '³⁺', 4: '⁴⁺' }

/**
 * The ion table: per residue, the theoretical m/z of the linear peptide's ions without losses of the types and
 * charges shown, those NuXL annotated (unshifted, without a loss) marked; and beside each series that has shifted
 * ions among those shown, a column of them (NuXL's m/z, the most intense of its number; its shifts in the tooltip).
 */
export function nuxlIonTable(theoretical: TheoreticalIon[], shown: NuxlMatch[], length: number, o: NuxlOptions): NuxlIonTable {
  const charges = [...o.charges].sort((a, b) => a - b)
  const key = (type: string, ordinal: number, charge: number) => `${type}${ordinal}/${charge}`
  const shiftedOf = new Map<string, NuxlMatch[]>()
  const annotated = new Set<string>()
  for (const m of shown) {
    if (!isSequenceIon(m.ion)) continue
    const k = key(m.ion.kind, m.ion.ordinal, m.ion.charge)
    if (m.ion.shift !== '') {
      const list = shiftedOf.get(k)
      if (list) list.push(m)
      else shiftedOf.set(k, [m])
    } else if (m.loss === '') annotated.add(k)
  }
  const hasShifted = (type: string, charge: number) => [...shiftedOf.values()].some((l) => l[0].ion.kind === type && l[0].ion.charge === charge)
  const columns = (types: IonType[]) =>
    charges.flatMap((charge) =>
      types.flatMap((type) => {
        const header = `${type}${SUPERSCRIPT_CHARGE[charge] ?? `${charge}+`}`
        const plain: NuxlIonColumn = { type, charge, shifted: false, header }
        return hasShifted(type, charge) ? [plain, { type, charge, shifted: true, header: `${header} shifted` }] : [plain]
      }),
    )
  const n = columns(ION_TYPES.filter((t) => isNTerminal(t) && o.ions.includes(t)))
  const c = columns(ION_TYPES.filter((t) => !isNTerminal(t) && o.ions.includes(t)))
  const mzOf = new Map<string, TheoreticalIon>()
  for (const t of theoretical) if (t.type !== 'precursor' && lossOf(t.ion) === '') mzOf.set(key(t.type, t.ordinal, t.charge), t)
  const cell = (col: NuxlIonColumn, ordinal: number): NuxlIonCell | null => {
    const k = key(col.type, ordinal, col.charge)
    if (col.shifted) {
      const list = shiftedOf.get(k)
      if (!list) return null
      const best = list.reduce((p, q) => (q.intensity > p.intensity ? q : p))
      const title = list.map((m) => `${m.text} m/z ${m.mz.toFixed(4)}`).join('\n')
      return { ion: best.text, mz: best.mz, matched: true, title, shift: `+${nuxlLabel(best.ion.shift)}`, more: list.length - 1 }
    }
    const t = mzOf.get(k)
    return t ? { ion: t.ion, mz: t.mz, matched: annotated.has(k) } : null
  }
  const rows = Array.from({ length }, (_, i) => ({
    index: i,
    n: n.map((col) => (i < length - 1 ? cell(col, i + 1) : null)),
    c: c.map((col) => (i > 0 ? cell(col, length - i) : null)),
  }))
  return { n, c, rows }
}

/** Of the spectrum shown: the peaks the annotation shown explains, and the share of the intensity they carry. */
export function annotatedShare(groups: { peak: number }[], intensity: ArrayLike<number>): { peaks: number; total: number; intensityFraction: number } {
  let total = 0
  for (let i = 0; i < intensity.length; i++) total += intensity[i]
  let explained = 0
  for (const g of groups) explained += intensity[g.peak] ?? 0
  return { peaks: groups.length, total: intensity.length, intensityFraction: total > 0 ? explained / total : NaN }
}

/** The residues of a site sequence ('DyHTVLGAR': the candidates in lower case), with the candidates marked. */
export function siteResidues(siteSequence: string, site: number): { residue: string; candidate: boolean; site: boolean }[] {
  return Array.from(siteSequence, (ch, i) => ({ residue: ch.toUpperCase(), candidate: ch !== ch.toUpperCase(), site: i === site }))
}

/** The cutoff of a PSM's FDR group: the cross-link FDR for a cross-link, else the peptide FDR. */
export function fdrOf(isXL: boolean, fdr: { xlFdr: number; peptideFdr: number }): { cutoff: number; name: string } {
  return isXL ? { cutoff: fdr.xlFdr, name: 'cross-link FDR' } : { cutoff: fdr.peptideFdr, name: 'peptide FDR' }
}

/** A fraction as a percentage ("1 %", "0.5 %"). */
export const percent = (f: number) => `${Number((f * 100).toPrecision(3))} %`

// The features, as OpenNuXL names them: its scores first, then the ion matches, the partial-loss (shifted ion)
// features, the precursor and adduct, the rest.
const TOP_SCORES = [
  'NuXL:score',
  'NuXL:total_loss_score',
  'NuXL:partial_loss_score',
  'NuXL:marker_ions_score',
  'NuXL:ladder_score',
  'NuXL:sequence_score',
  'NuXL:precursor_score',
  'NuXL:immonium_score',
  '-ln(poisson)',
]

export type FeatureGroup = { title: string; features: { name: string; label: string; index: number }[] }

function groupOfFeature(name: string): string {
  if (TOP_SCORES.includes(name) || /^NuXL:.*score$/.test(name)) return 'Scores'
  if (name.startsWith('NuXL:pl_') || name === 'NuXL:tag_shifted' || name === 'NuXL:tag_XLed') return 'Shifted ions (partial loss)'
  if (/^NuXL:(total_)?(MIC|Morph|HS)$|^NuXL:(explained_peak_fraction|theo_peak_fraction|wTop50|tag_unshifted|aminoacid_.*|modds)$|^n_theoretical_peaks$/.test(name)) {
    return 'Ion matches'
  }
  if (/^NuXL:(NA_|XL_|isXL|isPhospho|mass_error_p|err$)|^(precursor_intensity_log10|isotope_error|nucleotide_mass_tags)$/.test(name)) return 'Precursor and adduct'
  return 'Other'
}
const GROUP_ORDER = ['Scores', 'Ion matches', 'Shifted ions (partial loss)', 'Precursor and adduct', 'Other']

/** The features (`psms.featureNames`) in groups, the main scores first; a label without 'NuXL:'. */
export function featureGroups(names: string[]): FeatureGroup[] {
  const groups = new Map<string, FeatureGroup['features']>()
  names.forEach((name, index) => {
    const g = groupOfFeature(name)
    const list = groups.get(g) ?? []
    list.push({ name, label: name.replace(/^NuXL:/, ''), index })
    groups.set(g, list)
  })
  const rank = (name: string) => {
    const i = TOP_SCORES.indexOf(name)
    return i < 0 ? TOP_SCORES.length : i
  }
  return GROUP_ORDER.filter((t) => groups.has(t)).map((title) => ({
    title,
    features: title === 'Scores' ? [...groups.get(title)!].sort((p, q) => rank(p.name) - rank(q.name) || p.index - q.index) : groups.get(title)!,
  }))
}
