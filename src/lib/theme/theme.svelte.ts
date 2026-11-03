// The app's theme, live: the preference (the top bar's menu), what the system says, and the theme on
// the page. `initTheme` starts following the system; the rules are in theme.ts.

import { onWindowThemeChanged, setWindowTheme, windowTheme } from '$lib/desktop'
import { applyTheme, readPreference, resolveTheme, writePreference, type Theme, type ThemePreference } from './theme'

const storage = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)

let preference = $state<ThemePreference>(readPreference(storage()))
let media = $state(false)
let window_ = $state<Theme | null>(null)

function update() {
  if (typeof document !== 'undefined') applyTheme(document.documentElement, theme.current)
}

/** The window's theme again (on Linux the event of a change may not carry the system's, so it is asked). */
async function readWindow() {
  window_ = await windowTheme()
  update()
}

export const theme = {
  get preference(): ThemePreference {
    return preference
  },
  /** The theme the page shows. */
  get current(): Theme {
    return resolveTheme(preference, { media, window: window_ })
  },
  /** Keeps the preference, shows its theme and gives the window (title bar, dialogs) the same one. */
  set preference(value: ThemePreference) {
    preference = value
    writePreference(storage(), value)
    update()
    void setWindowTheme(value === 'system' ? null : value).then(() => (value === 'system' ? readWindow() : undefined))
  },
}

let started = false

/** Follows the system's theme: the media query and the window's theme (both change while the app runs). */
export function initTheme(): void {
  if (started || typeof window === 'undefined') return
  started = true
  const query = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (query) {
    media = query.matches
    query.addEventListener('change', (event) => {
      media = event.matches
      update()
    })
  }
  update()
  // the window's own theme: the kept preference, or the system's (read, and read again on a change;
  // with Light or Dark chosen the window reports that choice, which System does not need)
  if (preference !== 'system') void setWindowTheme(preference)
  else void readWindow()
  void onWindowThemeChanged(() => {
    if (preference === 'system') void readWindow()
  })
}
