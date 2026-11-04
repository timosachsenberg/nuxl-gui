// The app's part of the new-version check (update.ts): the automatic check at start (on by default: the setting
// "Check for new versions at start", settings.svelte.ts), its banner (UpdateBanner.svelte) with the version the user
// dismissed remembered, and "Check for updates" of the About menu (AboutMenu.svelte).
//
// The check at start runs at most once per app start, a few seconds after it, and says nothing when it fails. It does
// not run with the setting off, nor when the shim says so (`NUXL_NO_UPDATE_CHECK`: the e2e specs).

import { appVersion, errorText, openReleasePage, updateCheckAtStart } from '../desktop'
import { updateSettings } from '../format/settings.svelte'
import { checkForUpdate, isNewer, parseVersion, type UpdateCheck } from './update'

/** How long after the start the automatic check waits (ms): the app's own start comes first. */
export const START_DELAY_MS = 5000

/** The version whose banner the user closed ("Not now"): its banner does not come back, a newer one's does. */
const dismissedKey = 'nuxl.updateDismissed'

/** Where Download was clicked. */
export type OpenFrom = 'banner' | 'panel'

export type ManualCheck = { status: 'idle' } | { status: 'checking' } | UpdateCheck

export const updateState = $state<{
  /** The app's version, once known (null: not yet, or unknown). */
  appVersion: string | null
  /** The newer release the banner shows (found at start, not dismissed). */
  banner: { version: string; url: string } | null
  /** "Check for updates": its state and result. */
  manual: ManualCheck
  /** Why the release page could not be opened, and from where (the banner or the About panel: each shows its own). */
  openError: { from: OpenFrom; message: string } | null
}>({ appVersion: null, banner: null, manual: { status: 'idle' }, openError: null })

let versionAsked: Promise<string | null> | null = null

/** The app's version from the shim (asked once); null if it cannot be read. */
export function loadAppVersion(): Promise<string | null> {
  versionAsked ??= appVersion().then(
    (version) => (updateState.appVersion = version),
    () => null,
  )
  return versionAsked
}

/** The version the user said "Not now" to, or null. */
export function dismissedVersion(): string | null {
  try {
    const stored = localStorage.getItem(dismissedKey)
    return parseVersion(stored) ? stored : null
  } catch {
    return null
  }
}

/** Whether release `version` gets a banner: unless it is the one dismissed (or older). */
export function bannerWanted(version: string, dismissed: string | null): boolean {
  return dismissed === null || isNewer(version, dismissed)
}

let started = false

/**
 * The automatic check (App.svelte, at start): once per app start, after `delayMs`; with the setting off (also when
 * it is turned off meanwhile) or `NUXL_NO_UPDATE_CHECK` set, nothing is asked. No banner when the setting was turned
 * off or "Check for updates" was asked while it waited for GitHub. Errors are silent. Resolves when done.
 */
export function startUpdateCheck(delayMs = START_DELAY_MS): Promise<void> {
  if (started) return Promise.resolve()
  started = true
  return new Promise((resolve) => setTimeout(() => void autoCheck().finally(resolve), delayMs))
}

async function autoCheck(): Promise<void> {
  if (!updateSettings.checkAtStart) return
  if (!(await updateCheckAtStart())) return
  if (!updateSettings.checkAtStart) return
  const version = await loadAppVersion()
  if (!version) return
  const result = await checkForUpdate(version)
  // tested again on the answer: the setting may have been turned off meanwhile, and a "Check for updates" asked
  // meanwhile shows its own result (its newer release in the panel, not also in a banner)
  if (!updateSettings.checkAtStart) return
  const manual = updateState.manual.status
  if (manual === 'checking' || manual === 'newer') return
  if (result.status === 'newer' && bannerWanted(result.version, dismissedVersion())) {
    updateState.banner = { version: result.version, url: result.url }
  }
}

/** "Check for updates": asks GitHub now (also with the setting off: the user asked), the result in `manual`. */
export async function checkNow(): Promise<void> {
  if (updateState.manual.status === 'checking') return
  updateState.manual = { status: 'checking' }
  updateState.openError = null // an earlier Download's error is not this check's
  const version = await loadAppVersion()
  updateState.manual = version ? await checkForUpdate(version) : { status: 'error', message: "the app's version is unknown." }
  // a newer release found here is shown here: the banner's goes
  if (updateState.manual.status === 'newer') updateState.banner = null
}

/** "Not now": the banner goes, and stays away for this version. */
export function dismissUpdate(): void {
  const banner = updateState.banner
  if (!banner) return
  updateState.banner = null
  updateState.openError = null
  try {
    localStorage.setItem(dismissedKey, banner.version)
  } catch {
    // then it is dismissed until the app closes
  }
}

/**
 * "Download" (in the banner or the panel, `from`): the release's page in the system's browser. Resolves with whether
 * it opened.
 */
export async function openRelease(version: string, from: OpenFrom = 'panel'): Promise<boolean> {
  try {
    await openReleasePage(version)
    updateState.openError = null
    return true
  } catch (e) {
    updateState.openError = { from, message: `The release page could not be opened: ${errorText(e)}` }
    return false
  }
}

/** The banner's "Download": the page opens and the banner goes (for this start only: not dismissed). */
export async function downloadFromBanner(): Promise<void> {
  const banner = updateState.banner
  if (banner && (await openRelease(banner.version, 'banner'))) updateState.banner = null
}
