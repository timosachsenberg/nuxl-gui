// What the reader computes from ProSE's outputs, as the web app's OpenMS module computed it
// (docs/parity.md, "derived in the UI"): the standard features of Percolator's .pin format, the
// AASequence and ProForma spellings of a peptide, the masses of its modifications, and the sequences
// of the decoys ProSE generated.

import unimod from '../chemistry/unimod.json'

//------------------------------------------------------------------------------
// The .pin features (OpenMS PercolatorInfile::stampPinFeaturesOnHits)

/** The enzyme name of Percolator's rules for an OpenMS enzyme (ProSEAlgorithm.cpp `pinEnzymeName`). */
export function pinEnzymeName(enzyme: string): string {
  const name = enzyme.replaceAll(' ', '').toLowerCase()
  if (name === 'trypsin/p') return 'trypsinp'
  if (name === 'pepsina') return 'pepsin'
  const known = ['elastase', 'pepsin', 'proteinasek', 'thermolysin', 'chymotrypsin', 'lys-n', 'lys-c', 'arg-c', 'asp-n', 'glu-c', 'trypsin', 'trypsinp']
  return known.includes(name) ? name : 'no_enzyme'
}

/**
 * Whether the enzyme `enz` (a pinEnzymeName) cleaves between residues `n` and `c`: Percolator's rule
 * table, as PercolatorInfile::isEnz_ (a protein terminus is '-'; the evidence's '[' and ']' are passed as
 * they are, as there).
 */
export function isEnz(n: string, c: string, enz: string): boolean {
  if (n === '-' || c === '-') return true
  switch (enz) {
    case 'trypsin':
      return (n === 'K' || n === 'R') && c !== 'P'
    case 'trypsinp':
      return n === 'K' || n === 'R'
    case 'chymotrypsin':
      return 'FWYL'.includes(n) && c !== 'P'
    case 'thermolysin':
      return ('AFILMV'.includes(c) || (n === 'R' && c === 'G')) && n !== 'D' && n !== 'E'
    case 'proteinasek':
      return 'AEFILTVWY'.includes(n)
    case 'pepsin':
      return ('FLWY'.includes(c) || 'FLWY'.includes(n)) && n !== 'R'
    case 'elastase':
      return 'LVAG'.includes(n) && c !== 'P'
    case 'lys-n':
      return c === 'K'
    case 'lys-c':
      return n === 'K' && c !== 'P'
    case 'arg-c':
      return n === 'R' && c !== 'P'
    case 'asp-n':
      return c === 'D'
    case 'glu-c':
      return n === 'E' && c !== 'P'
    default:
      return true
  }
}

/** The enzymatic sites inside `peptide` (PercolatorInfile::countEnzymatic_, the feature enzInt). */
export function countEnzymatic(peptide: string, enz: string): number {
  let count = 0
  for (let i = 1; i < peptide.length; i++) if (isEnz(peptide[i - 1], peptide[i], enz)) count++
  return count
}

/** 13C − 12C (Constants::C13C12_MASSDIFF_U) */
export const C13C12_MASSDIFF_U = 1.0033548378

//------------------------------------------------------------------------------
// Peptides

/** A modification of a peptide: position −1 N-terminal, the length C-terminal, else the 0-based residue. */
export interface Modification {
  position: number
  /** the (Unimod) name, as QPX `modifications[].name` (OpenMS' modification id); a mass-only one as its mass */
  name: string
  /** the Unimod accession number; −1: none */
  unimod: number
  /** the monoisotopic mass delta */
  mass: number
}

/** A name that is a mass delta: '+15.9949', '[-17.0265]' */
const MASS_NAME = /^\[?([+-]\d+(?:\.\d*)?)\]?$/

const UNIMOD = unimod as unknown as Record<string, [string, number]>
const UNIMOD_BY_NAME = new Map(Object.values(UNIMOD).map(([name, mass]) => [name, mass]))

