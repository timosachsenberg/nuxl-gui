// History without the disk: the record, the folder a saved search leaves, the project file (read with
// fflate; made by the Rust side, here by the memory backend, and one the Rust side made: fixtures/rust-project.prose),
// and how a project is refused. Against a search folder of the pinned tool
// (results/fixtures/example) held in memory; the Rust side has its own tests (src-tauri/tests/history.rs).

import { strToU8, zipSync } from 'fflate'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { OldLayoutError, RUNS } from '../results/read'
import type { OpenResult } from '../search/session.svelte'
import {
  countPsms,
  exportProject,
  frameEntries,
  importProject,
  importProjectBytes,
  isPlainName,
  MAX_UNPACKED,
  MAX_ZIP_ENTRIES,
  openSearch,
  parseRecord,
  ProjectError,
  ProjectVersionError,
  proteinsFasta,
  projectFileName,
  psmsOfSearch,
  recordOf,
  saveSearch,
  unpackProject,
} from './history'
import { exampleFolder, exampleResult } from './fixtures'
import { MemoryBackend, unframe } from './memory-backend'

let fixture: Record<string, Uint8Array>
let result: OpenResult

beforeAll(async () => {
  fixture = exampleFolder()
  result = await exampleResult(fixture)
}, 60000)

/** A backend with the example searched as `id` and saved to History. */
async function savedBackend(id = '100-0', name = 'Example') {
  const backend = new MemoryBackend()
  backend.addFolder(id, fixture)
  await saveSearch(backend, { ...result, id }, name, '3.6.0')
  return backend
}

describe('the record', () => {
  test('search.json holds the fields of schema 1', () => {
    const record = recordOf(result, 'Example', '3.6.0')
    expect(Object.keys(record).sort()).toEqual(
      ['appVersion', 'createdAt', 'database', 'design', 'files', 'id', 'name', 'proteinFdr', 'psmFdr', 'psms', 'schema', 'seconds', 'settings', 'toolVersion'],
    )
    expect(record).toMatchObject({
      schema: 1,
      id: '100-0',
      name: 'Example',
      createdAt: '2026-10-20T10:00:00.000Z',
      toolVersion: '3.6.0',
      files: ['Ecoli_1.mzML', 'Ecoli_2.mzML'],
      database: 'human.fasta',
      psms: countPsms(result.outcome.tables, 0.02),
      seconds: 12.5,
    })
    expect(record.psms).toBeGreaterThan(0)
    expect(record.appVersion).toMatch(/^\d+\.\d+\.\d+/)
    // a stored result keeps the versions that made it
    const stored = recordOf({ ...result, stored: { name: 'x', appVersion: '0.0.9', moduleVersion: '3.5.0' } }, 'y', '3.6.0')
    expect([stored.appVersion, stored.toolVersion]).toEqual(['0.0.9', '3.5.0'])
    expect(parseRecord(JSON.stringify(record))).toEqual(JSON.parse(JSON.stringify(record)))
  })

  test('a record that is incomplete or of another kind is refused with a message', () => {
    const good = JSON.parse(JSON.stringify(recordOf(result, 'x', '1')))
    const refuse = (change: (r: Record<string, unknown>) => void, message: RegExp) => {
      const r = JSON.parse(JSON.stringify(good))
      change(r)
      expect(() => parseRecord(JSON.stringify(r))).toThrow(message)
    }
    expect(() => parseRecord('{ not json')).toThrow(/not valid JSON/)
    expect(() => parseRecord('[1]')).toThrow(/not a search record/)
    refuse((r) => delete r.schema, /no schema/)
    refuse((r) => (r.schema = 0), /unknown schema 0/)
    refuse((r) => delete r.design, /design is missing/)
    refuse((r) => delete r.settings, /settings is missing/)
    refuse((r) => (r.psmFdr = 'x'), /psmFdr is missing/)
    refuse((r) => delete r.name, /name is missing/)
  })

  test('a newer schema is refused with a message', () => {
    const newer = JSON.stringify({ ...recordOf(result, 'x', '1'), schema: 2 })
    expect(() => parseRecord(newer)).toThrow(ProjectVersionError)
    expect(() => parseRecord(newer)).toThrow(/saved by a newer version of ProSE \(schema 2\).*reads schema 1/)
    expect(() => parseRecord(newer, 'project')).toThrow(/This project was saved by a newer version/)
    expect(() => parseRecord(newer)).toThrow(/This search was saved by a newer version/)
  })
})

