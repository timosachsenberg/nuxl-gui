// Reading ProSE's Parquet files (Arrow C++, Zstandard) with hyparquet.
//
// hyparquet assembles nested columns into one JavaScript object per list element: for the psm file of a
// large search (150,000 PSMs with ~30 scores and hundreds of peaks each) that is millions of objects and
// seconds of garbage collection. The reader needs the columns, not the objects, so `readLeaf` decodes one
// leaf column with hyparquet's page decoders (its exported `src/*.js` modules) and keeps it flat: one value
// per row, or per element of a list (and of a list of lists, as QPX `modifications` positions), with the offsets
// of the rows' lists. Only small views (run, provenance) are read with hyparquet as objects (`readObjects`).

import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet'
import type { Compressors, DecodedArray, FileMetaData, SchemaTree } from 'hyparquet'
import { parquetHeader } from 'hyparquet/src/column.js'
import { convert, convertWithDictionary, DEFAULT_PARSERS } from 'hyparquet/src/convert.js'
import { decompressPage, readDataPage, readDataPageV2 } from 'hyparquet/src/datapage.js'
import { readPlain } from 'hyparquet/src/plain.js'
import { getTreePath } from 'hyparquet/src/schema.js'
import { decompress } from 'fzstd'
import { ZSTDDecoder } from 'zstddec'

// Zstandard, which ProSE's Parquet files use (hyparquet has Snappy only): zstd itself in WebAssembly
// (zstddec), ten times as fast as the JavaScript port fzstd, which is the fallback where WebAssembly
// cannot start (a Content-Security-Policy without 'wasm-unsafe-eval', or without data: for connect-src,
// from where zstddec loads its module).
let wasm: ZSTDDecoder | null = null
let starting: Promise<void> | null = null

/** Starts the WebAssembly decoder (once); without it, ZSTD decodes with fzstd. */
export function startZstd(): Promise<void> {
  starting ??= (async () => {
    try {
      const decoder = new ZSTDDecoder()
      await decoder.init()
      wasm = decoder
    } catch (e) {
      wasm = null
      console.warn(`Zstandard: the WebAssembly decoder (zstddec) did not start, the reader uses fzstd, about ten times slower (${e instanceof Error ? e.message : String(e)}).`)
    }
  })()
  return starting
}

/** Decompresses a Zstandard page of `outputLength` bytes. */
export const ZSTD = (input: Uint8Array, outputLength: number): Uint8Array =>
  wasm ? wasm.decode(input, outputLength) : decompress(input, new Uint8Array(outputLength))
const compressors: Compressors = { ZSTD }

export interface ParquetFile {
  /** the bytes of the file from `base` on (all of it: `base` 0) */
  bytes: Uint8Array
  /** the position of `bytes` in the file */
  base: number
  buffer: ArrayBuffer
  metadata: FileMetaData
  tree: SchemaTree
  rows: number
}

export function openParquet(bytes: Uint8Array): ParquetFile {
  const buffer =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
      ? bytes.buffer
      : (bytes.slice().buffer as ArrayBuffer)
  const metadata = parquetMetadata(buffer)
  return { bytes: new Uint8Array(buffer), base: 0, buffer, metadata, tree: parquetSchema(metadata), rows: Number(metadata.num_rows) }
}

/**
 * The metadata of a Parquet file from its last bytes `tail` (see footerOfTail), or the number of last bytes
 * it needs if `tail` has fewer. Throws if `tail` is not the end of a Parquet file.
 */
export function metadataOfTail(tail: Uint8Array): FileMetaData | number {
  if (tail.byteLength < 8) throw new Error('not a Parquet file (too short)')
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  if (view.getUint32(tail.byteLength - 4, true) !== 0x31524150) throw new Error('not a Parquet file (no PAR1 at its end)')
  const needed = view.getUint32(tail.byteLength - 8, true) + 8
  if (needed > tail.byteLength) return needed
  return parquetMetadata(tail.slice(tail.byteLength - needed).buffer)
}

