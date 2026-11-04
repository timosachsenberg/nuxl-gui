import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The check at start and "Check for updates" (update.svelte.ts): the shim (app version, NUXL_NO_UPDATE_CHECK, the
// release page) and GitHub (fetch) are the tests'.

const shim = vi.hoisted(() => ({
  version: '0.3.0' as string | null,
  atStart: true,
  opened: [] as string[],
  openFails: null as string | null,
}))
vi.mock('$lib/desktop', () => ({
  appVersion: async () => {
    if (shim.version === null) throw new Error('no Tauri')
    return shim.version
  },
  updateCheckAtStart: async () => shim.atStart,
  openReleasePage: async (version: string) => {
    if (shim.openFails) throw shim.openFails
    shim.opened.push(version)
  },
  errorText: (e: unknown) => String(e),
}))

let storage: Map<string, string>
let fetch: ReturnType<typeof vi.fn>

function latest(tag: string) {
  fetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: tag })))
  vi.stubGlobal('fetch', fetch)
}

/** GitHub's next answer is held: the returned function gives it (a release tag). */
function held(): (tag: string) => void {
  let give!: (tag: string) => void
  const answer = new Promise<string>((resolve) => (give = resolve))
  fetch = vi.fn(async () => new Response(JSON.stringify({ tag_name: await answer })))
  vi.stubGlobal('fetch', fetch)
  return give
}

/** A fresh copy of the modules, as after an app start. */
async function load() {
  vi.resetModules()
  return import('./update.svelte')
}

beforeEach(() => {
  Object.assign(shim, { version: '0.3.0', atStart: true, opened: [], openFails: null })
  storage = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  })
  latest('desktop-native-v0.4.0')
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the check at start', () => {
  it('waits a few seconds, asks once, and shows a newer release', async () => {
    const update = await load()
    const done = update.startUpdateCheck()
    void update.startUpdateCheck() // a second call (a reload of App) does nothing
    await vi.advanceTimersByTimeAsync(update.START_DELAY_MS - 1)
    expect(fetch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(update.updateState.banner).toEqual({
      version: '0.4.0',
      url: 'https://github.com/timosachsenberg/nuxl-gui/releases/tag/desktop-native-v0.4.0',
    })
  })

  it('shows nothing when the app is current', async () => {
    latest('desktop-native-v0.3.0')
    const update = await load()
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(update.updateState.banner).toBeNull()
  })

  it('does not ask with the setting off, or with NUXL_NO_UPDATE_CHECK', async () => {
    storage.set('nuxl.updateCheck', 'off')
    let update = await load()
    let done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    expect(fetch).not.toHaveBeenCalled()

    storage.clear()
    shim.atStart = false
    update = await load()
    done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    expect(fetch).not.toHaveBeenCalled()
    expect(update.updateState.banner).toBeNull()
  })

  it('is silent when it fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    const update = await load()
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    expect(update.updateState.banner).toBeNull()
    expect(update.updateState.manual).toEqual({ status: 'idle' })
  })

  it('remembers "Not now" for that version, not for a newer one', async () => {
    let update = await load()
    let done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    update.dismissUpdate()
    expect(update.updateState.banner).toBeNull()
    expect(storage.get('nuxl.updateDismissed')).toBe('0.4.0')

    // the next start: the same release, no banner
    update = await load()
    done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    expect(fetch).toHaveBeenCalledTimes(2) // (asked again: a newer one would show)
    expect(update.updateState.banner).toBeNull()

    // a newer one: the banner again
    latest('desktop-native-v0.4.1')
    update = await load()
    done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    expect(update.updateState.banner?.version).toBe('0.4.1')
  })

  it('Download opens the release page by its version and hides the banner (not dismissed)', async () => {
    const update = await load()
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    await update.downloadFromBanner()
    expect(shim.opened).toEqual(['0.4.0'])
    expect(update.updateState.banner).toBeNull()
    expect(storage.has('nuxl.updateDismissed')).toBe(false)
  })

  it('says when the page cannot be opened, and keeps the banner', async () => {
    shim.openFails = 'xdg-open is missing'
    const update = await load()
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    await update.downloadFromBanner()
    expect(update.updateState.banner?.version).toBe('0.4.0')
    expect(update.updateState.openError).toEqual({
      from: 'banner',
      message: 'The release page could not be opened: xdg-open is missing',
    })
  })

  it('shows no banner when the setting is turned off while it waits for GitHub', async () => {
    const answer = held()
    const update = await load()
    const { updateSettings } = await import('$lib/format/settings.svelte')
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    expect(fetch).toHaveBeenCalledTimes(1)
    updateSettings.checkAtStart = false
    answer('desktop-native-v0.4.0')
    await done
    expect(update.updateState.banner).toBeNull()
  })

  it('shows no banner when "Check for updates" was asked while it waited (that check shows the result)', async () => {
    const answer = held()
    const update = await load()
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    // the user's check, answered before the start check's
    latest('desktop-native-v0.4.0')
    await update.checkNow()
    expect(update.updateState.manual).toMatchObject({ status: 'newer', version: '0.4.0' })
    answer('desktop-native-v0.4.0')
    await done
    expect(update.updateState.banner).toBeNull()
  })

  it('shows no banner while "Check for updates" is still checking', async () => {
    const startAnswer = held()
    const update = await load()
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    const manualAnswer = held()
    const checking = update.checkNow()
    await vi.advanceTimersByTimeAsync(0)
    startAnswer('desktop-native-v0.4.0')
    await done
    expect(update.updateState.banner).toBeNull()
    manualAnswer('desktop-native-v0.4.0')
    await checking
    expect(update.updateState.manual).toMatchObject({ status: 'newer', version: '0.4.0' })
    expect(update.updateState.banner).toBeNull()
  })
})

