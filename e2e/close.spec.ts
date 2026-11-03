// The window closes during a search: the app asks first; closed, it ends, and no ProSE of its data folder
// outlives it.
// Gated: runs only with PROSE_BIN set (the app inherits it). These tests end the app, so they have a file
// of their own. Each test starts its own search and ends the app, so each runs alone.
import {
  appProcesses,
  appReady,
  clearSearches,
  closeWindowLikeAUser,
  proseProcesses,
  searchFolders,
  startLongSearch,
  textOf,
  windowCloseToolsMissing,
} from './lib.ts'

const enabled = Boolean(process.env.PROSE_BIN)

/** A search (the example's run as many files, lib.ts startLongSearch), started and in a file's step: ProSE runs. */
async function searchRunning() {
  await startLongSearch()
  await browser.waitUntil(async () => /Searching/.test(await textOf('[data-testid="search-progress"]')), { timeout: 60000, interval: 100 })
  expect(proseProcesses()).toHaveLength(1)
  expect(appProcesses()).toHaveLength(1)
  expect(searchFolders().partial).toHaveLength(1)
}

const gone = (what: () => unknown[], message: string) => browser.waitUntil(() => what().length === 0, { timeout: 30000, interval: 100, timeoutMsg: message })

describe('closing the window', () => {
  before(async function () {
    if (!enabled) {
      console.log('skipped: set PROSE_BIN to run a search through the app')
      this.skip()
    }
    await appReady()
  })

  afterEach(() => clearSearches())

  it('closing the window asks first, and then ends ProSE', async function () {
    const missing = windowCloseToolsMissing()
    if (missing) {
      console.log(`skipped: the window-manager close ${missing} (see the README)`)
      return this.skip()
    }
    await searchRunning()
    // the close button: the window gets the request of a window manager, and the app asks
    const app = appProcesses()[0].pid
    closeWindowLikeAUser(app)
    const guard = $('[data-testid="close-guard"]')
    await guard.waitForDisplayed({ timeout: 20000 })
    expect(await guard.getProperty('textContent')).toContain('A search is running')
    // "Keep searching": the window stays, and the search goes on
    await guard.$('button=Keep searching').click()
    await guard.waitForDisplayed({ reverse: true, timeout: 10000 })
    expect(appProcesses().map((p) => p.pid)).toEqual([app])
    expect(proseProcesses()).toHaveLength(1)
    // (the search goes on: its progress is shown, whatever step it is in)
    expect(await $('[data-testid="search-progress"]').isDisplayed()).toBe(true)
    // asked again: "Close ProSE" closes as before
    closeWindowLikeAUser(app)
    await guard.waitForDisplayed({ timeout: 20000 })
    // (the app ends while WebDriver's click is on its way: the session ends with it)
    await guard
      .$('button=Close ProSE')
      .click()
      .catch(() => {})
    await gone(appProcesses, 'the app is still running')
    // no ProSE is left, and the search that was cut short leaves no folder: the app stopped it
    expect(proseProcesses()).toEqual([])
    expect(searchFolders()).toEqual({ finished: [], partial: [] })
    // (the app starts again for the next test)
    await browser.reloadSession()
    await appReady()
  })

  it('a window closed through WebDriver leaves no ProSE either', async () => {
    await searchRunning()
    // Close Window of WebDriver ends the session, and WebKitWebDriver ends the app itself
    await browser.closeWindow().catch(() => {})
    await gone(appProcesses, 'the app is still running')
    expect(proseProcesses()).toEqual([])
  })
})
