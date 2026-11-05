// The spectral library's precursor sequences: a peptide of OpenMS' notation (as OpenNuXL writes it) in the DIA-NN
// spelling of nuxl2dia.py, with the cross-link's adduct in brackets after its residue ('KDIHPK' with C-H3N1 on K1 is
// 'K[C-H3N1]DIHPK'), Oxidation and Carbamidomethyl as Unimod accessions ('M(UniMod:35)', 'C(UniMod:4)'), the
// dinucleotide names of the adducts in alphabetical order ('UC' is 'CU').
//
// Ported from nuxl-app src/nuxl2dia.py (NuXL Team; NuXLDIA, github.com/timosachsenberg/NuXLDIA:
// `_build_xl_modified_sequence`, `_convert_modification_format`, `_normalize_dinucleotide_order`), BSD-3,
// Copyright OpenMS Inc. -- Eberhard Karls University Tuebingen, ETH Zurich, and Freie Universitaet Berlin
// 2002-present. Differences: the adduct that OpenNuXL already writes as a modification of its residue
// ('K(NuXL:C-H3N1)DIHPK', docs/design.md §5; the TextExporter files nuxl2dia.py was written for had none) becomes the
// bracket at that residue, never a second one; nested parentheses ('Label:13C(6)15N(2)') are read whole.

/** The modifications nuxl2dia.py writes as Unimod accessions; every other one stays in OpenMS' notation. */
const UNIMOD_NAMES: [string, string][] = [
  ['(Oxidation)', '(UniMod:35)'],
  ['(Carbamidomethyl)', '(UniMod:4)'],
]

/** Dinucleotides in DIA-NN's (NuXLDIA's declaration file's) order: alphabetical, A < C < G < U. */
const DINUCLEOTIDES: Record<string, string> = { UA: 'AU', UC: 'CU', UG: 'GU', CA: 'AC', GA: 'AG', GC: 'CG' }

/** An adduct's name as the library writes it: a leading dinucleotide in alphabetical order ('UC-H2O1' is 'CU-H2O1'). */
export function libraryAdductName(adduct: string): string {
  const head = DINUCLEOTIDES[adduct.slice(0, 2)]
  return head ? head + adduct.slice(2) : adduct
}

/** A part of an OpenMS sequence: a residue, a modification in parentheses or brackets, or another character ('.'). */
type Token = { kind: 'residue' | 'mod' | 'other'; text: string }

/** The parts of an OpenMS sequence ('.(Acetyl)M(Oxidation)K[+1.0]'); a group without its end runs to the end. */
function tokens(text: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '(' || c === '[') {
      const close = c === '(' ? ')' : ']'
      let depth = 0
      let j = i
      for (; j < text.length; j++) {
        if (text[j] === c) depth++
        else if (text[j] === close && --depth === 0) break
      }
      out.push({ kind: 'mod', text: text.slice(i, j + 1) })
      i = j + 1
    } else {
      out.push({ kind: /[A-Za-z]/.test(c) ? 'residue' : 'other', text: c })
      i++
    }
  }
  return out
}

const isAdductMod = (t: Token) => t.kind === 'mod' && t.text.startsWith('(NuXL:')

/** A peptide's sequences in the library, and its key for the deduplication. */
export type LibrarySequence = {
  /** ModifiedPeptideSequence: 'K[C-H3N1]DIHPK', 'GQDM(UniMod:35)ETEAHQNK' */
  modified: string
  /** PeptideSequence: the residues ('KDIHPK') */
  plain: string
  /**
   * The peptide as nuxl2dia.py deduplicates it (the TextExporter's `sequence`): OpenMS' notation without OpenNuXL's
   * adduct modification ('KDIHPK', 'GQDM(Oxidation)ETEAHQNK'). Two localizations of one adduct are one entry.
   */
  key: string
  /** The adduct written in brackets ('' none), as `libraryAdductName` spells it. */
  adduct: string
}

/** A mass-delta modification of OpenMS' notation ('[+306.0253]', '[-17.03]'): its mass; NaN another one. */
function massDelta(t: Token | undefined): number {
  return t?.kind === 'mod' && /^\[[+-]\d+(\.\d*)?\]$/.test(t.text) ? Number(t.text.slice(1, -1)) : NaN
}

/** How near a mass-delta modification of the site has to be to the adduct's mass to be it (Da). */
const ADDUCT_MASS_TOLERANCE = 0.01

