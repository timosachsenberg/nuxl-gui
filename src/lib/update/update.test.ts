import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdate, compareVersions, isNewer, LATEST_RELEASE_API, parseVersion, releasePage, tagVersion } from './update'

// The new-version check: versions and tags, and GitHub's answers (a fetch of the tests).

describe('versions', () => {
  it('reads major.minor.patch only', () => {
    expect(parseVersion('0.3.0')).toEqual([0, 3, 0])
    expect(parseVersion('10.20.30')).toEqual([10, 20, 30])
    for (const bad of ['', '1', '1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', ' 1.2.3', '1.2.x', '1..3', '1234567.0.0', null, 3, undefined]) {
      expect(parseVersion(bad)).toBeNull()
    }
  })

  it('reads the version of a release tag', () => {
    expect(tagVersion('desktop-native-v0.4.0')).toBe('0.4.0')
    for (const bad of ['v0.4.0', '0.4.0', 'desktop-native-v0.4', 'desktop-native-v0.4.0-rc1', 'xdesktop-native-v0.4.0', 'desktop-native-v0.4.0/../x', {}, null]) {
      expect(tagVersion(bad)).toBeNull()
    }
  })

  it('compares numerically', () => {
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0)
    expect(compareVersions([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0)
    expect(compareVersions([0, 3, 1], [0, 3, 0])).toBeGreaterThan(0)
    expect(compareVersions([0, 3, 0], [0, 3, 0])).toBe(0)
    expect(compareVersions([0, 2, 9], [0, 3, 0])).toBeLessThan(0)
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
    expect(isNewer('0.4.0', 'junk')).toBe(false)
  })

  it("builds a release's page from its version", () => {
    expect(releasePage('0.4.0')).toBe('https://github.com/timosachsenberg/nuxl-gui/releases/tag/desktop-native-v0.4.0')
  })
})

/** A fetch that answers with `body` (JSON unless a string) and `status`. */
function answering(body: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  })
}

describe('checkForUpdate', () => {
  afterEach(() => vi.useRealTimers())

  it('asks GitHub for the latest release, without credentials', async () => {
    const fetch = answering({ tag_name: 'desktop-native-v0.3.0' })
    await checkForUpdate('0.3.0', { fetch })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(LATEST_RELEASE_API)
    expect(url).toBe('https://api.github.com/repos/timosachsenberg/nuxl-gui/releases/latest')
    expect(init?.method).toBe('GET')
    expect(init?.credentials).toBe('omit')
    expect(init?.headers).toEqual({ Accept: 'application/vnd.github+json' })
    expect(init?.body).toBeUndefined()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('finds a newer release, with its page built from the tag (not html_url)', async () => {
    const fetch = answering({ tag_name: 'desktop-native-v0.10.0', html_url: 'https://evil.example/download' })
    expect(await checkForUpdate('0.9.2', { fetch })).toEqual({
      status: 'newer',
      version: '0.10.0',
      url: 'https://github.com/timosachsenberg/nuxl-gui/releases/tag/desktop-native-v0.10.0',
    })
  })

  it('says the app is current when the latest is the same or older', async () => {
    expect(await checkForUpdate('0.3.0', { fetch: answering({ tag_name: 'desktop-native-v0.3.0' }) })).toEqual({ status: 'current', version: '0.3.0' })
    expect(await checkForUpdate('0.4.0', { fetch: answering({ tag_name: 'desktop-native-v0.3.9' }) })).toEqual({ status: 'current', version: '0.4.0' })
  })

  it('ignores a release without a tag it can read', async () => {
    for (const body of [{ tag_name: 'v0.4.0' }, { tag_name: 'desktop-native-v0.4.0-beta' }, { name: 'x' }, [], null, 'null']) {
      const result = await checkForUpdate('0.3.0', { fetch: answering(body) })
      expect(result).toEqual({ status: 'error', message: 'the latest release has no version this app can read.' })
    }
  })

  it('says why it could not check: not JSON, offline, HTTP errors, rate limits', async () => {
    expect(await checkForUpdate('0.3.0', { fetch: answering('<html>busy</html>') })).toEqual({ status: 'error', message: "GitHub's answer cannot be read." })
    const offline = vi.fn(async () => {
      throw new TypeError('Load failed')
    })
    expect(await checkForUpdate('0.3.0', { fetch: offline })).toEqual({ status: 'error', message: 'GitHub cannot be reached (is this computer offline?).' })
    for (const status of [403, 429]) {
      expect(await checkForUpdate('0.3.0', { fetch: answering({ message: 'API rate limit exceeded' }, status) })).toEqual({
        status: 'error',
        message: "GitHub's limit of requests is reached; try again later.",
      })
    }
    expect(await checkForUpdate('0.3.0', { fetch: answering({}, 404) })).toEqual({ status: 'error', message: 'no release was found.' })
    expect(await checkForUpdate('0.3.0', { fetch: answering({}, 502) })).toEqual({ status: 'error', message: 'GitHub answered with HTTP 502.' })
  })

  it('gives up after the timeout', async () => {
    vi.useFakeTimers()
    // a fetch that answers only when aborted
    const hanging = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    )
    const result = checkForUpdate('0.3.0', { fetch: hanging, timeoutMs: 8000 })
    await vi.advanceTimersByTimeAsync(7999)
    expect(hanging.mock.calls[0][1]!.signal!.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ status: 'error', message: 'GitHub did not answer within 8 s.' })
  })

  it('does not ask with a version of its own it cannot compare', async () => {
    const fetch = answering({ tag_name: 'desktop-native-v0.4.0' })
    expect(await checkForUpdate('dev', { fetch })).toEqual({ status: 'error', message: 'this version (dev) cannot be compared.' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
