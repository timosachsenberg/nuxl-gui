// saveTextWithCompanion: the shim's answers (src-tauri/src/export.rs `Saved`), and the question when the companion
// exists: Replace saves again to the file chosen (no second dialog), Cancel writes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Record<string, unknown>[] = []
let answers: unknown[] = []
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push({ command, ...args })
    return answers.shift()
  },
}))

const { saveTextWithCompanion } = await import('./desktop')

const written = { status: 'written', path: '/l/lib.tsv', companion: '/l/lib_diann_mods.txt' }
const exists = { ...written, status: 'companionExists' }

describe('saveTextWithCompanion', () => {
  beforeEach(() => {
    calls.length = 0
    answers = []
  })

  it('saves both files in one go', async () => {
    answers = [written]
    const asked: string[] = []
    const r = await saveTextWithCompanion('lib.tsv', 'tsv', '_diann_mods.txt', '--mod U,1', async (p) => (asked.push(p), true))
    expect(r).toEqual({ path: '/l/lib.tsv', companion: '/l/lib_diann_mods.txt' })
    expect(asked).toEqual([])
    expect(calls).toEqual([{ command: 'save_text_with_companion', name: 'lib.tsv', contents: 'tsv', suffix: '_diann_mods.txt', companion: '--mod U,1', replace: false }])
  })

  it('asks before it replaces a companion that exists, and saves again only when told', async () => {
    answers = [exists, written]
    const asked: string[] = []
    const r = await saveTextWithCompanion('lib.tsv', 'tsv', '_diann_mods.txt', 'm', async (p) => (asked.push(p), true))
    expect(asked).toEqual(['/l/lib_diann_mods.txt'])
    expect(calls.map((c) => c.replace)).toEqual([false, true])
    expect(r).toEqual({ path: '/l/lib.tsv', companion: '/l/lib_diann_mods.txt' })

    calls.length = 0
    answers = [exists]
    expect(await saveTextWithCompanion('lib.tsv', 'tsv', '_diann_mods.txt', 'm', async () => false)).toBeNull()
    expect(calls.map((c) => c.replace)).toEqual([false])
  })

  it('is null when the user cancels the dialog', async () => {
    answers = [null]
    expect(await saveTextWithCompanion('lib.tsv', 'tsv', '_diann_mods.txt', 'm', async () => true)).toBeNull()
  })
})
