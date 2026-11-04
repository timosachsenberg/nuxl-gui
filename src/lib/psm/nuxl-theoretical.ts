// The theoretical m/z of an ion NuXL annotated, from its label, computed as OpenNuXL computes the ion it aligned to the
// observed peak (OpenMS src/topp/OpenNuXL, develop 7b5d88c06b). For the mass error strip under the spectrum.
//
// What NuXL's fragment_annotation holds (NuXLAnnotateAndLocate::annotateAndLocate_): per annotated peak the OBSERVED
// peak's m/z and intensity (fa.mz = exp_spectrum[fragment_index].getMZ(), of the deisotoped spectrum NuXL scored), the
// charge of the theoretical ion and its name. NuXL aligns two theoretical spectra of the hit's peptide (its fixed and
// variable modifications, without the nucleic acid) to the observed one (getSpectrumAlignmentFastCharge: same charge,
// within the search's fragment tolerance), and names the observed peak by the theoretical ion:
//
// 1. the "total loss" spectrum (createTotalLossSpectrumForAnnotations): TheoreticalSpectrumGenerator, charges 1 to the
//    precursor's, with a, b and y ions, the first prefix ion, neutral losses (the residues' and of the termini: H2O,
//    NH3), all precursor charges, the abundant immonium ions and the internal fragments; plus, for a peptide with M,
//    '[M+zH]-CH4S', and for one with K, the lysine immonium ions 'iK(C5H10N1)' and 'iK(C6H13N2O)'.
//    TheoreticalSpectrumGenerator (z protons, PROTON_MASS_U = 1.007276466771; the residues' Residue::Internal masses):
//      b_n    (z·p + N-term mod + Σ_{1..n} internal + H)/z              (Residue::getInternalToBIon: H − H, i.e. +0)
//      a_n    (… + internal-to-a = H − CHO, i.e. −CO)/z
//      y_n    (z·p + C-term mod + Σ_{last n} internal + H2O)/z
//      with a loss: the same before the division, minus the loss formula's mass ('y1-H2O1+', 'b3-C1H4O1S1+',
//      oxidized M's CH4OS) — the name carries the formula (EmpiricalFormula::toString, counts of 1 written)
//      [M+zH]   AASequence::getMonoWeight(Full, z)/z = (z·p + mods + Σ internal + H2O)/z
//      [M+zH-H2O], [M+zH-NH3]   (getFormula(Full, z) − loss).getMonoWeight()/z
//      [M+zH]-CH4S   (getMonoWeight(Full, z) − CH4S)/z  (no '+' in the name: the peak's charge)
//      iP+ 70.0656, iC+ 76.0221, iL/I+ 86.09698, iH+ 110.0718, iF+ 120.0813, iY+ 136.0762, iW+ 159.0922 (constants of
//      addAbundantImmoniumIons_, charge 1)
//      iK(C5H10N1)+, iK(C6H13N2O)+   EmpiricalFormula(…).getMonoWeight() (the atoms' masses, no proton or electron)
//      internal 'HTV' (b-type), 'HTV-CO' (a-type), with losses 'HTV-H2O1+', 'AD-CO-H2O1+':
//        (z·p + Σ internal of the residues (from the 2nd to the next-to-last residue, 2 to 11 of them) + 0 or −CO −
//        loss)/z; written without '+' when it has no loss in the OpenNuXL of the fixtures ('AD', 'AD-CO')
// 2. the "partial loss" spectrum (NuXLFragmentIonGenerator::generatePartialLossSpectrum), only for the peaks the
//    first left unannotated, for each fragment adduct of the cross-linked nucleotide feasible for the precursor
//    adduct (NuXL:fragment_adducts or the preset's, 'U:C4H2N2O1;U'-H2O': formula and name; its mass
//    EmpiricalFormula::getMonoWeight):
//      shifted a, b, y and precursor ions: the ion of charge z (TheoreticalSpectrumGenerator for z only, a, b, y,
//        no losses, the precursor of that charge with its -H2O and -NH3) + adduct mass / z; named
//        '<ion> <adduct>' → 'y5+U'-H2O++', '[M+2H-H2O]+U'++' (the precursor's charge moved to the end)
//      shifted immonium ions (addShiftedImmoniumIons, charge 1): formula mass + adduct mass, named 'iY+U-H3PO4+'
//        (Y C8H10NO, W C10H11N2, F C8H10N, H C5H8N3, C C2H6NS, P C4H8N, L (and I) C5H12N, K C5H13N2, M 104.05285 and
//        CH5S — both named 'iM+<adduct>+'), and 'iK(C5H10N1)<adduct>+', 'iK(C6H13N2O)<adduct>+'
//      the precursor with the whole nucleic acid (addPrecursorWithCompleteRNA_): (peptide's getMonoWeight() + the
//        precursor adduct's mass (NuXL:NA_MASS_z0, its sum formula's) + z·p)/z, named '[M+zH+<NuXL:NA>]'
//      marker ions (addMS2MarkerIons, charge 1): adduct mass + p, named 'MI:<adduct>+' — the fragment adducts of all
//        nucleotides of the precursor adduct and, always, the default ones (RNA: U C9H13N2O9P1, C C9H14N3O8P,
//        G C10H14N5O8P, A C10H14N5O7P, U' C4H4N2O2, C' C4H5N3O, G' C5H5N5O, A' C5H5N5; DNA: T C10H15N2O8P,
//        C C9H14N3O7P, G C10H14N5O7P, A C10H14N5O6P, T' C5H6N2O2, C' C4H5N3O, G' C5H5N5O, A' C5H5N5)
//
// No isotopes (the spectra are deisotoped; isotope_model none). Where a name stands for more than one m/z (the two
// 'iM' ions, an adduct name with two formulas in the search, an internal fragment whose residues occur twice with
// different modifications) the one nearest the annotated m/z is NuXL's: it aligned the nearest.

