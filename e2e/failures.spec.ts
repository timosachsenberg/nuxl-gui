// A search that is cancelled, and one whose OpenNuXL is killed from outside: neither leaves anything in
// History or in the searches folder, the failure names its stage, and the next search runs.
// With the fake (NUXL_FAKE=1), also an OpenNuXL that fails: the app shows OpenNuXL's own message.
// Gated: runs only with NUXL_TOOL set (the app inherits it; NUXL_FAKE=1 sets it to the stand-in, e2e/run.sh).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  appReady,
  clearSearches,
  countOf,
  dataHome,
  dropFiles,
  EXAMPLE_FASTA,
  EXAMPLE_MZML,
  EXAMPLE_PROTEINS,
  EXAMPLE_PSMS,
  exampleSettings,
  FAKE,
  fakeDelay,
  goTo,
  LONG_SEARCH_FILES,
  toolProcesses,
  resultsId,
  searchesDir,
  searchFolders,
  startLongSearch,
  textOf,
  waitForResults,
} from './lib.ts'

const enabled = Boolean(process.env.NUXL_TOOL)

/** New search with the example's run as many files (lib.ts startLongSearch), and Start. */
const startExample = startLongSearch

/** The search is in a file's step (the file is being searched or scored). */
const searching = () =>
  browser.waitUntil(async () => /Searching|Scoring/.test(await textOf('[data-testid="search-progress"]')), {
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
  fakeDelay(0)
  await goTo('New search')
  // New search kept the files and the choices; Start again
  await $('button*=Start search').waitForClickable({ timeout: 20000 })
  await $('button*=Start search').click()
  await waitForResults()
  await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 30000 })
  expect(await textOf('[data-testid="result-chip"]')).toContain(`${LONG_SEARCH_FILES} files`)
  // each copy of the example's run has the example's PSMs
  if (EXAMPLE_PSMS) expect(await countOf('psm-count')).toBe(EXAMPLE_PSMS.psms * LONG_SEARCH_FILES)
  expect(searchFolders().finished).toHaveLength(1)
  expect(searchFolders().partial).toEqual([])
}

describe('a search that does not finish', () => {
  before(async function () {
    if (!enabled) {
      console.log('skipped: set NUXL_TOOL (or NUXL_FAKE=1) to run searches through the app')
      this.skip()
    }
    await appReady()
  })

  afterEach(() => {
    fakeDelay(0)
    clearSearches()
  })

  it('cancel leaves nothing in History and the next search runs', async () => {
    await startExample()
    await searching()
    expect(searchFolders().partial).toHaveLength(1)
    await $('button=Cancel').click()
    // the footer is the plan and Start again; the process is gone before the cancel returns
    await $('button*=Start search').waitForDisplayed({ timeout: 30000 })
    expect(toolProcesses()).toEqual([])
    expect(await resultsId()).toBeNull()
    expect(await $$('[data-testid="search-error"]')).toHaveLength(0)
    await expectNothingKept()
    await nextSearchRuns()
  })

  it('a killed OpenNuXL reports and the next search runs', async () => {
    await startExample()
    await searching()
    // OpenNuXL is found by its command line, which names the search folder in this spec's data folder
    let pid = 0
    await browser.waitUntil(
      () => {
        const found = toolProcesses()
        if (found.length === 0) return false
        pid = found[0].pid
        return true
      },
      { timeout: 20000, timeoutMsg: 'no OpenNuXL process was found' },
    )
    process.kill(pid, 'SIGKILL')

    const error = $('[data-testid="search-error"]')
    await error.waitForDisplayed({ timeout: 30000 })
    const text = String(await error.getProperty('textContent'))
    expect(text).toContain('The search stopped')
    // the stage and the file it was searching, and what happened to OpenNuXL
    expect(text).toContain('While searching')
    expect(text).toMatch(/XL_run_\d+\.mzML/)
    // how OpenNuXL ended leads the message
    expect(text).toContain('OpenNuXL crashed (signal 9, SIGKILL')
    // its log is kept in the app's data (and named in the details)
    const log = join(dirname(searchesDir()), 'logs', 'last-failure.log')
    expect(existsSync(log)).toBe(true)
    expect(readFileSync(log, 'utf8')).toMatch(/^\$ .*OpenNuXL/)
    expect(text).toContain(log)
    expect(await resultsId()).toBeNull()
    await expect($('button*=Start search')).toBeDisplayed()
    expect(toolProcesses()).toEqual([])
    await expectNothingKept()
    await nextSearchRuns()
  })

  it("an OpenNuXL that fails shows OpenNuXL's message, and keeps nothing", async function () {
    if (!FAKE) {
      console.log('skipped: needs the fake OpenNuXL (NUXL_FAKE=1), which fails for an input named crash.mzML')
      return this.skip()
    }
    const dir = join(dataHome(), 'failing')
    mkdirSync(dir, { recursive: true })
    const crash = join(dir, 'crash.mzML')
    copyFileSync(EXAMPLE_MZML, crash)
    await exampleSettings()
    await dropFiles([crash, EXAMPLE_FASTA])
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
    await $('button*=Start search').click()
    const error = $('[data-testid="search-error"]')
    await error.waitForDisplayed({ timeout: 30000 })
    const text = String(await error.getProperty('textContent'))
    expect(text).toContain('The search stopped')
    expect(text).toContain('crash.mzML')
    // OpenNuXL's own error line (stderr), and how it ended
    expect(text).toContain('Unable to read file')
    expect(text).toContain('OpenNuXL ended with exit code 3')
    expect(await resultsId()).toBeNull()
    expect(toolProcesses()).toEqual([])
    await expectNothingKept()
  })
})
