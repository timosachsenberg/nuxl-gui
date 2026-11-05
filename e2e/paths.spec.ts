// Inputs by path, as the file manager would hand them over: names with spaces and umlauts, names whose lower case is
// longer, two inputs of the same name from different folders, and an mzML.gz (which OpenNuXL cannot read: refused
// with its message). The example's run and FASTA are copied into folders made for the spec; the app reads them where
// they are. They are searched with the example's precursor tolerance, set by hand (lib.ts exampleSettings).
// With the fake tools (NUXL_FAKE=1) also a Thermo .raw file and a Bruker timsTOF .d folder (stand-ins: lib.ts fakeRaw,
// fakeTimsD; the fake OpenNuXL searches them as the example and writes the example's QPX mz view as theirs, -out_qpx),
// and what is refused of them: a .d without timsTOF data, a Waters .raw folder, a zipped .d.
// Gated: runs only with NUXL_TOOL set (the app inherits it; NUXL_FAKE=1 sets it to the stand-in, e2e/run.sh).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  appReady,
  clearSearches,
  countOf,
  dataHome,
  dropFiles,
  EXAMPLE_FASTA as FASTA,
  EXAMPLE_MZML as MZML,
  EXAMPLE_PROTEINS,
  EXAMPLE_PSMS,
  exampleSettings,
  FAKE,
  fakeRaw,
  fakeTimsD,
  goTo,
  openFirstPsm,
  searchesDir,
  searchFolders,
  textOf,
  waitForResults,
} from './lib.ts'

const enabled = Boolean(process.env.NUXL_TOOL)

