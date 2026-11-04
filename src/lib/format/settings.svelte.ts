// Settings that persist across sessions (the webview's localStorage): display settings, and the new-version check.

export type ModMode = 'marked' | 'proforma'

const storageKey = 'nuxl.modMode'

function read(): ModMode {
  try {
    return localStorage.getItem(storageKey) === 'proforma' ? 'proforma' : 'marked'
  } catch {
    return 'marked' // no localStorage (tests, blocked storage)
  }
}

let modMode = $state<ModMode>(read())

const massErrorsKey = 'nuxl.massErrors'

function readMassErrors(): boolean {
  try {
    return localStorage.getItem(massErrorsKey) !== 'hidden'
  } catch {
    return true
  }
}

let massErrors = $state<boolean>(readMassErrors())

export const displaySettings = {
  /** How peptides show their modifications: a marked residue (default) or ProForma text. */
  get modMode(): ModMode {
    return modMode
  },
  set modMode(value: ModMode) {
    modMode = value
    try {
      localStorage.setItem(storageKey, value)
    } catch {
      // the setting then lasts until the page closes
    }
  },
  /** The PSM view shows the fragment mass errors under the spectrum (default); false: the strip is collapsed. */
  get massErrors(): boolean {
    return massErrors
  },
  set massErrors(value: boolean) {
    massErrors = value
    try {
      localStorage.setItem(massErrorsKey, value ? 'shown' : 'hidden')
    } catch {
      // the setting then lasts until the page closes
    }
  },
}

const updateCheckKey = 'nuxl.updateCheck'

function readUpdateCheck(): boolean {
  try {
    return localStorage.getItem(updateCheckKey) !== 'off'
  } catch {
    return true
  }
}

let checkAtStart = $state<boolean>(readUpdateCheck())

/** The new-version check (src/lib/update): kept on this computer, as the display settings. */
export const updateSettings = {
  /** "Check for new versions at start": on by default; off, the app asks GitHub only when the user says so. */
  get checkAtStart(): boolean {
    return checkAtStart
  },
  set checkAtStart(value: boolean) {
    checkAtStart = value
    try {
      localStorage.setItem(updateCheckKey, value ? 'on' : 'off')
    } catch {
      // the setting then lasts until the page closes
    }
  },
}
