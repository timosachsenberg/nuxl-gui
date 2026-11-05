// Helpers of the specs: the app's data folder, the processes on the machine, files dropped on the window,
// and the steps of a search through the screens. Not a spec (no `.spec.` in the name).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The example's run and FASTA, as the app bundles them (src-tauri/resources/example). */
export const EXAMPLE_DIR = resolve(fileURLToPath(new URL('../src-tauri/resources/example', import.meta.url)))
export const EXAMPLE_MZML = join(EXAMPLE_DIR, 'OpenNuXL_1_input.mzML')
export const EXAMPLE_FASTA = join(EXAMPLE_DIR, 'OpenNuXL_1_input.fasta')

/**
 * A stand-in for a Thermo .raw file at `path` (the fake tools read no vendor data: e2e/fake; the shim checks only that
 * it is a file that is not empty). Returns `path`.
 */
export function fakeRaw(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, Buffer.concat([Buffer.from([0x01, 0xa1]), Buffer.from('Finnigan', 'utf16le'), Buffer.alloc(1024)]))
  return path
}

/**
 * A stand-in for a Bruker timsTOF .d folder at `path`: analysis.tdf (the start of an SQLite file) and
 * analysis.tdf_bin, which the shim looks for (the fake tools read neither). Returns `path`.
 */
export function fakeTimsD(path: string): string {
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'analysis.tdf'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4080)]))
  writeFileSync(join(path, 'analysis.tdf_bin'), Buffer.alloc(8192, 7))
  return path
}

/** The spec's own data folder (XDG_DATA_HOME of its app; wdio.conf.ts sets it). */
export function dataHome(): string {
  const home = process.env.E2E_DATA_HOME
  if (!home) throw new Error('E2E_DATA_HOME is not set: run the specs through e2e/wdio.conf.ts')
  return home
}

/** The folder of the app's searches, `appDataDir()/searches`. */
export const searchesDir = () => join(dataHome(), 'org.openms.nuxl.desktop', 'searches')

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

/** OpenNuXL processes working in the spec's data folder (the tool's command line names the search folder). */
export const toolProcesses = () => findProcesses(dataHome(), 'OpenNuXL')

