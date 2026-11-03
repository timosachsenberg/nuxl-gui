// Inputs by path, as the file manager would hand them over: names with spaces and umlauts, two inputs
// of the same name from different folders, and an mzML.gz. The example's run and FASTA are copied into
// folders made for the spec; the app reads them where they are. They are searched with the example's fragment
// tolerance of 0.5 Da, set by hand (lib.ts exampleSettings).
// Gated: runs only with PROSE_BIN set (the app inherits it).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  appReady,
  clearSearches,
  dataHome,
  dropFiles,
  EXAMPLE_FASTA as FASTA,
  EXAMPLE_MZML as MZML,
  exampleSettings,
  goTo,
  searchFolders,
  textOf,
  waitForResults,
} from './lib.ts'

const enabled = Boolean(process.env.PROSE_BIN)

describe('inputs by path', () => {
  let work: string
  let umlautRun: string
  let umlautFasta: string

  before(async function () {
    if (!enabled) {
      console.log('skipped: set PROSE_BIN to run searches through the app')
      this.skip()
    }
    work = mkdtempSync(join(tmpdir(), 'prose-e2e-paths-'))
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

  /** Drops the paths on New search, starts the search and returns the text of the PSM count. */
  async function search(paths: string[], fileName: string) {
    await exampleSettings()
    await dropFiles(paths)
    // the table lists the file (one file has no design summary)
    await browser.waitUntil(async () => (await textOf('[data-testid="design-scroll"]')).includes(fileName), {
      timeoutMsg: `${fileName} is not in the table`,
    })
    await expect($('[data-testid="fasta-proteins"]')).toHaveText('4,136 proteins')
    await $('button*=Start search').click()
    await waitForResults()
    const count = $('[data-testid="psm-count"]')
    await count.waitForDisplayed({ timeout: 20000 })
    return textOf('[data-testid="psm-count"]')
  }

  it('paths with spaces and umlauts', async () => {
    const count = await search([umlautRun, umlautFasta], 'Probe Größe ä ö ü.mzML')
    expect(count).toMatch(/\d/)
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

  it('an mzML.gz searches like its mzML', async () => {
    const plainCount = await search([umlautRun, umlautFasta], 'Probe Größe ä ö ü.mzML')
    const gz = join(work, 'Probe Größe ä ö ü.mzML.gz')
    writeFileSync(gz, gzipSync(readFileSync(MZML)))
    const count = await search([gz, umlautFasta], 'Probe Größe ä ö ü.mzML.gz')
    expect(count).toBe(plainCount)
  })

  it('names whose lower case is longer (İ, Ⱥ) keep their PSMs, and one file exports its idXML', async () => {
    // the stem of such a name was cut at the lower-cased copy's offsets, and the reader found no PSMs
    const plainCount = await search([umlautRun, umlautFasta], 'Probe Größe ä ö ü.mzML')
    const odd = join(work, 'İstanbul Ⱥ run.mzML.gz')
    writeFileSync(odd, gzipSync(readFileSync(MZML)))
    const count = await search([odd, umlautFasta], 'İstanbul Ⱥ run.mzML.gz')
    expect(count).toBe(plainCount)
    expect(count).not.toMatch(/^\s*0\b/)
    // Export > idXML: the file's own idXML (ProSE writes the merged one only for several files)
    const chosen = join(dataHome(), 'chosen.prose')
    rmSync(chosen, { force: true })
    await $('header').$('button*=Export').click()
    await $('[role="menuitem"]*=idXML').click()
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
    await waitForResults()
    const count = $('[data-testid="psm-count"]')
    await count.waitForDisplayed({ timeout: 20000 })
    // two copies of the run give what the example's two names give
    await expect(count).toHaveText(expect.stringContaining('154'))
    expect(await textOf('[data-testid="result-chip"]')).toContain('2 files')
  })
})