describe('Check for updates', () => {
  it("clears an earlier Download's error", async () => {
    vi.useRealTimers()
    shim.openFails = 'xdg-open is missing'
    const update = await load()
    await update.checkNow()
    expect(await update.openRelease('0.4.0', 'panel')).toBe(false)
    expect(update.updateState.openError?.from).toBe('panel')
    latest('desktop-native-v0.3.0')
    await update.checkNow()
    expect(update.updateState.manual).toEqual({ status: 'current', version: '0.3.0' })
    expect(update.updateState.openError).toBeNull()
  })

  it('Not now clears the banner\'s Download error', async () => {
    shim.openFails = 'xdg-open is missing'
    const update = await load()
    const done = update.startUpdateCheck(0)
    await vi.runAllTimersAsync()
    await done
    await update.downloadFromBanner()
    expect(update.updateState.openError?.from).toBe('banner')
    update.dismissUpdate()
    expect(update.updateState.openError).toBeNull()
  })

  it('checks also with the setting off, and gives each result', async () => {
    storage.set('nuxl.updateCheck', 'off')
    vi.useRealTimers()
    const update = await load()
    const checking = update.checkNow()
    expect(update.updateState.manual).toEqual({ status: 'checking' })
    await checking
    expect(update.updateState.manual).toMatchObject({ status: 'newer', version: '0.4.0' })

    latest('desktop-native-v0.3.0')
    await update.checkNow()
    expect(update.updateState.manual).toEqual({ status: 'current', version: '0.3.0' })

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    await update.checkNow()
    expect(update.updateState.manual).toEqual({ status: 'error', message: 'GitHub cannot be reached (is this computer offline?).' })
  })

  it('without the app version, says so', async () => {
    vi.useRealTimers()
    shim.version = null
    const update = await load()
    await update.checkNow()
    expect(update.updateState.manual).toEqual({ status: 'error', message: "the app's version is unknown." })
    expect(fetch).not.toHaveBeenCalled()
  })
})
