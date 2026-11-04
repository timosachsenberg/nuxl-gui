// @vitest-environment happy-dom
// The new-version banner (UpdateBanner.svelte) and the About menu (AboutMenu.svelte): the shim and GitHub (fetch)
// are the tests'.
// (the modules are fresh for each test, `load`: Svelte's runtime too, so that the components and mount share one)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const shim = vi.hoisted(() => ({ opened: [] as string[], atStart: true, openFails: null as string | null }))
vi.mock('$lib/desktop', () => ({
  appVersion: async () => '0.3.0',
  updateCheckAtStart: async () => shim.atStart,
  openReleasePage: async (version: string) => {
    if (shim.openFails) throw shim.openFails
    shim.opened.push(version)
  },
  errorText: (e: unknown) => String(e),
  toolInfo: async () => ({ version: '3.5.0', path: '/opt/OpenNuXL' }),
  cpuCount: async () => 8,
}))

let fetch: ReturnType<typeof vi.fn>
function latest(tag: string | null, status = 200) {
  fetch = vi.fn(async () =>
    tag === null ? Promise.reject(new TypeError('offline')) : new Response(JSON.stringify({ tag_name: tag }), { status }),
  )
  vi.stubGlobal('fetch', fetch)
}

let svelte: typeof import('svelte')
const tick = () => svelte.tick()
const flushSync = () => svelte.flushSync()
let shown: Record<string, unknown>[] = []
async function show(component: 'UpdateBanner' | 'AboutMenu') {
  const { default: C } = component === 'UpdateBanner' ? await import('./UpdateBanner.svelte') : await import('./AboutMenu.svelte')
  shown.push(svelte.mount(C, { target: document.body }))
  await tick()
}

/** Fresh modules, as after an app start. */
async function load() {
  vi.resetModules()
  svelte = await import('svelte')
  return {
    update: await import('$lib/update/update.svelte'),
    settings: (await import('$lib/format/settings.svelte')).updateSettings,
    tool: await import('$lib/search/tool.svelte'),
  }
}

const byId = (testid: string) => document.querySelector<HTMLElement>(`[data-testid="${testid}"]`)
const settle = async () => {
  for (let i = 0; i < 10; i++) await tick()
  await new Promise((r) => setTimeout(r, 0))
  flushSync()
}

beforeEach(() => {
  shim.opened = []
  shim.atStart = true
  shim.openFails = null
  localStorage.clear()
  latest('desktop-native-v0.4.0')
})
afterEach(() => {
  for (const s of shown) svelte.unmount(s)
  shown = []
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('the banner', () => {
  it('shows a newer release found at start; Download opens its page through the shim', async () => {
    const { update } = await load()
    await show('UpdateBanner')
    // the live region is there before the banner, so that its text is read out when it comes
    const region = byId('update-banner-region')!
    expect(region.getAttribute('role')).toBe('status')
    expect(region.hasAttribute('aria-label')).toBe(false)
    expect(byId('update-banner')).toBeNull()
    await update.startUpdateCheck(0)
    await settle()
    const banner = byId('update-banner')!
    expect(byId('update-banner-region')).toBe(region)
    expect(region.contains(banner)).toBe(true)
    expect(banner.textContent).toContain('NuXL 0.4.0 is available')
    expect(banner.textContent?.replace(/\s+/g, ' ')).toContain('NuXL 0.4.0 is available (this is 0.3.0)')
    byId('update-download')!.click()
    await settle()
    expect(shim.opened).toEqual(['0.4.0'])
    expect(byId('update-banner')).toBeNull()
  })

  it('Not now hides it and remembers the version', async () => {
    const { update } = await load()
    await show('UpdateBanner')
    await update.startUpdateCheck(0)
    await settle()
    byId('update-dismiss')!.click()
    flushSync()
    expect(byId('update-banner')).toBeNull()
    expect(localStorage.getItem('nuxl.updateDismissed')).toBe('0.4.0')
  })

  it('with the setting off, nothing is fetched at start', async () => {
    localStorage.setItem('nuxl.updateCheck', 'off')
    const { update } = await load()
    await show('UpdateBanner')
    await update.startUpdateCheck(0)
    await settle()
    expect(fetch).not.toHaveBeenCalled()
    expect(byId('update-banner')).toBeNull()
  })
})

describe('a Download that cannot open the page', () => {
  it('says so where it was clicked only, and a new check clears it', async () => {
    shim.openFails = 'xdg-open is missing'
    const { update } = await load()
    await show('UpdateBanner')
    await show('AboutMenu')
    await update.startUpdateCheck(0)
    await settle()
    byId('update-download')!.click()
    await settle()
    expect(byId('update-banner')!.textContent).toContain('The release page could not be opened: xdg-open is missing')
    byId('about-menu')!.click()
    await settle()
    // the panel does not show the banner's error
    expect(byId('update-result')!.textContent).not.toContain('could not be opened')

    byId('update-check')!.click()
    await settle()
    byId('update-result-download')!.click()
    await settle()
    expect(byId('update-result')!.textContent).toContain('The release page could not be opened: xdg-open is missing')

    shim.openFails = null
    latest('desktop-native-v0.3.0')
    byId('update-check')!.click()
    await settle()
    expect(byId('update-result')!.textContent?.trim()).toBe('You have the latest version (0.3.0).')
  })
})

describe('the About menu', () => {
  async function open() {
    const loaded = await load()
    void loaded.tool.loadTool()
    await show('AboutMenu')
    byId('about-menu')!.click()
    await settle()
    return loaded
  }

  it('shows the versions, and the setting (on by default) that it keeps', async () => {
    const { settings } = await open()
    expect(byId('about-menu')!.getAttribute('aria-label')).toBe('About NuXL')
    expect(byId('about-version')!.textContent).toBe('NuXL 0.3.0')
    expect(byId('about-tool')!.textContent).toBe('OpenNuXL 3.5.0')
    expect(byId('about-author')!.textContent).toBe('Created by Timo Sachsenberg')
    const toggle = byId('update-at-start')!
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('label[for="about-check-at-start"]')!.textContent).toBe('Check for new versions at start')
    toggle.click()
    flushSync()
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(settings.checkAtStart).toBe(false)
    expect(localStorage.getItem('nuxl.updateCheck')).toBe('off')
    // nothing was asked of GitHub by opening it
    expect(fetch).not.toHaveBeenCalled()
  })

  it('Check for updates: a newer version, with Download', async () => {
    await open()
    byId('update-check')!.click()
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(byId('update-result')!.getAttribute('aria-live')).toBe('polite')
    expect(byId('update-result')!.textContent).toContain('NuXL 0.4.0 is available.')
    byId('update-result-download')!.click()
    await settle()
    expect(shim.opened).toEqual(['0.4.0'])
  })

  it('Check for updates: the latest version', async () => {
    latest('desktop-native-v0.3.0')
    await open()
    byId('update-check')!.click()
    await settle()
    expect(byId('update-result')!.textContent?.trim()).toBe('You have the latest version (0.3.0).')
  })

  it('Check for updates: could not check', async () => {
    latest(null)
    await open()
    byId('update-check')!.click()
    await settle()
    expect(byId('update-result')!.textContent?.trim()).toBe('Could not check: GitHub cannot be reached (is this computer offline?).')
    latest('desktop-native-v0.4.0', 403)
    byId('update-check')!.click()
    await settle()
    expect(byId('update-result')!.textContent?.trim()).toBe("Could not check: GitHub's limit of requests is reached; try again later.")
  })
})
