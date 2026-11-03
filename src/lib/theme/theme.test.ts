// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import {
  applyTheme,
  readPreference,
  resolveTheme,
  THEME_KEY,
  THEME_PREFERENCES,
  withLightTheme,
  writePreference,
  type Theme,
  type ThemeStorage,
} from './theme'
import script from '../../../public/theme.js?raw'

/** localStorage in memory. */
function memoryStorage(initial: Record<string, string> = {}): ThemeStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

describe('theme preference', () => {
  it('is System when nothing (or something unknown) is kept, or there is no storage', () => {
    expect(readPreference(memoryStorage())).toBe('system')
    expect(readPreference(memoryStorage({ [THEME_KEY]: 'sepia' }))).toBe('system')
    expect(readPreference(null)).toBe('system')
    const blocked: ThemeStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(readPreference(blocked)).toBe('system')
    expect(() => writePreference(blocked, 'dark')).not.toThrow()
  })

  it('is kept and read back', () => {
    const storage = memoryStorage()
    for (const preference of THEME_PREFERENCES) {
      writePreference(storage, preference)
      expect(storage.data.get(THEME_KEY)).toBe(preference)
      expect(readPreference(storage)).toBe(preference)
    }
  })
})

describe('resolveTheme', () => {
  it('takes Light and Dark as they are, whatever the system says', () => {
    for (const media of [false, true]) {
      for (const window of ['light', 'dark', null] as const) {
        expect(resolveTheme('light', { media, window })).toBe('light')
        expect(resolveTheme('dark', { media, window })).toBe('dark')
      }
    }
  })

  it('follows the system with System: dark when the media query or the window says dark', () => {
    expect(resolveTheme('system', { media: false, window: null })).toBe('light')
    expect(resolveTheme('system', { media: false, window: 'light' })).toBe('light')
    expect(resolveTheme('system', { media: true, window: null })).toBe('dark')
    // WebKitGTK's media query from a dark GTK theme, while the portal says nothing (Tauri: light)
    expect(resolveTheme('system', { media: true, window: 'light' })).toBe('dark')
    // the portal says dark, the GTK theme is a light one
    expect(resolveTheme('system', { media: false, window: 'dark' })).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('sets the class dark and the colour scheme', () => {
    const root = document.createElement('html')
    applyTheme(root, 'dark')
    expect(root.classList.contains('dark')).toBe(true)
    expect(root.style.colorScheme).toBe('dark')
    applyTheme(root, 'light')
    expect(root.classList.contains('dark')).toBe(false)
    expect(root.style.colorScheme).toBe('light')
  })

  it('withLightTheme reads with the light theme and puts dark back', () => {
    const root = document.createElement('html')
    root.classList.add('dark')
    expect(withLightTheme(root, () => root.classList.contains('dark'))).toBe(false)
    expect(root.classList.contains('dark')).toBe(true)
    expect(() =>
      withLightTheme(root, () => {
        throw new Error('read failed')
      }),
    ).toThrow('read failed')
    expect(root.classList.contains('dark')).toBe(true)
    // a light page stays as it is
    const light = document.createElement('html')
    expect(withLightTheme(light, () => 1)).toBe(1)
    expect(light.classList.contains('dark')).toBe(false)
  })
})

describe('public/theme.js (before the first paint)', () => {
  /** Runs the script against a page with `kept` in localStorage and the media query `media`. */
  function run(kept: string | null, media: boolean): { theme: Theme; scheme: string } {
    const root = document.createElement('html')
    const storage = memoryStorage(kept === null ? {} : { [THEME_KEY]: kept })
    const fakeWindow = { matchMedia: (q: string) => ({ matches: media && q === '(prefers-color-scheme: dark)' }) }
    new Function('window', 'document', 'localStorage', script)(fakeWindow, { documentElement: root }, storage)
    return { theme: root.classList.contains('dark') ? 'dark' : 'light', scheme: root.style.colorScheme }
  }

  it('agrees with resolveTheme on the media query', () => {
    for (const kept of [null, 'system', 'light', 'dark', 'other']) {
      for (const media of [false, true]) {
        const expected = resolveTheme(readPreference(memoryStorage(kept === null ? {} : { [THEME_KEY]: kept })), { media, window: null })
        expect(run(kept, media), `${kept} ${media}`).toEqual({ theme: expected, scheme: expected })
      }
    }
  })
})
