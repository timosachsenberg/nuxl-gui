// The peaks of one spectrum of an mzML file, read by byte range (the search folder's `read_search_file` serves an
// input mzML only so, never whole): an indexedmzML by its index (the tail's <indexListOffset>, the index's
// <offset idRef="...">), else by scanning the file once in chunks for its <spectrum> elements (at most
// MAX_SCANNED bytes), and then that <spectrum> element alone. Its binary data arrays are decoded as mzML 1.1 has them
// (MzMLHandler): base64, zlib or no compression (MS:1000574, MS:1000576), zstd as OpenMS develop writes it (MS:1003780,
// byte-shuffled MS:1003781, dictionary-encoded MS:1003782; ZstdCompression.cpp), 32- or 64-bit floats (MS:1000521,
// MS:1000523), the m/z and intensity arrays by their CV terms (MS:1000514, MS:1000515). MS-Numpress (alone or followed
// by zlib or zstd) is not supported: such a spectrum has no peaks, with a reason (SpectrumError).
//
// Byte offsets are of the file's bytes: the scanner decodes it as windows-1252 (one character per byte, so that a
// character's index is its byte's), and the native IDs it finds from their own bytes as UTF-8.

import { unzlibSync } from 'fflate'
import { decompress as unzstd } from 'fzstd'
import { unescapeXml } from './idxml'

/** A part of a file: its last `tail` bytes, or `length` bytes from `offset` (fewer at its end). */
export type Range = { tail: number } | { offset: number; length: number }

/** Reads a part of the mzML file (FileNotFound if it does not exist). */
export type ReadRange = (range: Range) => Promise<Uint8Array>

/** A spectrum's peaks and precursor. */
export interface MzmlSpectrum {
  /** sorted by m/z */
  mz: Float64Array
  intensity: Float32Array
  /** of the first precursor's first selected ion (MS:1000744); NaN: none */
  precursorMz: number
  /** of the first precursor in eV: MS:1000045 collision energy, else MS:1000509 activation energy; NaN: none */
  collisionEnergy: number
  /** scan start time in seconds; NaN: none */
  rt: number
}

/** Why a spectrum has no peaks that the PSM view can show (the file is fine). */
export class SpectrumError extends Error {}

/** The most bytes of a file without index that are scanned for its spectra (256 MB). */
export const MAX_SCANNED = 256 * 1024 * 1024

/** The bytes scanned per read. */
const SCAN_CHUNK = 8 * 1024 * 1024
/** The bytes read first for a spectrum whose end is not known. */
const FIRST_READ = 256 * 1024
/** The most bytes of one spectrum element. */
const MAX_SPECTRUM = 64 * 1024 * 1024

const latin = new TextDecoder('windows-1252')
const utf8 = new TextDecoder('utf-8')

/** Where the spectra of a file are: by native ID, the byte offset of its <spectrum> element and where it ends at most. */
export interface SpectrumIndex {
  /** 'index': the file's indexedmzML index; 'scan': found by scanning the file */
  source: 'index' | 'scan'
  offset: Map<string, number>
  /** the offset of the element after it (the next spectrum, or the end of the list); undefined: unknown */
  end: Map<string, number>
}

/** The end of each offset: the next larger one (of `all`), else `last`. */
function ends(offsets: Map<string, number>, last: number | undefined): Map<string, number> {
  const sorted = [...new Set(offsets.values())].sort((a, b) => a - b)
  const next = new Map<number, number>()
  for (let k = 0; k < sorted.length; k++) {
    const e = k + 1 < sorted.length ? sorted[k + 1] : last
    if (e !== undefined) next.set(sorted[k], e)
  }
  const out = new Map<string, number>()
  for (const [id, o] of offsets) {
    const e = next.get(o)
    if (e !== undefined) out.set(id, e)
  }
  return out
}

/** `bytes` as windows-1252 text (one character per byte). */
const bytesText = (bytes: Uint8Array) => latin.decode(bytes)

/**
 * The spectrum index of an indexedmzML from its tail; null if the file has none (or one that cannot be read, which
 * scanning then replaces).
 */
