// @vitest-environment happy-dom
/// <reference types="node" />
// The spectral library dialog on the example search: its FDRs (1 %, never looser than the search's), its counts and
// DIA-NN's declarations; Save writes the TSV and the declarations, and asks before it replaces those.
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { exampleResult, readDir } from '$lib/history/fixtures'

const saves: { name: string; tsv: string; mods: string }[] = []
let existing: string | null = null
let answered: boolean | null = null
vi.mock('$lib/results/exports', async (original) => ({
  ...(await original<typeof import('$lib/results/exports')>()),
  saveLibrary: async (name: string, tsv: string, mods: string, replace: (path: string) => Promise<boolean>) => {
    if (existing !== null) {
      answered = await replace(existing)
      if (!answered) return null
    }
    saves.push({ name, tsv, mods })
    return { path: `/l/${name}`, companion: mods ? '/l/x_diann_mods.txt' : '' }
  },
}))

/** When set: the export's adducts all of unknown mass (no declaration lines). */
let unknownMasses = false
vi.mock('$lib/results/library/export', async (original) => {
  const real = await original<typeof import('$lib/results/library/export')>()
  return {
    ...real,
    libraryExport: (...args: Parameters<typeof real.libraryExport>) => {
      const e = real.libraryExport(...args)
      return unknownMasses ? { ...e, mods: [], unknownMods: [...e.library.adducts.keys()] } : e
    },
  }
})

const { ResultsView } = await import('$lib/results/view.svelte')
const { default: LibraryDialog } = await import('./LibraryDialog.svelte')

let shown: Record<string, unknown> | null = null

async function show(xlFdr = 0.05) {
  const result = await exampleResult(readDir(join(__dirname, '../../results/fixtures/example')))
  const view = new ResultsView({ ...result, psmFdr: 0.05, settings: { ...result.settings, peptideFdr: 0.05, xlFdr } })
  shown = mount(LibraryDialog, { target: document.body, props: { view, open: true } })
  flushSync()
  await tick()
}

const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const button = (id: string) => q(id) as HTMLButtonElement

beforeEach(() => {
  saves.length = 0
  existing = null
  answered = null
  unknownMasses = false
})
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
})

describe('the spectral library dialog', () => {
  test('starts at 1 % and counts the precursors, fragments and adducts', async () => {
    await show()
    const fields = [...document.querySelectorAll<HTMLInputElement>('#library-peptide-fdr, #library-xl-fdr')]
    expect(fields.map((f) => f.value)).toEqual(['1', '1'])
    expect(q('library-counts')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      '16 precursors: 3 peptides, 13 cross-links · 434 fragments · 2 adducts Left out: 1 cross-link PSMs not localized.',
    )
    expect(q('library-mods')?.textContent).toMatch(/^--mod U-H3O4P1,226\.058973/m)
    expect(document.body.textContent).toContain('A looser cutoff needs a new search')
    expect(document.body.textContent).toContain('DIA-NN: paste into Additional options (or add to the command line) so that it knows the adduct masses.')
  })

  test('saves the library under its FDRs, with the declarations', async () => {
    await show()
    button('library-save').click()
    await tick()
    await tick()
    flushSync()
    expect(saves).toHaveLength(1)
    expect(saves[0].name).toMatch(/_library_pep1%_xl1%\.tsv$/)
    expect(saves[0].tsv.split('\n')[0].split('\t').at(-1)).toBe('FragmentLossType')
    expect(saves[0].mods).toMatch(/^--mod /)
    expect(document.body.textContent).toContain('and the declarations as /l/x_diann_mods.txt')
  })

  test('asks before it replaces a declarations file that exists', async () => {
    await show()
    existing = '/l/old_diann_mods.txt'
    button('library-save').click()
    await tick()
    flushSync()
    expect(document.body.textContent).toContain('Replace old_diann_mods.txt?')
    button('library-replace').click()
    await tick()
    await tick()
    flushSync()
    expect(answered).toBe(true)
    expect(saves).toHaveLength(1)
  })

  test('says so when no adduct has a known mass (no lines to copy)', async () => {
    unknownMasses = true
    await show()
    expect(q('library-mods')).toBeNull()
    expect(q('library-mods-copy')).toBeNull()
    expect(q('library-mods-unknown')?.textContent).toMatch(/^The mass of .+, .+ is not known: declare them yourself\.$/)
  })
})