describe('inputs by path', () => {
  let work: string
  let umlautRun: string
  let umlautFasta: string

  before(async function () {
    if (!enabled) {
      console.log('skipped: set NUXL_TOOL (or NUXL_FAKE=1) to run searches through the app')
      this.skip()
    }
    work = mkdtempSync(join(tmpdir(), 'nuxl-e2e-paths-'))
    const dir = join(work, 'Ünï cödé Ordner mit Leerzeichen', 'Läufe 2026')
    mkdirSync(dir, { recursive: true })
    umlautRun = join(dir, 'Probe Größe ä ö ü.mzML')
    umlautFasta = join(dir, 'Datenbank (Süß).fasta')
    copyFileSync(MZML, umlautRun)
    copyFileSync(FASTA, umlautFasta)
    await appReady()
  })

  afterEach(() => clearSearches())

  after(() => {
    if (work) rmSync(work, { recursive: true, force: true })
  })

  /** Drops the paths on New search, starts the search and returns its PSM count. */
  async function search(paths: string[], fileName: string): Promise<number> {
    await exampleSettings()
    await dropFiles(paths)
    // the table lists the file (one file has no design summary)
    await browser.waitUntil(async () => (await textOf('[data-testid="design-scroll"]')).includes(fileName), {
      timeoutMsg: `${fileName} is not in the table`,
    })
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
    await $('button*=Start search').click()
    await waitForResults()
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
    return countOf('psm-count')
  }

  it('paths with spaces and umlauts', async () => {
    const count = await search([umlautRun, umlautFasta], 'Probe Größe ä ö ü.mzML')
    expect(count).toBeGreaterThan(0)
    if (EXAMPLE_PSMS) expect(count).toBe(EXAMPLE_PSMS.psms)
    // the result's name keeps the letters: spaces become "_" and the umlauts stay
    expect(await textOf('[data-testid="result-chip"]')).toContain('Probe_Größe_ä_ö_ü · 1 file')
    await goTo('History')
    const row = $('[data-testid="history-row"]')
    await row.waitForDisplayed()
    expect(await textOf('[data-testid="history-row"] [data-column="name"]')).toBe('Probe_Größe_ä_ö_ü')
    // the file keeps its name as it is
    expect(await textOf('[data-testid="history-row"] [data-column="files"]')).toBe('Probe Größe ä ö ü.mzML')
    // nothing was written next to the inputs
    expect(readFileSync(umlautRun).length).toBe(readFileSync(MZML).length)
    expect(readdirSync(dirname(umlautRun)).sort()).toEqual(['Datenbank (Süß).fasta', 'Probe Größe ä ö ü.mzML'])
    expect(searchFolders().partial).toEqual([])
  })

  it('an mzML.gz is refused with what to do instead (OpenNuXL reads plain mzML only)', async () => {
    const gz = join(work, 'Probe Größe ä ö ü.mzML.gz')
    writeFileSync(gz, gzipSync(readFileSync(MZML)))
    await exampleSettings()
    await dropFiles([gz, umlautFasta])
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
    const notice = 'Probe Größe ä ö ü.mzML.gz is compressed. OpenNuXL reads plain mzML only: decompress it first (e.g. with gunzip), then add the .mzML.'
    await browser.waitUntil(async () => (await browser.execute(() => document.body.textContent ?? '')).includes(notice), {
      timeout: 10000,
      timeoutMsg: 'no notice of the compressed file',
    })
    // the file is not added: no spectra, nothing to start
    await expect($('button=Try the example')).toBeDisplayed()
    expect(await textOf('[data-testid="search-plan"]')).toBe('No spectra yet')
    await expect($('button*=Start search')).toBeDisabled()
    expect(searchFolders()).toEqual({ finished: [], partial: [] })
  })

  it('names whose lower case is longer (İ, Ⱥ) keep their PSMs, and one file exports its idXML', async () => {
    // the stem of such a name was cut at the lower-cased copy's offsets, and the reader found no PSMs
    const plainCount = await search([umlautRun, umlautFasta], 'Probe Größe ä ö ü.mzML')
    const odd = join(work, 'İstanbul Ⱥ run.mzML')
    copyFileSync(MZML, odd)
    const count = await search([odd, umlautFasta], 'İstanbul Ⱥ run.mzML')
    expect(count).toBe(plainCount)
    expect(count).toBeGreaterThan(0)
    // Export > idXML: the file's own idXML (every PSM of its OpenNuXL run)
    const chosen = join(dataHome(), 'chosen.nuxl')
    rmSync(chosen, { force: true })
    await $('header').$('button*=Export').click()
    await $('[role="menuitem"]=idXML').click()
    await browser.waitUntil(() => existsSync(chosen) && readFileSync(chosen).length > 0, { timeoutMsg: 'no idXML was written' })
    const idxml = readFileSync(chosen, 'utf8')
    expect(idxml).toContain('<IdXML')
    expect(idxml).toContain('<PeptideHit')
    rmSync(chosen, { force: true })
  })

  it('two inputs of the same name are searched and kept apart', async () => {
    const first = join(work, 'erste Ablage')
    const second = join(work, 'zweite Ablage')
    mkdirSync(first)
    mkdirSync(second)
    copyFileSync(MZML, join(first, 'Lauf.mzML'))
    copyFileSync(MZML, join(second, 'Lauf.mzML'))
    await exampleSettings()
    await dropFiles([join(first, 'Lauf.mzML'), join(second, 'Lauf.mzML'), umlautFasta])
    await expect($('[data-testid="design-summary"]')).toHaveText(expect.stringContaining('2 files'))
    // the table tells them apart by their folders
    const folders = (
      await browser.execute(() => [...document.querySelectorAll('[data-testid="file-folder"]')].map((f) => f.textContent ?? ''))
    ).join(' ')
    expect(folders).toContain('erste Ablage')
    expect(folders).toContain('zweite Ablage')
    await $('button*=Start search').click()
    const id = await waitForResults()
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
    // one run per file, each with its own outputs (the stems are told apart by their position: 1__Lauf, 2__Lauf)
    const outputs = readdirSync(join(searchesDir(), id, 'nuxl'))
    expect(outputs.filter((f) => f.endsWith('.outputs.json')).sort()).toEqual(['1__Lauf.outputs.json', '2__Lauf.outputs.json'])
    // two copies of the run give twice its PSMs
    if (EXAMPLE_PSMS) expect(await countOf('psm-count')).toBe(2 * EXAMPLE_PSMS.psms)
    expect(await textOf('[data-testid="result-chip"]')).toContain('2 files')
  })

  describe('Thermo .raw and Bruker .d inputs (the fake tools)', () => {
    before(function () {
      if (!FAKE) {
        console.log('skipped: the .raw and .d inputs are stand-ins that only the fake tools read (NUXL_FAKE=1)')
        this.skip()
      }
    })

    it('a .raw file and a .d folder are searched; the spectra of their PSMs are kept for the PSM view, nothing written beside them', async () => {
      const dir = join(work, 'Rohdaten mit Leerzeichen ä')
      const raw = fakeRaw(join(dir, 'Lauf 1.raw'))
      const tims = fakeTimsD(join(dir, 'Lauf 2.d'))
      await exampleSettings()
      // the .d as a folder dialog or a file manager may give it: with a trailing separator
      await dropFiles([raw, `${tims}/`, umlautFasta])
      await expect($('[data-testid="design-summary"]')).toHaveText(expect.stringContaining('2 files'))
      const table = await textOf('[data-testid="design-scroll"]')
      expect(table).toContain('Lauf 1.raw')
      expect(table).toContain('Lauf 2.d')
      await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
      await $('button*=Start search').click()
      const id = await waitForResults()
      await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
      // (the fake searches each as the example)
      if (EXAMPLE_PSMS) expect(await countOf('psm-count')).toBe(2 * EXAMPLE_PSMS.psms)
      expect(await textOf('[data-testid="result-chip"]')).toContain('2 files')

      // the shim's record: per input the QPX mz view of its PSMs' spectra (outputs.json `mz`), which OpenNuXL wrote
      // (-out_qpx) into nuxl/runs/ and the shim moved to the input's stem
      const folder = join(searchesDir(), id)
      const records = JSON.parse(readFileSync(join(folder, 'inputs.json'), 'utf8')) as { stem: string; name: string; path: string }[]
      expect(records.map((r) => [r.name, r.path])).toEqual([
        ['Lauf 1.raw', raw],
        ['Lauf 2.d', tims],
      ])
      for (const r of records) {
        expect(r.stem).not.toMatch(/\.(raw|d)$/i)
        const outputs = JSON.parse(readFileSync(join(folder, 'nuxl', `${r.stem}.outputs.json`), 'utf8'))
        expect(outputs.mz).toBe(`nuxl/${r.stem}.mz.parquet`)
        expect(outputs.spectra).toBeUndefined()
        expect(readFileSync(join(folder, outputs.mz)).subarray(0, 4).toString()).toBe('PAR1')
        const argv = readFileSync(join(folder, 'nuxl', `${r.stem}.argv.txt`), 'utf8').split('\n')
        expect(argv[argv.indexOf('-out_qpx') + 1]).toBe(join(folder + '.partial', 'nuxl'))
      }
      expect(existsSync(join(folder, 'nuxl', 'runs'))).toBe(false)
      // nothing was written next to the inputs, nor into the .d
      expect(readdirSync(dir).sort()).toEqual(['Lauf 1.raw', 'Lauf 2.d'])
      expect(readdirSync(tims).sort()).toEqual(['analysis.tdf', 'analysis.tdf_bin'])
      expect(searchFolders().partial).toEqual([])

      // the PSM view reads the peaks from the mz view
      await openFirstPsm()
      await expect($('[data-testid="psm-crosslink"]')).toBeDisplayed()
      expect(await $$('[data-testid="peaks-missing-note"]')).toHaveLength(0)
      const sticks = String(await $('[data-testid="unmatched-peaks"]').getAttribute('d'))
      expect(new Set([...sticks.matchAll(/V(-?[\d.]+)/g)].map((m) => m[1])).size).toBeGreaterThan(5)
    })

    it('a .d dropped as its analysis.tdf joins as the folder; a .d without timsTOF data, a Waters .raw folder and a zipped .d are refused', async () => {
      const dir = join(work, 'Abgelehnt')
      const tims = fakeTimsD(join(dir, 'tims.d'))
      const agilent = join(dir, 'agilent.d')
      mkdirSync(join(agilent, 'AcqData'), { recursive: true })
      writeFileSync(join(agilent, 'AcqData', 'MSScan.bin'), 'x')
      const waters = join(dir, 'waters.raw')
      mkdirSync(waters, { recursive: true })
      writeFileSync(join(waters, '_FUNC001.DAT'), 'x')
      const zipped = join(dir, 'tims.d.zip')
      writeFileSync(zipped, 'PK')
      await exampleSettings()
      await dropFiles([join(tims, 'analysis.tdf'), agilent, waters, zipped, umlautFasta])
      await expect($('[data-testid="design-summary"]')).toHaveText(expect.stringContaining('3 files'))
      const body = async () => String(await browser.execute(() => document.body.textContent ?? ''))
      // the zipped .d is not added; New search says what to do
      const unzip = 'tims.d.zip is a zipped Bruker .d folder: unzip it first, then add the .d folder.'
      await browser.waitUntil(async () => (await body()).includes(unzip), { timeout: 10000, timeoutMsg: 'no notice of the zipped .d' })
      const table = await textOf('[data-testid="design-scroll"]')
      expect(table).toContain('tims.d')
      expect(table).not.toContain('analysis.tdf')
      // the shim's problems of the folders that are no timsTOF data and no Thermo file: they join marked, and the
      // search cannot start
      const text = await body()
      expect(text).toContain('agilent.d is not a Bruker timsTOF .d folder (no analysis.tdf or analysis.tsf).')
      expect(text).toContain('waters.raw is a folder, not a Thermo .raw file')
      await expect($('button*=Start search')).toBeDisabled()
      expect(searchFolders()).toEqual({ finished: [], partial: [] })
    })
  })
})