async function readIndex(read: ReadRange): Promise<SpectrumIndex | null> {
  const tail = bytesText(await read({ tail: 4096 }))
  const m = /<indexListOffset>\s*(\d+)\s*<\/indexListOffset>/.exec(tail)
  if (!m) return null
  const at = Number(m[1])
  // the index list: read until its end (a large file's index is some MB)
  let text = ''
  for (let length = 1 << 20; ; length *= 4) {
    const bytes = await read({ offset: at, length })
    text = bytesText(bytes)
    if (text.includes('</indexList>') || bytes.length < length) break
    if (length > 1 << 28) return null
  }
  if (!text.trimStart().startsWith('<indexList')) return null
  const spectrum = /<index\s+name\s*=\s*["']spectrum["'][^>]*>([\s\S]*?)<\/index>/.exec(text)
  if (!spectrum) return null
  const offset = new Map<string, number>()
  const entry = /<offset\s+idRef\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>\s*(\d+)\s*<\/offset>/g
  for (let e; (e = entry.exec(spectrum[1])); ) {
    // (the index's text is windows-1252: an id with UTF-8 bytes is decoded from them)
    const raw = e[1] ?? e[2]
    const id = /[\x80-￿]/.test(raw) ? utf8.decode(Uint8Array.from(raw, (c) => latinByte(c))) : raw
    offset.set(unescapeXml(id), Number(e[3]))
  }
  // the spectrum list ends before the chromatograms or the index; the last spectrum's end is that of the chromatogram
  // index's first entry if any, else the index list itself
  const chromatogram = /<index\s+name\s*=\s*["']chromatogram["'][^>]*>\s*<offset[^>]*>\s*(\d+)/.exec(text)
  return { source: 'index', offset, end: ends(offset, chromatogram ? Math.min(Number(chromatogram[1]), at) : at) }
}

/** The byte of a windows-1252 character. */
const WINDOWS_1252 = new Map<number, number>()
for (let b = 0x80; b < 0xa0; b++) WINDOWS_1252.set(latin.decode(Uint8Array.of(b)).charCodeAt(0), b)
const latinByte = (c: string) => {
  const code = c.charCodeAt(0)
  return code < 0x100 ? code : (WINDOWS_1252.get(code) ?? 0x3f)
}

/**
 * The spectrum index of a file by scanning it for its <spectrum> elements (a file without index), up to
 * `maxBytes`. Throws a SpectrumError for a larger file.
 */
async function scanIndex(read: ReadRange, maxBytes: number): Promise<SpectrumIndex> {
  const offset = new Map<string, number>()
  const tag = /<spectrum[\s>]/g
  let at = 0
  let listEnd: number | undefined
  while (true) {
    // (one byte beyond the limit, to tell a file of the limit from a larger one)
    const length = Math.min(SCAN_CHUNK, maxBytes + 1 - at)
    const bytes = await read({ offset: at, length })
    const text = bytesText(bytes)
    const atEnd = bytes.length < length
    // a tag cut at the chunk's end is read again with the next chunk
    let next = atEnd ? text.length : Math.max(0, text.length - 64)
    tag.lastIndex = 0
    for (let m; (m = tag.exec(text)); ) {
      if (m.index >= next) break
      const close = text.indexOf('>', m.index)
      if (close < 0) {
        next = m.index
        break
      }
      const head = text.slice(m.index, close)
      const id = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(head)
      if (id) {
        const start = m.index + id.index + id[0].indexOf(id[1] !== undefined ? '"' : "'") + 1
        const raw = bytes.subarray(start, start + (id[1] ?? id[2]).length)
        offset.set(unescapeXml(utf8.decode(raw)), at + m.index)
      }
    }
    const list = text.indexOf('</spectrumList>')
    if (list >= 0 && list < next) {
      listEnd = at + list
      break
    }
    if (atEnd) break
    if (at + bytes.length > maxBytes) {
      throw new SpectrumError(`The file has no index and is larger than ${Math.max(1, Math.round(maxBytes / 2 ** 20))} MB, so its spectra are not looked up.`)
    }
    if (next === 0) next = text.length // (no progress: a tag longer than a chunk)
    at += next
  }
  return { source: 'scan', offset, end: ends(offset, listEnd) }
}

/**
 * The index of the spectra of an mzML file: its own (indexedmzML), else (or with `scan`) by scanning it, up to
 * `maxScanned` bytes (MAX_SCANNED).
 */
export async function spectrumIndex(read: ReadRange, options: { scan?: boolean; maxScanned?: number } = {}): Promise<SpectrumIndex> {
  const own = options.scan ? null : await readIndex(read)
  return own ?? scanIndex(read, options.maxScanned ?? MAX_SCANNED)
}

/**
 * The text of the <spectrum> element at `offset` (ending before `end` if known); null if there is none there (an
 * index that does not fit the file).
 */
async function elementAt(read: ReadRange, offset: number, end: number | undefined): Promise<string | null> {
  for (let length = end !== undefined ? end - offset : FIRST_READ; ; length *= 4) {
    const bytes = await read({ offset, length })
    if (!(bytes[0] === 0x3c && bytesText(bytes.subarray(0, 10)).startsWith('<spectrum'))) return null
    // the element's end: its closing tag, else (a self-closing one) the first '>'
    const latinText = bytesText(bytes)
    const close = latinText.indexOf('</spectrum>')
    if (close >= 0) return utf8.decode(bytes.subarray(0, close + '</spectrum>'.length))
    const first = latinText.indexOf('>')
    if (first > 0 && latinText[first - 1] === '/') return utf8.decode(bytes.subarray(0, first + 1))
    if (bytes.length < length || length >= MAX_SPECTRUM) return null
  }
}

/** The value of attribute `name` of the start tag `tag`. */
function attributeOf(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
  return m ? unescapeXml(m[1] ?? m[2]) : undefined
}

/** The cvParams of an element's text: accession → value (and unit accession). */
function cvParams(text: string): Map<string, { value: string; unit: string }> {
  const out = new Map<string, { value: string; unit: string }>()
  const param = /<cvParam\s[^>]*>/g
  for (let m; (m = param.exec(text)); ) {
    const accession = attributeOf(m[0], 'accession')
    if (accession && !out.has(accession)) out.set(accession, { value: attributeOf(m[0], 'value') ?? '', unit: attributeOf(m[0], 'unitAccession') ?? '' })
  }
  return out
}

const BASE64 = new Int16Array(256).fill(-1)
'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').forEach((c, k) => (BASE64[c.charCodeAt(0)] = k))
BASE64['-'.charCodeAt(0)] = 62
BASE64['_'.charCodeAt(0)] = 63

/** The bytes of a base64 text (white space ignored). */
export function base64Bytes(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4))
  let n = 0
  let bits = 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    const v = BASE64[text.charCodeAt(i) & 0xff]
    if (v < 0) {
      if (text[i] === '=') break
      continue
    }
    bits = (bits << 6) | v
    count += 6
    if (count >= 8) {
      count -= 8
      out[n++] = (bits >> count) & 0xff
    }
  }
  return out.subarray(0, n)
}

