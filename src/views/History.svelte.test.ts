// @vitest-environment happy-dom
// History's Show search folder button: the shim is asked by the search's id; a folder whose name is no search's has
// the button disabled, and a failure is said above the list.
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryBackend } from '$lib/history/memory-backend'

vi.mock('$lib/route.svelte', () => ({ router: { route: { view: 'history' } }, navigate: () => {}, forgetResult: () => {} }))

const { refreshHistory, useBackend } = await import('$lib/history/history.svelte')
const { default: History } = await import('./History.svelte')

let disk: MemoryBackend
let shown: Record<string, unknown> | null = null

beforeEach(async () => {
  disk = new MemoryBackend()
  disk.addFolder('1-0', { 'search.json': JSON.stringify({ schema: 1, id: '1-0', name: 'first', createdAt: '2026-10-20T09:00:00.000Z' }) })
  disk.addFolder('my search', {})
  useBackend(disk)
  shown = mount(History, { target: document.body })
  await refreshHistory()
  await tick()
})
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
})

const button = (id: string) => document.querySelector<HTMLButtonElement>(`[data-id="${id}"] [data-testid="history-show-folder"]`)!

describe('History', () => {
  test('Show search folder shows the folder of the row', async () => {
    expect(button('1-0').disabled).toBe(false)
    expect(button('1-0').getAttribute('aria-label')).toBe('Show search folder of first')
    expect(button('1-0').parentElement!.title).toMatch(/^Opens the search's folder in /)
    button('1-0').click()
    await tick()
    expect(disk.revealed).toEqual(['1-0'])
    // a folder that is no search's: disabled, the tooltip says why
    expect(button('my search').disabled).toBe(true)
    expect(button('my search').parentElement!.title).toContain('not a search')
  })

  test('a folder that cannot be shown is said', async () => {
    disk.reveal = async () => {
      throw new Error('no file manager')
    }
    button('1-0').click()
    await tick()
    await tick()
    flushSync()
    expect(document.querySelector('[data-testid="history-problem"]')?.textContent).toContain('no file manager')
  })
})