/**
 * The monoisotopic mass delta of a modification: of its Unimod accession, else of its name, from the
 * app's modification table (src/lib/chemistry/unimod.json, generated from the Unimod file of the
 * OpenMS pin by scripts/unimod-table.mjs); a mass-only name is its mass. NaN if unknown.
 */
export function modificationMass(name: string, unimodId: number): number {
  const byId = unimodId > 0 ? UNIMOD[String(unimodId)] : undefined
  if (byId) return byId[1]
  const byName = UNIMOD_BY_NAME.get(name)
  if (byName !== undefined) return byName
  const mass = MASS_NAME.exec(name)
  return mass ? Number(mass[1]) : NaN
}

/**
 * A mass delta as OpenMS writes it in brackets, with 4 decimals ('+15.9949', '-0.9840'): OpenMS takes
 * the tolerance of a bracketed mass from its last digit, so that 4 decimals resolve to the named
 * modification (Oxidation) where the full double would match none.
 */
function massDelta(mass: number): string {
  return `${mass < 0 ? '-' : '+'}${Math.abs(mass).toFixed(4)}`
}

/** How a modification is named in brackets: its name, or the mass delta of a mass-only one. */
function bracketName(m: Modification): string {
  return MASS_NAME.test(m.name) || m.name === '' ? massDelta(m.mass) : m.name
}

/**
 * The peptide as AASequence::toString() writes it: 'AVM(Oxidation)DDFAAFVEK', '.(Acetyl)DAHKSEVAHR',
 * 'PEPTIDER.(Amidated)'; a modification without a name as its mass delta ('M[+15.9949]').
 * `mods` by position.
 */
export function openmsString(sequence: string, mods: Modification[]): string {
  if (mods.length === 0) return sequence
  const at = (m: Modification) => (MASS_NAME.test(m.name) || m.name === '' ? `[${massDelta(m.mass)}]` : `(${m.name})`)
  let out = ''
  for (const m of mods) if (m.position < 0) out += `.${at(m)}`
  for (let i = 0; i < sequence.length; i++) {
    out += sequence[i]
    for (const m of mods) if (m.position === i) out += at(m)
  }
  for (const m of mods) if (m.position >= sequence.length) out += `.${at(m)}`
  return out
}

/**
 * The peptide in ProForma with Unimod names, as the web app's tables() writes it:
 * 'AVM[Oxidation]DDFAAFVEK', '[Acetyl]-DAHKSEVAHR', 'PEPTIDER-[Amidated]'; a modification without a
 * Unimod accession as its mass delta ('[+15.9949]').
 */
export function proformaString(sequence: string, mods: Modification[]): string {
  const name = (m: Modification) => `[${m.unimod > 0 ? m.name : bracketName(m)}]`
  let out = ''
  for (const m of mods) if (m.position < 0) out += name(m)
  if (out) out += '-'
  for (let i = 0; i < sequence.length; i++) {
    out += sequence[i]
    for (const m of mods) if (m.position === i) out += name(m)
  }
  const cTerm = mods.filter((m) => m.position >= sequence.length)
  if (cTerm.length) out += '-' + cTerm.map(name).join('')
  return out
}

//------------------------------------------------------------------------------
// Generated decoys (ProSEAlgorithm::buildDecoyAugmentedDB_, DecoyGenerator)

