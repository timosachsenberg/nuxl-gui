// The example searched with PeptDeep, and what the app does with its result: the PSM view with PeptDeep's
// mirror, the ion toggles, and a project file that opens again with the same PSMs. Every test searches
// the example itself (beforeEach), so each runs alone.
// Gated: runs only with PROSE_BIN set (the app inherits it).
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { appReady, clearSearches, dataHome, goTo, jsClick, openFirstPsm, runExample, searchFolders, textOf, waitForResults } from './lib.ts'

const enabled = Boolean(process.env.PROSE_BIN)

/** The labels of the matched peaks in the spectrum. */
const peakLabels = (): Promise<string[]> =>
  browser.execute(() => [...document.querySelectorAll('[data-testid="peak-label"]')].map((l) => l.textContent ?? ''))

describe('the example with PeptDeep', () => {
  before(async function () {
    if (!enabled) {
      console.log('skipped: set PROSE_BIN to run the example through the app')
      this.skip()
    }
    await appReady()
  })

  beforeEach(async () => {
    await runExample({ peptdeep: true })
  })

  afterEach(() => {
    clearSearches()
    rmSync(join(dataHome(), 'chosen.prose'), { force: true })
  })

  it('the example with PeptDeep: 154 PSMs, a PSM shows the PeptDeep mirror', async () => {
    await expect($('[data-testid="psm-count"]')).toHaveText(expect.stringContaining('154'))

    await openFirstPsm()
    // the lower half is PeptDeep's prediction, with peaks, not the theoretical spectrum or a "no prediction" note
    await expect($('[data-testid="bottom-label"]')).toHaveText(expect.stringContaining('PeptDeep'))
    expect((await $$('[data-testid="bottom-peaks"]')).length).toBeGreaterThan(0)
    expect(await $$('[data-testid="bottom-status"]')).toHaveLength(0)
    await expect($('[data-testid="similarity"]')).toBeExisting()
    // the radio of the bottom half is on the prediction
    expect(await $('input[type="radio"][value="peptdeep"]').isSelected()).toBe(true)
  })

  it('ion toggles change the annotation', async () => {
    await openFirstPsm()
    const before = await peakLabels()
    expect(before.length).toBeGreaterThan(0)
    expect(before.some((l) => l.startsWith('y'))).toBe(true)
    // the matched peaks' paths, one per series (b, y, ...)
    const matched = (): Promise<string[]> =>
      browser.execute(() => [...document.querySelectorAll('[data-testid="matched-peaks"]')].map((p) => p.getAttribute('d') ?? ''))
    const dBefore = await matched()

    // y ions off: no label of a y ion is left, and the matched peaks are fewer
    await jsClick(await $('input[aria-label="y ions"]'))
    await browser.waitUntil(async () => !(await peakLabels()).some((l) => l.startsWith('y')), { timeoutMsg: 'y labels are still there' })
    expect((await matched()).length).toBeLessThan(dBefore.length)
    expect((await peakLabels()).some((l) => l.startsWith('b'))).toBe(true)

    // back on: the annotation is as it was
    await jsClick(await $('input[aria-label="y ions"]'))
    await browser.waitUntil(async () => (await peakLabels()).some((l) => l.startsWith('y')))
    expect(await matched()).toEqual(dBefore)
    expect(await peakLabels()).toEqual(before)
  })

  it('with 1+ fragments hidden and nothing matched, the view says so and shows them again in one click', async () => {
    await openFirstPsm()
    expect((await peakLabels()).length).toBeGreaterThan(0)
    expect(await $('[data-testid="oneplus-hint"]').isExisting()).toBe(false)
    // every fragment charge off (1+, and 2+ where the precursor has it)
    for (const charge of ['1+', '2+']) {
      const box = $(`input[aria-label="${charge} fragments"]`)
      if ((await box.isExisting()) && (await box.isSelected())) await jsClick(await box)
    }
    const hint = $('[data-testid="oneplus-hint"]')
    await hint.waitForDisplayed({ timeout: 10000 })
    await expect(hint).toHaveText(expect.stringContaining('1+ fragments are hidden'))
    expect(await peakLabels()).toEqual([])
    await hint.$('button=Show 1+').click()
    await browser.waitUntil(async () => (await peakLabels()).length > 0, { timeoutMsg: 'no peak is annotated again' })
    expect(await $('input[aria-label="1+ fragments"]').isSelected()).toBe(true)
    await expect(hint).not.toBeExisting()
  })

  it('a project opens again with the same PSMs', async () => {
    // Export > Project (.prose): the app writes it where the specs' dialog seam says (app.sh)
    const count = await textOf('[data-testid="psm-count"]')
    expect(count).toContain('154')
    const file = join(dataHome(), 'chosen.prose')
    rmSync(file, { force: true })
    await $('header').$('button*=Export').click()
    await $('[role="menuitem"]*=Project (.prose)').click()
    await browser.waitUntil(() => {
      try {
        return readFileSync(file).length > 0
      } catch {
        return false
      }
    }, { timeoutMsg: 'no project file was written' })
    // a zip
    expect(readFileSync(file).subarray(0, 2).toString('latin1')).toBe('PK')

    // History is cleared of the search, then the project is opened: it comes back as a search of its own
    await goTo('History')
    const rows = $$('[data-testid="history-row"]')
    await browser.waitUntil(async () => (await rows.length) === 1)
    await $('button[aria-label^="Delete"]').click()
    await $('[role="dialog"]').$('button=Delete').click()
    await $('[data-testid="history-empty"]').waitForDisplayed()
    expect(searchFolders().finished).toEqual([])

    await $('[data-testid="open-project"]').click()
    await waitForResults(30000)
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 30000 })
    expect(await textOf('[data-testid="psm-count"]')).toBe(count)
    // the PSM view opens as before: the spectrum and the prediction are in the project
    await openFirstPsm()
    await expect($('[data-testid="bottom-label"]')).toHaveText(expect.stringContaining('PeptDeep'))
    expect((await $$('[data-testid="bottom-peaks"]')).length).toBeGreaterThan(0)
  })
})
