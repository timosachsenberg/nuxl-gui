// The new-version check: GitHub's latest release of the app (published, not a draft nor a prerelease), compared with
// the app's own version. One GET of api.github.com without credentials and without anything about this computer or
// its searches; the release page is built from the release's tag (src-tauri/src/update.rs opens it), never taken from
// the answer. No Svelte or Tauri here: update.svelte.ts does the app's part.

/** The API of the latest release (README.md, "Where the data is"; the CSP's connect-src has api.github.com only). */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/timosachsenberg/nuxl-gui/releases/latest'

/** A release's page: `<RELEASE_PAGES><TAG_PREFIX><version>`. */
export const RELEASE_PAGES = 'https://github.com/timosachsenberg/nuxl-gui/releases/tag/'
export const TAG_PREFIX = 'desktop-native-v'

/** How long the check waits for GitHub (ms). */
export const CHECK_TIMEOUT_MS = 8000

/** A version as the releases have it: major, minor, patch. */
export type Version = readonly [number, number, number]

const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/

/** `1.2.3` (each part 1 to 6 digits; nothing before or after), or null. */
export function parseVersion(text: unknown): Version | null {
  if (typeof text !== 'string') return null
  const m = VERSION.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** The version of a release's tag, `desktop-native-v1.2.3` -> `1.2.3`, or null. */
export function tagVersion(tag: unknown): string | null {
  if (typeof tag !== 'string' || !tag.startsWith(TAG_PREFIX)) return null
  const version = tag.slice(TAG_PREFIX.length)
  return parseVersion(version) ? version : null
}

/** Negative, 0 or positive as `a` is older than, the same as or newer than `b` (numerically: 0.10.0 > 0.9.0). */
export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

/** Whether version text `a` is newer than `b` (false when either is not a version). */
export function isNewer(a: string, b: string): boolean {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  return va !== null && vb !== null && compareVersions(va, vb) > 0
}

/** The page of the release of `version` (a version, as `parseVersion` takes it). */
export function releasePage(version: string): string {
  return `${RELEASE_PAGES}${TAG_PREFIX}${version}`
}

/** What a check found: a newer release (its version and page), none (the app's version), or why it could not tell. */
export type UpdateCheck =
  | { status: 'newer'; version: string; url: string }
  | { status: 'current'; version: string }
  | { status: 'error'; message: string }

export type CheckOptions = {
  /** The fetch to use (the tests'); default the page's. */
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * Asks GitHub for the latest release and compares it with `current`, the app's version. Never rejects: offline,
 * a timeout, an HTTP error (GitHub's rate limit: 403, 429), an answer that is not JSON or has no release tag the app
 * can read are an `error` with a sentence.
 */
export async function checkForUpdate(current: string, options: CheckOptions = {}): Promise<UpdateCheck> {
  const ours = parseVersion(current)
  if (!ours) return { status: 'error', message: `this version (${current}) cannot be compared.` }
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? CHECK_TIMEOUT_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    let response: Response
    try {
      response = await doFetch(LATEST_RELEASE_API, {
        method: 'GET',
        headers: { Accept: 'application/vnd.github+json' },
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
    } catch {
      return {
        status: 'error',
        message: timedOut
          ? `GitHub did not answer within ${Math.round(timeoutMs / 1000)} s.`
          : 'GitHub cannot be reached (is this computer offline?).',
      }
    }
    if (!response.ok) return { status: 'error', message: httpError(response.status) }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return {
        status: 'error',
        message: timedOut ? `GitHub did not answer within ${Math.round(timeoutMs / 1000)} s.` : "GitHub's answer cannot be read.",
      }
    }
    const tag = body !== null && typeof body === 'object' ? (body as { tag_name?: unknown }).tag_name : undefined
    const latest = tagVersion(tag)
    if (latest === null) return { status: 'error', message: 'the latest release has no version this app can read.' }
    if (compareVersions(parseVersion(latest)!, ours) > 0) return { status: 'newer', version: latest, url: releasePage(latest) }
    return { status: 'current', version: current }
  } finally {
    clearTimeout(timer)
  }
}

function httpError(status: number): string {
  if (status === 403 || status === 429) return "GitHub's limit of requests is reached; try again later."
  if (status === 404) return 'no release was found.'
  return `GitHub answered with HTTP ${status}.`
}
