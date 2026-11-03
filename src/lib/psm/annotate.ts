// The fragment annotation of a PSM's peaks: the web app's `annotatePeaks` (its OpenMS module's binding,
// prose-pages app, OpenMS src/openms_wasm/bindings/bind_prose.cpp: theoreticalFragments, alignFragments,
// parseIonName, lossFormulaName, annotatePeaks) in TypeScript, so that the PSM view can change the ion,
// charge and loss toggles without WebAssembly. It computes what OpenMS computes, operation for
// operation, so that the result is the web module's to the last bit:
//
// - the peptide: AASequence::fromString of the OpenMS string (peptides.openms: 'AM(Oxidation)K',
//   '.(Acetyl)PEPTIDE', 'PEPTIDER.(Amidated)'); the residues as ResidueDB builds them, a modified residue
//   with the formula of the residue plus the modification's (Residue::setModification) and the neutral
//   losses of the modification's specificity instead of the residue's own;
// - the ions: TheoreticalSpectrumGenerator::getSpectrum(spectrum, peptide, 1, maxCharge) with
//   add_first_prefix_ion, add_metainfo, the ion types asked for, add_losses, add_precursor_peaks
//   (of charge maxCharge), sorted stably by m/z;
// - the matching: SpectrumAlignment, ppm: each ion takes its closest peak (MatchedIterator, compared in
//   float precision); Da: its dynamic-programming alignment, one to one.
//
// Masses: monoisotopic, from src/lib/chemistry/chemistry.json (the elements, residues and Unimod
// formulas of the OpenMS pin, scripts/chemistry-table.mjs) and src/lib/chemistry/unimod.json (the
// modifications' mass deltas, scripts/unimod-table.mjs). A formula's mass is summed as
// EmpiricalFormula::getMonoWeight sums it (by atomic number), since the order changes the last bits.

import chemistry from '../chemistry/chemistry.json'
import unimod from '../chemistry/unimod.json'
import type { PeakAnnotationResult, PeakMatch } from '../results/types'

/** The options of the web app's annotatePeaks (its OpenMS module's declaration). */
export type AnnotationOptions = {
  tolerance?: number
  unit?: 'Da' | 'ppm'
  maxCharge?: number
  ions?: ('a' | 'b' | 'c' | 'x' | 'y' | 'z')[]
  losses?: boolean
  precursor?: boolean
} | null | undefined

/** Constants::PROTON_MASS_U */
const PROTON_MASS_U = 1.007276466771

//------------------------------------------------------------------------------
// Formulas (EmpiricalFormula)

/** symbol → count; no zero counts (EmpiricalFormula removes them) */
type Formula = Readonly<Record<string, number>>

type Chemistry = {
  elements: Record<string, [number, number]>
  residues: Record<string, [Formula, Formula[]]>
  modifications: Record<string, [Formula, [string, string, Formula[]][]]>
}
const CHEMISTRY = chemistry as unknown as Chemistry
const ELEMENTS = CHEMISTRY.elements

