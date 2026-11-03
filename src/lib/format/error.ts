// The text of an error for the user: of an Error, a Tauri command's rejection (a string, or an object with a
// message) or anything else. Free of Tauri, so that the results reader (which runs in Node too) can use it.

/** The text of a rejection or error (a string, or an object with a message); never "[object Object]". */
export function errorText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  if (e && typeof e === 'object') {
    try {
      const json = JSON.stringify(e)
      if (json !== undefined && json !== '{}') return json
    } catch {
      // (a cycle) the name of its kind, below
    }
    return `unknown error (${Object.prototype.toString.call(e).slice(8, -1)})`
  }
  return String(e)
}