describe('proteins.fasta', () => {
  test('lists every protein of the table, decoys as searched', async () => {
    // (the web app's example: its result has decoy proteins, the app's example none)
    const { tables } = (await exampleResult(exampleFolder('suitability'))).outcome
    const { proteins } = tables
    const fasta = proteinsFasta(tables)
    const lines = fasta.trimEnd().split('\n')
    expect(lines.length).toBe(2 * proteins.count)
    expect(proteins.count).toBeGreaterThan(10)
    for (let p = 0; p < proteins.count; p++) {
      const head = proteins.description[p] ? `${proteins.accession[p]} ${proteins.description[p]}` : proteins.accession[p]
      expect(lines[2 * p]).toBe(`>${head}`)
      expect(lines[2 * p + 1]).toBe(proteins.sequence[p])
    }
    // decoys are in it, with their generated sequences
    const decoy = [...proteins.decoy].findIndex((d) => d === 1)
    expect(decoy).toBeGreaterThanOrEqual(0)
    expect(proteins.sequence[decoy].length).toBeGreaterThan(0)
    expect(fasta).toContain(`>${proteins.accession[decoy]}`)
  })

  test('is one entry per protein even with line ends in a description', () => {
    const tables = structuredClone(result.outcome.tables)
    tables.proteins.description[0] = 'a\nb\r\nc'
    const lines = proteinsFasta(tables).trimEnd().split('\n')
    expect(lines.length).toBe(2 * tables.proteins.count)
    expect(lines[0]).toBe(`>${tables.proteins.accession[0]} a b c`)
  })

  test('is empty without proteins', () => {
    const tables = structuredClone(result.outcome.tables)
    tables.proteins.count = 0
    expect(proteinsFasta(tables)).toBe('')
  })
})