/** EmpiricalFormula's order of the elements (ElementLess_): atomic number, then the symbol's length, then the symbol. */
function elementLess(a: string, b: string): number {
  const [x, y] = [ELEMENTS[a], ELEMENTS[b]]
  if (x[0] !== y[0]) return x[0] - y[0]
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** The elements of `f` in EmpiricalFormula's order. */
const ordered = (f: Formula): [string, number][] => Object.entries(f).sort(([a], [b]) => elementLess(a, b))

function combine(a: Formula, b: Formula, sign: 1 | -1): Formula {
  const out: Record<string, number> = { ...a }
  for (const [symbol, count] of Object.entries(b)) {
    const n = (out[symbol] ?? 0) + sign * count
    if (n === 0) delete out[symbol]
    else out[symbol] = n
  }
  return out
}
const plus = (a: Formula, b: Formula) => combine(a, b, 1)
const minus = (a: Formula, b: Formula) => combine(a, b, -1)

/** EmpiricalFormula::getMonoWeight of `f` with `charge` (a proton per charge). */
function monoWeight(f: Formula, charge = 0): number {
  let weight = PROTON_MASS_U * charge
  for (const [symbol, count] of ordered(f)) weight += ELEMENTS[symbol][1] * count
  return weight
}

/** EmpiricalFormula::operator<: the number of elements, then element by element (and count). */
function formulaLess(a: Formula, b: Formula): number {
  const [x, y] = [ordered(a), ordered(b)]
  if (x.length !== y.length) return x.length - y.length
  for (let i = 0; i < x.length; i++) {
    const e = elementLess(x[i][0], y[i][0])
    if (e !== 0) return e
    if (x[i][1] !== y[i][1]) return x[i][1] - y[i][1]
  }
  return 0
}

/** EmpiricalFormula::toString: the symbols in alphabetical order, each with its count ('H2O1'). */
const formulaString = (f: Formula) =>
  Object.keys(f)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((symbol) => `${symbol}${f[symbol]}`)
    .join('')

/** A neutral loss: its formula, mass and name as TheoreticalSpectrumGenerator writes it ('H2O1'). */
type Loss = { formula: Formula; mono: number; name: string }
const LOSSES = new Map<string, Loss>()
function loss(formula: Formula): Loss {
  const name = formulaString(formula)
  let l = LOSSES.get(name)
  if (!l) LOSSES.set(name, (l = { formula, mono: monoWeight(formula), name }))
  return l
}

/** A set of losses (std::set<EmpiricalFormula>): in the formulas' order, without duplicates. */
function insertLoss(set: Loss[], l: Loss): void {
  let i = 0
  while (i < set.length && formulaLess(set[i].formula, l.formula) < 0) i++
  if (i < set.length && formulaLess(set[i].formula, l.formula) === 0) return
  set.splice(i, 0, l)
}

// Residue::getInternalTo*()
const INTERNAL_TO_FULL: Formula = { H: 2, O: 1 }
const INTERNAL_TO_NTERM: Formula = { H: 1 }
const INTERNAL_TO_CTERM: Formula = { O: 1, H: 1 }
const ION_OFFSET: Record<IonType, number> = {
  a: monoWeight(minus(INTERNAL_TO_NTERM, { C: 1, H: 1, O: 1 })),
  b: monoWeight(minus(INTERNAL_TO_NTERM, { H: 1 })),
  c: monoWeight(plus(INTERNAL_TO_NTERM, { N: 1, H: 2 })),
  x: monoWeight(minus(plus(INTERNAL_TO_CTERM, { C: 1, O: 1 }), { H: 1 })),
  y: monoWeight(plus(INTERNAL_TO_CTERM, { H: 1 })),
  z: monoWeight(minus(INTERNAL_TO_CTERM, { N: 1, H: 2 })),
}
/** Residue::internal_to_full_monoweight_ */
const INTERNAL_TO_FULL_MONO = monoWeight(INTERNAL_TO_FULL)

//------------------------------------------------------------------------------
// The peptide (AASequence::fromString)

type Residue = {
  code: string
  /** the free amino acid's formula, with the modification's (not with a mass-only one's) */
  formula: Formula
  /** Residue::getMonoWeight(Residue::Full) */
  mono: number
  /** Residue::getMonoWeight(Residue::Internal) */
  internalMono: number
  /** the neutral losses: the residue's, or its modification's */
  losses: Loss[]
  /** a modification known by its mass only: not in the formula */
  massOnly: boolean
}
type TerminalMod = { diffMono: number; diffFormula: Formula; massOnly: boolean }
type Peptide = { residues: Residue[]; nTerm: TerminalMod | null; cTerm: TerminalMod | null }

/** A residue as ResidueDB has it (formula, mass, losses). */
function residue(code: string, formula: Formula, losses: Formula[]): Residue {
  const mono = monoWeight(formula)
  return { code, formula, mono, internalMono: mono - INTERNAL_TO_FULL_MONO, losses: losses.map(loss), massOnly: false }
}

/**
 * A residue with a modification of mass delta `mass` that no database entry explains
 * (ResidueModification::createUnknownFromMassString: the residue's mass plus the delta, the formula and
 * no neutral losses).
 */
function massOnlyResidue(r: Residue, mass: number): Residue {
  const mono = mass + r.mono
  return { code: r.code, formula: r.formula, mono, internalMono: mono - INTERNAL_TO_FULL_MONO, losses: [], massOnly: true }
}
const RESIDUES = new Map(Object.entries(CHEMISTRY.residues).map(([code, [formula, losses]]) => [code, residue(code, formula, losses)]))

/** Unimod: name → monoisotopic mass delta (unimod.json); accession → name. */
const UNIMOD = unimod as unknown as Record<string, [string, number]>
const MOD_MASS = new Map(Object.values(UNIMOD).map(([name, mass]) => [name, mass]))
const MOD_BY_ACCESSION = new Map(Object.entries(UNIMOD).map(([id, [name]]) => [`unimod:${id}`, name]))

/** A modification of the Unimod file by its name (or 'UniMod:35'), with its mass delta; null if unknown. */
function modification(name: string) {
  const id = MOD_BY_ACCESSION.get(name.toLowerCase()) ?? name
  const entry = Object.hasOwn(CHEMISTRY.modifications, id) ? CHEMISTRY.modifications[id] : undefined
  const mass = MOD_MASS.get(id)
  if (!entry || mass === undefined) return null
  const [diffFormula, specificities] = entry
  return { name: id, diffMono: mass, diffFormula, specificities }
}

class AnnotationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnnotationError'
  }
}

