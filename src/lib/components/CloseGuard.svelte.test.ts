// @vitest-environment happy-dom
// The close guard: asked while a search runs, it says that closing keeps nothing; when the search ends while it
// is open, the app is answered "keep" at once (no question left open there) and the guard says what is left.
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shim = vi.hoisted(() => ({ ask: null as (() => void) | null, answers: [] as boolean[] }))
vi.mock('$lib/desktop', () => ({
  onCloseRequested: async (handler: () => void) => {
    shim.ask = handler
    return () => (shim.ask = null)
  },
  answerClose: async (close: boolean) => void shim.answers.push(close),
}))

const { searchRun } = await import('$lib/search/session.svelte')
const { default: CloseGuard } = await import('./CloseGuard.svelte')

let shown: Record<string, unknown> | null = null
beforeEach(async () => {
  Object.assign(searchRun, { status: 'running', toolEnded: false })
  shim.answers = []
  shown = mount(CloseGuard, { target: document.body })
  await tick()
})
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
})

const guard = () => document.querySelector('[data-testid="close-guard"]')
const buttons = () => [...(guard()?.querySelectorAll('button') ?? [])].map((b) => b.textContent?.trim()).filter((t) => t)
const click = (text: string) => {
  ;[...guard()!.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!.click()
  flushSync()
}

describe('the close guard', () => {
  it('asks while ProSE runs, and answers with the button', () => {
    shim.ask!()
    flushSync()
    expect(guard()?.textContent).toMatch(/A search is running.*nothing from it is kept/s)
    expect(buttons()).toContain('Keep searching')
    click('Close ProSE')
    expect(shim.answers).toEqual([true])
  })

  it('when the search finishes while it asks, answers "keep" at once and says that the search is saved', () => {
    shim.ask!()
    flushSync()
    // ProSE ends; its results are read
    searchRun.toolEnded = true
    flushSync()
    expect(shim.answers).toEqual([false])
    expect(guard()?.textContent).toMatch(/The search has finished.*saved in History/s)
    expect(guard()?.textContent).not.toMatch(/nothing from it is kept/)
    // done: no second answer
    searchRun.status = 'done'
    flushSync()
    expect(shim.answers).toEqual([false])
    // the user still wants to close
    click('Close ProSE')
    expect(shim.answers).toEqual([false, true])
  })

  it('says so when the search failed or was cancelled meanwhile', () => {
    shim.ask!()
    flushSync()
    searchRun.status = 'cancelled'
    flushSync()
    expect(shim.answers).toEqual([false])
    expect(guard()?.textContent).toMatch(/The search has ended/)
    click('Keep ProSE open')
    expect(shim.answers).toEqual([false, false])
  })
})