describe('a saved search', () => {
  test('is a folder with proteins.fasta and search.json that opens again', async () => {
    const backend = await savedBackend()
    const folder = backend.folders.get('100-0')!
    expect(folder.has('search.json') && folder.has('proteins.fasta')).toBe(true)
    const opened = await openSearch(backend, '100-0')
    expect(opened.origin).toEqual({ id: '100-0', createdAt: '2026-10-20T10:00:00.000Z' })
    expect(opened.result.outcome.tables).toEqual(result.outcome.tables)
    expect(opened.result.outcome.seconds).toBe(12.5)
    expect(opened.result.stored).toEqual({ name: 'Example', appVersion: recordOf(result, '', '').appVersion, moduleVersion: '3.6.0' })
    expect(opened.result.settings).toEqual(result.settings)
    expect(opened.result.design).toEqual(JSON.parse(JSON.stringify(result.design)))
    expect([opened.result.psmFdr, opened.result.proteinFdr]).toEqual([0.02, 0.01])
  })

  test('a search of the earlier layout (summary.yaml, no QPX columns) does not open, with a message that says why', async () => {
    const backend = await savedBackend()
    const folder = backend.folders.get('100-0')!
    for (const name of [...folder.keys()]) if (name.startsWith('qpx/')) folder.delete(name)
    folder.set('summary.yaml', strToU8('shared:\n  enzyme: "Trypsin"\nper_file: []\n'))
    await expect(openSearch(backend, '100-0')).rejects.toBeInstanceOf(OldLayoutError)
    await expect(openSearch(backend, '100-0')).rejects.toThrow(/saved by an earlier version of ProSE Desktop/)
  })

  test('the PSMs of a search come from its QPX run view', async () => {
    const backend = new MemoryBackend()
    backend.addFolder('7-0', fixture)
    const asked: string[] = []
    const read = backend.read.bind(backend)
    backend.read = async (id, name, range) => {
      asked.push(name)
      return read(id, name, range)
    }
    // 77 target PSMs in each of the example's two files
    expect(await psmsOfSearch(backend, '7-0')).toBe(154)
    expect(asked).toEqual([RUNS])
    await expect(psmsOfSearch(backend, 'missing')).rejects.toThrow()
    backend.folders.get('7-0')!.set(RUNS, strToU8('not parquet'))
    await expect(psmsOfSearch(backend, '7-0')).rejects.toThrow(`${RUNS}:`)
  })

  test('opens when the FASTA it was searched with is gone: proteins.fasta has the sequences', async () => {
    const backend = await savedBackend()
    const folder = backend.folders.get('100-0')!
    // the folder's own database copy is gone too (and the path of the footer was never served)
    folder.delete('database.fasta')
    const opened = await openSearch(backend, '100-0')
    expect(opened.result.outcome.warnings).toEqual(result.outcome.warnings)
    expect(opened.result.outcome.tables.proteins).toEqual(result.outcome.tables.proteins)
  })

  test('a folder with a record of a newer schema or no record does not open', async () => {
    const backend = await savedBackend()
    const folder = backend.folders.get('100-0')!
    folder.set('search.json', strToU8(JSON.stringify({ ...recordOf(result, 'x', '1'), schema: 7 })))
    await expect(openSearch(backend, '100-0')).rejects.toThrow(/newer version of ProSE \(schema 7\)/)
    folder.delete('search.json')
    await expect(openSearch(backend, '100-0')).rejects.toThrow(ProjectError)
  })
})

/** A copy of a zip with the bytes of one name replaced by another of the same length. */
function renamed(zip: Uint8Array, from: string, to: string): Uint8Array {
  const a = strToU8(from)
  const b = strToU8(to)
  const out = zip.slice()
  for (let i = 0; i + a.length <= out.length; i++) {
    if (a.every((byte, k) => out[i + k] === byte)) out.set(b, i)
  }
  return out
}

