import { describe, expect, test } from 'vitest'
import { dialogOpen, oneDialog } from './dialogs'

describe('one dialog at a time', () => {
  test('a dialog asked for while one is open counts as cancelled', async () => {
    let answer!: (paths: string[]) => void
    const first = oneDialog<string[]>([], () => new Promise((resolve) => (answer = resolve)))
    expect(dialogOpen()).toBe(true)
    let shown = false
    const second = await oneDialog<string[]>([], async () => {
      shown = true
      return ['/b.mzML']
    })
    expect(shown).toBe(false)
    expect(second).toEqual([])
    answer(['/a.mzML'])
    expect(await first).toEqual(['/a.mzML'])
    expect(dialogOpen()).toBe(false)
  })

  test('after a dialog closes, or fails, the next one is shown', async () => {
    await expect(oneDialog(null, async () => Promise.reject(new Error('no dialog')))).rejects.toThrow('no dialog')
    expect(await oneDialog<string | null>(null, async () => '/x.csv')).toBe('/x.csv')
  })
})