/** Unimod's specificities in the order ModificationsDB has them (the file's): for the search by mass. */
const SPECIFICITIES = Object.entries(CHEMISTRY.modifications).flatMap(([name, [, specificities]]) => {
  const diffMono = MOD_MASS.get(name)
  return diffMono === undefined ? [] : specificities.map(([site, position]) => ({ name, diffMono, site, position }))
})

/** ModificationsDB::residuesMatch_ (Unimod has no user-defined modifications) */
const residuesMatch = (residue: string, site: string) => site === 'X' || site === residue || residue === 'X' || residue === '.' || residue === '?' || residue === ''

/**
 * The Unimod modification of mass delta `mass` for `residue` at `position` ('A' anywhere, 'N'/'C' any
 * terminus), as AASequence's parsing of a mass in brackets looks it up: of a mass with decimals the
 * closest within `tolerance` (getBestModificationByDiffMonoMass: the first of equally close ones), of
 * an integer mass the first within it (searchModificationsByDiffMonoMass); none for a delta of 0 unless
 * the mass is 0. Null if none.
 */
function modificationByMass(mass: number, tolerance: number, integer: boolean, residue: string, position: 'A' | 'N' | 'C') {
  let best: (typeof SPECIFICITIES)[number] | null = null
  let minError = tolerance
  for (const spec of SPECIFICITIES) {
    if (spec.position !== position || !residuesMatch(residue, spec.site) || !(spec.diffMono !== 0 || mass === 0)) continue
    const error = Math.abs(spec.diffMono - mass)
    if (integer ? error <= tolerance : error < minError) {
      if (integer) return modification(spec.name)
      minError = error
      best = spec
    }
  }
  return best && modification(best.name)
}

/**
 * The specificity of `mod` for `residue` at `position` ('A' anywhere, 'N'/'C' terminal, 'PN'/'PC'
 * protein terminal): of the residue, else of any residue ('X'); null if none.
 */
function specificity(mod: NonNullable<ReturnType<typeof modification>>, residue: string, positions: string[]) {
  const fits = mod.specificities.filter(([, position]) => positions.includes(position))
  return fits.find(([site]) => site === residue) ?? fits.find(([site]) => site === 'X') ?? null
}

/** The modified residue (ResidueDB::getModifiedResidue, Residue::setModification); null if it has no such modification. */
function modifiedResidue(r: Residue, name: string): Residue | null {
  const mod = modification(name)
  const spec = mod && specificity(mod, r.code, ['A'])
  if (!mod || !spec) return null
  // the formula changes with the modification's; the residue's own losses are replaced by the
  // modification's (ResidueModification::hasNeutralLoss: the first one uncharged, as these all are)
  const formula = Object.keys(mod.diffFormula).length > 0 ? plus(r.formula, mod.diffFormula) : r.formula
  return residue(r.code, formula, [...spec[2]])
}

/** The mass of a modification by its name, for those that the Unimod file does not have (peptides.modMass). */
export type ModificationMass = (name: string) => number | undefined

/** A terminal modification (terminalResidueHelper: terminal, else protein-terminal specificity). */
function terminalMod(name: string, residue: string, term: 'N' | 'C', peptide: string): TerminalMod {
  const mod = modification(name)
  const spec = mod && (specificity(mod, residue, [term]) ?? specificity(mod, residue, [`P${term}`]))
  if (!mod || !spec) {
    throw new AnnotationError(`Cannot convert '${peptide}' to a peptide: no ${term}-terminal modification '${name}' of ${residue}.`)
  }
  return { diffMono: mod.diffMono, diffFormula: mod.diffFormula, massOnly: false }
}

/**
 * A modification given by its mass (AASequence::parseModSquareBrackets_): the Unimod modification of
 * that mass for the residue or terminus, within the precision the mass is written with (one unit of its
 * last digit; 0.5 for an integer); else, for a residue, a terminal one if the residue is the first or
 * last; else a modification of that mass only.
 */
