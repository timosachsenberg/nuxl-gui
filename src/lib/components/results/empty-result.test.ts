// @vitest-environment happy-dom
/// <reference types="node" />
// The tables of a search in which no PSM passes the FDR, rendered from a search folder of OpenNuXL's outputs
// (fixtures/empty: two inputs whose filtered idXML files hold no hit; OpenNuXL has no protein FDR). Every table says
// why it is empty and names no protein FDR.
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import { input } from '../../design/fixtures'
import { resolveDesign } from '../../design/model'
import { FileNotFound, readSearch } from '../../results/read'
import { releaseResultsView, resultsViewFor } from '../../results/view.svelte'
import type { OpenResult } from '../../search/session.svelte'
import PeptidesTable from './PeptidesTable.svelte'
import ProteinsTable from './ProteinsTable.svelte'
import PsmsTable from './PsmsTable.svelte'

// the folder from the root of the project: under happy-dom, import.meta.url is not a file URL
const fixture = join(process.cwd(), 'src/lib/results/fixtures/empty')

/** The files of the fixture's search folder; an absolute path (the user's FASTA) is in user/. */
async function files(name: string): Promise<Uint8Array> {
  const path = name.startsWith('/') ? join(fixture, 'user', basename(name)) : join(fixture, name)
  try {
    return new Uint8Array(readFileSync(path))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFound(name)
    throw e
  }
}

async function openEmpty(): Promise<OpenResult> {
  const read = await readSearch(files)
  return {
    id: 'empty',
    createdAt: '2026-10-21T00:00:00Z',
    design: resolveDesign(read.tables.files.map((f, i) => input(basename(f), { condition: 'control', replicate: i + 1 }))),
    psmFdr: 0.01,
    proteinFdr: 1,
    settings: { parameters: {}, fixedMods: [], database: 'empty.fasta', rescore: true, contaminants: false, peptideFdr: 0.01, xlFdr: 0.01 },
    outcome: { ...read, seconds: 1 },
  }
}

const EMPTY = "No PSMs pass the search's FDR (1 %, q ≤ 0.01). The database may not match the organism of the sample."
const EMPTY_TWO =
  "No PSMs pass the search's peptide FDR (1 %, q ≤ 0.01) and cross-link FDR (5 %, q ≤ 0.05). The database may not match the organism of the sample."

describe('the tables of a search without PSMs', () => {
  let shown: Record<string, unknown> | null = null
  afterEach(() => {
    if (shown) unmount(shown)
    shown = null
    releaseResultsView()
    document.body.innerHTML = ''
  })

  it('say that no PSM passed the FDR, on every level, and name no protein FDR', async () => {
    const result = await openEmpty()
    expect(result.outcome.summary.proteinFdrApplied).toBe(false)
    const view = resultsViewFor(result)
    const tables = [
      [ProteinsTable, { view, level: view.proteins, onOpen: () => {} }],
      [PeptidesTable, { view, level: view.peptides }],
      [PsmsTable, { view, level: view.psms, onOpen: () => {} }],
    ] as const
    for (const [component, props] of tables) {
      const target = document.createElement('div')
      document.body.append(target)
      shown = mount(component as never, { target, props: props as never })
      flushSync()
      expect(target.textContent).toContain(EMPTY)
      expect(target.textContent).not.toContain('protein FDR')
      unmount(shown)
      shown = null
      target.remove()
    }
  })

  it('name both cutoffs when the cross-links have their own', async () => {
    const empty = await openEmpty()
    const result = { ...empty, settings: { ...empty.settings, xlFdr: 0.05 } }
    const view = resultsViewFor(result)
    expect([view.proteins.emptyText, view.peptides.emptyText, view.psms.emptyText]).toEqual([EMPTY_TWO, EMPTY_TWO, EMPTY_TWO])
  })
})