/**
 * The library's sequences of a peptide `openms` (OpenMS' notation). The adduct: OpenNuXL's modification
 * `(NuXL:<adduct>)` on a residue, at that residue; without one, `adduct` (NuXL:NA, '' none) at the 0-based residue
 * `site` (NuXL:best_localization_position; −1: none, no bracket). As nuxl2dia.py, the bracket follows its residue,
 * but goes before it when the residue carries another modification ('PEM(Oxidation)K' with U on M: 'PE[U]M(UniMod:35)K').
 * OpenNuXL merges the adduct with a modification its residue has already ('M(NuXL:U~Oxidation)'): that one stays the
 * residue's own ('[U]M(UniMod:35)'). When OpenNuXL could not (a residue's modification of no formula) it writes the
 * adduct's mass, `adductMass` (NuXL:NA_MASS_z0), as a mass delta ('K[+306.0253]', with the other modification's added):
 * that is the bracket (and what is left over, the residue's mass delta), never a second adduct.
 */
export function librarySequence(openms: string, adduct: string, site: number, adductMass = NaN): LibrarySequence {
  const parts = tokens(openms)
  // OpenNuXL's merged modification: the adduct's, then the residue's own ('(NuXL:U-H2O1~Oxidation)')
  for (let k = 0; k < parts.length; k++) {
    const t = parts[k]
    const merged = isAdductMod(t) ? t.text.indexOf('~') : -1
    if (merged < 0) continue
    parts.splice(k, 1, { kind: 'mod', text: t.text.slice(0, merged) + ')' }, { kind: 'mod', text: '(' + t.text.slice(merged + 1) })
    k++
  }
  // the adduct as a mass delta at the site (when OpenNuXL wrote no modification of its own for it)
  if (Number.isFinite(adductMass) && adduct !== '' && site >= 0 && !parts.some(isAdductMod)) {
    let r = -1
    for (let k = 0; k < parts.length; k++) {
      if (parts[k].kind === 'residue' && ++r === site) {
        const delta = massDelta(parts[k + 1])
        if (delta >= adductMass - ADDUCT_MASS_TOLERANCE) {
          const left = delta - adductMass
          const own: Token[] = Math.abs(left) <= ADDUCT_MASS_TOLERANCE ? [] : [{ kind: 'mod', text: `[${left >= 0 ? '+' : ''}${Number(left.toFixed(4))}]` }]
          parts.splice(k + 1, 1, { kind: 'mod', text: `(NuXL:${adduct})` }, ...own)
        }
        break
      }
    }
  }
  // OpenNuXL's adduct modification: its residue (the residue before it), and the parts without it
  let at = -1
  let name = ''
  const rest: Token[] = []
  let residues = 0
  for (let k = 0; k < parts.length; k++) {
    const t = parts[k]
    if (isAdductMod(t)) {
      if (name === '') {
        name = t.text.slice('(NuXL:'.length, -1)
        // on a residue (not a terminus: '.(NuXL:U)PEPTIDE'): that residue; else the site
        at = rest.length > 0 && rest[rest.length - 1].kind === 'residue' ? residues - 1 : -2
      }
      // a terminal one's '.' (unless the terminus' own modification follows)
      if (rest.length > 0 && rest[rest.length - 1].kind === 'other' && rest[rest.length - 1].text === '.' && parts[k + 1]?.kind !== 'mod') rest.pop()
      continue
    }
    if (t.kind === 'residue') residues++
    rest.push(t)
  }
  const key = rest.map((t) => t.text).join('')
  let bracket = ''
  let position = -1
  if (name !== '' && at >= 0) {
    bracket = name
    position = at
  } else if ((adduct || name) !== '' && site >= 0) {
    bracket = adduct || name
    position = site
  }
  bracket = libraryAdductName(bracket)

  let out = ''
  let plain = ''
  let r = 0
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k]
    if (t.kind !== 'residue') {
      out += t.text
      continue
    }
    const here = bracket !== '' && r === position
    // (nuxl2dia.py: a residue with a modification gets the adduct before it)
    const modified = rest[k + 1]?.kind === 'mod'
    const residue = t.text.toUpperCase()
    if (here && modified) out += `[${bracket}]`
    out += residue
    if (here && !modified) out += `[${bracket}]`
    plain += residue
    r++
  }
  for (const [from, to] of UNIMOD_NAMES) out = out.split(from).join(to)
  // (nuxl2dia.py normalises the dinucleotide of every bracket)
  out = out.replace(/\[([^\]]+)\]/g, (_, inner: string) => `[${libraryAdductName(inner)}]`)
  return { modified: out, plain, key, adduct: bracket !== '' && position >= 0 && position < r ? bracket : '' }
}