/** The bytes of a column chunk: from its first page (the dictionary's, if any) on. */
export function chunkRange(meta: { dictionary_page_offset?: bigint; data_page_offset: bigint; total_compressed_size: bigint }): {
  start: number
  end: number
} {
  let start = Number(meta.dictionary_page_offset ?? meta.data_page_offset)
  if (!start || Number(meta.data_page_offset) < start) start = Number(meta.data_page_offset)
  return { start, end: start + Number(meta.total_compressed_size) }
}

/**
 * A part of a Parquet file whose metadata is known: `bytes` from position `base` of the file, enough for
 * the column chunks that readLeaf is asked for.
 */
export function partOfParquet(metadata: FileMetaData, bytes: Uint8Array, base: number): ParquetFile {
  return { bytes, base, buffer: bytes.buffer as ArrayBuffer, metadata, tree: parquetSchema(metadata), rows: Number(metadata.num_rows) }
}

/** The key-value metadata of the file's footer. */
export function footerOf(file: ParquetFile): Map<string, string> {
  return new Map((file.metadata.key_value_metadata ?? []).map((kv) => [kv.key, kv.value ?? '']))
}

/**
 * The footer key-value metadata of a Parquet file from its last bytes `tail` (the footer, its length and the
 * magic number "PAR1"), or the number of last bytes the footer needs if `tail` has fewer. Throws if `tail` is
 * not the end of a Parquet file.
 */
export function footerOfTail(tail: Uint8Array): Map<string, string> | number {
  const metadata = metadataOfTail(tail)
  if (typeof metadata === 'number') return metadata
  return new Map((metadata.key_value_metadata ?? []).map((kv) => [kv.key, kv.value ?? '']))
}

/** Whether the file has the top-level column `name`. */
export function hasColumn(file: ParquetFile, name: string): boolean {
  return file.tree.children.some((c) => c.element.name === name)
}

/**
 * A leaf column. Flat (offsets null): one value per row. In a list (offsets set): the elements of row r
 * are offsets[r] .. offsets[r + 1] of values.
 */
export interface Leaf<T> {
  rows: number
  offsets: Uint32Array | null
  /** list columns: 1 where the row's list is null (not merely empty) */
  nullList: Uint8Array | null
  /** one per row or element; absent values are null, or NaN in a numeric column, or −1 (codes) */
  values: T
  /** mode 'codes': the strings of the codes */
  dictionary?: string[]
  /**
   * A leaf in a list of lists: `offsets` are the rows' ranges of the outer elements, and the inner elements (the
   * values) of outer element e are offsets2[e] .. offsets2[e + 1]
   */
  offsets2?: Uint32Array
}

/**
 * How a leaf is read: as it is ('values'); a string column with few distinct strings as codes ('codes':
 * Int32Array of indices into `dictionary`, −1: absent).
 */
export type LeafMode = 'values' | 'codes'

type Values = Float64Array | Float32Array | Int32Array | unknown[]

/**
 * The numbers of a leaf: FLOAT as Float32Array, DOUBLE, INT32 and INT64 as Float64Array (NaN: absent; INT64 as the
 * nearest double: identities compare, but large values are not exact); else null.
 */
function makeNumbers(type: string | undefined, length: number): Float64Array | Float32Array | null {
  if (type === 'FLOAT') return new Float32Array(length).fill(NaN)
  if (type === 'DOUBLE' || type === 'INT32' || type === 'INT64') return new Float64Array(length).fill(NaN)
  return null
}

/**
 * Reads the leaf column at `path` (e.g. ['psm_metavalues', 'list', 'element', 'name']) of every row
 * group (or of the row groups `groups`, in their order), as `mode` says. Leaves under at most one
 * repeated level only.
 */
