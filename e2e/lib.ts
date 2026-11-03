// Helpers of the specs: the app's data folder, the processes on the machine, files dropped on the window,
// and the steps of a search through the screens. Not a spec (no `.spec.` in the name).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The example's run and FASTA, as the app bundles them (src-tauri/resources/example). */
export const EXAMPLE_DIR = resolve(fileURLToPath(new URL('../src-tauri/resources/example', import.meta.url)))
export const EXAMPLE_MZML = join(EXAMPLE_DIR, 'Ecoli_MS2_small.mzML')
export const EXAMPLE_FASTA = join(EXAMPLE_DIR, 'Ecoli_K12_proteome.fasta')

/** The spec's own data folder (XDG_DATA_HOME of its app; wdio.conf.ts sets it). */
export function dataHome(): string {
  const home = process.env.E2E_DATA_HOME
  if (!home) throw new Error('E2E_DATA_HOME is not set: run the specs through e2e/wdio.conf.ts')
  return home
}

/** The folder of the app's searches, `appDataDir()/searches`. */
export const searchesDir = () => join(dataHome(), 'org.openms.prose.desktop', 'searches')

/** The folders of the searches dir: finished (`<id>`) and running (`<id>.partial`). */
export function searchFolders(): { finished: string[]; partial: string[] } {
  const dir = searchesDir()
  const names = existsSync(dir) ? readdirSync(dir) : []
  return { finished: names.filter((n) => !n.endsWith('.partial')), partial: names.filter((n) => n.endsWith('.partial')) }
}

/** Removes every search of the spec's data folder (a spec cleans up after itself). */
export function clearSearches() {
  rmSync(searchesDir(), { recursive: true, force: true })
}

export type Proc = { pid: number; comm: string; cmdline: string }

/** The processes whose command line contains `needle` (a scan of /proc, arguments joined by spaces). */
export function findProcesses(needle: string, comm?: string): Proc[] {
  const found: Proc[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ').trim()
      const name = readFileSync(`/proc/${entry}/comm`, 'utf8').trim()
      if (cmdline.includes(needle) && (comm === undefined || name === comm)) found.push({ pid: Number(entry), comm: name, cmdline })
    } catch {
      // the process ended meanwhile
    }
  }
  return found
}

/** ProSE processes working in the spec's data folder (the tool's command line names the search folder). */
export const proseProcesses = () => findProcesses(dataHome(), 'ProSE')

/** The app processes (the debug build) of the spec's data folder: found by the XDG_DATA_HOME of their environment. */
export function appProcesses(): Proc[] {
  const found: Proc[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() !== 'prose-desktop') continue
      const env = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0')
      if (env.includes(`XDG_DATA_HOME=${dataHome()}`)) {
        found.push({ pid: Number(entry), comm: 'prose-desktop', cmdline: readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ') })
      }
    } catch {
      // ended meanwhile, or not ours to read
    }
  }
  return found
}

/** The peak resident memory (VmHWM, kB) of a process. */
export function peakMemoryKb(pid: number): number | null {
  try {
    const m = /^VmHWM:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

/** Calls a command of the app: { result }, or { failure } with the error text. */
export async function invoke(command: string, args: object = {}): Promise<{ result?: any; failure?: string }> {
  return browser.execute(
    async (command: string, args: object) => {
      try {
        return { result: await (window as any).__TAURI_INTERNALS__.invoke(command, args) }
      } catch (error) {
        return { failure: typeof error === 'string' ? error : JSON.stringify(error) }
      }
    },
    command,
    args,
  )
}

/**
 * Drops files on the window as the file manager does: the webview's `tauri://drag-drop` event with the
 * files' paths (WebDriver cannot drag from outside the page, and the open dialog is the system's).
 * New search listens for drops while it is shown; its listener is registered by a command of the app, so a
 * round trip of another command of the app, made after the view shows, comes after the registration.
 */
export async function dropFiles(paths: string[]) {
  await $('[data-testid="view-search"]').waitForDisplayed({ timeout: 20000 })
  await browser.execute(async (paths: string[]) => {
    const internals = (window as any).__TAURI_INTERNALS__
    await internals.invoke('plugin:event|listen', {
      event: 'e2e://flush',
      target: { kind: 'Any' },
      handler: internals.transformCallback(() => {}),
    })
    await internals.invoke('plugin:event|emit', {
      event: 'tauri://drag-drop',
      payload: { paths, position: { x: 10, y: 10 } },
    })
  }, paths)
}

/** A click in the page (WebKitWebDriver does not take table rows as interactable). */
export const jsClick = (el: WebdriverIO.Element) => browser.execute((e: HTMLElement) => e.click(), el as unknown as HTMLElement)

export const textOf = async (selector: string) => String(await $(selector).getProperty('textContent'))

/** The id of the search whose results are shown (the route `#/results/<id>`), or null. */
export async function resultsId(): Promise<string | null> {
  return /#\/results\/([^/]+)$/.exec(await browser.getUrl())?.[1] ?? null
}

/** Opens a view by its link in the top bar. */
export async function goTo(view: 'New search' | 'Results' | 'History') {
  await $('nav[aria-label="Main"]').$(`a=${view}`).click()
}

/** New search without the files and choices of an earlier search (the page is loaded again). */
export async function freshForm() {
  await browser.refresh()
  await $('header').waitForDisplayed({ timeout: 30000 })
  await goTo('New search')
}

/** The app is up (its top bar shows). */
export async function appReady() {
  await $('header').waitForDisplayed({ timeout: 30000 })
}

/** Waits for the results of a search that has been started, and returns its id. */
export async function waitForResults(timeout = 180000): Promise<string> {
  await browser.waitUntil(async () => (await resultsId()) !== null, { timeout, interval: 500, timeoutMsg: 'the search did not open its result' })
  return (await resultsId())!
}

/**
 * Closes the app's window as the user does with the close button: a WM_DELETE_WINDOW request to the
 * window of the app process (found by its _NET_WM_PID) on the display of the run (xvfb-run).
 */
export function closeWindowLikeAUser(appPid: number) {
  const tree = execFileSync('xwininfo', ['-root', '-tree']).toString()
  const ids = [...tree.matchAll(/^\s+(0x[0-9a-f]+) "ProSE":/gm)].map((m) => m[1])
  const window = ids.find((id) => {
    const pid = /_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(execFileSync('xprop', ['-id', id, '_NET_WM_PID']).toString())?.[1]
    return Number(pid) === appPid
  })
  if (!window) throw new Error(`no window of process ${appPid} (windows: ${ids.join(', ') || 'none'})`)
  execFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), 'close-window.py'), [window])
}

