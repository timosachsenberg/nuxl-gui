import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  })
  return data
}

/** A fresh copy of the module, as after a page load. */
async function load() {
  vi.resetModules()
  return (await import('./settings.svelte')).displaySettings
}

describe('displaySettings', () => {
  beforeEach(() => stubStorage())
  afterEach(() => vi.unstubAllGlobals())

  it('shows marked residues by default', async () => {
    expect((await load()).modMode).toBe('marked')
  })

  it('persists the switch in localStorage "nuxl.modMode"', async () => {
    const data = stubStorage()
    const settings = await load()
    settings.modMode = 'proforma'
    expect(settings.modMode).toBe('proforma')
    expect(data.get('nuxl.modMode')).toBe('proforma')
    // a reload picks it up
    expect((await load()).modMode).toBe('proforma')
  })

  it('ignores an unknown stored value', async () => {
    stubStorage({ 'nuxl.modMode': 'lowercase' })
    expect((await load()).modMode).toBe('marked')
  })

  it('works without localStorage', async () => {
    vi.stubGlobal('localStorage', undefined)
    const settings = await load()
    expect(settings.modMode).toBe('marked')
    settings.modMode = 'proforma'
    expect(settings.modMode).toBe('proforma')
  })
})

describe('updateSettings', () => {
  afterEach(() => vi.unstubAllGlobals())
  const loadUpdate = async () => {
    vi.resetModules()
    return (await import('./settings.svelte')).updateSettings
  }

  it('checks at start by default, and keeps "off" in localStorage "nuxl.updateCheck"', async () => {
    const data = stubStorage()
    const settings = await loadUpdate()
    expect(settings.checkAtStart).toBe(true)
    settings.checkAtStart = false
    expect(data.get('nuxl.updateCheck')).toBe('off')
    expect((await loadUpdate()).checkAtStart).toBe(false)
    ;(await loadUpdate()).checkAtStart = true
    expect(data.get('nuxl.updateCheck')).toBe('on')
    expect((await loadUpdate()).checkAtStart).toBe(true)
  })

  it('is on without storage', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    const settings = await loadUpdate()
    expect(settings.checkAtStart).toBe(true)
    settings.checkAtStart = false
    expect(settings.checkAtStart).toBe(false)
  })
})
