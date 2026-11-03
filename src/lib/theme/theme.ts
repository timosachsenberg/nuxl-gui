// The colour theme: light or dark. The user's preference (System, Light, Dark) is kept in localStorage;
// System follows the system's setting, which the app reads in two ways: the webview's
// `prefers-color-scheme` and the window's theme from Tauri (WebKitGTK takes the media query from the GTK
// theme, Tauri the window's from the desktop's portal; either may say light where the other knows dark).
// The theme is the class `dark` on <html> (app.css has the dark palette under `.dark`).
//
// public/theme.js sets the class before the first paint from the same key and the media query (the
// window's theme comes later, over IPC): keep it in step with `resolveTheme` (theme.test.ts checks it).

export type ThemePreference = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']

/** Where the preference is kept. */
export const THEME_KEY = 'prose.theme'

/** What the theme needs of localStorage (an in-memory one in the tests). */
export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>

/** What the system says: the media query, and the window's theme (null: not known, e.g. outside Tauri). */
export type SystemTheme = { media: boolean; window: Theme | null }

/** The kept preference; anything else (nothing kept, an old value, no storage) is System. */
export function readPreference(storage: ThemeStorage | null): ThemePreference {
  try {
    const value = storage?.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system' // blocked storage
  }
}

export function writePreference(storage: ThemeStorage | null, preference: ThemePreference): void {
  try {
    storage?.setItem(THEME_KEY, preference)
  } catch {
    // the preference then lasts until the window closes
  }
}

/** The theme of a preference: Light and Dark as they say, System dark when either source says dark. */
export function resolveTheme(preference: ThemePreference, system: SystemTheme): Theme {
  if (preference !== 'system') return preference
  return system.media || system.window === 'dark' ? 'dark' : 'light'
}

/** Puts the theme on the page: the class `dark`, and the colour scheme of the webview's own controls. */
export function applyTheme(root: HTMLElement, theme: Theme): void {
  root.classList.toggle('dark', theme === 'dark')
  root.style.colorScheme = theme
}

/**
 * Runs `read` with the light theme on the page and puts the theme back (for the SVG export, whose
 * colours are the light ones whatever the page shows). Synchronous, so nothing is painted in between.
 */
export function withLightTheme<T>(root: HTMLElement, read: () => T): T {
  const dark = root.classList.contains('dark')
  if (!dark) return read()
  root.classList.remove('dark')
  try {
    return read()
  } finally {
    root.classList.add('dark')
  }
}