function squareBracket(peptide: Peptide, mod: string, term: 'N' | 'C' | null, s: string, end: number, text: string): void {
  let mass = Number(mod)
  if (mod.trim() === '' || !Number.isFinite(mass)) throw new AnnotationError(`Cannot convert '${text}' to a peptide: '${mod}' is no mass.`)
  const decimal = mod.indexOf('.')
  const integer = decimal < 0
  const tolerance = integer ? 0.5 : Math.pow(10, -(mod.length - decimal - 1))
  let delta = mod[0] === '+' || mod[0] === '-'
  const residues = peptide.residues
  const terminal = (found: ReturnType<typeof modification>, diffMono: number): TerminalMod =>
    found ? { diffMono: found.diffMono, diffFormula: found.diffFormula, massOnly: false } : { diffMono, diffFormula: {}, massOnly: true }

  if (term === 'N') {
    let next = end + 1
    if (s[next] === '.') next++
    const diff = delta ? mass : mass - monoWeight(INTERNAL_TO_NTERM)
    peptide.nTerm = terminal(modificationByMass(diff, tolerance, integer, s[next] ?? '', 'N'), diff)
    return
  }
  const last = residues[residues.length - 1]
  if (term === 'C') {
    const diff = delta ? mass : mass - monoWeight(INTERNAL_TO_CTERM)
    peptide.cTerm = terminal(modificationByMass(diff, tolerance, integer, last.code, 'C'), diff)
    return
  }
  if (delta && last.mono <= 0) {
    throw new AnnotationError(`Cannot convert '${text}' to a peptide: a mass difference on a residue of unknown mass ('${last.code}[${mod}]').`)
  }
  if (!delta) {
    // a residue's mass: relative to the residue as in a peptide (internal)
    mass -= last.internalMono
    delta = true
  }
  const found = modificationByMass(mass, tolerance, integer, last.code, 'A')
  const modified = found && modifiedResidue(last, found.name)
  if (modified) {
    residues[residues.length - 1] = modified
    return
  }
  if (residues.length === 1) {
    const nTerm = modificationByMass(mass, tolerance, integer, last.code, 'N')
    if (nTerm) {
      peptide.nTerm = terminal(nTerm, mass)
      return
    }
  } else if (end === s.length - 1) {
    const cTerm = modificationByMass(mass, tolerance, integer, last.code, 'C')
    if (cTerm) {
      peptide.cTerm = terminal(cTerm, mass)
      return
    }
  }
  residues[residues.length - 1] = massOnlyResidue(last, mass)
}

/**
 * The peptide of an OpenMS string (AASequence::fromString): modifications by name in round brackets, or
 * by mass in square brackets ('M[+15.9949]', '.[+42.0106]PEPTIDE'; a mass without sign is the residue's
 * or terminus' mass), which the Unimod modification of that mass becomes if there is one. A name that
 * the Unimod file does not have (or not for that residue or terminus) is taken as the mass delta that
 * `massOf` gives it, if it gives one.
 */
function parsePeptide(text: string, massOf?: ModificationMass): Peptide {
  let s = text.trim()
  if (s.startsWith('n')) s = s.slice(1)
  if (s.endsWith('c')) s = s.slice(0, -1)
  const peptide: Peptide = { residues: [], nTerm: null, cTerm: null }
  const residues = peptide.residues
  let dotNotation = false
  let dotTerminal = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '.') {
      dotNotation = dotTerminal = true
      continue
    }
    const r = RESIDUES.get(ch)
    if (r) {
      dotTerminal = false
      residues.push(r)
      continue
    }
    let term: 'N' | 'C' | null = null
    if (i === 0 || (dotNotation && dotTerminal && residues.length === 0)) term = 'N'
    else if (ch === 'c') {
      i++
      term = 'C'
    } else if (dotNotation && dotTerminal && residues.length > 0) term = 'C'

    if (s[i] === '(') {
      // the name, up to the matching ')'
      let depth = 1
      let end = i + 1
      for (; end < s.length; end++) {
        if (s[end] === '(') depth++
        else if (s[end] === ')' && --depth === 0) break
      }
      if (end >= s.length) throw new AnnotationError(`Cannot convert '${text}' to a peptide: missing ')'.`)
      const name = s.slice(i + 1, end)
      // a name the Unimod file does not have for this place: its mass delta, if the caller knows it
      const known = massOf?.(name)
      const byMass = <T>(lookup: () => T): T => {
        try {
          return lookup()
        } catch (e) {
          if (known === undefined || !Number.isFinite(known)) throw e
          return null as T
        }
      }
      if (residues.length === 0 || term === 'N') {
        let next = end + 1
        if (s[next] === '.') next++
        peptide.nTerm = byMass(() => terminalMod(name, s[next] ?? '', 'N', text)) ?? { diffMono: known!, diffFormula: {}, massOnly: true }
      } else if (term === 'C') {
        peptide.cTerm = byMass(() => terminalMod(name, residues[residues.length - 1].code, 'C', text)) ?? { diffMono: known!, diffFormula: {}, massOnly: true }
      } else {
        const last = residues[residues.length - 1]
        const modified = modifiedResidue(last, name)
        if (modified) residues[residues.length - 1] = modified
        // the old notation of a terminal modification on the first or last residue
        else if (i === 1 && modification(name)) peptide.nTerm = byMass(() => terminalMod(name, last.code, 'N', text)) ?? { diffMono: known!, diffFormula: {}, massOnly: true }
        else if (end === s.length - 1 && modification(name)) peptide.cTerm = byMass(() => terminalMod(name, last.code, 'C', text)) ?? { diffMono: known!, diffFormula: {}, massOnly: true }
        else if (known !== undefined && Number.isFinite(known)) residues[residues.length - 1] = massOnlyResidue(last, known)
        else throw new AnnotationError(`Cannot convert '${text}' to a peptide: no modification '${name}' of ${last.code}.`)
      }
      i = end
    } else if (s[i] === '[') {
      const end = s.indexOf(']', i + 1)
      if (end < 0) throw new AnnotationError(`Cannot convert '${text}' to a peptide: missing ']'.`)
      squareBracket(peptide, s.slice(i + 1, end), term, s, end, text)
      i = end
    } else {
      throw new AnnotationError(`Cannot convert '${text}' to a peptide: unexpected character '${s[i]}'.`)
    }
    dotTerminal = false
  }
  return peptide
}