/** The cleavage rules of OpenMS' enzymes (share/OpenMS/CHEMISTRY/Enzymes.xml of the pin). */
const ENZYME_REGEX: Record<string, string> = {
  Trypsin: '(?<=[KRX])(?!P)',
  'Arg-C': '(?<=[RX])(?!P)',
  'Arg-C/P': '(?<=[RX])',
  'Asp-N': '(?=[DBX])',
  'Asp-N/B': '(?=[DX])',
  'Asp-N_ambic': '(?=[DBEZX])',
  Chymotrypsin: '(?<=[FYWLJX])(?!P)',
  'Chymotrypsin/P': '(?<=[FYWLJX])',
  CNBr: '(?<=[MX])',
  Formic_acid: '(?<=[DBX])(?=[DBX])',
  'Lys-C': '(?<=[KX])(?!P)',
  'Lys-N': '(?=[KX])',
  'Lys-C/P': '(?<=[KX])',
  PepsinA: '(?<=[FLJX])',
  TrypChymo: '(?<=[FYWLJKRX])(?!P)',
  'Trypsin/P': '(?<=[KRX])',
  'V8-DE': '(?<=[DBEZX])(?!P)',
  'V8-E': '(?<=[EZX])(?!P)',
  'leukocyte elastase': '(?<=[ALIJVX])(?!P)',
  'proline endopeptidase': '(?<=[HKRX][PX])(?!P)',
  'glutamyl endopeptidase': '(?<=[DBEZX])',
  'Alpha-lytic protease': '(?<=[TASVX])',
  '2-iodobenzoate': '(?<=[WX])',
  iodosobenzoate: '(?<=W)',
  'staphylococcal protease/D': '(?<=[EZX])',
  'proline-endopeptidase/HKR': '(?<=[PX])',
  'Glu-C+P': '(?<=[DBEZX])(?!P)',
  'PepsinA + P': '(?<=[FLJX])(?!P)',
  'cyanogen-bromide': '(?<=[MX])',
  'Clostripain/P': '(?<=[RX])',
  'elastase-trypsin-chymotrypsin': '(?<=[ALIJVKRWFYX])(?!P)',
  'unspecific cleavage': '(?<=[A-Z])',
}

/** The peptides of `protein` without missed cleavages (ProteaseDigestion::digest, full specificity). */
function digest(protein: string, enzyme: string): string[] {
  const rule = ENZYME_REGEX[enzyme]
  if (rule === undefined) return [protein] // 'no cleavage', or an enzyme this table does not know
  const sites = new RegExp(rule, 'y') // sticky: a site at exactly lastIndex
  const peptides: string[] = []
  let from = 0
  for (let at = 1; at < protein.length; at++) {
    sites.lastIndex = at
    const match = sites.exec(protein)
    if (match) {
      peptides.push(protein.slice(from, at))
      from = at
    }
  }
  peptides.push(protein.slice(from))
  return peptides.filter((p) => p.length > 0)
}

const reverse = (s: string) => [...s].reverse().join('')

/**
 * DecoyGenerator::reversePeptides: each peptide of the enzyme reversed but its last residue (the
 * cleavage site), the last peptide of the protein reversed whole.
 */
export function reversePeptides(protein: string, enzyme: string): string {
  const peptides = digest(protein, enzyme)
  if (peptides.length === 0) return ''
  let out = ''
  for (let i = 0; i < peptides.length - 1; i++) out += reverse(peptides[i].slice(0, -1)) + peptides[i].slice(-1)
  return out + reverse(peptides[peptides.length - 1])
}

export interface DecoyGeneration {
  enzyme: string
  /** `peptide:clip_nterm_methionine`: the initial M stays in place */
  keepInitialMet: boolean
  /** `peptide:enzyme_specificity none`: the whole protein reversed */
  unspecific: boolean
}

/** The decoy ProSE generates from the target sequence `target` (as the web app's tables() regenerates it). */
export function generatedDecoy(target: string, g: DecoyGeneration): string {
  const keepMet = g.keepInitialMet && target.length > 1 && target[0] === 'M'
  const rest = keepMet ? target.slice(1) : target
  const decoy = g.unspecific ? reverse(rest) : reversePeptides(rest, g.enzyme)
  return keepMet ? 'M' + decoy : decoy
}

//------------------------------------------------------------------------------
// Ions

/** An ion as the web app names it ('b3', 'y5++'): ProSE's sidecar writes a charge of 1 as '+' ('b3+'). */
export function webIonName(ion: string): string {
  return ion.endsWith('+') && !ion.endsWith('++') ? ion.slice(0, -1) : ion
}
