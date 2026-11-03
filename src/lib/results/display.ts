// How the results tables show proteins, samples and numbers.

import { fileStem } from '../design/model'
import { signedNumber } from '../format/number'
import { contaminantPrefix, type ResultSample } from './model'

export type AccessionView = {
  /** What the table shows: the identifier of a UniProt accession ("P02768"), else the accession. */
  id: string
  /** The UniProt entry name ("ALBU_HUMAN"), or null. */
  entry: string | null
  /** A cRAP contaminant (`CON__`; the prefix is not part of `id`). */
  contaminant: boolean
}

/** The parts of an accession: "sp|P02768|ALBU_HUMAN" shows as P02768, "CON__P00761" as a contaminant P00761. */
export function parseAccession(accession: string): AccessionView {
  const contaminant = accession.startsWith(contaminantPrefix)
  const rest = contaminant ? accession.slice(contaminantPrefix.length) : accession
  const parts = rest.split('|')
  if (parts.length === 3 && parts[1] !== '') return { id: parts[1], entry: parts[2] || null, contaminant }
  return { id: rest, entry: null, contaminant }
}

export type DescriptionView = { name: string; gene: string | null; organism: string | null }

/** The protein name, gene (GN=) and organism (OS=) of a UniProt-style description; other descriptions are the name. */
export function parseDescription(description: string): DescriptionView {
  const tag = /\s(OS|OX|GN|PE|SV)=/.exec(` ${description}`)
  if (!tag) return { name: description.trim(), gene: null, organism: null }
  const name = description.slice(0, Math.max(0, tag.index - 1)).trim()
  const gene = /(?:^|\s)GN=(\S+)/.exec(description)?.[1] ?? null
  const organism = /(?:^|\s)OS=(.*?)(?=\s+(?:OX|GN|PE|SV)=|$)/.exec(description)?.[1]?.trim() ?? null
  return { name, gene, organism }
}

/** A per-sample column's header under its condition's group header: "1", "1 · TR2"; without a condition the label. */
export function sampleHeader(sample: ResultSample): string {
  const { condition, label } = sample
  return condition !== null && label.startsWith(`${condition} `) ? label.slice(condition.length + 1) : label
}

const scanTerm = /(?:^|\s)(?:scan|spectrum|index)=(\d+)(?=\s|$)/

/**
 * What the Spectrum column shows of a native ID: the number of its `scan=`, `spectrum=` or `index=`
 * term (Thermo "controllerType=0 controllerNumber=1 scan=4711" is 4711), else the native ID.
 */
export function spectrumLabel(nativeId: string): string {
  return scanTerm.exec(nativeId)?.[1] ?? nativeId
}

/** The number of the `scan=`, `spectrum=` or `index=` term of a native ID, or null if it has none. */
export function scanNumber(nativeId: string): number | null {
  const digits = scanTerm.exec(nativeId)?.[1]
  return digits === undefined ? null : Number(digits)
}

/**
 * A sort key that puts text in natural order by plain comparison: case-insensitive, with every run of
 * digits padded to the same width, so that "frame=5" comes before "frame=12".
 */
export function naturalKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, (digits) => digits.padStart(20, '0'))
}

const counts = new Intl.NumberFormat('en-US')

/** A count with thousands separators: "1,284". */
export function formatCount(n: number): string {
  return counts.format(n)
}

/** A q-value in a cell: two significant digits, below 0.001 in scientific notation ("2.0e-5"); NaN is "–". */
export function formatQValue(q: number): string {
  if (q !== q) return '–'
  if (q === 0) return '0'
  return q < 1e-3 ? q.toExponential(1) : String(Number(q.toPrecision(2)))
}

/**
 * A q-value in a narrow cell (the list beside the PSM view): at most six characters, below 0.01 in scientific
 * notation with one decimal ("3.1e-3"; "<1e-9" below that), else two significant digits ("0.012", "0.5"); NaN is "–".
 */
export function formatQCompact(q: number): string {
  if (q !== q) return '–'
  if (q === 0) return '0'
  if (q < 1e-9) return '<1e-9'
  return q < 0.01 ? q.toExponential(1) : String(Number(q.toPrecision(2)))
}

/**
 * A PSM's (or protein's best) score with three decimals, a negative one with a real minus (rounded
 * first: no "−0.000"). A hit Percolator could not score carries -100 with q-value 1: it shows as "–",
 * as does a missing score.
 */
export function formatScore(score: number, q: number): string {
  if (score !== score || (score === -100 && !(q < 1))) return '–'
  return signedNumber(score, 3, { plus: false })
}

const fallbackName = 'prose-results'

/**
 * A name for the files of a result (exports are called `<name>-proteins.csv`, `<name>.idXML`): the
 * one file's stem, or what the stems of several files start with ("EGF_time" for EGF_time_1 and
 * EGF_time_2), reduced to letters (of any script), digits, "-", "_" and "." (`fileSafe`). Otherwise "prose-results".
 */
export function resultName(files: string[]): string {
  if (files.length === 0) return fallbackName
  const stems = files.map(fileStem)
  let prefix = stems[0]
  for (const stem of stems.slice(1)) {
    let i = 0
    while (i < prefix.length && i < stem.length && prefix[i] === stem[i]) i++
    prefix = prefix.slice(0, i)
  }
  const name = fileSafe(prefix)
  return name.length >= 3 ? name : fallbackName
}

/**
 * The longest piece `fileSafe` returns, in UTF-8 bytes (file systems count bytes, ext4 255 per name, or
 * UTF-16 units, NTFS 255): room for a suffix such as "-proteins.csv" or ".prose".
 */
export const fileSafeMaxBytes = 200

/** Names Windows reserves for devices, with or without an extension ("CON", "nul.txt", "COM1.csv"). */
const reservedOnWindows = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i

/** The UTF-8 length of one code point. */
function utf8Bytes(char: string): number {
  const code = char.codePointAt(0) ?? 0
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
}

/** `text` cut to at most `max` UTF-8 bytes, at a code point boundary. */
function cutToBytes(text: string, max: number): string {
  let bytes = 0
  let out = ''
  for (const char of text) {
    bytes += utf8Bytes(char)
    if (bytes > max) break
    out += char
  }
  return out
}

/**
 * `text` as a piece of a file name: letters (of any script), digits, combining marks, "_", "-" and "."
 * are kept, every run of anything else (spaces, separators, characters that are invalid on Windows, control
 * characters) becomes one "_", and "_", "-" and "." at the ends are dropped. "Probe Größe (1)" is
 * "Probe_Größe_1". At most `fileSafeMaxBytes` UTF-8 bytes, cut between characters, and never a name Windows
 * reserves for a device (CON, PRN, AUX, NUL, COM1-9, LPT1-9, in any case, with or without an extension):
 * those get a "_" in front ("_CON"), within the limit. May be empty.
 */
export function fileSafe(text: string): string {
  const trim = (s: string) => s.replace(/^[_.-]+|[_.-]+$/g, '')
  const safe = trim(cutToBytes(trim(text.normalize('NFC').replace(/[^\p{L}\p{N}\p{M}_.-]+/gu, '_')), fileSafeMaxBytes))
  return reservedOnWindows.test(safe) ? `_${trim(cutToBytes(safe, fileSafeMaxBytes - 1))}` : safe
}