import { classifyLabel } from './nuxl-annotation'
import {
  INTERNAL_TO_FULL_MONO,
  ION_OFFSET,
  PREFIX,
  PROTON_MASS_U,
  monoWeight,
  parseFormula,
  parsePeptide,
  type IonType,
  type ModificationMass,
  type Peptide,
} from './annotate'
import { PROTOCOLS, CUSTOM_PROTOCOL } from '$lib/settings/protocols'

//------------------------------------------------------------------------------
// The search's fragment adducts and marker ions

/** OpenNuXL's default NuXL:fragment_adducts (without a preset). */
export const DEFAULT_FRAGMENT_ADDUCTS = [
  'U:C9H10N2O5;U-H3PO4',
  "U:C4H4N2O2;U'",
  "U:C4H2N2O1;U'-H2O",
  'U:C3O;C3O',
  'U:C9H13N2O9P1;U',
  'U:C9H11N2O8P1;U-H2O',
  'U:C9H12N2O6;U-HPO3',
]
/** OpenNuXL's default NuXL:target_nucleotides. */
const DEFAULT_TARGET_NUCLEOTIDES = ['A=C10H14N5O7P', 'C=C9H14N3O8P', 'G=C10H14N5O8P', 'U=C9H13N2O9P']

/** The marker ions OpenNuXL always adds (NuXLParameterParsing::getFeasibleFragmentAdducts), RNA and DNA. */
const DEFAULT_MARKERS: Record<'RNA' | 'DNA', [string, string][]> = {
  RNA: [
    ['U', 'C9H13N2O9P1'],
    ['C', 'C9H14N3O8P'],
    ['G', 'C10H14N5O8P'],
    ['A', 'C10H14N5O7P'],
    ["U'", 'C4H4N2O2'],
    ["C'", 'C4H5N3O'],
    ["G'", 'C5H5N5O'],
    ["A'", 'C5H5N5'],
  ],
  DNA: [
    ['T', 'C10H15N2O8P'],
    ['C', 'C9H14N3O7P'],
    ['G', 'C10H14N5O7P'],
    ['A', 'C10H14N5O6P'],
    ["T'", 'C5H6N2O2'],
    ["C'", 'C4H5N3O'],
    ["G'", 'C5H5N5O'],
    ["A'", 'C5H5N5'],
  ],
}

