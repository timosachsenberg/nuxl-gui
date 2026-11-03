// Screenshots of the app for docs/screens, at 1440×900 CSS pixels. Not part of the e2e run (the name has no
// `.spec.`):
//   NUXL_FAKE=1 e2e/run.sh e2e/screens.shot.ts                                         (or NUXL_TOOL=…)
//   GDK_SCALE=2 E2E_SCREEN=3000x2000x24 NUXL_FAKE=1 e2e/run.sh e2e/screens.shot.ts     (at device scale factor 2)
// GDK_SCALE=2 makes WebKitGTK render at twice the pixels (the screen of xvfb-run has to hold the window: E2E_SCREEN).
// Runs the example, then the views (01-11 light, 12-13 in the dark theme); removes its search folder at the end. With the fake, e2e/run.sh serves the
// outputs of src/lib/results/fixtures/screens (FAKE_NUXL_RESULTS=screens: OpenNuXL's test 3 on the example, 10 ppm,
// with decoys) in place of the specs' fixtures/example (test 6, searched at 1e9 ppm: unrealistic precursor errors).
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { clearSearches, fakeDelay, goTo, jsClick } from './lib.ts'

const dir = resolve(fileURLToPath(new URL('../docs/screens', import.meta.url)))

async function shot(name: string) {
  // the pointer away from buttons and rows (no hover), and a moment for the paint
  await browser.pause(400)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${name}.png`), Buffer.from(await browser.takeScreenshot(), 'base64'))
}

/**
 * Scrolls the page so that the FDR hint at the end of the search settings stands above the sticky footer (with the
 * card's padding below it), not cut by it; at 1440×900 that takes the top bar out of the picture.
 */
async function revealFdrHint() {
  await browser.execute(() => {
    window.scrollTo(0, 0)
    const hint = document.getElementById('fdr-hint')
    const footer = document.querySelector('[data-testid="search-footer"]')
    if (!hint || !footer) return
    const over = hint.getBoundingClientRect().bottom + 28 - footer.getBoundingClientRect().top
    // (the top bar scrolls with the page: all of it out of the picture, never half)
    const bar = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0
    if (over > 0) window.scrollTo(0, Math.max(over, bar))
  })
}

/** The PSM of 08-psm-view: its sequence as the PSMs grid shows it (a row with it, else the first row). */
const PSM = process.env.FAKE_NUXL_RESULTS === 'screens' ? 'AWQQLDNGSCAQIR' : 'XL'

const text = async (selector: string) => String(await $(selector).getProperty('textContent'))

/** Opens a tab of the results by its label. */
const tab = async (label: string) => jsClick(await $('[role="tablist"]').$(`button*=${label}`))

/** The first row of a grid of the results whose text has `needle`, else its first row. */
async function rowWith(grid: string, needle: string) {
  const g = $(`[role="grid"][aria-label="${grid}"]`)
  await g.waitForDisplayed({ timeout: 10000 })
  await browser.waitUntil(async () => (await g.$$('tbody tr[aria-rowindex]')).length > 0)
  const rows = await g.$$('tbody tr[aria-rowindex]')
  for (const r of rows) if (String(await r.getProperty('textContent')).includes(needle)) return r
  return rows[0]
}

describe('screens', () => {
  after(() => {
    fakeDelay(0)
    clearSearches()
  })

  it('takes the screenshots', async () => {
    if (!process.env.NUXL_TOOL) throw new Error('set NUXL_TOOL (or NUXL_FAKE=1): the screenshots need a search')
    if (process.env.NUXL_FAKE && process.env.FAKE_NUXL_RESULTS !== 'screens') console.warn('the fake serves', process.env.FAKE_NUXL_RESULTS, 'not the screens set')
    await $('header').waitForDisplayed({ timeout: 20000 })
    await browser.setWindowSize(1440, 900).catch(() => {})
    const size = await browser.execute(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio])
    console.log('viewport (CSS px) and device pixel ratio', size)
    await $('[data-testid="view-search"]').waitForDisplayed({ timeout: 20000 })
    await shot('01-new-search-empty')

    await $('button=Try the example').click()
    await browser.waitUntil(async () => (await text('[data-testid="fasta-proteins"]')).includes('5 proteins'), { timeout: 20000 })
    await revealFdrHint()
    await shot('02-new-search-files')

    // (the fake takes its time per scoring step, so that the progress can be seen)
    fakeDelay(3)
    await $('button*=Start search').click()
    await $('[data-testid="search-progress"]').waitForDisplayed({ timeout: 20000 })
    await browser.waitUntil(async () => /Searching|Scoring/.test(await text('[data-testid="search-progress"]')), { timeout: 60000, interval: 200 })
    await browser.waitUntil(async () => /%/.test(await text('[data-testid="search-progress"]')), { timeout: 30000, interval: 200 }).catch(() => {})
    await revealFdrHint()
    await shot('03-search-running')

    await browser.waitUntil(async () => /#\/results\/[^/]+$/.test(await browser.getUrl()), { timeout: 180000, interval: 500 })
    fakeDelay(0)
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
    await shot('04-results-proteins')

    await tab('PSMs')
    await rowWith('PSMs', '')
    await shot('05-results-psms')

    await tab('Peptides')
    await rowWith('Peptides', '')
    await shot('06-results-peptides')

    // the protein with the most cross-linked sites (the first of the Proteins tab), its peptides
    await tab('Proteins')
    await jsClick(await rowWith('Proteins', ''))
    await $('[data-testid="protein-panel"]').waitForDisplayed({ timeout: 10000 })
    const peptidesTab = await $('[data-testid="protein-panel"]').$('button*=Peptides')
    if (await peptidesTab.isExisting()) await jsClick(peptidesTab)
    await shot('07-protein-panel')
    await browser.keys('Escape')

    // the PSM view of a localized cross-link with shifted and marker ions (of the screens set: the best one,
    // AWQQLDNGSC(U)AQIR, U at C22 of Cse2); else the first cross-link
    await tab('PSMs')
    await jsClick(await rowWith('PSMs', PSM))
    await $('[data-testid="psm-view"]').waitForDisplayed({ timeout: 10000 })
    await browser.waitUntil(async () => !(await $('[data-testid="spectrum-loading"]').isExisting()), { timeout: 10000 })
    await shot('08-psm-view')
    await browser.keys('Escape')

    await tab('Overview')
    await $('[data-testid="search-facts"]').waitForDisplayed({ timeout: 10000 })
    await shot('09-overview')

    await tab('QC')
    await browser.pause(300)
    await shot('10-qc')

    await goTo('History')
    await $('[data-testid="view-history"]').waitForDisplayed({ timeout: 10000 })
    await shot('11-history')

    // the dark theme (the top bar's menu): the PSM view and the QC charts; then back to the system's
    await jsClick(await $('[data-testid="theme-menu"]'))
    await jsClick(await $('[data-testid="theme-dark"]'))
    await browser.waitUntil(async () => (await browser.execute(() => document.documentElement.classList.contains('dark'))), { timeout: 5000 })
    await browser.keys('Escape')
    await goTo('Results')
    await tab('PSMs')
    await jsClick(await rowWith('PSMs', PSM))
    await $('[data-testid="psm-view"]').waitForDisplayed({ timeout: 10000 })
    await browser.waitUntil(async () => !(await $('[data-testid="spectrum-loading"]').isExisting()), { timeout: 10000 })
    await shot('12-psm-view-dark')
    await browser.keys('Escape')
    await tab('QC')
    await browser.pause(300)
    await shot('13-qc-dark')
    await jsClick(await $('[data-testid="theme-menu"]'))
    await jsClick(await $('[data-testid="theme-system"]'))
    await browser.keys('Escape')
  })
})