//------------------------------------------------------------------------------
// The theoretical spectrum (TheoreticalSpectrumGenerator)

type IonType = 'a' | 'b' | 'c' | 'x' | 'y' | 'z'
/** The order in which getSpectrum adds the ion types of a charge. */
const GENERATION_ORDER: IonType[] = ['b', 'y', 'a', 'c', 'x', 'z']
const PREFIX = new Set<IonType>(['a', 'b', 'c'])

/** A peak of the theoretical spectrum: its m/z, the ion name TSG gives it ('y7-H2O1++'), its charge. */
type TheoreticalPeak = { mz: number; name: string; charge: number }

/** The peptide's ions of charges 1 to maxCharge (theoreticalFragments), sorted stably by m/z. */
function theoreticalFragments(peptide: Peptide, ions: IonType[], maxCharge: number, losses: boolean, precursor: boolean): TheoreticalPeak[] {
  const residues = peptide.residues
  const n = residues.length
  const peaks: TheoreticalPeak[] = []
  const add = (mz: number, name: string, charge: number) => peaks.push({ mz, name, charge })
  const max = Math.max(1, maxCharge)

  for (let z = 1; z <= max; z++) {
    const plusses = '+'.repeat(z)
    for (const type of GENERATION_ORDER) {
      if (!ions.includes(type)) continue
      if ((type === 'c' || type === 'x') && n < 2) {
        throw new AnnotationError(`The peptide must have at least 2 residues for ${type}-ion generation.`)
      }
      const offset = ION_OFFSET[type]
      // the ions without and then with neutral losses (addPeaks_, addLossesFaster_)
      const prefix = PREFIX.has(type)
      const term = prefix ? peptide.nTerm : peptide.cTerm
      let mono = PROTON_MASS_U * z
      if (term) mono += term.diffMono
      const initial = mono
      // the residues in the order they are added: from the N-terminus for a/b/c, from the C-terminus for x/y/z
      const order = prefix ? Array.from({ length: n - 1 }, (_, i) => i) : Array.from({ length: n - 1 }, (_, k) => n - 1 - k)
      const ordinal = (i: number) => (prefix ? i + 1 : n - i)
      for (const i of order) {
        mono += residues[i].internalMono
        add((mono + offset) / z, `${type}${ordinal(i)}${plusses}`, z)
      }
      if (losses) {
        mono = initial
        const set: Loss[] = []
        for (const i of order) {
          mono += residues[i].internalMono
          for (const l of residues[i].losses) insertLoss(set, l)
          const mz = mono + offset
          for (const l of set) add((mz - l.mono) / z, `${type}${ordinal(i)}-${l.name}${plusses}`, z)
        }
      }
    }
  }

  if (precursor) {
    // addPrecursorPeaks_ of charge max: [M+zH], and with the loss of water and of ammonia
    const z = max
    const plusses = '+'.repeat(z)
    const adduct = z === 1 ? 'M+H' : `M+${z}H`
    if (residues.some((r) => r.code === 'X')) throw new AnnotationError("Cannot get the weight of a sequence with unknown residue 'X'.")
    let mono = PROTON_MASS_U * z
    if (peptide.nTerm) mono += peptide.nTerm.diffMono
    if (peptide.cTerm) mono += peptide.cTerm.diffMono
    for (const r of residues) mono += r.internalMono
    add((mono + INTERNAL_TO_FULL_MONO) / z, `[${adduct}]${plusses}`, z)
    // AASequence::getFormula(Residue::Full, z)
    let formula: Formula = {}
    if (peptide.nTerm) formula = plus(formula, peptide.nTerm.diffFormula)
    if (peptide.cTerm) formula = plus(formula, peptide.cTerm.diffFormula)
    for (const r of residues) formula = plus(formula, minus(r.formula, INTERNAL_TO_FULL))
    formula = plus(formula, INTERNAL_TO_FULL)
    if (residues.some((r) => r.massOnly) || peptide.nTerm?.massOnly || peptide.cTerm?.massOnly) {
      // a modification known by its mass only is not in the formula (OpenMS leaves it out of these two
      // peaks): from the precursor's mass instead
      add((mono + INTERNAL_TO_FULL_MONO - monoWeight({ H: 2, O: 1 })) / z, `[${adduct}-H2O]${plusses}`, z)
      add((mono + INTERNAL_TO_FULL_MONO - monoWeight({ N: 1, H: 3 })) / z, `[${adduct}-NH3]${plusses}`, z)
    } else {
      add(monoWeight(minus(formula, { H: 2, O: 1 }), z) / z, `[${adduct}-H2O]${plusses}`, z)
      add(monoWeight(minus(formula, { N: 1, H: 3 }), z) / z, `[${adduct}-NH3]${plusses}`, z)
    }
  }

  // sortByPositionPresorted: the chunks merged stably, i.e. a stable sort by m/z
  return peaks.sort((p, q) => p.mz - q.mz)
}

