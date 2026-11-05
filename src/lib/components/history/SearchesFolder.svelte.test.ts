// @vitest-environment happy-dom
// Where new searches are saved: the folder, Change… and, for a folder of the user's, Use the default folder.
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryBackend } from '$lib/history/memory-backend'
import { useBackend } from '$lib/history/history.svelte'
import type { SearchesLocation } from '$lib/history/history'
import SearchesFolder from './SearchesFolder.svelte'

const own: SearchesLocation = { folder: '/data/searches', isDefault: true, defaultFolder: '/data/searches' }
const mine: SearchesLocation = { folder: 'D:\\NuXL searches', isDefault: false, defaultFolder: '/data/searches' }

describe('SearchesFolder', () => {
  let shown: Record<string, unknown> | null = null
  afterEach(() => {
    if (shown) unmount(shown)
    shown = null
    document.body.innerHTML = ''
  })

  async function show(current: SearchesLocation | null) {
    const disk = new MemoryBackend()
    if (current) Object.assign(disk, { location: async () => current, chooseLocation: async () => mine, defaultLocation: async () => own })
    useBackend(disk)
    const target = document.createElement('div')
    document.body.append(target)
    shown = mount(SearchesFolder, { target })
    flushSync()
    await tick()
    await Promise.resolve()
    flushSync()
    return target
  }

  it("names the app's own folder, with Change… only", async () => {
    const target = await show(own)
    expect(target.querySelector('[data-testid="searches-folder-path"]')?.textContent).toBe('/data/searches')
    expect(target.textContent).toContain("(the app's data folder)")
    expect(target.querySelector('[data-testid="searches-folder-change"]')).not.toBeNull()
    expect(target.querySelector('[data-testid="searches-folder-default"]')).toBeNull()
  })

  it("names a folder of the user's, and offers the default back", async () => {
    const target = await show(mine)
    expect(target.querySelector('[data-testid="searches-folder-path"]')?.textContent).toBe('D:\\NuXL searches')
    expect(target.textContent).not.toContain("(the app's data folder)")
    expect(target.querySelector('[data-testid="searches-folder-default"]')?.textContent).toBe('Use the default folder')
  })

  it('shows nothing without folders to choose', async () => {
    const target = await show(null)
    expect(target.querySelector('[data-testid="searches-folder"]')).toBeNull()
  })
})
