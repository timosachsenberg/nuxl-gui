// Screenshots of the app for docs/screens, at 1440×900 CSS pixels. Not part of the e2e run (the name has no
// `.spec.`):
//   NUXL_FAKE=1 e2e/run.sh e2e/screens.shot.ts                                         (or NUXL_TOOL=…)
//   GDK_SCALE=2 E2E_SCREEN=3000x2000x24 NUXL_FAKE=1 e2e/run.sh e2e/screens.shot.ts     (at device scale factor 2)
// GDK_SCALE=2 makes WebKitGTK render at twice the pixels (the screen of xvfb-run has to hold the window: E2E_SCREEN).
// Runs the example, then the views (01-11 light, 12-13 in the dark theme, 14 the PSM view's Measure and Label in use,
// 15 the same in the dark theme; last, 16-17, the new-version banner and the About menu's Check for updates, with
// GitHub's answer stubbed in the page: no request leaves it); removes its search folder at the end. With the fake,
// e2e/run.sh serves the outputs of src/lib/results/fixtures/screens (FAKE_NUXL_RESULTS=screens: OpenNuXL's test 3 on
// the example, 10 ppm, with decoys) in place of the specs' fixtures/example (test 6, searched at 1e9 ppm: unrealistic
// precursor errors).
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { clearSearches, clickSpectrum, fakeDelay, goTo, jsClick, residuePair, tallestPeakAwayFrom } from './lib.ts'

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

/** The release that the stubbed GitHub of 16-17 names as the latest (newer than any version of the app yet). */
const STUB_RELEASE = '9.9.0'

/**
 * GitHub's answer stubbed in the page (until it is loaded again), in its fetch: api.github.com answers with release
 * STUB_RELEASE, and the shim's `update_check_at_start` (Tauri's IPC is a fetch of ipc://localhost/<command> here;
 * `__TAURI_INTERNALS__.invoke` cannot be replaced) answers true in place of NUXL_NO_UPDATE_CHECK's false
 * (e2e/app.sh); other requests go on as before. Called right after a reload, before the check at start (5 s after
 * it): if it came too late, the shim's false stands and nothing is asked of GitHub either.
 */
async function stubGitHub() {
  await browser.execute((version: string) => {
    const w = window as any
    const realFetch = w.fetch.bind(w)
    w.__stubbed = { github: 0, atStart: 0 }
    const json = (body: unknown, headers: Record<string, string> = {}) =>
      Promise.resolve(new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', ...headers } }))
    w.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/^(ipc:\/\/localhost|http:\/\/ipc\.localhost)\/update_check_at_start$/.test(url)) {
        w.__stubbed.atStart++
        return json(true, { 'Tauri-Response': 'ok' })
      }
      if (!url.startsWith('https://api.github.com/')) return realFetch(input, init)
      w.__stubbed.github++
      return json({ tag_name: `desktop-native-v${version}`, name: `NuXL ${version}`, published_at: '2026-11-01T12:00:00Z' })
    }
  }, STUB_RELEASE)
}

/** How often the stubs answered: GitHub's, and the shim's `update_check_at_start`. */
const stubbed = () => browser.execute(() => (window as any).__stubbed as { github: number; atStart: number })

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

/** Measure on, a measurement started at `from`, the pointer on `to` (the live Δ). */
async function halfMeasurement(from: { x: number; y: number }, to: { x: number; y: number }) {
  await $('[data-testid="tool-measure"]').click()
  await clickSpectrum(from)
  await $('[data-testid="measure-start"]').waitForExist({ timeout: 5000 })
  const box = await browser.execute(() => {
    const r = document.querySelector('[data-testid="spectrum"]')!.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ origin: 'viewport', x: Math.round(box.left + to.x), y: Math.round(box.top + to.y) })
    .perform()
  await $('[data-testid="measure-preview"]').waitForExist({ timeout: 5000 })
}