/** The masses of the fragment adducts (shifts) and the marker ions by name; a name may have more than one. */
export type NuxlChemistry = { adducts: Map<string, number[]>; markers: Map<string, number[]> }

const addMass = (map: Map<string, number[]>, name: string, mass: number) => {
  const list = map.get(name)
  if (!list) map.set(name, [mass])
  else if (!list.some((m) => Math.abs(m - mass) < 1e-9)) list.push(mass)
}

/** EmpiricalFormula::toString: the symbols alphabetically, each with its count ('C4H2N2O1'). */
const formulaName = (f: Record<string, number>) =>
  Object.keys(f)
    .sort()
    .map((s) => `${s}${f[s]}`)
    .join('')

/**
 * The fragment adducts and marker ions of a search (NuXLParameterParsing::getTargetNucleotideToFragmentAdducts):
 * entries '<nucleotide>:<formula>;<name>' (without a name, the formula's EmpiricalFormula::toString), the formula
 * also as '<precursor adduct>-><formula>'; `rna`: which default marker ions OpenNuXL adds.
 */
export function nuxlChemistry(fragmentAdducts: readonly string[], rna: boolean): NuxlChemistry {
  const adducts = new Map<string, number[]>()
  const markers = new Map<string, number[]>()
  for (const entry of fragmentAdducts) {
    const t = entry.replace(/\s/g, '')
    if (t[1] !== ':') continue
    const [body, name, ...more] = t.slice(2).split(';')
    if (more.length > 0) continue
    const formula = parseFormula(body.includes('->') ? body.slice(body.indexOf('->') + 2) : body)
    if (!formula) continue
    const mass = monoWeight(formula)
    const n = name ?? formulaName(formula)
    addMass(adducts, n, mass)
    addMass(markers, n, mass)
  }
  for (const [name, f] of DEFAULT_MARKERS[rna ? 'RNA' : 'DNA']) addMass(markers, name, monoWeight(parseFormula(f)!))
  return { adducts, markers }
}

const stringList = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null)

/**
 * The fragment adducts of a search as OpenNuXL takes them: of its preset (`NuXL:presets`, or the folder's `preset`),
 * else the NuXL:fragment_adducts parameter, else OpenNuXL's defaults; RNA or DNA as OpenNuXL decides it (a preset's
 * name; else the last target nucleotide starting with U or T). Null for a preset this app does not know.
 * `parameters` are the search's that differ from OpenNuXL's defaults (the record's, search.json, which every opened
 * search has, or the live request's; the shim passes OpenNuXL no others): no `NuXL:presets` there is OpenNuXL's 'none',
 * so OpenNuXL's defaults are what it ran with, not a guess.
 */
export function searchChemistry(parameters: Record<string, unknown>, preset?: string): NuxlChemistry | null {
  const p = typeof parameters['NuXL:presets'] === 'string' && parameters['NuXL:presets'] !== '' ? (parameters['NuXL:presets'] as string) : (preset ?? CUSTOM_PROTOCOL)
  if (p !== CUSTOM_PROTOCOL) {
    const protocol = PROTOCOLS[p]
    if (!protocol) return null
    // (RNA if the name says so, as OpenNuXL decides it; else DNA's default marker ions)
    return nuxlChemistry(protocol.fragment_adducts, p.includes('RNA'))
  }
  const adducts = stringList(parameters['NuXL:fragment_adducts']) ?? DEFAULT_FRAGMENT_ADDUCTS
  let rna = false
  for (const t of stringList(parameters['NuXL:target_nucleotides']) ?? DEFAULT_TARGET_NUCLEOTIDES) {
    if (/^[Uu]/.test(t)) rna = true
    else if (/^[Tt]/.test(t)) rna = false
  }
  return nuxlChemistry(adducts, rna)
}

