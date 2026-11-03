// A search that is cancelled, and one whose ProSE is killed from outside: neither leaves anything in
// History or in the searches folder, the failure names its stage, and the next search runs.
// Gated: runs only with PROSE_BIN set (the app inherits it).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appReady,
  clearSearches,
  goTo,
  LONG_SEARCH_FILES,
  proseProcesses,
  resultsId,
  searchesDir,
  searchFolders,
  startLongSearch,
  textOf,
  waitForResults,
} from './lib.ts'

const enabled = Boolean(process.env.PROSE_BIN)

/** New search with the example's run as many files (lib.ts startLongSearch), and Start. */
const startExample = startLongSearch

/** The search is in a file's step (the file is being searched). */
const searching = () =>
  browser.waitUntil(async () => /Searching/.test(await textOf('[data-testid="search-progress"]')), {
    timeout: 60000,
    interval: 100,
    timeoutMsg: 'the search never got to a file',
  })

/** Nothing of a search is on disk or in History. */
async function expectNothingKept() {
  expect(searchFolders()).toEqual({ finished: [], partial: [] })
  await goTo('History')
  await $('[data-testid="history-empty"]').waitForDisplayed({ timeout: 20000 })
}

/** The next search runs: the same files once more, to its results. */
async function nextSearchRuns() {
  await goTo('New search')
  // New search kept the files and the choices; Start again
  await $('button*=Start search').waitForClickable({ timeout: 20000 })
  await $('button*=Start search').click()
  await waitForResults()
  // each copy of the example's run has the example's 77 PSMs
  await expect($('[data-testid="psm-count"]')).toHaveText(expect.stringContaining((77 * LONG_SEARCH_FILES).toLocaleString('en-US')))
  expect(searchFolders().finished).toHaveLength(1)
  expect(searchFolders().partial).toEqual([])
}

describe('a search that does not finish', () => {
  before(async function () {
    if (!enabled) {
      console.log('skipped: set PROSE_BIN to run searches through the app')
      this.skip()
    }
    await appReady()
  })

  afterEach(() => clearSearches())

  it('cancel leaves nothing in History and the next search runs', async () => {
    await startExample()
    await searching()
    expect(searchFolders().partial).toHaveLength(1)
    await $('button=Cancel').click()
    // the footer is the plan and Start again; the process is gone before the cancel returns
    await $('button*=Start search').waitForDisplayed({ timeout: 30000 })
    expect(proseProcesses()).toEqual([])
    expect(await resultsId()).toBeNull()
    expect(await $$('[data-testid="search-error"]')).toHaveLength(0)
    await expectNothingKept()
    await nextSearchRuns()
  })

  it('a killed ProSE reports and the next search runs', async () => {
    await startExample()
    await searching()
    // ProSE is found by its command line, which names the search folder in this spec's data folder
    let pid = 0
    await browser.waitUntil(
      () => {
        const found = proseProcesses()
        if (found.length === 0) return false
        pid = found[0].pid
        return true
      },
      { timeout: 20000, timeoutMsg: 'no ProSE process was found' },
    )
    process.kill(pid, 'SIGKILL')

    const error = $('[data-testid="search-error"]')
    await error.waitForDisplayed({ timeout: 30000 })
    const text = String(await error.getProperty('textContent'))
    expect(text).toContain('The search stopped')
    // the stage and the file it was searching, and what happened to ProSE
    expect(text).toContain('While searching')
    expect(text).toMatch(/Ecoli_\d+\.mzML/)
    // how ProSE ended leads the message
    expect(text).toContain('ProSE crashed (signal 9, SIGKILL')
    // its log is kept in the app's data (and named in the details)
    const log = join(dirname(searchesDir()), 'logs', 'last-failure.log')
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log, 'utf8')).toMatch(/^\$ .*ProSE/)
    expect(text).toContain(log)
    expect(await resultsId()).toBeNull()
    await expect($('button*=Start search')).toBeDisplayed()
    expect(proseProcesses()).toEqual([])
    await expectNothingKept()
    await nextSearchRuns()
  })
})