export function readLeaf<T extends Values = Values>(file: ParquetFile, path: string[], mode: LeafMode = 'values', groups?: number[]): Leaf<T> {
  const schemaPath = getTreePath(file.tree, path)
  const element = schemaPath[schemaPath.length - 1].element
  let maxDef = 0
  let maxRep = 0
  // the definition levels at which an element of the outer list (elementDef1) and of the inner one (elementDef) exist
  let elementDef1 = 0
  let elementDef = 0
  for (const node of schemaPath.slice(1)) {
    const repetition = node.element.repetition_type
    if (repetition !== 'REQUIRED') maxDef++
    if (repetition === 'REPEATED') {
      maxRep++
      if (maxRep === 1) elementDef1 = maxDef
      elementDef = maxDef
    }
  }
  if (maxRep > 2) throw new Error(`readLeaf: ${path.join('.')} is nested deeper than a list of lists`)
  const listed = maxRep >= 1
  const nested = maxRep === 2

  const key = path.join('\u0000')
  const rowGroups = groups ? groups.map((g) => file.metadata.row_groups[g]) : file.metadata.row_groups
  const rows = groups ? rowGroups.reduce((n, g) => n + Number(g.num_rows), 0) : file.rows
  const chunks = rowGroups.map((group) => {
    const chunk = group.columns.find((c) => c.meta_data?.path_in_schema.join('\u0000') === key)
    if (!chunk?.meta_data) throw new Error(`readLeaf: no column ${path.join('.')}`)
    return chunk.meta_data
  })
  // an upper bound of the elements: every level entry is at most one
  const entries = chunks.reduce((n, c) => n + Number(c.num_values), 0)
  // numbers in a typed array, anything else (strings, booleans, bigints) in an array (null: absent)
  const asCodes = mode === 'codes' && element.type === 'BYTE_ARRAY'
  const numbers = asCodes ? new Int32Array(listed ? entries : rows).fill(-1) : makeNumbers(element.type, listed ? entries : rows)
  // codes: the strings, and the code of each
  const strings: string[] = []
  const codeOf = new Map<string, number>()
  const code = (s: unknown) => {
    const key = String(s)
    let c = codeOf.get(key)
    if (c === undefined) {
      c = strings.length
      strings.push(key)
      codeOf.set(key, c)
    }
    return c
  }
  const others: unknown[] = numbers ? [] : new Array(listed ? entries : rows)
  let o = 0
  const offsets = listed ? new Uint32Array(rows + 1) : null
  const nullList = listed ? new Uint8Array(rows) : null
  // a list of lists: the outer elements' ranges of the inner elements
  const offsets2 = nested ? new Uint32Array(entries + 1) : null
  let row = 0
  let count = 0 // (inner) elements so far
  let count1 = 0 // outer elements so far (a list of lists)

  for (const meta of chunks) {
    const decoder = {
      pathInSchema: path,
      type: meta.type,
      element,
      schemaPath,
      codec: meta.codec,
      parsers: DEFAULT_PARSERS,
      compressors,
      utf8: true,
    }
    const { start, end } = chunkRange(meta)
    if (start < file.base || end - file.base > file.bytes.byteLength) throw new Error(`readLeaf: ${path.join('.')} is not in the bytes read`)
    const bytes = file.bytes.subarray(start - file.base, end - file.base)
    const reader = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), offset: 0 }
    let dictionary: DecodedArray | undefined
    let seen = 0
    const total = Number(meta.num_values)
    while (seen < total && reader.offset < bytes.byteLength) {
      const header = parquetHeader(reader)
      const pageBytes = bytes.subarray(reader.offset, reader.offset + header.compressed_page_size)
      reader.offset += header.compressed_page_size
      if (header.type === 'DICTIONARY_PAGE') {
        const page = decompressPage(pageBytes, header.uncompressed_page_size, meta.codec, compressors)
        const pageReader = { view: new DataView(page.buffer, page.byteOffset, page.byteLength), offset: 0 }
        const n = header.dictionary_page_header?.num_values ?? 0
        const plain = readPlain(pageReader, meta.type, n, element.type_length)
        dictionary = asCodes ? Int32Array.from(convert(plain, decoder) as string[], code) : convert(plain, decoder)
        continue
      }
      let page
      let encoding
      if (header.type === 'DATA_PAGE' && header.data_page_header) {
        const raw = decompressPage(pageBytes, header.uncompressed_page_size, meta.codec, compressors)
        page = readDataPage(raw, header.data_page_header, decoder)
        encoding = header.data_page_header.encoding
      } else if (header.type === 'DATA_PAGE_V2' && header.data_page_header_v2) {
        page = readDataPageV2(pageBytes, header, decoder)
        encoding = header.data_page_header_v2.encoding
      } else {
        continue // an index page
      }
      let data
      if (asCodes && dictionary && encoding.endsWith('_DICTIONARY')) {
        const indices = page.dataPage
        data = new Int32Array(indices.length)
        for (let k = 0; k < indices.length; k++) data[k] = (dictionary as Int32Array)[indices[k] as number]
      } else if (asCodes) data = Int32Array.from(convert(page.dataPage, decoder) as string[], code)
      else data = convertWithDictionary(page.dataPage, dictionary, encoding as Parameters<typeof convertWithDictionary>[2], decoder)
      // (INT64 decodes as bigints: as doubles into the Float64Array)
      if (numbers && element.type === 'INT64') data = Float64Array.from(data as ArrayLike<bigint>, (b) => Number(b))
      const def = page.definitionLevels ?? []
      const rep = page.repetitionLevels ?? []
      const n = Math.max(def.length, rep.length, data.length)
      const allDefined = def.length === 0
      let v = 0
      if (nested) {
        for (let k = 0; k < n; k++) {
          const d = allDefined ? maxDef : def[k]
          const r = rep[k] ?? 0
          if (r === 0) {
            offsets![row] = count1
            if (d < elementDef1 - 1) nullList![row] = 1
            row++
          }
          if (r <= 1 && d >= elementDef1) offsets2![count1++] = count
          if (d >= elementDef) {
            if (numbers) {
              if (d === maxDef) numbers[count] = data[v++] as number
            } else {
              others[o++] = d === maxDef ? data[v++] : null
            }
            count++
          }
        }
      } else if (listed) {
        for (let k = 0; k < n; k++) {
          const d = allDefined ? maxDef : def[k]
          if (rep[k] === 0) {
            offsets![row] = count
            if (d < elementDef - 1) nullList![row] = 1
            row++
          }
          if (d >= elementDef) {
            if (numbers) {
              if (d === maxDef) numbers[count] = data[v++] as number
            } else {
              others[o++] = d === maxDef ? data[v++] : null
            }
            count++
          }
        }
      } else if (numbers) {
        for (let k = 0; k < n; k++, row++) if (allDefined || def[k] === maxDef) numbers[row] = data[v++] as number
      } else {
        for (let k = 0; k < n; k++, row++) others[o++] = allDefined || def[k] === maxDef ? data[v++] : null
      }
      seen += n
    }
  }
  if (row !== rows) throw new Error(`readLeaf: ${path.join('.')} has ${row} rows, the file ${rows}`)
  if (offsets) offsets[rows] = nested ? count1 : count
  if (offsets2) offsets2[count1] = count
  others.length = o
  const values = numbers ? (listed ? numbers.subarray(0, count) : numbers) : others
  return {
    rows,
    offsets,
    nullList,
    offsets2: offsets2 ? offsets2.subarray(0, count1 + 1) : undefined,
    values: values as T,
    dictionary: asCodes ? strings : undefined,
  }
}

/** The leaves `fields` of the list of structs `column` (`column.list.element.<field>`). */
export function readStructList<F extends string>(
  file: ParquetFile,
  column: string,
  fields: F[],
  modes: Partial<Record<F, LeafMode>> = {},
): { offsets: Uint32Array; nullList: Uint8Array; dictionaries: Partial<Record<F, string[]>> } & Record<F, Values> {
  const out: Record<string, unknown> = {}
  const dictionaries: Partial<Record<F, string[]>> = {}
  let offsets: Uint32Array | null = null
  let nullList: Uint8Array | null = null
  for (const field of fields) {
    const leaf = readLeaf(file, [column, 'list', 'element', field], modes[field])
    if (leaf.dictionary) dictionaries[field] = leaf.dictionary
    offsets ??= leaf.offsets
    nullList ??= leaf.nullList
    out[field] = leaf.values
  }
  return { ...out, offsets: offsets!, nullList: nullList!, dictionaries } as never
}

/** The rows of `columns` as hyparquet assembles them (for small or rarely filled nested columns). */
export async function readObjects(file: ParquetFile, columns: string[]): Promise<Record<string, unknown>[]> {
  return parquetReadObjects({ file: file.buffer, columns, compressors })
}