/**
 * MS-Numpress compressions (MS:1002312–1002314, their zlib combinations MS:1002746–1002748 and their zstd ones
 * MS:1003783–1003785).
 */
const NUMPRESS = new Set(['MS:1002312', 'MS:1002313', 'MS:1002314', 'MS:1002746', 'MS:1002747', 'MS:1002748', 'MS:1003783', 'MS:1003784', 'MS:1003785'])

/** zstd compressions (MS:1003780) and the byte transforms before them: byte shuffle (MS:1003781), dictionary (MS:1003782). */
const ZSTD = { 'MS:1003780': 'none', 'MS:1003781': 'shuffle', 'MS:1003782': 'dictionary' } as const

/** ZstdCompression::byteUnshuffle: `bytes` holds byte i of every element, then byte i + 1, ... */
function byteUnshuffle(bytes: Uint8Array, size: number): Uint8Array {
  if (bytes.length % size !== 0) throw new Error(`its byte-shuffled array of ${bytes.length} bytes is not of ${size}-byte values`)
  const count = bytes.length / size
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < size; i++) for (let j = 0; j < count; j++) out[j * size + i] = bytes[i * count + j]
  return out
}

/** The index width (bytes) the mzML specification gives `values` distinct values. */
const indexWidth = (values: number) => (values < 2 ** 8 ? 1 : values < 2 ** 16 ? 2 : values < 2 ** 32 ? 4 : 8)

