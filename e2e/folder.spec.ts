// Where the searches are saved: New search and History name the folder; "Change…" takes a folder of the user's (the
// folder dialog answered by NUXL_TEST_FOLDER_DIALOG_PATH, e2e/app.sh) when it is empty or holds NuXL's searches only,
// and says why not otherwise; a search then goes there, History lists it with those of the app's own folder, and
// "Use the default folder" goes back with both still listed. The PSM view marks the precursor of the PSM.
// Gated: the search runs only with NUXL_TOOL set (NUXL_FAKE=1 sets it to the stand-in, e2e/run.sh).
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appReady, clearSearches, dataHome, goTo, jsClick, openFirstPsm, runExample, searchesDir, textOf } from './lib.ts'

const enabled = Boolean(process.env.NUXL_TOOL)

/** Waits until the element of `testid` holds `path` (its text: WebKit's WebDriver gives none of a truncated element). */
async function expectPath(testid: string, path: string) {
  let shown = ''
  await browser.waitUntil(async () => (shown = await textOf(`[data-testid="${testid}"]`).catch(() => '')) === path, {
    timeoutMsg: `${testid} is ${JSON.stringify(shown)}, not ${JSON.stringify(path)}`,
  })
}

describe('the searches folder', () => {
  const chosen = () => join(dataHome(), 'chosen-folder')

  before(async () => {
    await appReady()
    rmSync(chosen(), { recursive: true, force: true })
  })

  after(() => {
    clearSearches()
    rmSync(chosen(), { recursive: true, force: true })
  })

  it("is the app's data folder until another is chosen; a folder with other things in it is refused", async () => {
    await goTo('New search')
    await expectPath('searches-folder-path', searchesDir())
    await expect($('[data-testid="searches-folder"]')).toHaveText(expect.stringContaining("(the app's data folder)"))
    await expect($('[data-testid="searches-folder-default"]')).not.toBeExisting()
    mkdirSync(chosen(), { recursive: true })
    writeFileSync(join(chosen(), 'notes.txt'), 'mine')
    await $('[data-testid="searches-folder-change"]').click()
    await expect($('[data-testid="searches-folder-problem"]')).toHaveText(expect.stringContaining('holds other files or folders ("notes.txt")'))
    await expectPath('searches-folder-path', searchesDir())
    expect(existsSync(join(dataHome(), 'org.openms.nuxl.desktop', 'searches-folder.json'))).toBe(false)
  })

  it('an empty folder is taken, kept, and named in History too', async () => {
    rmSync(join(chosen(), 'notes.txt'))
    await $('[data-testid="searches-folder-change"]').click()
    await expectPath('searches-folder-path', chosen())
    await expect($('[data-testid="searches-folder-problem"]')).not.toBeExisting()
    await expect($('[data-testid="searches-folder-default"]')).toBeExisting()
    await goTo('History')
    await expectPath('searches-folder-path', chosen())
    // kept: a reload of the page reads it again from the shim
    await browser.refresh()
    await appReady()
    await goTo('New search')
    await expectPath('searches-folder-path', chosen())
  })

  it('a search goes to the folder chosen; back to the default, History lists it still', async function () {
    if (!enabled) return this.skip()
    const id = await runExample()
    expect(readdirSync(chosen())).toEqual([id])
    expect(existsSync(join(chosen(), id, 'search.json'))).toBe(true)
    expect(existsSync(join(searchesDir(), id))).toBe(false)
    // the Overview names where it is
    await jsClick(await $('[role="tablist"]').$('button*=Overview'))
    await expectPath('search-folder-path', join(chosen(), id))

    // the precursor is marked in the spectrum, at the PSM's m/z, and its peaks are shown
    await openFirstPsm()
    const mark = $('[data-testid="precursor-mark"]')
    await expect(mark).toBeExisting()
    const header = await textOf('[data-testid="psm-header"]')
    const mz = Number(await mark.getAttribute('data-mz'))
    expect(header).toContain(`m/z ${mz.toFixed(4)}`)
    await expect($('[data-testid="precursor-label"]')).toHaveText(expect.stringMatching(/^precursor \d\+$/))
    expect(await $('[data-testid="precursor-toggle"]').getProperty('checked')).toBe(true)

    await goTo('New search')
    await $('[data-testid="searches-folder-default"]').click()
    await expectPath('searches-folder-path', searchesDir())
    await goTo('History')
    await expect($(`[data-testid="history-row"][data-id="${id}"]`)).toBeExisting()
    // deleted from History: its folder goes, the folder chosen stays
    await $(`[data-testid="history-row"][data-id="${id}"]`).$('button*=Delete').click()
    await $('[role="dialog"]').$('button=Delete').click()
    await expect($(`[data-testid="history-row"][data-id="${id}"]`)).not.toBeExisting()
    expect(readdirSync(chosen())).toEqual([])
  })
})
