import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchProgress, SearchRequest } from '../desktop'

// The run of a search in the session, against a fake shim: its progress, the result read from its
// folder, a failure with ProSE's stage and file, and a cancel (also one that races the end).

const fake = vi.hoisted(() => ({
  start: vi.fn(),
  cancel: vi.fn(async () => {}),
  stop: vi.fn(),
  read: vi.fn(),
}))

vi.mock('../desktop', async () => {
  class SearchFailed extends Error {
    constructor(
      message: string,
      readonly stage: string,
      readonly file: number,
      readonly details: object = {},
    ) {
      super(message)
    }
  }
  return {
    SearchFailed,
    startSearch: fake.start,
    cancelSearch: fake.cancel,
    searchFiles: (id: string) => `files of ${id}`,
    errorText: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  }
})
vi.mock('../results/read', () => ({ readSearch: fake.read }))

const { SearchFailed } = await import('../desktop')
const {
  cancelSearch,
  closeResult,
  finishedWhileCancelled,
  forgetFinishedWhileCancelled,
  onFinishedWhileCancelled,
  onSearchEnded,
  openFinished,
  openResult,
  runSearch,
  searchProgress,
  searchRun,
} = await import('./session.svelte')

const request: SearchRequest = {
  files: [
    { id: 'f1', path: '/runs/a.mzML' },
    { id: 'f2', path: '/runs/b.mzML.gz' },
  ],
  database: '/db/human.fasta',
  contaminants: true,
  settings: { parameters: {}, rescore: true, peptdeep: false, threads: 0 },
}
const meta = {
  design: { rows: [], samples: [], conditions: [] } as never,
  psmFdr: 0.01,
  proteinFdr: 0.01,
  settings: { parameters: {}, fixedMods: [], database: 'human.fasta', rescore: true, peptdeep: false, contaminants: true },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)))
  return { promise, resolve, reject }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

/** A started search of the fake shim: its progress callback and how it ends. */
function started(id = '17-0') {
  const done = deferred<{ folder: string }>()
  let progress!: (p: SearchProgress) => void
  fake.start.mockImplementationOnce(async (_r: SearchRequest, onProgress: (p: SearchProgress) => void) => {
    progress = onProgress
    return { searchId: id, done: done.promise, stop: fake.stop }
  })
  return { done, progress: (p: SearchProgress) => progress(p) }
}

