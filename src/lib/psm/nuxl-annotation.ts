// OpenNuXL's own annotation of a PSM's peaks: the `fragment_annotation` UserParam of its hits (PeptideHit's peak
// annotations as IdXMLFile writes them: 'mz,intensity,charge,"label"|...', PeptideHit::PeakAnnotation), and what its
// labels say. The labels are NuXL's (NuXLFragmentAnnotationHelper, NuXLAnnotateAndLocate):
//
//   y5+  b3++  a2+                    a b, y or a ion (one '+' per charge)
//   y1-H2O1+  a2-H3N1+                with a neutral loss (its formula as EmpiricalFormula writes it)
//   y5+U'-H2O++  b2+U'+               shifted by a fragment of the cross-linked nucleotide ("+" shift, then the charge)
//   MI:A'+  MI:U-H3PO4+               a marker ion of a nucleotide (fragment)
//   [M+H]+  [M+2H-H2O]+U-H3PO4++      the precursor, with a loss and a shift ('[M+2H+U-H2O1]++', '[M+2H]-CH4S')
//   iK(C5H10N1)U'-H2O+  iW+U+  iF+    an immonium ion, with its composition and a shift
//   AD-CO-H2O1+  YTF  QQ-H3N1+        an internal fragment (its residues; '-CO': a-type), with losses
//
// The intensities are relative (NuXL's normalized spectrum), the m/z the peaks'. The PSM view shows these peaks when
// the input mzML (or the converted spectra of a .raw or .d) cannot be read, and their labels on the observed peaks.

/** A peak of NuXL's annotation. */
export interface NuxlPeak {
  mz: number
  /** relative, as NuXL scored the spectrum (0–1) */
  intensity: number
  charge: number
  /** NuXL's label, e.g. "y5+U'-H2O++" */
  label: string
}

/** What a label says. */
export interface NuxlIon {
  /** 'a' to 'z' (a sequence ion), 'immonium', 'marker', 'precursor', 'internal', or 'unknown' */
  kind: 'a' | 'b' | 'c' | 'x' | 'y' | 'z' | 'immonium' | 'marker' | 'precursor' | 'internal' | 'unknown'
  /** the ion number (5 for y5); 0 for the others */
  ordinal: number
  /** the charge of the label's '+' suffix (else the peak's) */
  charge: number
  /** the neutral loss as written ('H2O1', 'CO-H2O1'); '' none */
  loss: string
  /** the nucleotide (fragment) the ion carries ("U'-H2O", 'U-H3PO4', "A'" of a marker ion); '' none */
  shift: string
  /** the residue of an immonium ion ('K'), the residues of an internal fragment ('YTF'); '' else */
  residues: string
}

/** Splits `s` at `separator` outside double quotes (OpenMS StringUtils::split_quoted). */
function splitQuoted(s: string, separator: string): string[] {
  const out: string[] = []
  let start = 0
  let quoted = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"') quoted = !quoted
    else if (c === separator && !quoted) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

const unquote = (s: string) => {
  const t = s.trim()
  return t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"' ? t.slice(1, -1) : t
}

/**
 * The peaks of a fragment_annotation value ('' gives none), by ascending m/z. An entry that is not four fields
 * (m/z, intensity, charge, label) is passed over.
 */
export function parseFragmentAnnotation(value: string): NuxlPeak[] {
  if (value.trim() === '') return []
  const out: NuxlPeak[] = []
  for (const entry of splitQuoted(value, '|')) {
    const fields = splitQuoted(entry, ',')
    if (fields.length !== 4) continue
    const mz = Number(fields[0])
    if (!Number.isFinite(mz)) continue
    out.push({ mz, intensity: Number(fields[1]), charge: Math.trunc(Number(fields[2])) || 0, label: unquote(fields[3]) })
  }
  return out.sort((a, b) => a.mz - b.mz)
}

const SEQUENCE_ION = /^([abcxyz])(\d+)(.*?)(\+*)$/
const MARKER = /^MI:(.*?)(\+*)$/
// [M+<n>H<inside>]<losses>+<shift><charge>: inside, '-<loss>' or '+<shift>' ('[M+2H+U-H2O1]++'); after, losses
const PRECURSOR = /^\[M(?:\+(\d*)H)?([^\]]*)\]((?:-[A-Za-z0-9]+)*)(?:\+([^+].*?))?(\+*)$/
const IMMONIUM = /^i([A-Z])(?:\(([^)]*)\))?(.*?)(\+*)$/
const INTERNAL = /^([A-Z]{2,})((?:-[A-Za-z0-9]+)*)(\+*)$/

/** A '+' suffix as a charge; the peak's charge without one. */
const chargeOf = (pluses: string, fallback: number) => (pluses.length > 0 ? pluses.length : fallback)
/** '-H2O1-CO' → 'H2O1-CO' */
const lossOf = (losses: string) => (losses.startsWith('-') ? losses.slice(1) : losses)

/** What NuXL's label `label` of a peak of charge `charge` says. */
export function classifyLabel(label: string, charge = 1): NuxlIon {
  const ion = (kind: NuxlIon['kind'], more: Partial<NuxlIon> = {}): NuxlIon => ({
    kind,
    ordinal: 0,
    charge,
    loss: '',
    shift: '',
    residues: '',
    ...more,
  })
  let m = SEQUENCE_ION.exec(label)
  if (m) {
    // after the number: '+<shift>' (a nucleotide fragment) or '-<loss>'
    const rest = m[3]
    return ion(m[1] as NuxlIon['kind'], {
      ordinal: Number(m[2]),
      charge: chargeOf(m[4], charge),
      ...(rest.startsWith('+') ? { shift: rest.slice(1) } : { loss: lossOf(rest) }),
    })
  }
  if ((m = MARKER.exec(label))) return ion('marker', { shift: m[1], charge: chargeOf(m[2], charge) })
  if ((m = PRECURSOR.exec(label))) {
    const inside = m[2]
    const shifted = inside.startsWith('+')
    const loss = [shifted ? '' : lossOf(inside), lossOf(m[3])].filter((l) => l !== '').join('-')
    const shift = [shifted ? inside.slice(1) : '', m[4] ?? ''].filter((x) => x !== '').join('+')
    return ion('precursor', { loss, shift, charge: chargeOf(m[5], m[1] === undefined ? charge : Number(m[1] || 1)) })
  }
  if ((m = IMMONIUM.exec(label))) {
    const rest = m[3]
    return ion('immonium', { residues: m[1], shift: rest.startsWith('+') ? rest.slice(1) : rest, charge: chargeOf(m[4], charge) })
  }
  if ((m = INTERNAL.exec(label))) return ion('internal', { residues: m[1], loss: lossOf(m[2]), charge: chargeOf(m[3], charge) })
  return ion('unknown')
}