//------------------------------------------------------------------------------
// Ion names (bind_prose.cpp)

/** A fragment ion's name split up (IonLabel). */
type IonLabel = { ion: string; type: string; ordinal: number; loss: string }

const CONVENTIONAL_LOSS: Record<string, string> = { H3N: 'NH3', H3O4P: 'H3PO4', HO3P: 'HPO3' }

/** lossFormulaName: the formula without counts of 1 ('H2O' for 'H2O1'), and NH3, H3PO4, HPO3 as conventionally spelled. */
function lossFormulaName(formula: string): string {
  let name = ''
  for (let i = 0; i < formula.length; i++) {
    const countOne =
      formula[i] === '1' && i > 0 && /[A-Za-z]/.test(formula[i - 1]) && (i + 1 === formula.length || !/[0-9]/.test(formula[i + 1]))
    if (!countOne) name += formula[i]
  }
  return Object.hasOwn(CONVENTIONAL_LOSS, name) ? CONVENTIONAL_LOSS[name] : name
}

/** parseIonName: 'b3+' → b3, 'y7-H2O1++' → y7-H2O++ (loss H2O), '[M+2H-H2O]++' → precursor. */
function parseIonName(name: string, charge: number): IonLabel {
  const unexpected = () => new AnnotationError(`Unexpected name of a fragment ion: ${name}`)
  let base = name
  for (let z = 0; z < charge && base.endsWith('+'); z++) base = base.slice(0, -1)
  const label: IonLabel = { ion: '', type: '', ordinal: 0, loss: '' }
  if (base.length > 4 && base.startsWith('[M+') && base.endsWith(']')) {
    label.type = 'precursor'
    const minus = base.indexOf('-')
    if (minus >= 0) {
      label.loss = lossFormulaName(base.slice(minus + 1, base.length - 1))
      if (label.loss === '') throw unexpected()
      base = `${base.slice(0, minus + 1)}${label.loss}]`
    }
  } else {
    let digits = 0
    while (digits < base.length && !/[0-9]/.test(base[digits]) && base[digits] !== '-') digits++
    let end = digits
    while (end < base.length && /[0-9]/.test(base[end])) end++
    if (digits === 0 || end === digits) throw unexpected()
    label.type = base.slice(0, digits)
    label.ordinal = Number(base.slice(digits, end))
    if (end < base.length) {
      if (base[end] !== '-' || end + 1 === base.length) throw unexpected()
      label.loss = lossFormulaName(base.slice(end + 1))
      base = base.slice(0, end + 1) + label.loss
    }
  }
  label.ion = charge > 1 ? base + '+'.repeat(charge) : base
  return label
}