describe('runSearch', () => {
  beforeEach(() => {
    fake.start.mockReset()
    fake.cancel.mockClear()
    fake.read.mockReset()
    searchRun.status = 'idle'
  })

  it('follows the progress, then reads the folder and opens the result', async () => {
    const search = started()
    const result = { summary: {}, tables: {}, spectra: {}, predicted: {}, warnings: [] }
    fake.read.mockResolvedValue(result)
    const run = runSearch(request, meta)
    await settle()
    expect(searchRun.status).toBe('running')
    expect(searchRun.files).toEqual(['a.mzML', 'b.mzML.gz'])
    expect(searchProgress.label).toBe('Starting ProSE…')
    expect(searchProgress.threads).toBe('all threads')
    search.progress({ label: 'Searching b.mzML.gz (2 of 2)...', file: 1, fraction: 0.5 })
    expect(searchProgress.label).toBe('Searching b.mzML.gz (2 of 2)…')
    expect(searchProgress.percent).toBe(50)
    search.done.resolve({ folder: '/data/searches/17-0' })
    expect(await run).toBe('17-0')
    expect(fake.read).toHaveBeenCalledWith('files of 17-0')
    expect(searchRun.status).toBe('done')
    expect(openResult.current?.id).toBe('17-0')
    expect(openResult.current?.outcome.summary).toBe(result.summary)
    expect(openResult.current?.outcome.seconds).toBeGreaterThanOrEqual(0)
  })

  it('a search that finishes while the user is elsewhere leaves the open result open, and waits to be shown', async () => {
    const result = { summary: {}, tables: {}, spectra: {}, predicted: {}, warnings: [] }
    fake.read.mockResolvedValue(result)
    // a result is open (this session's first search)
    let search = started('20-0')
    let run = runSearch(request, meta)
    await settle()
    search.done.resolve({ folder: '/data/searches/20-0' })
    expect(await run).toBe('20-0')
    expect(openResult.current?.id).toBe('20-0')
    // the next one finishes while the user looks at it: it stays open
    search = started('21-0')
    run = runSearch(request, meta, () => true)
    await settle()
    search.done.resolve({ folder: '/data/searches/21-0' })
    expect(await run).toBe('21-0')
    expect(searchRun.status).toBe('done')
    expect(openResult.current?.id).toBe('20-0')
    // shown: from memory, in place of the open one
    expect(openFinished('20-0')).toBe(false)
    expect(openFinished('21-0')).toBe(true)
    expect(openResult.current?.id).toBe('21-0')
    expect(openResult.current?.outcome.summary).toBe(result.summary)
    expect(openFinished('21-0')).toBe(false)
    // closed (deleted from History): nothing is open
    expect(closeResult('20-0')).toBe(false)
    expect(closeResult('21-0')).toBe(true)
    expect(openResult.current).toBeNull()
    // with nothing open, a finished search opens whatever the user does
    search = started('22-0')
    run = runSearch(request, meta, () => true)
    await settle()
    search.done.resolve({ folder: '/data/searches/22-0' })
    expect(await run).toBe('22-0')
    expect(openResult.current?.id).toBe('22-0')
  })

  it('a failure says where: the stage and the file ProSE was at', async () => {
    const search = started()
    const run = runSearch(request, meta)
    await settle()
    search.done.reject(new SearchFailed('Error: Unable to read file (broken)', 'Searching b.mzML.gz (2 of 2)...', 1))
    expect(await run).toBeNull()
    expect(searchRun.status).toBe('failed')
    expect(searchRun.failure?.context).toBe('While searching file 2 of 2 (b.mzML.gz)')
    expect(searchRun.failure?.summary).toBe('Error: Unable to read file (broken)')
  })

  it('a crash leads with how ProSE ended, with its last lines and the kept log', async () => {
    const search = started()
    const run = runSearch(request, meta)
    await settle()
    search.done.reject(
      new (SearchFailed as unknown as new (...a: unknown[]) => Error)('Reading b.mzML.gz ...', 'Searching b.mzML.gz (2 of 2)...', 1, {
        ended: 'ProSE crashed (signal 11, SIGSEGV)',
        detail: 'Reading b.mzML.gz ...',
        log: '/data/logs/last-failure.log',
      }),
    )
    expect(await run).toBeNull()
    expect(searchRun.failure).toEqual({
      context: 'While searching file 2 of 2 (b.mzML.gz)',
      summary: 'ProSE crashed (signal 11, SIGSEGV): Reading b.mzML.gz ...',
      detail: 'Reading b.mzML.gz ...',
      log: '/data/logs/last-failure.log',
    })
  })

  it('a request the shim refuses fails before the search', async () => {
    fake.start.mockRejectedValueOnce(new Error('The input file /runs/a.mzML cannot be read (No such file or directory).'))
    expect(await runSearch(request, meta)).toBeNull()
    expect(searchRun.failure).toEqual({
      context: 'Before the search',
      summary: 'The input file /runs/a.mzML cannot be read (No such file or directory).',
      detail: null,
    })
  })

  it('cancel ends the run at once and the search in the shim', async () => {
    started('18-0')
    const run = runSearch(request, meta)
    await settle()
    vi.useFakeTimers()
    try {
      cancelSearch()
      expect(searchRun.status).toBe('cancelled')
      expect(fake.cancel).toHaveBeenCalledWith('18-0')
      expect(await run).toBeNull()
      // its events are listened to until the shim has ended it, and a moment more (a done on its way)
      await vi.advanceTimersByTimeAsync(5000)
      expect(fake.stop).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a cancel goes to the running search, not to an earlier one cancelled while it was starting', async () => {
    // B: cancelled while start_search is still on its way
    const startB = deferred<{ searchId: string; done: Promise<{ folder: string }>; stop: () => void }>()
    fake.start.mockImplementationOnce(() => startB.promise)
    const runB = runSearch(request, meta)
    await settle()
    cancelSearch()
    expect(fake.cancel).not.toHaveBeenCalled()
    // C: started next, and running
    started('21-0')
    const runC = runSearch(request, meta)
    await settle()
    // B's start_search answers late: B is ended in the shim at once
    startB.resolve({ searchId: '20-0', done: new Promise(() => {}), stop: fake.stop })
    expect(await runB).toBeNull()
    expect(fake.cancel).toHaveBeenLastCalledWith('20-0')
    expect(searchRun.status).toBe('running')
    // Cancel now is C's
    cancelSearch()
    expect(fake.cancel).toHaveBeenLastCalledWith('21-0')
    expect(await runC).toBeNull()
  })

  it('a search that finishes as it is cancelled stays cancelled: its done is not opened', async () => {
    const before = openResult.current
    const search = started('19-0')
    const run = runSearch(request, meta)
    await settle()
    cancelSearch()
    // the shim's done of a search that ended just before the cancel reached it
    search.done.resolve({ folder: '/data/searches/19-0' })
    expect(await run).toBeNull()
    expect(fake.read).not.toHaveBeenCalled()
    expect(searchRun.status).toBe('cancelled')
    expect(openResult.current).toBe(before)
    // its folder exists: kept, so that History can remove it
    await settle()
    expect(finishedWhileCancelled()).toContain('19-0')
    forgetFinishedWhileCancelled('19-0')
    expect(finishedWhileCancelled()).not.toContain('19-0')
  })

  it('tells History at once of a search that finished as it was cancelled', async () => {
    const told: string[] = []
    const remove = onFinishedWhileCancelled((id) => told.push(id))
    onFinishedWhileCancelled(() => {
      throw new Error('a listener that fails does not stop the others or the cancel')
    })
    const search = started('23-0')
    const run = runSearch(request, meta)
    await settle()
    cancelSearch()
    search.done.resolve({ folder: '/data/searches/23-0' })
    await run
    await settle()
    expect(told).toEqual(['23-0'])
    remove()
    forgetFinishedWhileCancelled('23-0')
  })

  it('a cancelled search that ends without done is not recorded as finished', async () => {
    started('22-0')
    const run = runSearch(request, meta)
    await settle()
    cancelSearch()
    await run
    await settle()
    expect(finishedWhileCancelled()).not.toContain('22-0')
  })

  it('results that cannot be read fail the run, saying so', async () => {
    const search = started()
    fake.read.mockRejectedValue(new Error('qpx/runs/1__a.psm.parquet: not a Parquet file'))
    const run = runSearch(request, meta)
    await settle()
    search.done.resolve({ folder: '/x' })
    expect(await run).toBeNull()
    // (the search is kept: SearchError offers to open it again)
    expect(searchRun.failure).toEqual({ context: 'While reading the results', summary: 'qpx/runs/1__a.psm.parquet: not a Parquet file', detail: null, searchId: '17-0' })
  })

  it('once ProSE has ended, Cancel does nothing: the done won, and the search is read and opened', async () => {
    const search = started('24-0')
    const read = deferred<unknown>()
    fake.read.mockReturnValueOnce(read.promise)
    const run = runSearch(request, meta)
    await settle()
    expect(searchRun.toolEnded).toBe(false)
    search.done.resolve({ folder: '/data/searches/24-0' })
    await settle()
    // the results are being read: the search is complete
    expect(searchRun.toolEnded).toBe(true)
    expect(searchProgress.label).toBe('Reading the results…')
    cancelSearch()
    expect(searchRun.status).toBe('running')
    expect(fake.cancel).not.toHaveBeenCalled()
    read.resolve({ summary: {}, tables: {}, spectra: {}, predicted: {}, warnings: [], proteinsSaved: true })
    expect(await run).toBe('24-0')
    expect(searchRun.status).toBe('done')
    expect(openResult.current?.id).toBe('24-0')
    expect(finishedWhileCancelled()).not.toContain('24-0')
  })

  it('the listeners of an ended search run before its results are read, and a failing one does not stop the read', async () => {
    const order: string[] = []
    const removeA = onSearchEnded(async (ended) => {
      order.push(`ended ${ended.id} ${ended.seconds >= 0} ${ended.settings.database}`)
    })
    const removeB = onSearchEnded(() => {
      throw new Error('a listener that fails')
    })
    const search = started('25-0')
    fake.read.mockImplementationOnce(async () => {
      order.push('read')
      return { summary: {}, tables: {}, spectra: {}, predicted: {}, warnings: [], proteinsSaved: true }
    })
    const run = runSearch(request, meta)
    await settle()
    search.done.resolve({ folder: '/data/searches/25-0' })
    expect(await run).toBe('25-0')
    expect(order).toEqual(['ended 25-0 true human.fasta', 'read'])
    removeA()
    removeB()
  })
})
