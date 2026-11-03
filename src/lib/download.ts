import { saveText } from './desktop'

/**
 * Saves `data` as a file where the user chooses (the system's save dialog, suggesting `name`); nothing
 * leaves the computer. Resolves with the path, or null if the user cancelled. (The web app downloaded
 * a Blob; `type` is kept for its callers.)
 */
export function download(name: string, data: string, _type = 'text/plain'): Promise<string | null> {
  return saveText(name, data)
}