//------------------------------------------------------------------------------
// The matching (SpectrumAlignment)

/** ppm: for each ion the closest peak within the tolerance (MatchedIterator with PpmTrait, in float precision). */
function alignPpm(theoretical: ArrayLike<number>, measured: ArrayLike<number>, tolerance: number): [number, number][] {
  const out: [number, number][] = []
  const f = Math.fround
  const tol = f(tolerance)
  if (measured.length === 0) return out
  let t = 0
  for (let r = 0; r < theoretical.length; r++) {
    const ref = theoretical[r]
    const maxDist = f(f(tol / 1e6) * f(ref)) // Math::ppmToMass<float>
    let best = t
    let diff = f(Math.abs(ref - measured[t]))
    while (++t < measured.length) {
      const d = f(Math.abs(ref - measured[t]))
      if (d < diff) {
        diff = d
        best = t
      } else if (d > diff) break
    }
    t = best
    if (diff <= maxDist) out.push([r, best])
  }
  return out
}

/**
 * Da: SpectrumAlignment's banded dynamic-programming alignment (gap cost: the tolerance), one to one; with
 * its traceback from the last aligned cell, which stops at a cell outside the band.
 */
function alignDa(theoretical: ArrayLike<number>, measured: ArrayLike<number>, tolerance: number): [number, number][] {
  const n = theoretical.length
  const m = measured.length
  // row i (1..n): the cells lo[i]..hi[i] (and column 0); the traceback 0 diagonal, 1 up (i, j-1), 2 left (i-1, j)
  const lo = new Int32Array(n + 1)
  const hi = new Int32Array(n + 1).fill(-1)
  // (a row holds the cells of its band only: it ends where the band does)
  const score: number[][] = new Array(n + 1)
  const trace: number[][] = new Array(n + 1)
  /** the matrix value of a cell, or undefined if the matrix does not have it */
  const cell = (i: number, j: number): number | undefined => {
    if (j === 0) return i * tolerance
    if (i === 0) return j <= m ? j * tolerance : undefined
    return j >= lo[i] && j <= hi[i] ? score[i][j - lo[i]] : undefined
  }

  let leftPtr = 1
  let lastI = 0
  let lastJ = 0
  for (let i = 1; i <= n; i++) {
    const pos1 = theoretical[i - 1]
    lo[i] = leftPtr
    score[i] = []
    trace[i] = []
    for (let j = leftPtr; j <= m; j++) {
      let offBand = false
      const pos2 = measured[j - 1]
      const diffAlign = Math.abs(pos1 - pos2)
      if (pos2 > pos1 && diffAlign > tolerance) {
        if (i < n && j < m && theoretical[i] < pos2) offBand = true
      }
      if (pos1 > pos2 && diffAlign > tolerance && j > leftPtr + 1) leftPtr++

      const diag = cell(i - 1, j - 1)
      const scoreAlign = diffAlign + (diag !== undefined ? diag : (i - 1 + j - 1) * tolerance)
      const upCell = cell(i, j - 1)
      const scoreUp = tolerance + (upCell !== undefined ? upCell : (i + j - 1) * tolerance)
      const leftCell = cell(i - 1, j)
      const scoreLeft = tolerance + (leftCell !== undefined ? leftCell : (i - 1 + j) * tolerance)

      // the cell j of row i (j - lo[i] of its arrays)
      if (scoreAlign <= scoreUp && scoreAlign <= scoreLeft && diffAlign <= tolerance) {
        score[i].push(scoreAlign)
        trace[i].push(0)
        lastI = i
        lastJ = j
      } else if (scoreUp <= scoreLeft) {
        score[i].push(scoreUp)
        trace[i].push(1)
      } else {
        score[i].push(scoreLeft)
        trace[i].push(2)
      }
      hi[i] = j
      if (offBand) break
    }
  }

  const out: [number, number][] = []
  let i = lastI
  let j = lastJ
  while (i >= 1 && j >= 1) {
    if (!(j >= lo[i] && j <= hi[i])) break // not in the matrix: std::map's default (0, 0) ends the traceback
    const t = trace[i][j - lo[i]]
    if (t === 0) {
      out.push([i - 1, j - 1])
      i--
      j--
    } else if (t === 1) j--
    else i--
  }
  return out.reverse()
}

//------------------------------------------------------------------------------
// annotatePeaks

const ION_TYPES = new Set(['a', 'b', 'c', 'x', 'y', 'z'])
const isNullish = (v: unknown) => v === undefined || v === null

