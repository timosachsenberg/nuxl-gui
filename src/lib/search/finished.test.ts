import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Route } from '../route'

// A search that finishes: its results open on New search; elsewhere the user stays, and a notification links
// to them (svelte-sonner's toast and the router are replaced).

const router = vi.hoisted(() => ({ route: { view: 'search' } as Route }))
const navigate = vi.hoisted(() => vi.fn((next: Route) => (router.route = next)))
vi.mock('../route.svelte', () => ({ router, navigate }))
const toast = vi.hoisted(() => ({ success: vi.fn() }))
vi.mock('svelte-sonner', () => ({ toast }))
vi.mock('./session.svelte', () => ({ searchRun: { files: ['Ecoli_1.mzML', 'Ecoli_2.mzML'] } }))

const { filesText, keepsOpenResult, opensWhenFinished, showFinished } = await import('./finished')

describe('a finished search', () => {
  beforeEach(() => {
    navigate.mockClear()
    toast.success.mockClear()
  })

  it('opens only from New search', () => {
    expect(opensWhenFinished({ view: 'search' })).toBe(true)
    expect(opensWhenFinished({ view: 'history' })).toBe(false)
    expect(opensWhenFinished({ view: 'results', id: '1-0' })).toBe(false)
    expect(opensWhenFinished({ view: 'results', id: null })).toBe(false)
    router.route = { view: 'search' }
    expect(keepsOpenResult()).toBe(false)
    router.route = { view: 'results', id: '1-0' }
    expect(keepsOpenResult()).toBe(true)
  })

  it('on New search, shows its results', () => {
    router.route = { view: 'search' }
    showFinished('7-0')
    expect(navigate).toHaveBeenCalledWith({ view: 'results', id: '7-0' })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('elsewhere, stays and says so, with a link to the results', () => {
    router.route = { view: 'history' }
    showFinished('7-0')
    expect(navigate).not.toHaveBeenCalled()
    expect(router.route).toEqual({ view: 'history' })
    expect(toast.success).toHaveBeenCalledTimes(1)
    const [title, options] = toast.success.mock.calls[0]
    expect(title).toBe('Search finished')
    expect(options.description).toBe('Ecoli_1.mzML and Ecoli_2.mzML. The results are saved in History.')
    expect(options.action.label).toBe('Open results')
    options.action.onClick()
    expect(navigate).toHaveBeenCalledWith({ view: 'results', id: '7-0' })
  })

  it('names its files briefly', () => {
    expect(filesText(['a.mzML'])).toBe('a.mzML')
    expect(filesText(['a.mzML', 'b.mzML'])).toBe('a.mzML and b.mzML')
    expect(filesText(['a.mzML', 'b.mzML', 'c.mzML'])).toBe('a.mzML and 2 more')
  })
})