describe('project files', () => {
  test('a project round-trips (export, import, same tables)', async () => {
    const backend = await savedBackend('100-0', 'My search')
    expect(await exportProject(backend, '100-0', 'My search')).toBe('/saved/My_search.prose')
    const [{ name, bytes }] = backend.saved
    expect(name).toBe('My_search.prose')
    // a zip of the folder's files, search.json first, no links, no database copy
    const zipped = unpackProject(bytes)
    expect(zipped[0].name).toBe('search.json')
    expect(zipped.map((e) => e.name).sort()).toEqual([...backend.folders.get('100-0')!.keys()].filter((n) => n !== 'database.fasta').sort())

    // another computer: a fresh backend, the file chosen in the open dialog
    const other = new MemoryBackend()
    other.projects.set('/home/me/My_search.prose', bytes)
    other.chosen = '/home/me/My_search.prose'
    const id = await importProject(other)
    expect(id).not.toBeNull()
    expect(id).not.toBe('100-0')
    const [entry] = await other.list()
    expect(entry).toMatchObject({ id, name: 'My search', files: ['Ecoli_1.mzML', 'Ecoli_2.mzML'], database: 'human.fasta', error: null })
    // the FASTA was not exported: the sequences come from proteins.fasta
    expect(other.folders.get(id!)!.has('database.fasta')).toBe(false)
    const opened = await openSearch(other, id!)
    // the same tables; the searched files are named, not placed (the paths of the other computer are not in the project)
    const named = (files: string[]) => files.map((f) => f.split('/').pop())
    expect(opened.result.outcome.tables).toEqual({ ...result.outcome.tables, files: named(result.outcome.tables.files) })
    expect(opened.result.outcome.tables.files).toEqual(['Ecoli_1.mzML', 'Ecoli_2.mzML'])
    // the spectra are read when a PSM is opened: the same peaks
    const [a, b] = [await opened.result.outcome.spectra.load(5), await result.outcome.spectra.load(5)]
    expect(a.spectra.mz).toEqual(b.spectra.mz)
    expect(a.predicted).toEqual(b.predicted)
    expect(opened.result.outcome.summary.files.map((f) => f.path)).toEqual(['Ecoli_1.mzML', 'Ecoli_2.mzML'])
    expect({ ...opened.result.outcome.summary, files: [] }).toEqual({ ...result.outcome.summary, files: [] })
    expect(opened.origin.id).toBe(id)
    expect(opened.result.stored?.name).toBe('My search')
    // the imported search is marked, and the database path of its footer is refused (not "not found"):
    // the reader goes on with proteins.fasta and has no warning
    expect(JSON.parse(new TextDecoder().decode(other.folders.get(id!)!.get('search.json')!)).imported).toBe(true)
    await expect(other.read(id!, '/tmp/prose-fixture-rouhIU/search/database.fasta')).rejects.toThrow(/imported search reads only its own folder/)
    expect(opened.result.outcome.warnings).toEqual(result.outcome.warnings)
  })

  test('a project does not carry the database copy or the paths of this computer', async () => {
    const backend = await savedBackend()
    backend.folders.get('100-0')!.set('prose.log', strToU8('$ /home/me/ProSE -in /home/me/data/a.mzML'))
    // (saving the proteins removed database.fasta; a folder still has it before its results are read)
    expect(backend.folders.get('100-0')!.has('database.fasta')).toBe(false)
    backend.folders.get('100-0')!.set('database.fasta', strToU8('>sp|P1|X\nPEPTIDE\n'))
    await exportProject(backend, '100-0', 'x')
    const files = Object.fromEntries(unpackProject(backend.saved[0].bytes).map((e) => [e.name, e.data]))
    expect(Object.keys(files)).not.toContain('database.fasta')
    expect(Object.keys(files)).not.toContain('prose.log')
    expect(Object.keys(files)).toContain('proteins.fasta')
    const inputs = JSON.parse(new TextDecoder().decode(files['inputs.json']))
    expect(inputs.map((r: { path: string; name: string }) => r.path)).toEqual(['Ecoli_1.mzML', 'Ecoli_2.mzML'])
    expect(JSON.stringify(inputs)).not.toContain('/data/')
    // the other fields of the records stay (the reader uses them)
    expect(inputs[0]).toMatchObject({ id: 'f1', index: 0, link: '1__Ecoli_1.mzML', stem: '1__Ecoli_1' })
    // the folder itself is untouched
    expect(new TextDecoder().decode(backend.folders.get('100-0')!.get('inputs.json'))).toContain('/data/Ecoli_1.mzML')
    // an inputs.json that is not a list stops the export
    backend.folders.get('100-0')!.set('inputs.json', strToU8('{"a":1}'))
    await expect(exportProject(backend, '100-0', 'x')).rejects.toThrow(/inputs.json/)
    backend.folders.get('100-0')!.set('inputs.json', strToU8('nope'))
    await expect(exportProject(backend, '100-0', 'x')).rejects.toThrow(/inputs.json/)
  })

  test('a search too large for a project file is refused before anything is read or zipped', async () => {
    const backend = await savedBackend()
    const read = vi.spyOn(backend, 'read')
    const files = backend.files.bind(backend)
    // results of more than the 3 GB a project opens with (and so near the 4 GB a zip without zip64 holds)
    backend.files = async (id: string) => [...(await files(id)), { name: 'qpx/huge.psm.parquet', size: MAX_UNPACKED }]
    await expect(exportProject(backend, '100-0', 'x')).rejects.toThrow(
      /too large for a project file: its results take 3\.\d+ GB, and a project file holds at most 3\.\d+ GB/,
    )
    expect(read).not.toHaveBeenCalled()
    expect(backend.saved).toEqual([])
    // the files left out of a project do not count (prose.log, database.fasta)
    backend.files = async (id: string) => [...(await files(id)), { name: 'database.fasta', size: MAX_UNPACKED }]
    expect(await exportProject(backend, '100-0', 'x')).toBe('/saved/x.prose')
    // a project of more files than a zip without zip64 holds
    backend.files = async () => Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: i === 0 ? 'search.json' : `f/${i}`, size: 1 }))
    await expect(exportProject(backend, '100-0', 'x')).rejects.toThrow(/its results take 65536 files/)
  })

  test('the project of a search that is not saved is refused', async () => {
    const backend = new MemoryBackend()
    backend.addFolder('1-0', fixture)
    await expect(exportProject(backend, '1-0', 'x')).rejects.toThrow(/not saved to History/)
    expect(backend.saved).toEqual([])
  })

  test('a cancelled save dialog or open dialog does nothing', async () => {
    const backend = await savedBackend()
    backend.cancelSave = true
    expect(await exportProject(backend, '100-0', 'x')).toBeNull()
    expect(await importProject(backend)).toBeNull()
    expect(backend.imported).toBe(0)
  })

  test('parquet is stored, the rest deflated', async () => {
    const backend = await savedBackend()
    await exportProject(backend, '100-0', 'x')
    const bytes = backend.saved[0].bytes
    // the method of each local entry: 0 stored, 8 deflated
    const view = new DataView(bytes.buffer, bytes.byteOffset)
    const methods = new Map<string, number>()
    for (let at = 0; at + 30 < bytes.length && view.getUint32(at, true) === 0x04034b50; ) {
      const method = view.getUint16(at + 8, true)
      const compressed = view.getUint32(at + 18, true)
      const nameLength = view.getUint16(at + 26, true)
      const extra = view.getUint16(at + 28, true)
      methods.set(new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength)), method)
      at += 30 + nameLength + extra + compressed
    }
    expect(methods.get('qpx/runs/1__Ecoli_1.psm.parquet')).toBe(0)
    expect(methods.get('inputs.json')).toBe(8)
  })

  test('the export says how far it is', async () => {
    const backend = await savedBackend()
    const seen: number[] = []
    await exportProject(backend, '100-0', 'x', (f) => seen.push(f))
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.at(-1)).toBe(1)
  })

  test("a project the Rust side wrote opens (src-tauri/tests/project.rs makes it, entry by entry)", async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/rust-project.prose', import.meta.url)))
    const entries = unpackProject(bytes)
    const files = Object.fromEntries(entries.map((e) => [e.name, new TextDecoder().decode(e.data)]))
    // the record first, the rest by name; without the database copy, its path and the log
    expect(entries.map((e) => e.name)).toEqual([
      'search.json',
      'empty.txt',
      'inputs.json',
      'mods/1__a_PTMStats.tsv',
      'proteins.fasta',
      'qpx/quantms.psm.parquet',
      'qpx/runs/1__a.mz.parquet',
    ])
    expect(parseRecord(files['search.json'], 'project').name).toBe('Fixture')
    expect(JSON.parse(files['inputs.json']).map((r: { path: string }) => r.path)).toEqual(['a.mzML', 'b.mzML'])
    expect(files['proteins.fasta']).toBe('>P1 first protein\nPEPTIDEKPEPTIDEKPEPTIDEK\n'.repeat(50))
    expect(files['mods/1__a_PTMStats.tsv']).toBe('name\tcount\nOxidation\t3\n')
    expect(files['empty.txt']).toBe('')
    const parquet = entries.find((e) => e.name === 'qpx/quantms.psm.parquet')!.data
    expect(parquet.length).toBe(20000)
    expect(new DataView(parquet.buffer, parquet.byteOffset).getUint32(4 * 4999, true)).toBe(4999 * 7919)
    // and becomes a search of History
    const backend = new MemoryBackend()
    const id = await importProjectBytes(backend, bytes)
    expect((await backend.list())[0]).toMatchObject({ id, name: 'Fixture', files: ['a.mzML', 'b.mzML'], error: null })
  })

  test('a newer schema is refused with a message, and nothing is written', async () => {
    const newer = zipSync({ 'search.json': strToU8(JSON.stringify({ ...recordOf(result, 'x', '1'), schema: 2 })), 'a.txt': strToU8('x') })
    const backend = new MemoryBackend()
    await expect(importProjectBytes(backend, newer)).rejects.toThrow(/This project was saved by a newer version of ProSE \(schema 2\)/)
    await expect(importProjectBytes(backend, newer)).rejects.toBeInstanceOf(ProjectVersionError)
    expect(backend.imported).toBe(0)
  })

  const record = () => JSON.stringify(recordOf(result, 'x', '1'))

  test('something that is not a project is refused with a message', async () => {
    const backend = new MemoryBackend()
    await expect(importProjectBytes(backend, strToU8('hello, this is text and not a zip file at all'))).rejects.toThrow(/not a zip file/)
    await expect(importProjectBytes(backend, new Uint8Array(0))).rejects.toThrow(/not a zip file/)
    const damaged = zipSync({ 'search.json': strToU8('x'.repeat(1000)) })
    damaged.fill(0xff, damaged.length - 40, damaged.length - 22) // the central directory
    await expect(importProjectBytes(backend, damaged)).rejects.toThrow(ProjectError)
    await expect(importProjectBytes(backend, zipSync({ 'a.txt': strToU8('x') }))).rejects.toThrow(/no search.json/)
    await expect(importProjectBytes(backend, zipSync({ 'search.json': strToU8('{ no') }))).rejects.toThrow(/not valid JSON/)
    await expect(importProjectBytes(backend, zipSync({ 'search.json': strToU8('{}') }))).rejects.toThrow(/no schema/)
    expect(backend.imported).toBe(0)
  })

  test('names outside the folder are refused before anything is written', async () => {
    const backend = new MemoryBackend()
    const bad = ['../escape.txt', 'a/../../escape.txt', '/etc/passwd', 'a//b', './a', 'a/./b', 'a\\b', 'C:evil', 'with\nnewline']
    for (const name of bad) {
      const zip = zipSync({ 'search.json': strToU8(record()), [name]: strToU8('x') })
      await expect(importProjectBytes(backend, zip), name).rejects.toThrow(/not a plain name/)
    }
    // a file that is also a folder
    const clash = zipSync({ 'search.json': strToU8(record()), a: strToU8('x'), 'a/b': strToU8('y') })
    await expect(importProjectBytes(backend, clash)).rejects.toThrow(/as a file and as a folder/)
    expect(backend.imported).toBe(0)
    // plain names, folders included, are fine
    expect(unpackProject(zipSync({ 'search.json': strToU8(record()), 'qpx/a b.parquet': strToU8('x'), 'mods/deep/x.txt': strToU8('y') })).length).toBe(3)
  })

  test('a link in the zip is refused', async () => {
    // a zip as `zip -y` makes it: the link's entry is made on Unix with the mode of a symbolic link
    const zip = zipSync({ 'search.json': strToU8(record()), link: [strToU8('/etc/passwd'), { os: 3, attrs: 0o120777 << 16 }] })
    expect(() => unpackProject(zip)).toThrow(/contains a link/)
    // a regular file made on Unix is fine
    const fine = zipSync({ 'search.json': [strToU8(record()), { os: 3, attrs: 0o100644 << 16 }] })
    expect(unpackProject(fine).length).toBe(1)
  })

  test('a name twice in the zip is refused', () => {
    const zip = zipSync({ 'search.json': strToU8(record()), 'a1.txt': strToU8('one'), 'a2.txt': strToU8('two') })
    // the second entry renamed to the first's name, in its local and its central header
    const twice = renamed(zip, 'a2.txt', 'a1.txt')
    expect(() => unpackProject(twice)).toThrow(/twice/)
    expect(() => unpackProject(zip)).not.toThrow()
  })

  test('a zip64 locator is refused: the two readers could take different directories', () => {
    const zip = zipSync({ 'search.json': strToU8(record()) })
    const eocd = zip.length - 22
    const locator = new Uint8Array(20)
    new DataView(locator.buffer).setUint32(0, 0x07064b50, true)
    const withLocator = new Uint8Array(zip.length + 20)
    withLocator.set(zip.subarray(0, eocd))
    withLocator.set(locator, eocd)
    withLocator.set(zip.subarray(eocd), eocd + 20)
    expect(() => unpackProject(withLocator)).toThrow(/zip64/)
    // the counts of an end record that points to zip64 data likewise
    const big = zip.slice()
    new DataView(big.buffer).setUint16(eocd + 10, 0xffff, true)
    expect(() => unpackProject(big)).toThrow(/zip64/)
  })

  test('the size limit counts what the zip declares, entry by entry, and what comes out', () => {
    const zip = zipSync({ 'search.json': strToU8(record()), 'a.bin': new Uint8Array(5000), 'b.bin': new Uint8Array(5000) })
    expect(unpackProject(zip, 20000).length).toBe(3)
    expect(() => unpackProject(zip, 9000)).toThrow(/more than/)
    // one entry alone is within it, the sum is not
    expect(() => unpackProject(zip, record().length + 5000 + 100)).toThrow(/more than/)
  })

  test('non-ASCII names (UTF-8 flagged, as the app writes them) read the same in both readers', () => {
    const zip = zipSync({ 'search.json': strToU8(record()), 'qpx/ü ö.parquet': strToU8('x') })
    expect(unpackProject(zip).map((e) => e.name).sort()).toEqual(['qpx/ü ö.parquet', 'search.json'])
  })

  test('folders in the zip are skipped, not written', () => {
    const zip = zipSync({ 'search.json': strToU8(record()), 'qpx/': new Uint8Array(0), 'qpx/a.txt': strToU8('x') })
    expect(unpackProject(zip).map((e) => e.name).sort()).toEqual(['qpx/a.txt', 'search.json'])
  })

  test('plain names: the rule of the Rust side', () => {
    for (const ok of ['a', 'a/b.parquet', 'qpx/1__a b.psm.parquet', 'ü/ö']) expect(isPlainName(ok), ok).toBe(true)
    for (const bad of ['', '/a', 'a/', '..', 'a/..', '.', 'a/./b', 'a//b', 'a\\b', 'c:/x', 'a\u0000b', 'a\u007fb', 'a\u0085b']) {
      expect(isPlainName(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  test('project names are reduced to safe file names', () => {
    expect(projectFileName('My search #1')).toBe('My_search_1.prose')
    expect(projectFileName('../etc/passwd')).toBe('etc_passwd.prose')
    expect(projectFileName('???')).toBe('prose-results.prose')
    expect(projectFileName('Probe Größe ä ö ü')).toBe('Probe_Größe_ä_ö_ü.prose')
    expect(projectFileName('蛋白质组 a:b')).toBe('蛋白质组_a_b.prose')
    expect(projectFileName('DatabaseSuitability.v2')).toBe('DatabaseSuitability.v2.prose')
  })

  test('the entries are framed as the Rust side reads them', () => {
    // the same bytes as the Rust test `frames_have_a_fixed_layout`
    expect([...frameEntries([{ name: 'ab', data: strToU8('xyz') }])]).toEqual([0, 0, 0, 2, 97, 98, 0, 0, 0, 0, 0, 0, 0, 3, 120, 121, 122])
    const entries = [
      { name: 'search.json', data: strToU8('{}') },
      { name: 'qpx/ü.parquet', data: new Uint8Array([0, 255, 7]) },
      { name: 'empty', data: new Uint8Array(0) },
    ]
    expect(unframe(frameEntries(entries))).toEqual(entries)
  })
})
