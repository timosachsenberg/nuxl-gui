// What the reader derives from the tool's outputs: the peptides of OpenMS' sequence notation (AASequence::toString,
// as OpenNuXL writes them in idXML) with their modifications and masses, and their ProForma spelling.

import unimod from '../chemistry/unimod.json'

/** 13C − 12C (Constants::C13C12_MASSDIFF_U) */
export const C13C12_MASSDIFF_U = 1.0033548378

//------------------------------------------------------------------------------
// Peptides

/** A modification of a peptide: position −1 N-terminal, the length C-terminal, else the 0-based residue. */
export interface Modification {
  position: number
  /** the (Unimod) name, OpenMS' modification id (an adduct of OpenNuXL without its prefix); a mass-only one as its mass */
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
/** Unimod accession numbers by name (the lowest of a name that two entries have). */
const UNIMOD_ID = new Map<string, number>()
for (const [id, [name]] of Object.entries(UNIMOD)) if (!UNIMOD_ID.has(name)) UNIMOD_ID.set(name, Number(id))

/** The Unimod accession number of a modification name ('Oxidation' → 35); −1 if the table has none. */
export function unimodAccession(name: string): number {
  return UNIMOD_ID.get(name) ?? -1
}

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

//------------------------------------------------------------------------------
// OpenMS' sequence notation

/** A modification as written in an OpenMS sequence: at a position (as Modification), by name or by mass. */
export interface WrittenModification {
  position: number
  /** what the parentheses hold ('Oxidation', 'NuXL:U-H3O4P1', 'UniMod:35'); '' for one in brackets */
  name: string
  /** the bracket's number ('+15.9949' → 15.9949); NaN for a named one */
  mass: number
  /** the bracket's number is the residue's (or terminus') mass, not a delta ('M[147.0354]') */
  absolute: boolean
}

/**
 * The residues and modifications of a peptide in OpenMS' notation (AASequence::toString): 'AEADNLDDK(NuXL:U-H3O4P1)K',
 * '.(Acetyl)PEPTIDE', 'PEPTIDER.(Amidated)', 'M[+15.9949]K', 'Label:13C(6)15N(2)' nested in parentheses. Modifications
 * by position as `Modification` (−1 N-terminal, the length C-terminal). Throws on text it cannot read.
 */
export function parseOpenmsSequence(text: string): { sequence: string; mods: WrittenModification[] } {
  let sequence = ''
  const mods: WrittenModification[] = []
  let i = 0
  // a modification after position `at` (the residue before it; −1 before the first)
  const modification = (at: number) => {
    const open = text[i]
    const close = open === '(' ? ')' : ']'
    let depth = 0
    let j = i
    for (; j < text.length; j++) {
      if (text[j] === open) depth++
      else if (text[j] === close && --depth === 0) break
    }
    if (j >= text.length) throw new Error(`'${text}': no '${close}' for the '${open}' at ${i + 1}`)
    const inner = text.slice(i + 1, j)
    i = j + 1
    if (open === '(') return { position: at, name: inner, mass: NaN, absolute: false }
    const mass = Number(inner)
    if (inner.trim() === '' || !Number.isFinite(mass)) throw new Error(`'${text}': '[${inner}]' is no mass`)
    return { position: at, name: '', mass, absolute: inner[0] !== '+' && inner[0] !== '-' }
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '.') {
      // a terminal modification: '.(Acetyl)' before the residues, '.(Amidated)' after them
      i++
      if (text[i] !== '(' && text[i] !== '[') continue
      const atEnd = sequence.length > 0
      const m = modification(atEnd ? Infinity : -1)
      mods.push(m)
    } else if (c === '(' || c === '[') {
      mods.push(modification(sequence.length - 1))
    } else if (/[A-Z]/.test(c)) {
      sequence += c
      i++
    } else {
      throw new Error(`'${text}': unexpected '${c}' at ${i + 1}`)
    }
  }
  for (const m of mods) if (m.position === Infinity) m.position = sequence.length
  return { sequence, mods }
}

/** Monoisotopic residue masses of the standard amino acids (for an absolute mass in brackets, 'M[147.0354]'). */
const RESIDUE_MASS: Record<string, number> = {
  G: 57.021464, A: 71.037114, S: 87.032028, P: 97.052764, V: 99.068414, T: 101.047679, C: 103.009185, L: 113.084064,
  I: 113.084064, N: 114.042927, D: 115.026943, Q: 128.058578, K: 128.094963, E: 129.042593, M: 131.040485, H: 137.058912,
  F: 147.068414, R: 156.101111, Y: 163.06332, W: 186.079313, U: 150.95363, O: 237.147727,
}
/** The mass of the termini in brackets: '.[43.0184]' is H + Acetyl (an N-terminus is H, a C-terminus OH). */
const N_TERM_MASS = 1.0078250319
const C_TERM_MASS = 17.0027396541

/**
 * The modifications of a parsed OpenMS sequence as the result tables have them: names as Unimod names with their
 * accession numbers ('UniMod:35' → Oxidation, 35); OpenNuXL's precursor adducts 'NuXL:U-H3O4P1' as 'U-H3O4P1' with
 * the mass `adductMass` gives (its modification_definitions); mass-only ones by their delta (name '+15.9949'). The
 * masses from the app's Unimod table; NaN if unknown.
 */
export function tableModifications(
  sequence: string,
  written: WrittenModification[],
  adductMass: (id: string) => number,
): Modification[] {
  return written.map((w) => {
    if (w.name === '') {
      let delta = w.mass
      if (w.absolute) {
        const base = w.position < 0 ? N_TERM_MASS : w.position >= sequence.length ? C_TERM_MASS : (RESIDUE_MASS[sequence[w.position]] ?? NaN)
        delta = w.mass - base
      }
      return { position: w.position, name: massDelta(delta), unimod: -1, mass: delta }
    }
    if (w.name.startsWith('NuXL:')) return { position: w.position, name: w.name.slice(5), unimod: -1, mass: adductMass(w.name) }
    const accession = /^unimod:(\d+)$/i.exec(w.name)
    if (accession) {
      const id = Number(accession[1])
      const entry = UNIMOD[String(id)]
      return { position: w.position, name: entry ? entry[0] : w.name, unimod: id, mass: entry ? entry[1] : NaN }
    }
    const unimod = unimodAccession(w.name)
    return { position: w.position, name: w.name, unimod, mass: modificationMass(w.name, unimod) }
  })
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
