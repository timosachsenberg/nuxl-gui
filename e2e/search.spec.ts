// The example searched through the app's screens: New search with the example, Start, Results, the PSM view,
// History, and a project file exported and opened again.
// Gated: runs only with NUXL_TOOL set (the app inherits it; NUXL_FAKE=1 sets it to the stand-in, e2e/run.sh).
// Every test that needs a result searches the example itself, so each runs alone; the searches' folders (in the
// spec's own data folder) are removed after each test.
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  countOf,
  dataHome,
  EXAMPLE_PROTEINS,
  EXAMPLE_PSMS,
  clearSearches,
  freshForm,
  goTo,
  jsClick,
  openFirstPsm,
  resultsId,
  runExample,
  searchesDir,
  textOf,
  waitForResults,
} from './lib.ts'

const enabled = Boolean(process.env.NUXL_TOOL)

describe('the example search', () => {
  before(function () {
    if (!enabled) {
      console.log('skipped: set NUXL_TOOL (or NUXL_FAKE=1) to run the example search through the app')
      this.skip()
    }
  })

  afterEach(() => clearSearches())

  it('the monospace fonts are the bundled ones (Liberation Mono, Inconsolata), not a wider system one', async () => {
    await $('header').waitForDisplayed({ timeout: 20000 })
    // 'NDSVIVADQTPTPTR' at 12.5px: Inconsolata (0.5 em) for sequences and Liberation Mono (0.6 em) for font-mono.
    // WebKitGTK sets text at whole pixel sizes (12.5px as 13px) and the hinted advances fall on whole pixels, so
    // here they measure 90 and 120 px; the system's DejaVu Sans Mono 120.
    const widths = await browser.execute(async () => {
      await document.fonts.load('12.5px "Inconsolata"')
      await document.fonts.load('12.5px "Liberation Mono"')
      const width = (font: string, className = '') => {
        const s = document.createElement('span')
        s.className = className
        if (font) s.style.font = font
        s.style.fontSize = '12.5px'
        s.textContent = 'NDSVIVADQTPTPTR'
        document.body.append(s)
        const w = s.getBoundingClientRect().width
        s.remove()
        return w
      }
      return {
        sequence: width('12.5px var(--font-sequence)'),
        mono: width('', 'font-mono'),
        inconsolata: width('12.5px "Inconsolata"'),
        liberation: width('12.5px "Liberation Mono"'),
        dejavu: width('12.5px "DejaVu Sans Mono"'),
      }
    })
    console.log('monospace widths', JSON.stringify(widths))
    expect(widths.sequence).toBe(widths.inconsolata)
    expect(widths.mono).toBe(widths.liberation)
    expect(widths.sequence / 15).toBeGreaterThanOrEqual(6)
    expect(widths.sequence / 15).toBeLessThanOrEqual(6.5)
    expect(widths.mono / 15).toBeGreaterThanOrEqual(7.5)
    expect(widths.mono / 15).toBeLessThanOrEqual(8)
    expect(widths.sequence).toBeLessThan(widths.dejavu - 10)
  })

  it('the example search shows PSMs with cross-links, and the PSM view its adduct, site and peaks', async () => {
    await freshForm()
    await $('button=Try the example').click()
    // one file (no design summary: one file needs no design), the database counted, the example's precursor tolerance
    await browser.waitUntil(async () => (await textOf('[data-testid="design-scroll"]')).includes('OpenNuXL_1_input.mzML'))
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
    await expect($('#precursor-tolerance')).toHaveValue('10')
    await expect($('[data-testid="protocol-summary"]')).toHaveText(expect.stringContaining('cross-links at U'))
    // (textContent: the footer line is cut to the window's width)
    expect(await textOf('[data-testid="search-plan"]')).toBe('1 file · 5 proteins + 116 cRAP + decoys')
    // the example's note, on a line of its own that wraps (not cut)
    expect(await textOf('[data-testid="search-note"]')).toBe(
      "OpenMS' test run of OpenNuXL (20 spectra, 5 proteins) with its 10 ppm precursor tolerance. It has too few PSMs for Percolator, which OpenNuXL skips below 1,000 PSMs.",
    )
    const clipped = await browser.execute(() => {
      const note = document.querySelector('[data-testid="search-note"]') as HTMLElement
      return note.scrollHeight > note.clientHeight + 1
    })
    expect(clipped).toBe(false)
    await $('button*=Start search').click()
    const id = await waitForResults()
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
    const psms = await countOf('psm-count')
    const xls = await countOf('xl-psm-count')
    if (EXAMPLE_PSMS) {
      expect(psms).toBe(EXAMPLE_PSMS.psms)
      expect(xls).toBe(EXAMPLE_PSMS.xls)
    }
    expect(xls).toBeGreaterThan(0)
    expect(psms).toBeGreaterThanOrEqual(xls)
    expect(await countOf('protein-count')).toBeGreaterThan(0)
    expect(await textOf('[data-testid="result-chip"]')).toContain('OpenNuXL_1_input · 1 file')
    // OpenNuXL's outputs and the shim's record of them (docs/design.md §2)
    const outputs = JSON.parse(readFileSync(join(searchesDir(), id, 'nuxl', '1__OpenNuXL_1_input.outputs.json'), 'utf8'))
    expect(outputs.percolator).toBe(false)
    expect(outputs.notes.join(' ')).toContain('Too few PSMs')

    // the PSM view of the best PSM: a cross-link (the PSMs tab lists them first), its adduct and site, and the peaks
    // of the input mzML
    await openFirstPsm()
    await expect($('[data-testid="psm-crosslink"]')).toBeDisplayed()
    expect(await textOf('[data-testid="psm-adduct"]')).toMatch(/adduct \S+ \(\+\d+\.\d+ Da\)/)
    expect(await textOf('[data-testid="psm-site"]')).toMatch(/on [A-Z]\d+/)
    expect(await textOf('[data-testid="psm-header"]')).toMatch(/[−+-]?\d+\.\d ppm/)
    const sticks = String(await $('[data-testid="unmatched-peaks"]').getAttribute('d'))
    const tops = new Set([...sticks.matchAll(/V(-?[\d.]+)/g)].map((m) => m[1]))
    expect(tops.size).toBeGreaterThan(5)
    expect((await $$('[data-testid="matched-peaks"]')).length).toBeGreaterThan(0)
    // the fragment mass errors under the spectrum, in ppm (the preset's fragment tolerance), each dot under its peak
    const strip = await browser.execute(() => {
      const svg = document.querySelector('[data-testid="spectrum"]')!
      const peaks = [...svg.querySelectorAll('[data-testid="matched-peaks"]')].map((p) => p.getAttribute('d') ?? '').join('')
      const dots = [...svg.querySelectorAll('[data-testid="error-dot"]')].map((d) => d.getAttribute('cx'))
      return { unit: svg.querySelector('[data-testid="error-unit"]')?.textContent, dots: dots.length, unaligned: dots.filter((cx) => !peaks.includes(`M${cx} `)) }
    })
    expect(strip.unit).toBe('ppm')
    expect(strip.dots).toBeGreaterThan(5)
    expect(strip.unaligned).toEqual([])
    expect(await $$('[data-testid="peaks-missing-note"]')).toHaveLength(0)

    // the PSM table stands under the spectrum, with the keyboard focus: the arrow keys go through the PSMs
    await expect($('[data-testid="psm-list"] [role="grid"][aria-label="PSMs"]')).toBeDisplayed()
    expect(await browser.execute(() => document.activeElement?.closest('[data-testid="psm-list"]') !== null)).toBe(true)
    const first = await textOf('[data-testid="psm-header"]')
    await browser.keys('ArrowDown')
    await browser.waitUntil(async () => (await textOf('[data-testid="psm-header"]')) !== first, {
      timeout: 5000,
      timeoutMsg: 'ArrowDown in the PSM table did not show the next PSM',
    })
    await browser.keys('ArrowUp')
    await browser.waitUntil(async () => (await textOf('[data-testid="psm-header"]')) === first, { timeout: 5000, timeoutMsg: 'ArrowUp did not go back' })
    // the mass errors collapse (and come back)
    await jsClick(await $('[data-testid="mass-errors-toggle"]'))
    await browser.waitUntil(async () => (await $$('[data-testid="error-dot"]')).length === 0, { timeout: 5000, timeoutMsg: 'the mass errors stayed' })
    await jsClick(await $('[data-testid="mass-errors-toggle"]'))
    await browser.waitUntil(async () => (await $$('[data-testid="error-dot"]')).length > 0, { timeout: 5000, timeoutMsg: 'the mass errors did not come back' })
    await browser.keys('Escape')

    // the proteins with their cross-linked sites: the first protein's panel lists them
    await jsClick(await $('[role="tablist"]').$('button*=Proteins'))
    const proteins = $('[role="grid"][aria-label="Proteins"]')
    await proteins.waitForDisplayed({ timeout: 10000 })
    await jsClick((await proteins.$$('tbody tr[aria-rowindex]'))[0])
    const panel = $('[data-testid="protein-panel"]')
    await panel.waitForDisplayed({ timeout: 10000 })
    expect(await textOf('[data-testid="panel-xl"]')).toMatch(/^[1-9]\d* XL PSMs? · [1-9]\d* cross-linked sites?$/)
  })

  it("Remove all and Start over empty the form, give back the preset's precursor tolerance, and can be undone", async () => {
    await freshForm()
    await $('button=Try the example').click()
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
    await expect($('#precursor-tolerance')).toHaveValue('10')
    await expect($('button=Start over')).toHaveAttribute(
      'title',
      "Removes the spectra and the database. Your settings stay, but the example's precursor tolerance goes back to the preset's.",
    )
    await $('button=Remove all').click()
    await expect($('button=Try the example')).toBeDisplayed()
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
    // the example's 10 ppm does not stay for the next files: the preset's (OpenNuXL's 6 ppm)
    await expect($('#precursor-tolerance')).toHaveValue('6')
    await expect($('[data-testid="removed-note"]')).toHaveText(expect.stringContaining('Removed 1 file.'))
    await $('[data-testid="removed-note"]').$('button=Undo').click()
    await browser.waitUntil(async () => (await textOf('[data-testid="design-scroll"]')).includes('OpenNuXL_1_input.mzML'))
    await expect($('#precursor-tolerance')).toHaveValue('10')
    await $('button=Start over').click()
    await expect($('button=Try the example')).toBeDisplayed()
    await expect($('#fasta-chosen')).toHaveText('Choose a FASTA file…')
    expect(await textOf('[data-testid="search-plan"]')).toBe('No spectra yet')
    await expect($('#precursor-tolerance')).toHaveValue('6')
    await expect($('[data-testid="removed-note"]')).toHaveText(expect.stringContaining('Removed 1 file and the database.'))
    await expect($('button=Start over')).not.toBeExisting()
  })

  it('a parameter set in "All parameters" reaches OpenNuXL', async () => {
    await freshForm()
    await $('button=Try the example').click()
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
    await $('button*=parameters').click()
    const dialog = $('[role="dialog"]')
    await dialog.waitForDisplayed({ timeout: 10000 })
    await expect(dialog.$('[data-slot="dialog-title"]')).toHaveText(expect.stringMatching(/^All \d+ parameters$/))
    // an advanced parameter without a field on the page, found by its name
    await dialog.$('input[aria-label="Find a parameter"]').setValue('marker_ions')
    const field = dialog.$('#param-NuXL-marker_ions_tolerance')
    await field.waitForDisplayed({ timeout: 10000 })
    await field.setValue('0.05')
    await expect(dialog.$('button*=default:')).toBeDisplayed()
    await dialog.$('button=Done').click()
    await expect(dialog).not.toBeDisplayed()
    // the preset counts as modified
    await expect($('span=modified')).toBeDisplayed()
    await $('button*=Start search').click()
    const id = await waitForResults()
    // the command line of the run, in the search's log (docs/design.md §2)
    const log = readFileSync(join(searchesDir(), id, 'nuxl.log'), 'utf8')
    const command = log.split('\n').find((l) => l.startsWith('$ '))!
    expect(command).toMatch(/ -NuXL:marker_ions_tolerance 0\.05( |$)/)
    expect(command).toMatch(/ -precursor:mass_tolerance 10( |$)/)
    expect(command).toContain(' -NuXL:presets ')
  })

  it('History survives a restart: the search is listed, can be renamed, and opens again with its results', async () => {
    const searchId = await runExample()
    const psms = await countOf('psm-count')
    const row = () => $(`[data-testid="history-row"][data-id="${searchId}"]`)
    await goTo('History')
    await row().waitForDisplayed({ timeout: 20000 })
    // (textContent: WebKit's visible text leaves out the cells that the table cuts to its width)
    expect(await row().getProperty('textContent')).toContain('OpenNuXL_1_input.mzML')
    // the folder has its record: proteins.fasta and search.json; proteins.fasta replaced the copy of the database
    // with the contaminants
    expect(existsSync(join(searchesDir(), searchId, 'search.json'))).toBe(true)
    expect(existsSync(join(searchesDir(), searchId, 'proteins.fasta'))).toBe(true)
    expect(existsSync(join(searchesDir(), searchId, 'database.fasta'))).toBe(false)
    expect(await row().$('[data-column="psms"]').getProperty('textContent')).toBe(String(psms))

    await row().$('button=Rename').click()
    await row().$('input').waitForDisplayed()
    // (typed into the field, which has the focus and the name selected; WebDriver's clear would blur it and end the
    // rename; a name with a space came out garbled through WebKitWebDriver)
    await browser.keys([...'Renamed_search', 'Enter'])
    await browser.waitUntil(async () => String(await row().getProperty('textContent')).includes('Renamed_search'))

    // the app starts again (a new process): History lists the search, and it opens with its results
    await browser.reloadSession()
    await $('header').waitForDisplayed({ timeout: 30000 })
    await goTo('History')
    await row().waitForDisplayed({ timeout: 20000 })
    expect(await row().getProperty('textContent')).toContain('Renamed_search')
    await row().$('button=Open').click()
    await browser.waitUntil(async () => (await browser.getUrl()).endsWith(`#/results/${searchId}`), { timeout: 30000 })
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 30000 })
    expect(await countOf('psm-count')).toBe(psms)
  })

  it('Export › Project writes a .nuxl that Open project opens again, as a search of its own', async () => {
    const searchId = await runExample()
    const psms = await countOf('psm-count')
    const xls = await countOf('xl-psm-count')
    // (debug builds take the file of NUXL_TEST_DIALOG_PATH in place of the save and open dialogs: e2e/app.sh)
    const chosen = join(dataHome(), 'chosen.nuxl')
    rmSync(chosen, { force: true })
    await $('header').$('button*=Export').click()
    await $('[role="menuitem"]*=Project (.nuxl)').click()
    await browser.waitUntil(async () => existsSync(chosen) && statSync(chosen).size > 0 && (await textOf('header')).includes('Export'), {
      timeout: 30000,
      timeoutMsg: 'no project was written',
    })
    // a zip: OpenNuXL's outputs and the record, not the log
    const zip = readFileSync(chosen)
    expect(zip.subarray(0, 2).toString()).toBe('PK')
    expect(zip.includes('search.json')).toBe(true)
    expect(zip.includes('nuxl/1__OpenNuXL_1_input.outputs.json')).toBe(true)
    expect(zip.includes('nuxl.log')).toBe(false)

    await goTo('History')
    await $('[data-testid="open-project"]').click()
    // it opens as a search of its own, with the same results
    await browser.waitUntil(async () => {
      const id = await resultsId()
      return id !== null && id !== searchId
    }, { timeout: 30000, timeoutMsg: 'the project did not open' })
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 30000 })
    expect(await countOf('psm-count')).toBe(psms)
    expect(await countOf('xl-psm-count')).toBe(xls)
    // the project has no spectra and its inputs.json no paths: the PSM view shows the peaks NuXL annotated, and says so
    await openFirstPsm()
    await expect($('[data-testid="psm-crosslink"]')).toBeDisplayed()
    await expect($('[data-testid="peaks-missing-note"]')).toBeDisplayed()
    await goTo('History')
    await browser.waitUntil(async () => (await $$('[data-testid="history-row"]')).length === 2, { timeoutMsg: 'History does not list both searches' })
    rmSync(chosen, { force: true })
  })
})
