// DIA-NN's declarations of the library's adducts: one `--mod <name>,<mass>` per adduct in the library's brackets, so
// that DIA-NN knows the masses of '[U-H2O1]' and the like (its README: unknown modifications in a library give a
// warning, and declaring them is strongly recommended; fine-tuning with --tune-lib needs them). NuXLDIA ships one such
// file for one preset (DIA-NN/declare_mod_UV_UCGA_ext.txt, 3 decimals); the export writes the lines of its own
// adducts, with 6.
//
// The mass of an adduct is the search's own: OpenNuXL's NuXL:NA_MASS_z0 of its PSMs (the sum formula's monoisotopic
// mass). Without one, from the name and the nucleotides' formulas of the search's protocol (`adductFormulaMass`), as
// OpenNuXL composes them: the nucleotides' formulas, less a water per bond between them, then the formulas added or
// lost ('UU-H3O4P1' is 2 U − H2O − H3PO4).

import { monoWeight, parseFormula, type Formula } from '../../psm/annotate'
import { PROTOCOLS, CUSTOM_PROTOCOL } from '../../settings/protocols'

/** OpenNuXL's default NuXL:target_nucleotides (RNA), for a search of the custom protocol without its own. */
const DEFAULT_TARGET_NUCLEOTIDES = ['A=C10H14N5O7P', 'C=C9H14N3O8P', 'G=C10H14N5O8P', 'U=C9H13N2O9P']

/** The search's nucleotides by their letter, with their formulas ('U=C9H13N2O9P'): its protocol's, else its own. */
export function targetNucleotides(parameters: Record<string, unknown>, preset?: string): Map<string, Formula> {
  const given = parameters['NuXL:presets']
  const p = typeof given === 'string' && given !== '' ? given : (preset ?? CUSTOM_PROTOCOL)
  const own = parameters['NuXL:target_nucleotides']
  const list =
    p !== CUSTOM_PROTOCOL && PROTOCOLS[p]
      ? PROTOCOLS[p].target_nucleotides
      : Array.isArray(own) && own.every((t) => typeof t === 'string')
        ? (own as string[])
        : DEFAULT_TARGET_NUCLEOTIDES
  const out = new Map<string, Formula>()
  for (const entry of list) {
    const [letter, formula] = entry.split('=')
    const f = formula ? parseFormula(formula) : null
    if (letter?.length === 1 && f) out.set(letter, f)
  }
  return out
}

const WATER = parseFormula('H2O')!

/**
 * The monoisotopic mass of adduct `name` (NuXL:NA: nucleotides, then formulas added or lost: 'U', 'U-H2O1',
 * 'CU-H3N1-H3O4P1', 'U+C4H6O2-H2O1') from the nucleotides' formulas `nucleotides`; NaN if a nucleotide or a formula
 * is unknown.
 */
export function adductFormulaMass(name: string, nucleotides: Map<string, Formula>): number {
  const m = /^([^+-]+)((?:[+-][^+-]+)*)$/.exec(name)
  if (!m) return NaN
  let mass = 0
  const letters = [...m[1]]
  for (const letter of letters) {
    const f = nucleotides.get(letter)
    if (!f) return NaN
    mass += monoWeight(f)
  }
  mass -= (letters.length - 1) * monoWeight(WATER)
  for (const part of m[2].match(/[+-][^+-]+/g) ?? []) {
    const f = parseFormula(part.slice(1))
    if (!f) return NaN
    mass += (part[0] === '+' ? 1 : -1) * monoWeight(f)
  }
  return mass
}

/** The suffix of the declarations' file beside the library (`<library stem>_diann_mods.txt`). */
export const MODS_SUFFIX = '_diann_mods.txt'

/**
 * The declaration lines of adducts `masses` (name as in the library's brackets → monoisotopic mass), by name:
 * '--mod U-H2O1,306.025302'. An adduct of unknown mass (NaN) gets none: `unknown` names those.
 */
export function diannModLines(masses: ReadonlyMap<string, number>): { lines: string[]; unknown: string[] } {
  const names = [...masses.keys()].sort()
  const lines: string[] = []
  const unknown: string[] = []
  for (const name of names) {
    const mass = masses.get(name)!
    if (Number.isFinite(mass)) lines.push(`--mod ${name},${mass.toFixed(6)}`)
    else unknown.push(name)
  }
  return { lines, unknown }
}