/** A measurement from `from` to `to`, a label at `labelAt`, then a measurement half made from `to` back to `from`. */
async function makeMarks(from: { x: number; y: number }, to: { x: number; y: number }, labelAt: { x: number; y: number }) {
  await $('[data-testid="tool-measure"]').click()
  await clickSpectrum(from)
  await $('[data-testid="measure-start"]').waitForExist({ timeout: 5000 })
  await clickSpectrum(to)
  await $('[data-testid="measurement"]').waitForExist({ timeout: 5000 })
  await $('[data-testid="tool-label"]').click()
  await clickSpectrum(labelAt)
  await $('[data-testid="label-editor"] input').waitForExist({ timeout: 5000 })
  await $('[data-testid="label-editor"] input').setValue('check this peak')
  await browser.keys('Enter')
  await $('[data-testid="user-label"]').waitForExist({ timeout: 5000 })
  await browser.keys('Escape') // the Label tool
  await halfMeasurement(labelAt, from)
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

    // the tools in use: a measurement between two annotated peaks a residue apart ("≈ residue"), a label of one's own
    // on another peak, and Measure on with a second measurement half made (the pointer on its second peak: the live Δ);
    // kept for the dark theme's (15), then cleared, so that the dark theme's PSM view (12) has none
    const [from, to] = await residuePair()
    const away = await tallestPeakAwayFrom([from, to])
    await makeMarks(from, to, away)
    await shot('14-psm-measure')
    await browser.keys('Escape') // the half measurement
    await browser.keys('Escape') // the tool
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
    // (the marks of 14 are kept for the spectrum: a half measurement again for 15, then all of it cleared)
    await $('[data-testid="measurement"]').waitForExist({ timeout: 5000 })
    await halfMeasurement(away, to)
    await shot('15-psm-measure-dark')
    await browser.keys('Escape')
    await browser.keys('Escape')
    await jsClick(await $('[data-testid="clear-measurements"]'))
    await jsClick(await $('[data-testid="clear-labels"]'))
    await browser.action('pointer').move({ origin: 'viewport', x: 2, y: 2 }).perform()
    await shot('12-psm-view-dark')
    await browser.keys('Escape')
    await tab('QC')
    await browser.pause(300)
    await shot('13-qc-dark')
    await jsClick(await $('[data-testid="theme-menu"]'))
    await jsClick(await $('[data-testid="theme-system"]'))
    await browser.keys('Escape')

    // a newer release (stubbed: stubGitHub): the banner of the check at start over the results, then the About
    // menu's Check for updates (last: the page is loaded again, the marks of 14-15 would go); then loaded again (the
    // stubs gone, the banner too)
    await goTo('Results')
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
    await browser.refresh()
    await $('header').waitForDisplayed({ timeout: 30000 })
    await stubGitHub()
    await $('[data-testid="update-banner"]')
      .waitForDisplayed({ timeout: 15000 })
      .catch(async (e) => {
        throw new Error(`no banner (the stubs answered ${JSON.stringify(await stubbed())}): ${e}`)
      })
    await expect($('[data-testid="update-banner"]')).toHaveText(expect.stringContaining(`NuXL ${STUB_RELEASE} is available`))
    await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 20000 })
    await browser.action('pointer').move({ origin: 'viewport', x: 2, y: 2 }).perform()
    await shot('16-update-available')
    await jsClick(await $('[data-testid="about-menu"]'))
    await $('[data-testid="about-panel"]').waitForDisplayed({ timeout: 10000 })
    await jsClick(await $('[data-testid="update-check"]'))
    await expect($('[data-testid="update-result"]')).toHaveText(expect.stringContaining(`NuXL ${STUB_RELEASE} is available.`))
    expect(await stubbed()).toEqual({ github: 2, atStart: 1 })
    await browser.action('pointer').move({ origin: 'viewport', x: 2, y: 2 }).perform()
    await shot('17-about-check-for-updates')
    await browser.keys('Escape')
    await browser.refresh()
    await $('header').waitForDisplayed({ timeout: 30000 })
  })
})
