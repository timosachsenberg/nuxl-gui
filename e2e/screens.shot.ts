// Screenshots of the app for docs/screens, at 1440×900 CSS pixels. Not part of the e2e run (the name has no
// `.spec.`):
//   NUXL_FAKE=1 e2e/run.sh e2e/screens.shot.ts                                         (or NUXL_TOOL=…)
//   GDK_SCALE=2 E2E_SCREEN=3000x2000x24 NUXL_FAKE=1 e2e/run.sh e2e/screens.shot.ts     (at device scale factor 2)
// GDK_SCALE=2 makes WebKitGTK render at twice the pixels (the screen of xvfb-run has to hold the window: E2E_SCREEN).
// Runs the example, then the views; removes its search folder at the end.
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
    await $('header').waitForDisplayed({ timeout: 20000 })
    await browser.setWindowSize(1440, 900).catch(() => {})
    const size = await browser.execute(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio])
    console.log('viewport (CSS px) and device pixel ratio', size)
    await $('[data-testid="view-search"]').waitForDisplayed({ timeout: 20000 })
    await shot('01-new-search-empty')

    await $('button=Try the example').click()
    await browser.waitUntil(async () => (await text('[data-testid="fasta-proteins"]')).includes('5 proteins'), { timeout: 20000 })
    await browser.execute(() => window.scrollTo(0, 0))
    await shot('02-new-search-files')

    // (the fake takes its time per scoring step, so that the progress can be seen)
    fakeDelay(3)
    await $('button*=Start search').click()
    await $('[data-testid="search-progress"]').waitForDisplayed({ timeout: 20000 })
    await browser.waitUntil(async () => /Searching|Scoring/.test(await text('[data-testid="search-progress"]')), { timeout: 60000, interval: 200 })
    await browser.waitUntil(async () => /%/.test(await text('[data-testid="search-progress"]')), { timeout: 30000, interval: 200 }).catch(() => {})
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

    // the PSM view of the best cross-link PSM
    await tab('PSMs')
    await jsClick(await rowWith('PSMs', 'XL'))
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
  })
})
