// Screenshots of the app for docs/screens, at the web app's screenshot size (1440×900), to compare
// with the web app's (docs/screens/compare.html). Not part of the e2e run (the name has no `.spec.`):
//   PROSE_BIN=… e2e/run.sh e2e/screens.shot.ts
// Runs the example as the web app's screenshots did (PeptDeep on), then the views; removes its search
// folder at the end.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { clearSearches, jsClick } from './lib.ts'

const dir = resolve(fileURLToPath(new URL('../docs/screens', import.meta.url)))

async function shot(name: string) {
  // the pointer away from buttons and rows (no hover), and a moment for the paint
  await browser.pause(400)
  mkdirSync(dir, { recursive: true })
  writeFileSync(resolve(dir, `${name}.png`), Buffer.from(await browser.takeScreenshot(), 'base64'))
}

const text = async (selector: string) => String(await $(selector).getProperty('textContent'))

describe('screens', () => {
  after(() => clearSearches())

  it('takes the screenshots', async () => {
    await $('header').waitForDisplayed({ timeout: 20000 })
    await browser.setWindowSize(1440, 900).catch(() => {})
    const size = await browser.execute(() => [window.innerWidth, window.innerHeight])
    console.log('viewport', size)
    await shot('01-new-search-empty')

    await $('button=Try the example').click()
    await browser.waitUntil(async () => (await text('[data-testid="fasta-proteins"]')).includes('4,136 proteins'), { timeout: 20000 })
    // as the web app's screenshots: PeptDeep on
    await $('#peptdeep').click()
    await browser.execute(() => window.scrollTo(0, 0))
    await shot('02-new-search-files')

    await $('button*=Start search').click()
    await $('[data-testid="search-progress"]').waitForDisplayed({ timeout: 20000 })
    await browser.waitUntil(async () => /Searching/.test(await text('[data-testid="search-progress"]')), { timeout: 60000, interval: 200 })
    await shot('03-search-running')

    await browser.waitUntil(async () => /#\/results\/[^/]+$/.test(await browser.getUrl()), { timeout: 180000, interval: 500 })
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
    await shot('04-results-proteins')

    // the first protein's panel, its peptides
    await jsClick((await $$('[role="grid"][aria-label="Proteins"] tbody tr[aria-rowindex]'))[0])
    await $('[data-testid="protein-panel"]').waitForDisplayed({ timeout: 10000 })
    const peptidesTab = await $('[data-testid="protein-panel"]').$('button*=Peptides')
    if (await peptidesTab.isExisting()) await jsClick(peptidesTab)
    await shot('05-protein-panel')
    await browser.keys('Escape')

    // the PSM view of LHVNSAR (the web app's screenshot), else the first PSM
    await jsClick(await $('[role="tablist"]').$('button*=PSMs'))
    const grid = $('[role="grid"][aria-label="PSMs"]')
    await grid.waitForDisplayed({ timeout: 10000 })
    const rows = await grid.$$('tbody tr[aria-rowindex]')
    let target = rows[0]
    for (const r of rows) if (String(await r.getProperty('textContent')).includes('LHVNSAR')) target = r
    await jsClick(target)
    await $('[data-testid="psm-view"]').waitForDisplayed({ timeout: 10000 })
    await shot('06-psm-mirror')
    await browser.keys('Escape')

    await jsClick(await $('[role="tablist"]').$('button=Overview'))
    await $('[data-testid="search-facts"]').waitForDisplayed({ timeout: 10000 })
    await shot('07-overview')

    await jsClick(await $('[role="tablist"]').$('button=QC'))
    await browser.pause(300)
    await shot('08-qc')

    await $('a=History').click()
    await $('[data-testid="view-history"]').waitForDisplayed({ timeout: 10000 })
    await shot('10-history')
  })
})