//------------------------------------------------------------------------------
// The peptide

/** The hit's peptide as NuXL computed its ions: without the nucleic acid; and the precursor adduct's mass. */
export type NuxlPeptide = {
  peptide: Peptide
  /** the residues' one-letter codes */
  sequence: string
  /** AASequence::getMonoWeight(Full), neutral */
  fullMono: number
  /** NuXL:NA_MASS_z0 (NaN: not known) */
  adductMass: number
  /** NuXL:NA ('' none) */
  adduct: string
}

/**
 * The peptide of an OpenMS string as NuXL computed its ions (its 'NuXL:…' adduct modification left out); the precursor
 * adduct `adduct` (NuXL:NA) of mass `adductMass` (NuXL:NA_MASS_z0). Throws if the peptide cannot be read.
 */
export function nuxlPeptide(openms: string, modificationMass?: ModificationMass, adduct = '', adductMass = NaN): NuxlPeptide {
  const linear = openms
    .replace(/^\.\(NuXL:[^)]*\)/, '')
    .replace(/\.\(NuXL:[^)]*\)$/, '')
    .replace(/\(NuXL:[^)]*\)/g, '')
  const peptide = parsePeptide(linear, modificationMass)
  let full = (peptide.nTerm?.diffMono ?? 0) + (peptide.cTerm?.diffMono ?? 0)
  for (const r of peptide.residues) full += r.internalMono
  return { peptide, sequence: peptide.residues.map((r) => r.code).join(''), fullMono: full + INTERNAL_TO_FULL_MONO, adduct, adductMass }
}

//------------------------------------------------------------------------------
// The ions

/** The theoretical m/z of a label, or why there is none. */
export type NuxlTheoretical = { mz: number; reason?: undefined } | { mz: null; reason: string }

const IMMONIUM_CONSTANTS: Record<string, number> = { P: 70.0656, C: 76.0221, L: 86.09698, I: 86.09698, H: 110.0718, F: 120.0813, Y: 136.0762, W: 159.0922 }
const IMMONIUM_FORMULAS: Record<string, string[]> = {
  Y: ['C8H10NO'],
  W: ['C10H11N2'],
  F: ['C8H10N'],
  H: ['C5H8N3'],
  C: ['C2H6NS'],
  P: ['C4H8N'],
  L: ['C5H12N'],
  I: ['C5H12N'],
  K: ['C5H13N2'],
}

/** The mass of a formula ('H2O1', 'C1H4O1S1'); null if it is none. */
function formulaMass(text: string): number | null {
  const f = parseFormula(text)
  return f ? monoWeight(f) : null
}

/** The sum of the losses '-H2O1-CO' ... (as named after an ion); null if one is not a formula. */
function lossesMass(losses: string): number | null {
  if (losses === '') return 0
  let sum = 0
  for (const part of losses.split('-').filter((x) => x !== '')) {
    const m = formulaMass(part)
    if (m === null) return null
    sum += m
  }
  return sum
}

const fail = (reason: string): NuxlTheoretical => ({ mz: null, reason })

/** Of several m/z, the one nearest `near` (NaN: the first). */
function pick(candidates: number[], near: number, what: string): NuxlTheoretical {
  if (candidates.length === 0) return fail(`no ${what}`)
  let best = candidates[0]
  if (Number.isFinite(near)) for (const c of candidates) if (Math.abs(c - near) < Math.abs(best - near)) best = c
  return { mz: best }
}

/** The masses of a fragment adduct (shift) by its name. */
function shiftMasses(name: string, chemistry: NuxlChemistry): number[] {
  return chemistry.adducts.get(name) ?? []
}

