// Show search folder: what opens on which system, and which folders of History can be shown.
import { describe, expect, test } from 'vitest'
import { canShowFolder, fileManager, showFolderTitle } from './folder'

const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Edg/130.0.0.0'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)'

describe('Show search folder', () => {
  test('the tooltip names the file manager of the system', () => {
    expect(fileManager(MAC)).toBe('Finder')
    expect(fileManager(WINDOWS)).toBe('Explorer')
    expect(fileManager(LINUX)).toBe('the file manager')
    expect(showFolderTitle(MAC)).toMatch(/^Opens the search's folder in Finder: /)
    expect(showFolderTitle(WINDOWS)).toContain('in Explorer')
    expect(showFolderTitle(LINUX)).toContain('in the file manager')
  })

  test('a folder whose name is a search id can be shown, no other', () => {
    for (const id of ['1793864817011-0', '1001-i0', 'a_b-C']) expect(canShowFolder(id), id).toBe(true)
    for (const id of ['', 'my search', 'a.b', '1-0.partial', '../1-0', '1-0/nuxl', 'C:x']) expect(canShowFolder(id), id).toBe(false)
  })
})