/**
 * A finished search of the example, through the screens, for a test that needs a result: a fresh New
 * search form, "Try the example", Start, and the results open. Returns the search's id.
 */
export async function runExample(options: { peptdeep?: boolean } = {}): Promise<string> {
  await freshForm()
  await $('button=Try the example').click()
  await expect($('[data-testid="fasta-proteins"]')).toHaveText('4,136 proteins')
  if (options.peptdeep) {
    await $('#peptdeep').click()
    await expect($('#peptdeep')).toHaveAttribute('aria-checked', 'true')
  }
  await $('button*=Start search').click()
  const id = await waitForResults()
  await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 30000 })
  return id
}

/**
 * New search with nothing chosen and the example's own settings set by hand (they end with its files: Start over gives
 * back the preset's): its fragment tolerance, 0.5 Da, its PSM FDR, 2 % (the run is too small for 1 %), and no protein
 * FDR.
 */
export async function exampleSettings() {
  await freshForm()
  await $('button[aria-label^="Fragment tolerance unit: ppm"]').click()
  await $('#fragment-tolerance').setValue('0.5')
  await expect($('button[aria-label^="Fragment tolerance unit: Da"]')).toBeExisting()
  await expect($('#fragment-tolerance')).toHaveValue('0.5')
  await $('#psm-fdr').setValue('2')
  await $('#protein-fdr').setValue('off')
  await $('#fragment-tolerance').click()
  await expect($('#psm-fdr')).toHaveValue('2')
  await expect($('#protein-fdr')).toHaveValue('off')
}

/** The files of `longSearch`: copies of the example's run, Ecoli_1.mzML … Ecoli_<n>.mzML, in the spec's data folder. */
export const LONG_SEARCH_FILES = 24

/**
 * A search that is long enough to be cancelled, killed or closed while a file is searched: the example searches in
 * a few seconds, so its run goes in as LONG_SEARCH_FILES files (copies in the spec's data folder), with the example's
 * settings and FASTA. Started; resolves when its progress is shown.
 */
export async function startLongSearch() {
  const dir = join(dataHome(), 'long-search')
  mkdirSync(dir, { recursive: true })
  const files = Array.from({ length: LONG_SEARCH_FILES }, (_, i) => join(dir, `Ecoli_${i + 1}.mzML`))
  for (const f of files) if (!existsSync(f)) copyFileSync(EXAMPLE_MZML, f)
  await exampleSettings()
  await dropFiles([...files, EXAMPLE_FASTA])
  await expect($('[data-testid="design-summary"]')).toHaveText(expect.stringContaining(`${LONG_SEARCH_FILES} files`))
  await expect($('[data-testid="fasta-proteins"]')).toHaveText('4,136 proteins')
  await $('button*=Start search').click()
  await $('[data-testid="search-progress"]').waitForDisplayed({ timeout: 20000 })
}

/** Opens the PSM view of the first PSM in the PSMs tab of the results. */
export async function openFirstPsm() {
  await jsClick(await $('[role="tablist"]').$('button*=PSMs'))
  const grid = $('[role="grid"][aria-label="PSMs"]')
  await grid.waitForDisplayed({ timeout: 10000 })
  await browser.waitUntil(async () => (await grid.$$('tbody tr[aria-rowindex]')).length > 0)
  await jsClick((await grid.$$('tbody tr[aria-rowindex]'))[0])
  await $('[data-testid="psm-view"]').waitForDisplayed({ timeout: 10000 })
  // its spectrum is read from its input's psm file when it is opened
  await browser.waitUntil(async () => !(await $('[data-testid="spectrum-loading"]').isExisting()), { timeout: 10000 })
}

/** What `closeWindowLikeAUser` needs and the host lacks (xwininfo, xprop, python3 with libX11), or null. */
export function windowCloseToolsMissing(): string | null {
  const probes: [string, string[]][] = [
    ['xwininfo', ['-version']],
    ['xprop', ['-version']],
    ['python3', ['-c', 'import ctypes.util, sys; sys.exit(0 if ctypes.util.find_library("X11") else 1)']],
  ]
  const missing = probes.filter(([tool, args]) => {
    try {
      execFileSync(tool, args, { stdio: 'ignore' })
      return false
    } catch {
      return true
    }
  })
  return missing.length === 0 ? null : `needs ${missing.map(([t]) => (t === 'python3' ? 'python3 with libX11' : t)).join(', ')} on the host`
}