/** z·p + the residues' masses + the ion type's offset, of the sequence ion `type``ordinal` (TheoreticalSpectrumGenerator::addPeaks_). */
function sequenceIonMass(p: Peptide, type: IonType, ordinal: number, z: number): number | null {
  const n = p.residues.length
  if (ordinal < 1 || ordinal > n - 1) return null
  const prefix = PREFIX.has(type)
  let mono = PROTON_MASS_U * z
  const term = prefix ? p.nTerm : p.cTerm
  if (term) mono += term.diffMono
  for (let k = 0; k < ordinal; k++) mono += p.residues[prefix ? k : n - 1 - k].internalMono
  return mono + ION_OFFSET[type]
}

/**
 * The theoretical m/z of the ion NuXL named `label` on a peak of charge `charge` (its annotation's), for the hit's
 * peptide `peptide`, with the search's fragment adducts and marker ions `chemistry`; `near`: the annotated m/z, to
 * choose among the m/z one name stands for. Null, with the reason, for a label it cannot compute.
 */
export function nuxlTheoreticalMz(label: string, charge: number, peptide: NuxlPeptide, chemistry: NuxlChemistry, near = NaN): NuxlTheoretical {
  const ion = classifyLabel(label, charge)
  const z = ion.charge
  if (!(z >= 1)) return fail(`no charge: ${label}`)
  const p = peptide.peptide
  switch (ion.kind) {
    case 'a':
    case 'b':
    case 'c':
    case 'x':
    case 'y':
    case 'z': {
      const base = sequenceIonMass(p, ion.kind, ion.ordinal, z)
      if (base === null) return fail(`no ion ${ion.kind}${ion.ordinal} of ${peptide.sequence}`)
      if (ion.shift !== '') {
        const shifts = shiftMasses(ion.shift, chemistry)
        if (shifts.length === 0) return fail(`unknown fragment adduct '${ion.shift}'`)
        return pick(
          shifts.map((s) => base / z + s / z),
          near,
          'shift',
        )
      }
      const loss = lossesMass(ion.loss)
      if (loss === null) return fail(`unknown loss '${ion.loss}'`)
      return { mz: (base - loss) / z }
    }
    case 'marker': {
      const masses = chemistry.markers.get(ion.shift)
      if (!masses) return fail(`unknown marker ion '${ion.shift}'`)
      return pick(
        masses.map((m) => m + PROTON_MASS_U),
        near,
        'marker ion',
      )
    }
    case 'precursor':
      return precursorMz(label, z, peptide, chemistry, near)
    case 'immonium':
      return immoniumMz(label, peptide, chemistry, near)
    case 'internal':
      return internalMz(label, z, peptide, near)
    default:
      return fail(`unknown ion '${label}'`)
  }
}

/** '[M+zH]', '[M+zH-H2O]', '[M+zH]-CH4S', '[M+zH-H2O]+<adduct>', '[M+zH+<precursor adduct>]' (charge suffix stripped). */
function precursorMz(label: string, z: number, peptide: NuxlPeptide, chemistry: NuxlChemistry, near: number): NuxlTheoretical {
  const m = /^\[M\+(\d*)H(?:([+-])([^\]]*))?\](.*?)\+*$/.exec(label)
  if (!m) return fail(`unknown precursor ion '${label}'`)
  const [, , sign, inside, after] = m
  let neutral = peptide.fullMono
  if (sign === '+') {
    // the precursor with the whole nucleic acid
    if (!Number.isFinite(peptide.adductMass)) return fail('the precursor adduct mass is not known')
    if (peptide.adduct !== '' && inside !== peptide.adduct) return fail(`the precursor adduct is ${peptide.adduct}, not ${inside}`)
    neutral += peptide.adductMass
  } else if (sign === '-') {
    const loss = lossesMass(inside)
    if (loss === null) return fail(`unknown loss '${inside}'`)
    neutral -= loss
  }
  const mz = (neutral + z * PROTON_MASS_U) / z
  if (after === '') return { mz }
  if (after.startsWith('-')) {
    const loss = lossesMass(after)
    if (loss === null) return fail(`unknown loss '${after}'`)
    return { mz: mz - loss / z }
  }
  const shifts = shiftMasses(after.slice(1), chemistry)
  if (shifts.length === 0) return fail(`unknown fragment adduct '${after.slice(1)}'`)
  return pick(
    shifts.map((s) => mz + s / z),
    near,
    'shift',
  )
}