/**
 * Annotates the peaks mz/intensity (one spectrum's, in any order; of the same length) with the fragment
 * ions of `peptide` (peptides.openms, e.g. 'AM(Oxidation)K') of precursor charge `charge`, as the web
 * app's annotatePeaks: options tolerance (0.02), unit ('Da'), maxCharge (charge − 1, at least 1), ions
 * (['b', 'y']), losses (false), precursor (false; the precursor at maxCharge). In ppm each ion takes its
 * closest peak, so several ions can share one; in Da the matching is one to one. A match refers to its
 * peak by its index in the arrays as passed; its error is in ppm.
 *
 * Modifications given by mass ('M[+15.9949]') become the Unimod modification of that mass (Oxidation,
 * with its losses), as in OpenMS, else a mass delta without losses. A modification whose name the Unimod
 * file does not have is taken as the mass delta `modificationMass` gives it (the results' peptides.modMass);
 * without one it throws, as the web app's annotatePeaks.
 */
export function annotatePeaks(
  mz: ArrayLike<number>,
  intensity: ArrayLike<number>,
  peptide: string,
  charge: number,
  options: AnnotationOptions,
  modificationMass?: ModificationMass,
): PeakAnnotationResult {
  if (!Number.isInteger(charge)) throw new AnnotationError(`The precursor charge has to be an integer: ${charge}`)
  if (charge < 1) throw new AnnotationError(`The precursor charge has to be at least 1: ${charge}`)
  const parsed = parsePeptide(peptide, modificationMass)
  if (parsed.residues.length === 0) throw new AnnotationError(`The peptide is empty: '${peptide}'`)
  if (mz.length !== intensity.length) {
    throw new AnnotationError(`m/z and intensity arrays differ in length (${mz.length} vs. ${intensity.length})`)
  }
  for (let i = 0; i < mz.length; i++) {
    if (!Number.isFinite(mz[i])) throw new AnnotationError(`m/z has to be a finite number: peak ${i}`)
  }

  // alignFragments: the options
  const o = options ?? {}
  const tolerance = isNullish(o.tolerance) ? 0.02 : Number(o.tolerance)
  const unit = isNullish(o.unit) ? 'Da' : o.unit
  if (unit !== 'Da' && unit !== 'ppm') throw new AnnotationError(`unit has to be 'Da' or 'ppm': ${String(unit)}`)
  let maxCharge = Math.max(1, charge - 1)
  if (!isNullish(o.maxCharge)) {
    maxCharge = Number(o.maxCharge)
    if (!Number.isInteger(maxCharge) || maxCharge < -2147483648 || maxCharge > 2147483647) {
      throw new AnnotationError(`maxCharge has to be an integer: ${String(o.maxCharge)}`)
    }
  }
  const ions = (isNullish(o.ions) ? ['b', 'y'] : [...o.ions!].map(String)) as IonType[]
  for (const ion of ions) if (!ION_TYPES.has(ion)) throw new AnnotationError(`Unknown ion type (a, b, c, x, y, z): ${ion}`)
  const losses = !isNullish(o.losses) && Boolean(o.losses)
  const precursor = !isNullish(o.precursor) && Boolean(o.precursor)

  const theoretical = theoreticalFragments(parsed, ions, maxCharge, losses, precursor)
  const labels = theoretical.map((t) => parseIonName(t.name, t.charge))

  // the peaks sorted stably by m/z, and where they are in the arrays
  const position = Array.from({ length: mz.length }, (_, i) => i).sort((a, b) => (mz[a] < mz[b] ? -1 : mz[a] > mz[b] ? 1 : 0))
  const measured = Float64Array.from(position, (p) => mz[p])
  const theoreticalMz = Float64Array.from(theoretical, (t) => t.mz)
  const alignment = unit === 'ppm' ? alignPpm(theoreticalMz, measured, tolerance) : alignDa(theoreticalMz, measured, tolerance)

  const matches: PeakMatch[] = alignment.map(([t, m]) => {
    const theo = theoretical[t].mz
    const observed = measured[m]
    const label = labels[t]
    return {
      peak: position[m],
      ion: label.ion,
      type: label.type,
      ordinal: label.ordinal,
      charge: theoretical[t].charge,
      loss: label.loss,
      theoreticalMz: theo,
      errorPpm: ((observed - theo) / theo) * 1e6,
    }
  })
  return {
    matches,
    theoretical: theoretical.map((t, k) => ({ ion: labels[k].ion, type: labels[k].type, ordinal: labels[k].ordinal, charge: t.charge, mz: t.mz })),
  }
}