/** The app processes (the debug build) of the spec's data folder: found by the XDG_DATA_HOME of their environment. */
export function appProcesses(): Proc[] {
  const found: Proc[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (readFileSync(`/proc/${entry}/comm`, 'utf8').trim() !== 'nuxl-desktop') continue
      const env = readFileSync(`/proc/${entry}/environ`, 'utf8').split('\0')
      if (env.includes(`XDG_DATA_HOME=${dataHome()}`)) {
        found.push({ pid: Number(entry), comm: 'nuxl-desktop', cmdline: readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').join(' ') })
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
  const ids = [...tree.matchAll(/^\s+(0x[0-9a-f]+) "NuXL":/gm)].map((m) => m[1])
  const window = ids.find((id) => {
    const pid = /_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(execFileSync('xprop', ['-id', id, '_NET_WM_PID']).toString())?.[1]
    return Number(pid) === appPid
  })
  if (!window) throw new Error(`no window of process ${appPid} (windows: ${ids.join(', ') || 'none'})`)
  execFileSync(resolve(fileURLToPath(new URL('.', import.meta.url)), 'close-window.py'), [window])
}

/**
 * Whether the specs run against the stand-in for OpenNuXL (e2e/run.sh with NUXL_FAKE=1: e2e/fake/OpenNuXL, which
 * writes the example's outputs of src/lib/results/fixtures/example for every input). Its counts are known
 * (EXAMPLE_PSMS); a real OpenNuXL's depend on its version, so the specs then compare searches with each other.
 */
export const FAKE = Boolean(process.env.NUXL_FAKE)

/** The example's FASTA, as New search counts it (OpenNuXL_1_input.fasta: src-tauri/tests/files.rs). */
export const EXAMPLE_PROTEINS = '5 proteins'

/** The PSMs and cross-link PSMs of one run of the example at the default FDRs (1 %): the fake's (its outputs); null with a real tool. */
export const EXAMPLE_PSMS: { psms: number; xls: number } | null = FAKE ? { psms: 17, xls: 14 } : null

/**
 * How long each scoring step of the fake takes (seconds; 0: no wait), for a search that is to be seen running,
 * cancelled or closed: the file fake-nuxl.delay in the app's data folder, which the fake reads (src-tauri/tests/
 * fake-nuxl.sh). Nothing with a real tool.
 */
export function fakeDelay(seconds: number) {
  if (!FAKE) return
  const dir = join(dataHome(), 'org.openms.nuxl.desktop')
  mkdirSync(dir, { recursive: true })
  if (seconds > 0) writeFileSync(join(dir, 'fake-nuxl.delay'), String(seconds))
  else rmSync(join(dir, 'fake-nuxl.delay'), { force: true })
}

/** The number shown in a count of the results' summary (`psm-count`, `xl-psm-count`, ...): its first number. */
export async function countOf(testid: string): Promise<number> {
  const text = String(await $(`[data-testid="${testid}"]`).getProperty('textContent'))
  const m = /\d[\d,]*/.exec(text)
  if (!m) throw new Error(`no number in ${testid}: ${text}`)
  return Number(m[0].replace(/,/g, ''))
}

/**
 * A finished search of the example, through the screens, for a test that needs a result: a fresh New
 * search form, "Try the example", Start, and the results open. Returns the search's id.
 */
export async function runExample(): Promise<string> {
  await freshForm()
  await $('button=Try the example').click()
  await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
  await $('button*=Start search').click()
  const id = await waitForResults()
  await $('[data-testid="psm-count"]').waitForDisplayed({ timeout: 30000 })
  return id
}

/**
 * New search with nothing chosen and the example's own setting set by hand (it ends with its files: Start over gives
 * back the preset's): its precursor tolerance, 10 ppm (OpenMS' test of OpenNuXL; the preset's is 6 ppm).
 */
export async function exampleSettings() {
  await freshForm()
  await $('#precursor-tolerance').setValue('10')
  await $('#missed-cleavages').click()
  await expect($('#precursor-tolerance')).toHaveValue('10')
  await expect($('button[aria-label^="Precursor tolerance unit: ppm"]')).toBeExisting()
}

/** The files of `longSearch`: copies of the example's run, XL_run_1.mzML … XL_run_<n>.mzML, in the spec's data folder. */
export const LONG_SEARCH_FILES = 24

/**
 * A search that is long enough to be cancelled, killed or closed while a file is searched: the example searches in
 * a few seconds, so its run goes in as LONG_SEARCH_FILES files (copies in the spec's data folder), with the example's
 * settings and FASTA (the fake takes a second per scoring step: fakeDelay). Started; resolves when its progress is
 * shown.
 */
export async function startLongSearch() {
  const dir = join(dataHome(), 'long-search')
  mkdirSync(dir, { recursive: true })
  const files = Array.from({ length: LONG_SEARCH_FILES }, (_, i) => join(dir, `XL_run_${i + 1}.mzML`))
  for (const f of files) if (!existsSync(f)) copyFileSync(EXAMPLE_MZML, f)
  fakeDelay(1)
  await exampleSettings()
  await dropFiles([...files, EXAMPLE_FASTA])
  await expect($('[data-testid="design-summary"]')).toHaveText(expect.stringContaining(`${LONG_SEARCH_FILES} files`))
  await expect($('[data-testid="fasta-proteins"]')).toHaveText(EXAMPLE_PROTEINS)
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
  // its peaks are read from its input mzML when it is opened
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

/** Residues' masses (Residue::Internal) for a Δm/z between two annotated peaks. */
export const RESIDUES: Record<string, number> = {
  G: 57.02146,
  A: 71.03711,
  S: 87.03203,
  P: 97.05276,
  V: 99.06841,
  T: 101.04768,
  'I/L': 113.08406,
  N: 114.04293,
  D: 115.02694,
  Q: 128.05858,
  K: 128.09496,
  E: 129.04259,
  M: 131.04049,
  H: 137.05891,
  F: 147.06841,
  R: 156.10111,
  Y: 163.06333,
  W: 186.07931,
}

export type SpectrumPoint = { x: number; y: number; mz: number; delta: number; residue: string }

/**
 * Two annotated peaks of the PSM view's spectrum (their labels' m/z) one residue apart (within 5 mDa, and one only),
 * with where their sticks end in the SVG (its m/z scale, its paths).
 */
export async function residuePair(): Promise<[SpectrumPoint, SpectrumPoint]> {
  const pair = await browser.execute((residues: Record<string, number>) => {
    const svg = document.querySelector('[data-testid="spectrum"]')!
    const [d0, d1] = svg.getAttribute('data-mz-domain')!.split(' ').map(Number)
    const [r0, r1] = svg.getAttribute('data-x-range')!.split(' ').map(Number)
    const paths = [...svg.querySelectorAll('[data-testid="matched-peaks"]')].map((p) => p.getAttribute('d') ?? '')
    const at = (mz: number) => {
      const x = Math.round((r0 + ((mz - d0) * (r1 - r0)) / (d1 - d0)) * 10) / 10
      let y = Infinity
      for (const d of paths) for (const m of d.matchAll(/M(-?[\d.]+) (-?[\d.]+)V(-?[\d.]+)/g)) if (Number(m[1]) === x) y = Math.min(y, Number(m[3]))
      return { x, y }
    }
    const mzs = [...svg.querySelectorAll('[data-testid="peak-label"]')].map((l) => Number(l.getAttribute('data-mz'))).sort((p, q) => p - q)
    for (let i = 0; i < mzs.length; i++) {
      for (let j = i + 1; j < mzs.length; j++) {
        const delta = mzs[j] - mzs[i]
        const hits = Object.entries(residues).filter(([, mass]) => Math.abs(delta - mass) < 0.005)
        const [a, b] = [at(mzs[i]), at(mzs[j])]
        // (apart on screen, so that each click snaps to its own peak)
        if (hits.length === 1 && Number.isFinite(a.y) && Number.isFinite(b.y) && b.x - a.x > 30) {
          return [
            { ...a, mz: mzs[i], delta, residue: hits[0][0] },
            { ...b, mz: mzs[j], delta, residue: hits[0][0] },
          ]
        }
      }
    }
    return null
  }, RESIDUES)
  if (!pair) throw new Error("no two annotated peaks of the PSM's spectrum are a residue apart")
  return pair as [SpectrumPoint, SpectrumPoint]
}

/** The m/z of the peaks of the PSM view's spectrum that have NuXL's labels. */
export async function labelledMzs(): Promise<number[]> {
  return browser.execute(() => [...document.querySelectorAll('[data-testid="peak-label"]')].map((l) => Number(l.getAttribute('data-mz'))))
}

/** A click of the pointer at a point of the spectrum's SVG (scrolled into the middle of the view first). */
export async function clickSpectrum(p: { x: number; y: number }) {
  const box = await browser.execute(() => {
    const svg = document.querySelector('[data-testid="spectrum"]')!
    svg.scrollIntoView({ block: 'center' })
    const r = svg.getBoundingClientRect()
    return { left: r.left, top: r.top }
  })
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ origin: 'viewport', x: Math.round(box.left + p.x), y: Math.round(box.top + p.y) })
    .down()
    .up()
    .perform()
}

/** Where the tallest stick of the spectrum ends that is more than 60 px from each of `points` (for a label). */
export async function tallestPeakAwayFrom(points: { x: number }[]): Promise<{ x: number; y: number }> {
  return browser.execute((xs: number[]) => {
    const svg = document.querySelector('[data-testid="spectrum"]')!
    let best = { x: NaN, y: Infinity }
    for (const p of svg.querySelectorAll('[data-testid="matched-peaks"], [data-testid="unmatched-peaks"]')) {
      for (const m of (p.getAttribute('d') ?? '').matchAll(/M(-?[\d.]+) (-?[\d.]+)V(-?[\d.]+)/g)) {
        const [x, y] = [Number(m[1]), Number(m[3])]
        if (y < best.y && xs.every((at) => Math.abs(at - x) > 60)) best = { x, y }
      }
    }
    return best
  }, points.map((p) => p.x))
}
