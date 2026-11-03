// The Rust shim through the app's IPC: tool_info, start_search with its events, cancel_search.
// Gated: runs only with PROSE_BIN set (the app inherits it) and the example data (PROSE_EXAMPLE_DIR, default the
// app's src-tauri/resources/example). It writes the finished search into the app data folder and removes it at the
// end.
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXAMPLE_DIR } from './lib.ts'

const example = process.env.PROSE_EXAMPLE_DIR ?? EXAMPLE_DIR
const mzml = join(example, 'Ecoli_MS2_small.mzML')
const fasta = join(example, 'Ecoli_K12_proteome.fasta')
const enabled = Boolean(process.env.PROSE_BIN) && existsSync(mzml) && existsSync(fasta)

type Events = { progress: any[]; done: any[]; failed: any[] }

/** Calls a command and returns { result }, or { failure } with the error text (not `error`: WebDriver reads that key as its own). */
async function invoke(command: string, args: object = {}): Promise<any> {
  return browser.execute(async (command: string, args: object) => {
    try {
      return { result: await (window as any).__TAURI_INTERNALS__.invoke(command, args) }
    } catch (error) {
      return { failure: String(error) }
    }
  }, command, args)
}

describe('the shim', () => {
  before(async function () {
    if (!enabled) {
      console.log('skipped: set PROSE_BIN (and PROSE_EXAMPLE_DIR) to run the shim against the real tool')
      this.skip()
    }
    await (await $('header')).waitForDisplayed({ timeout: 20000 })
    // collect the shim's events in the page
    await browser.execute(() => {
      const internals = (window as any).__TAURI_INTERNALS__
      const events = ((window as any).__events = { progress: [], done: [], failed: [] })
      for (const name of ['progress', 'done', 'failed'] as const) {
        internals.invoke('plugin:event|listen', {
          event: `search://${name}`,
          target: { kind: 'Any' },
          handler: internals.transformCallback((e: { payload: unknown }) => (events[name] as unknown[]).push(e.payload)),
        })
      }
    })
  })

  const events = (): Promise<Events> => browser.execute(() => (window as any).__events)

  /** The example's run, its settings; `more` parameters on top. */
  const request = (dir: string, more: Record<string, unknown> = {}) => ({
    request: {
      files: [{ id: 'f1', path: mzml }],
      database: fasta,
      contaminants: true,
      settings: {
        parameters: {
          'FDR:PSM': 0.01,
          'FDR:protein': 0.01,
          'modifications:variable': ['Oxidation (M)'],
          'fragment:mass_tolerance': 0.5,
          'fragment:mass_tolerance_unit': 'Da',
          ...more,
        } as Record<string, unknown>,
        rescore: true,
        peptdeep: false,
        threads: 2,
      },
    },
    dir,
  })

  it('tool_info names the version, path and ONNX support', async () => {
    const { result, failure } = await invoke('tool_info')
    expect(failure).toBeUndefined()
    expect(result.path).toBe(process.env.PROSE_BIN)
    expect(result.version).toMatch(/^\d+\.\d+/)
    expect(typeof result.onnx).toBe('boolean')
  })

  it('start_search runs the example and ends with search://done', async () => {
    const work = mkdtempSync(join(tmpdir(), 'prose-e2e-'))
    const { result, failure } = await invoke('start_search', { request: request(work).request })
    expect(failure).toBeUndefined()
    const id: string = result.searchId
    expect(id).toBeTruthy()
    await browser.waitUntil(async () => (await events()).done.length + (await events()).failed.length > 0, {
      timeout: 120000,
      interval: 500,
      timeoutMsg: 'no search://done or search://failed',
    })
    const e = await events()
    expect(e.failed).toEqual([])
    expect(e.done).toHaveLength(1)
    expect(e.done[0].searchId).toBe(id)
    expect(existsSync(join(e.done[0].folder, 'qpx', 'quantms.psm.parquet'))).toBe(true)
    expect(e.progress.length).toBeGreaterThan(2)
    expect(e.progress.every((p: any) => p.searchId === id && typeof p.label === 'string' && p.fraction >= 0 && p.fraction <= 1)).toBe(true)
    expect(e.progress.some((p: any) => p.file === 0 && p.label.startsWith('Searching Ecoli_MS2_small.mzML (1 of 1)'))).toBe(true)
    rmSync(e.done[0].folder, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  })

  it('start_search refuses an unknown parameter', async () => {
    const r = request('')
    r.request.settings.parameters = { bogus: 1 }
    const { failure } = await invoke('start_search', { request: r.request })
    expect(failure).toContain('bogus')
  })

  it('cancel_search stops a search without done or failed', async () => {
    await browser.execute(() => {
      const e = (window as any).__events
      e.progress.length = e.done.length = e.failed.length = 0
    })
    // (the example takes seconds; in chunks of 20 proteins it runs long enough to be cancelled)
    const { result } = await invoke('start_search', { request: request('', { 'database:chunk_size': 20 }).request })
    await browser.waitUntil(async () => (await events()).progress.some((p: any) => p.label.startsWith('Searching')), { timeout: 30000 })
    const { failure } = await invoke('cancel_search', { searchId: result.searchId })
    expect(failure).toBeUndefined()
    await browser.pause(1500)
    const e = await events()
    expect(e.done).toEqual([])
    expect(e.failed).toEqual([])
  })
})