/** 'iY+', 'iL/I+', 'iK(C6H13N2O)+', 'iW+U-H2O+', 'iK(C5H10N1)C3O+' (charge 1). */
function immoniumMz(label: string, peptide: NuxlPeptide, chemistry: NuxlChemistry, near: number): NuxlTheoretical {
  const m = /^i([A-Z])(?:\/[A-Z])?(?:\(([^)]*)\))?(.*?)\+*$/.exec(label)
  if (!m) return fail(`unknown immonium ion '${label}'`)
  const [, residue, composition, rest] = m
  if (!peptide.sequence.includes(residue) && !(residue === 'L' && peptide.sequence.includes('I'))) return fail(`no ${residue} in ${peptide.sequence}`)
  const shiftName = composition !== undefined ? rest : rest.startsWith('+') ? rest.slice(1) : rest
  let bases: number[]
  if (composition !== undefined) {
    const mass = formulaMass(composition)
    if (mass === null) return fail(`unknown composition '${composition}'`)
    bases = [mass]
  } else if (shiftName === '') {
    if (!(residue in IMMONIUM_CONSTANTS)) return fail(`no immonium ion of ${residue}`)
    bases = [IMMONIUM_CONSTANTS[residue]]
  } else if (residue === 'M') {
    bases = [104.05285, monoWeight({ C: 1, H: 5, S: 1 })]
  } else {
    if (!(residue in IMMONIUM_FORMULAS)) return fail(`no shifted immonium ion of ${residue}`)
    bases = IMMONIUM_FORMULAS[residue].map((f) => formulaMass(f)!)
  }
  if (shiftName === '') return pick(bases, near, 'immonium ion')
  const shifts = shiftMasses(shiftName, chemistry)
  if (shifts.length === 0) return fail(`unknown fragment adduct '${shiftName}'`)
  return pick(
    bases.flatMap((b) => shifts.map((s) => b + s)),
    near,
    'immonium ion',
  )
}

/** 'HTV', 'HTV-CO' (a-type), with losses: 'AD-CO-H2O1+', 'QQ-H3N1+' (TheoreticalSpectrumGenerator::addInternalFragmentPeaks_). */
function internalMz(label: string, z: number, peptide: NuxlPeptide, near: number): NuxlTheoretical {
  const m = /^([A-Z]+)(-CO(?=-|\+|$))?((?:-[A-Za-z0-9()]+)*)\+*$/.exec(label)
  if (!m) return fail(`unknown internal fragment '${label}'`)
  const [, residues, aType, losses] = m
  const loss = lossesMass(losses)
  if (loss === null) return fail(`unknown loss '${losses}'`)
  const seq = peptide.sequence
  const n = seq.length
  const candidates: number[] = []
  // from the second residue on, ending before the last one, 2 to 11 residues
  if (residues.length >= 2 && residues.length <= 11) {
    for (let l = 1; l + residues.length <= n - 1; l++) {
      if (seq.slice(l, l + residues.length) !== residues) continue
      let mono = PROTON_MASS_U * z
      for (let i = l; i < l + residues.length; i++) mono += peptide.peptide.residues[i].internalMono
      const mz = (mono + (aType ? ION_OFFSET.a : ION_OFFSET.b) - loss) / z
      if (!candidates.some((c) => Math.abs(c - mz) < 1e-9)) candidates.push(mz)
    }
  }
  return pick(candidates, near, `internal fragment ${residues} of ${seq}`)
}
