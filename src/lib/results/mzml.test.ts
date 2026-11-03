/// <reference types="node" />
// The binary data arrays of a spectrum as OpenMS develop's MzMLHandler writes them with zstd
// (MzMLHandlerHelper::getCompressionTerm_, ZstdCompression.cpp): plain (MS:1003780), byte-shuffled (MS:1003781) and
// dictionary-encoded (MS:1003782); MS-Numpress followed by zstd (MS:1003783–1003785) is not read, and says so.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { parseSpectrum, SpectrumError } from './mzml'

const PLAIN = readFileSync(join(__dirname, '../../../src-tauri/resources/example/OpenNuXL_1_input.mzML'), 'latin1')

/** The <spectrum> element of `id` in the app's example (uncompressed 64-bit m/z, 32-bit intensities). */
function element(id: string): string {
  const at = PLAIN.indexOf(`<spectrum id="${id}"`)
  return PLAIN.slice(at, PLAIN.indexOf('</spectrum>', at) + '</spectrum>'.length)
}

/** ZstdCompression::byteShuffle: byte i of every element, then byte i + 1, ... */
function byteShuffle(bytes: Uint8Array, size: number): Uint8Array {
  const count = bytes.length / size
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < size; i++) for (let j = 0; j < count; j++) out[i * count + j] = bytes[j * size + i]
  return out
}

/** The little-endian bytes of the big-endian hex `hex` of a `size`-byte value. */
const hexLittleEndian = (hex: string, size: number) => Uint8Array.from({ length: size }, (_, i) => parseInt(hex.slice((size - 1 - i) * 2, (size - i) * 2), 16))

/** ZstdCompression::dictionaryEncode: the header, the sorted distinct values and the indices, both byte-shuffled. */
function dictionaryEncode(bytes: Uint8Array, size: number): Uint8Array {
  const count = bytes.length / size
  const key = (j: number) => Array.from(bytes.subarray(j * size, j * size + size), (b) => b.toString(16).padStart(2, '0')).reverse().join('')
  const distinct = [...new Set(Array.from({ length: count }, (_, j) => key(j)))].sort()
  const width = distinct.length < 256 ? 1 : distinct.length < 65536 ? 2 : 4
  const values = new Uint8Array(distinct.length * size)
  distinct.forEach((k, i) => values.set(hexLittleEndian(k, size), i * size))
  const indices = new Uint8Array(count * width)
  const iv = new DataView(indices.buffer)
  for (let j = 0; j < count; j++) {
    const index = distinct.indexOf(key(j))
    if (width === 1) indices[j] = index
    else if (width === 2) iv.setUint16(j * 2, index, true)
    else iv.setUint32(j * 4, index, true)
  }
  const out = new Uint8Array(16 + values.length + indices.length)
  const header = new DataView(out.buffer)
  header.setBigUint64(0, BigInt(16 + values.length), true)
  header.setBigUint64(8, BigInt(distinct.length), true)
  out.set(byteShuffle(values, size), 16)
  out.set(byteShuffle(indices, width), 16 + values.length)
  return out
}

/** `text` with every array's bytes re-encoded by `encode` and its compression term `accession`. */
function recompressed(text: string, accession: string, encode: (raw: Uint8Array, size: number) => Uint8Array): string {
  return text.replace(/<binaryDataArray[\s>][\s\S]*?<\/binaryDataArray>/g, (array) => {
    const size = array.includes('MS:1000523') ? 8 : 4
    const raw = Buffer.from(/<binary>([\s\S]*?)<\/binary>/.exec(array)![1], 'base64')
    const binary = Buffer.from(encode(new Uint8Array(raw), size)).toString('base64')
    return array
      .replace(/accession="MS:1000576" name="[^"]*"/, `accession="${accession}" name="zstd"`)
      .replace(/<binary>[\s\S]*?<\/binary>/, `<binary>${binary}</binary>`)
  })
}

describe('zstd-compressed arrays (OpenMS develop)', () => {
  const plain = parseSpectrum(element('spectrum=9'))

  test('plain, byte-shuffled and dictionary-encoded zstd give the same peaks', () => {
    expect(plain.mz.length).toBe(173)
    const cases: [string, (raw: Uint8Array, size: number) => Uint8Array][] = [
      ['MS:1003780', (raw) => zstdCompressSync(raw)],
      ['MS:1003781', (raw, size) => zstdCompressSync(byteShuffle(raw, size))],
      ['MS:1003782', (raw, size) => zstdCompressSync(dictionaryEncode(raw, size))],
    ]
    for (const [accession, encode] of cases) {
      const s = parseSpectrum(recompressed(element('spectrum=9'), accession, encode))
      expect(Array.from(s.mz), accession).toEqual(Array.from(plain.mz))
      expect(Array.from(s.intensity), accession).toEqual(Array.from(plain.intensity))
    }
  })

  test('MS-Numpress followed by zstd: no peaks, and that it is MS-Numpress', () => {
    for (const accession of ['MS:1003783', 'MS:1003784', 'MS:1003785']) {
      const text = recompressed(element('spectrum=9'), accession, (raw) => zstdCompressSync(raw))
      expect(() => parseSpectrum(text)).toThrow(new SpectrumError('Its peaks are compressed with MS-Numpress, which the app does not read.'))
    }
  })
})
