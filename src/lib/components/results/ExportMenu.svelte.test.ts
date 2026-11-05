// @vitest-environment happy-dom
/// <reference types="node" />
// The Export menu's new items: "Spectral library (DIA-NN TSV)…" opens its dialog, and at the end, after a separator,
// "Show search folder" asks the shim to show the search's folder by its id.
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { exampleResult, readDir } from '$lib/history/fixtures'

const revealed: string[] = []
vi.mock('$lib/history/history.svelte', () => ({
  revealSearch: async (id: string) => void revealed.push(id),
  saveProjectFile: async () => {},
}))

const { ResultsView } = await import('$lib/results/view.svelte')
const { default: ExportMenu } = await import('./ExportMenu.svelte')

let shown: Record<string, unknown> | null = null
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
})

async function openMenu() {
  const result = await exampleResult(readDir(join(__dirname, '../../results/fixtures/example')))
  shown = mount(ExportMenu, { target: document.body, props: { view: new ResultsView(result) } })
  flushSync()
  const trigger = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Export'))!
  trigger.focus()
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await tick()
  await new Promise((r) => setTimeout(r, 20))
  flushSync()
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="separator"]')]
}

describe('the Export menu', () => {
  test('ends with the library, the idXML, a separator and Show search folder', async () => {
    const items = await openMenu()
    const texts = items.map((i) => (i.getAttribute('role') === 'separator' ? '—' : i.textContent?.trim()))
    expect(texts.slice(-5)).toEqual(['Spectral library (DIA-NN TSV)…', '—', 'idXML', '—', 'Show search folder'])
    const show = items.at(-1)!
    expect(show.title).toMatch(/^Opens the search's folder in /)
    show.click()
    await tick()
    expect(revealed).toEqual(['100-0'])
  })

  test('the library item opens its dialog', async () => {
    const items = await openMenu()
    items.find((i) => i.textContent?.includes('Spectral library'))!.click()
    await tick()
    flushSync()
    expect(document.querySelector('[data-testid="library-dialog"]')).not.toBeNull()
  })
})
