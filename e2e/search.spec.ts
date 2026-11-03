// The example searched through the app's screens: New search with the example, Start, Results.
// Gated: runs only with PROSE_BIN set (the app inherits it). Every test that needs a result searches the
// example itself, so each runs alone; the searches' folders (in the spec's own data folder) are removed
// after each test.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { parquetReadObjects } from 'hyparquet'
import { clearSearches, freshForm, openFirstPsm, runExample, searchesDir, waitForResults } from './lib.ts'

const enabled = Boolean(process.env.PROSE_BIN)

describe('the example search', () => {
  before(function () {
    if (!enabled) {
      console.log('skipped: set PROSE_BIN to run the example search through the app')
      this.skip()
    }
  })

  afterEach(() => clearSearches())

  it('the CSP lets the results reader start its WebAssembly zstd decoder (from a data: URL)', async () => {
    await $('header').waitForDisplayed({ timeout: 20000 })
    // the smallest module, loaded as zstddec loads its own
    const outcome = await browser.execute(() =>
      fetch('data:application/wasm;base64,AGFzbQEAAAA=')
        .then((r) => r.arrayBuffer())
        .then((b) => WebAssembly.instantiate(b))
        .then(
          () => 'ok',
          (e) => String(e),
        ),
    )
    expect(outcome).toBe('ok')
  })

  it('the monospace fonts are the bundled ones (Liberation Mono, Inconsolata), not a wider system one', async () => {
    await $('header').waitForDisplayed({ timeout: 20000 })
    // In the web app's headless Chromium, 'NDSVIVADQTPTPTR' at 12.5px is 93.75 px in the peptide stack
    // (a 0.5 em font there) and 112.53 px in font-mono (Liberation Mono, 0.6 em). The app bundles
    // Inconsolata (0.5 em) for sequences and Liberation Mono. WebKitGTK sets text at whole pixel sizes
    // (12.5px as 13px) and Inconsolata's and Liberation Mono's hinted advances fall on whole pixels, so here
    // they measure 90 and 120 px; the system's DejaVu Sans Mono 120.
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
        // as the components use them: the peptide stack, and Tailwind's font-mono class
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
    // 0.5 em and 0.6 em per character (at 12.5 or 13 px; hinted advances rounded to whole pixels)
    expect(widths.sequence / 15).toBeGreaterThanOrEqual(6)
    expect(widths.sequence / 15).toBeLessThanOrEqual(6.5)
    expect(widths.mono / 15).toBeGreaterThanOrEqual(7.5)
    expect(widths.mono / 15).toBeLessThanOrEqual(8)
    expect(widths.sequence).toBeLessThan(widths.dejavu - 10)
  })

  it('the example search shows 154 PSMs', async () => {
    await $('header').waitForDisplayed({ timeout: 20000 })
    await $('button=Try the example').click()
    // the two files in the design table, the database counted
    await expect($('[data-testid="design-summary"]')).toHaveText('2 files → 2 samples · 1 condition')
    await expect($('[data-testid="fasta-proteins"]')).toHaveText('4,136 proteins')
    // the example's fragment tolerance for its ion-trap spectra, its PSM FDR of 2 % and its protein FDR off (the run is
    // too small for 1 % and for a protein FDR)
    await expect($('#fragment-tolerance')).toHaveValue('0.5')
    await expect($('#psm-fdr')).toHaveValue('2')
    await expect($('#protein-fdr')).toHaveValue('off')
    await expect($('button=Off')).toHaveAttribute('aria-pressed', 'true')
    // (textContent: the footer line is cut to the window's width)
    expect(await $('[data-testid="search-plan"]').getProperty('textContent')).toBe('2 files in 2 samples · 4,136 proteins + 116 cRAP + decoys')
    // the example's note, on a line of its own that wraps (not cut)
    // (textContent: WebKitWebDriver reads no visible text of a line-clamped box)
    expect(await $('[data-testid="search-note"]').getProperty('textContent')).toBe(
      "Ion-trap example with a 0.5 Da fragment tolerance, a 2 % PSM FDR and no protein FDR: the run is too small for 1 % and for a protein FDR. It has too few PSMs for Percolator's full model.",
    )
    const clipped = await browser.execute(() => {
      const note = document.querySelector('[data-testid="search-note"]') as HTMLElement
      return note.scrollHeight > note.clientHeight + 1
    })
    expect(clipped).toBe(false)
    await $('button*=Start search').click()
    await expect($('[data-testid="search-progress"]')).toBeDisplayed()
    await browser.waitUntil(async () => /#\/results\/[^/]+$/.test(await browser.getUrl()), {
      timeout: 180000,
      interval: 500,
      timeoutMsg: 'the search did not open its result',
    })
    const count = $('[data-testid="psm-count"]')
    await count.waitForDisplayed({ timeout: 20000 })
    await expect(count).toHaveText(expect.stringContaining('154'))
    expect(await $('[data-testid="result-chip"]').getProperty('textContent')).toContain('Ecoli · 2 files')
    // real data: the first PSM's precursor error is not 0 ppm, its peaks have intensities of their own
    await openFirstPsm()
    const header = String(await $('[data-testid="psm-header"]').getProperty('textContent'))
    const ppm = /([−+-]?\d+\.\d) ppm/.exec(header)
    if (!ppm) throw new Error(`no precursor error in the PSM header: ${header}`)
    expect(Number(ppm[1].replace('−', '-'))).not.toBe(0)
    const sticks = String(await $('[data-testid="unmatched-peaks"]').getAttribute('d'))
    const tops = new Set([...sticks.matchAll(/V(-?[\d.]+)/g)].map((m) => m[1]))
    expect(tops.size).toBeGreaterThan(5)
    // the fragment mass errors under the spectrum, in Da (the example's tolerance is in Da), each dot under its peak
    const strip = await browser.execute(() => {
      const svg = document.querySelector('[data-testid="spectrum"]')!
      const peaks = [...svg.querySelectorAll('[data-testid="matched-peaks"]')].map((p) => p.getAttribute('d') ?? '').join('')
      const dots = [...svg.querySelectorAll('[data-testid="error-dot"]')].map((d) => d.getAttribute('cx'))
      return { unit: svg.querySelector('[data-testid="error-unit"]')?.textContent, dots: dots.length, unaligned: dots.filter((cx) => !peaks.includes(`M${cx} `)) }
    })
    expect(strip.unit).toBe('Da')
    expect(strip.dots).toBeGreaterThan(5)
    expect(strip.unaligned).toEqual([])
  })

  it('Remove all and Start over empty the form, give back the preset\'s tolerance and protein FDR, and can be undone', async () => {
    await freshForm()
    await $('button=Try the example').click()
    await expect($('[data-testid="fasta-proteins"]')).toHaveText('4,136 proteins')
    await expect($('#fragment-tolerance')).toHaveValue('0.5')
    await expect($('#protein-fdr')).toHaveValue('off')
    await expect($('button=Start over')).toHaveAttribute(
      'title',
      "Removes the spectra and the database. Your settings stay, but the example's fragment tolerance, PSM FDR and protein FDR go back to the preset's.",
    )
    await $('button=Remove all').click()
    await expect($('button=Try the example')).toBeDisplayed()
    await expect($('[data-testid="fasta-proteins"]')).toHaveText('4,136 proteins')
    // the example's 0.5 Da and its protein FDR off do not stay for the next files
    await expect($('#fragment-tolerance')).toHaveValue('20')
    await expect($('#protein-fdr')).toHaveValue('1')
    await expect($('[data-testid="removed-note"]')).toHaveText(expect.stringContaining('Removed 2 files.'))
    await $('[data-testid="removed-note"]').$('button=Undo').click()
    await expect($('[data-testid="design-summary"]')).toHaveText('2 files → 2 samples · 1 condition')
    await expect($('#fragment-tolerance')).toHaveValue('0.5')
    await expect($('#protein-fdr')).toHaveValue('off')
    await $('button=Start over').click()
    await expect($('button=Try the example')).toBeDisplayed()
    await expect($('#fasta-chosen')).toHaveText('Choose a FASTA file…')
    expect(await $('[data-testid="search-plan"]').getProperty('textContent')).toBe('No spectra yet')
    await expect($('#fragment-tolerance')).toHaveValue('20')
    await expect($('#protein-fdr')).toHaveValue('1')
    await expect($('[data-testid="removed-note"]')).toHaveText(expect.stringContaining('Removed 2 files and the database.'))
    await expect($('button=Start over')).not.toBeExisting()
  })

  it('a parameter set in "All parameters" reaches ProSE', async () => {
    await freshForm()
    await $('button=Try the example').click()
    await expect($('[data-testid="fasta-proteins"]')).toHaveText('4,136 proteins')
    await $('button*=parameters').click()
    const dialog = $('[role="dialog"]')
    await dialog.waitForDisplayed({ timeout: 10000 })
    await expect(dialog.$('[data-slot="dialog-title"]')).toHaveText(expect.stringMatching(/^All \d+ parameters$/))
    // an advanced parameter without a field on the page, found by its name (PeptDeep is off: no effect on the result)
    await dialog.$('input[aria-label="Find a parameter"]').setValue('batch_size')
    const field = dialog.$('#param-peptdeep-batch_size')
    await field.waitForDisplayed({ timeout: 10000 })
    await field.setValue('32')
    await expect(dialog.$('button*=default:')).toBeDisplayed()
    await dialog.$('button=Done').click()
    await expect(dialog).not.toBeDisplayed()
    // the preset counts as modified
    await expect($('span=modified')).toBeDisplayed()
    await $('button*=Start search').click()
    const id = await waitForResults()
    // ProSE's own record of its parameters: the provenance view's configuration
    const bytes = readFileSync(join(searchesDir(), id, 'qpx', 'quantms.provenance.parquet'))
    const rows = (await parquetReadObjects({
      file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      columns: ['step_name', 'config'],
      compressors: { ZSTD: (input: Uint8Array) => new Uint8Array(zstdDecompressSync(input)) },
    })) as { step_name: string; config: string }[]
    const config = JSON.parse(rows.find((r) => r.step_name === 'peptide_search')!.config)
    expect(config['Search:peptdeep:batch_size']).toBe(32)
    expect(config['Search:fragment:mass_tolerance']).toBe(0.5)
  })

  it('the example without PeptDeep still shows the prediction', async () => {
    // PeptDeep is off for the search (no rescoring features), yet ProSE writes the prediction of every PSM
    await runExample()
    await openFirstPsm()
    await expect($('[data-testid="bottom-label"]')).toHaveText(expect.stringContaining('PeptDeep'))
    expect((await $$('[data-testid="bottom-peaks"]')).length).toBeGreaterThan(0)
    expect(await $$('[data-testid="bottom-status"]')).toHaveLength(0)
    expect(await $('input[type="radio"][value="peptdeep"]').isSelected()).toBe(true)
    expect(await $('input[type="radio"][value="peptdeep"]').isEnabled()).toBe(true)
    // the stored spectra are filtered (the footer of the QPX files says how): the view says so
    await expect($('[data-testid="peak-filter-note"]')).toHaveText(expect.stringContaining('Showing the top 100 peaks per 100 m/z'))
  })

  it('History survives a restart: the search is listed, can be renamed, and opens again with its results', async () => {
    const searchId = await runExample()
    const row = () => $(`[data-testid="history-row"][data-id="${searchId}"]`)
    await $('nav[aria-label="Main"]').$('a=History').click()
    await row().waitForDisplayed({ timeout: 20000 })
    // (textContent: WebKit's visible text leaves out the cells that the table cuts to its width)
    expect(await row().getProperty('textContent')).toContain('Ecoli_1.mzML, Ecoli_2.mzML')
    // the folder has its record: the shim's outputs, proteins.fasta and search.json; proteins.fasta replaced the
    // copy of the database with the contaminants
    expect(existsSync(join(searchesDir(), searchId, 'search.json'))).toBe(true)
    expect(existsSync(join(searchesDir(), searchId, 'proteins.fasta'))).toBe(true)
    expect(existsSync(join(searchesDir(), searchId, 'database.fasta'))).toBe(false)
    // the record's PSMs (written when ProSE ended, from its QPX run view) are the result's
    expect(await row().$('[data-column="psms"]').getProperty('textContent')).toBe('154')

    await row().$('button=Rename').click()
    await row().$('input').waitForDisplayed()
    // (typed into the field, which has the focus and the name selected; WebDriver's clear would blur it and end the
    // rename; a name with a space came out garbled through WebKitWebDriver)
    await browser.keys([...'Renamed_search', 'Enter'])
    await browser.waitUntil(async () => String(await row().getProperty('textContent')).includes('Renamed_search'))

    // the app starts again (a new process): History lists the search, and it opens with its results
    await browser.reloadSession()
    await $('header').waitForDisplayed({ timeout: 30000 })
    await $('nav[aria-label="Main"]').$('a=History').click()
    await row().waitForDisplayed({ timeout: 20000 })
    expect(await row().getProperty('textContent')).toContain('Renamed_search')
    await row().$('button=Open').click()
    await browser.waitUntil(async () => (await browser.getUrl()).endsWith(`#/results/${searchId}`), { timeout: 30000 })
    const count = $('[data-testid="psm-count"]')
    await count.waitForDisplayed({ timeout: 30000 })
    await expect(count).toHaveText(expect.stringContaining('154'))
  })
})