/**
 * ZstdCompression::dictionaryDecode: a 16-byte header (the offset of the indices and the number of distinct values,
 * uint64 little-endian), the byte-shuffled values, the byte-shuffled indices (of the width the writer took, one of
 * the specification's widths next to it when `length` tells, as OpenMS accepts it).
 */
function dictionaryDecode(bytes: Uint8Array, size: number, length: number): Uint8Array {
  if (bytes.length === 0) return bytes
  if (bytes.length < 16) throw new Error('its dictionary-encoded array is shorter than its header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  const offset = Number(view.getBigUint64(0, true))
  const values = Number(view.getBigUint64(8, true))
  if (offset < 16 || offset > bytes.length || offset - 16 !== values * size) throw new Error('its dictionary-encoded array has a broken header')
  const indexBytes = bytes.length - offset
  const spec = indexWidth(values)
  let width = spec
  if (length > 0 && indexBytes % length === 0) {
    const w = indexBytes / length
    if ([1, 2, 4, 8].includes(w) && (w === spec || w === indexWidth(values - 1) || w === indexWidth(values + 1))) width = w
  }
  if (indexBytes % width !== 0) throw new Error('its dictionary-encoded indices do not fit their width')
  const dictionary = byteUnshuffle(bytes.subarray(16, offset), size)
  const indices = byteUnshuffle(bytes.subarray(offset), width)
  const iv = new DataView(indices.buffer, indices.byteOffset, indices.length)
  const count = indexBytes / width
  const out = new Uint8Array(count * size)
  for (let j = 0; j < count; j++) {
    const at = j * width
    const index = width === 1 ? indices[at] : width === 2 ? iv.getUint16(at, true) : width === 4 ? iv.getUint32(at, true) : Number(iv.getBigUint64(at, true))
    if (index >= values) throw new Error(`its dictionary-encoded array has an index (${index}) beyond its ${values} values`)
    out.set(dictionary.subarray(index * size, index * size + size), j * size)
  }
  return out
}

/** The values of a binaryDataArray (little-endian floats, as mzML has them). */
function decodeArray(text: string, length: number): { kind: 'mz' | 'intensity' | null; values: Float64Array } {
  const params = cvParams(text.slice(0, text.indexOf('<binary>')))
  const kind = params.has('MS:1000514') ? 'mz' : params.has('MS:1000515') ? 'intensity' : null
  if (kind === null) return { kind, values: new Float64Array(0) }
  for (const accession of params.keys()) {
    if (NUMPRESS.has(accession)) throw new SpectrumError('Its peaks are compressed with MS-Numpress, which the app does not read.')
  }
  const bits = params.has('MS:1000523') ? 64 : params.has('MS:1000521') ? 32 : 0
  if (bits === 0) throw new SpectrumError(`Its ${kind === 'mz' ? 'm/z' : 'intensity'} array has a precision the app does not read (neither 32- nor 64-bit float).`)
  const binary = /<binary>([\s\S]*?)<\/binary>/.exec(text)
  let bytes = base64Bytes(binary ? binary[1] : '')
  const zstd = (Object.keys(ZSTD) as (keyof typeof ZSTD)[]).find((a) => params.has(a))
  if (zstd !== undefined) {
    if (bytes.length > 0) {
      try {
        bytes = unzstd(bytes)
        const transform = ZSTD[zstd]
        if (transform === 'shuffle') bytes = byteUnshuffle(bytes, bits / 8)
        else if (transform === 'dictionary') bytes = dictionaryDecode(bytes, bits / 8, length)
      } catch (e) {
        throw new Error(`its zstd-compressed ${kind} array cannot be decompressed (${(e as Error).message})`, { cause: e })
      }
    }
  } else if (params.has('MS:1000574')) {
    try {
      bytes = unzlibSync(bytes)
    } catch (e) {
      throw new Error(`its zlib-compressed ${kind} array cannot be decompressed (${(e as Error).message})`, { cause: e })
    }
  } else if (!params.has('MS:1000576') && bytes.length > 0) {
    throw new SpectrumError(`Its ${kind === 'mz' ? 'm/z' : 'intensity'} array is compressed in a way the app does not read.`)
  }
  const size = bits / 8
  const n = Math.floor(bytes.length / size)
  if (length >= 0 && n !== length && bytes.length > 0) throw new Error(`its ${kind} array has ${n} values, not ${length}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * size)
  const values = new Float64Array(n)
  if (bits === 64) for (let i = 0; i < n; i++) values[i] = view.getFloat64(i * 8, true)
  else for (let i = 0; i < n; i++) values[i] = view.getFloat32(i * 4, true)
  return { kind, values }
}

/** The peaks and precursor of a <spectrum> element's text. */
export function parseSpectrum(text: string): MzmlSpectrum {
  const head = text.slice(0, text.indexOf('>') + 1)
  const length = Number(attributeOf(head, 'defaultArrayLength') ?? NaN)
  // the precursor: the first <precursor>'s cvParams (selected ion, activation)
  let precursorMz = NaN
  let collisionEnergy = NaN
  const precursor = /<precursor[\s>][\s\S]*?<\/precursor>/.exec(text)
  if (precursor) {
    const p = cvParams(precursor[0])
    precursorMz = Number(p.get('MS:1000744')?.value ?? NaN)
    collisionEnergy = Number(p.get('MS:1000045')?.value ?? p.get('MS:1000509')?.value ?? NaN)
  }
  const scan = /<scan[\s>][\s\S]*?(?:<\/scan>|\/>)/.exec(text)
  let rt = NaN
  const time = scan ? cvParams(scan[0]).get('MS:1000016') : undefined
  if (time) rt = Number(time.value) * (time.unit === 'UO:0000031' ? 60 : 1)

  let mz: Float64Array | null = null
  let intensity: Float64Array | null = null
  const array = /<binaryDataArray[\s>][\s\S]*?<\/binaryDataArray>/g
  for (let m; (m = array.exec(text)); ) {
    const own = Number(attributeOf(m[0].slice(0, m[0].indexOf('>') + 1), 'arrayLength') ?? NaN)
    const { kind, values } = decodeArray(m[0], Number.isFinite(own) ? own : Number.isFinite(length) ? length : -1)
    if (kind === 'mz' && !mz) mz = values
    else if (kind === 'intensity' && !intensity) intensity = values
  }
  if (!mz || !intensity) {
    if (length === 0) return { mz: new Float64Array(0), intensity: new Float32Array(0), precursorMz, collisionEnergy, rt }
    throw new SpectrumError('The spectrum has no m/z or no intensity array.')
  }
  if (mz.length !== intensity.length) throw new Error(`its m/z and intensity arrays have ${mz.length} and ${intensity.length} values`)
  // sorted by m/z (mzML does not require it)
  let sorted = true
  for (let i = 1; i < mz.length && sorted; i++) sorted = mz[i - 1] <= mz[i]
  if (!sorted) {
    const order = Array.from(mz, (_, i) => i).sort((a, b) => mz![a] - mz![b])
    mz = Float64Array.from(order, (i) => mz![i])
    intensity = Float64Array.from(order, (i) => intensity![i])
  }
  return { mz, intensity: Float32Array.from(intensity), precursorMz, collisionEnergy, rt }
}

/**
 * The spectrum `nativeId` of the file that `read` reads, by `index` (spectrumIndex). Throws a SpectrumError when the
 * file has no spectrum of that ID; null when the index does not fit the file (offsets elsewhere): the caller scans
 * the file then.
 */
export async function readSpectrum(read: ReadRange, index: SpectrumIndex, nativeId: string): Promise<MzmlSpectrum | null> {
  const offset = index.offset.get(nativeId)
  if (offset === undefined) throw new SpectrumError(`The file has no spectrum with the native ID ${nativeId}.`)
  const text = await elementAt(read, offset, index.end.get(nativeId))
  if (text === null || attributeOf(text.slice(0, text.indexOf('>') + 1), 'id') !== nativeId) return null
  return parseSpectrum(text)
}
