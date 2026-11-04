// @vitest-environment happy-dom
// The cross-link cells of the Peptides and PSMs tables: the "XL" badge and the adduct (its mass in the tooltip), the
// cross-linked residue ("K4", or "–"), the stripped sequence and the positions in the proteins ("5 +1", "P1 K8"), and
// the badge after the peptide when the Adduct column is hidden.
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import type { PsmSpectra } from '../../results/read'
import { makeTables, syntheticDesign } from '../../results/synthetic'
import type { ProSEMultiSummary } from '../../results/types'
import { releaseResultsView, resultsViewFor } from '../../results/view.svelte'
import type { OpenResult } from '../../search/session.svelte'
import PeptidesTable from './PeptidesTable.svelte'
import PsmsTable from './PsmsTable.svelte'

function result(): OpenResult {
  const tables = makeTables({
    files: ['a.mzML'],
    proteins: [
      { accession: 'P1', sequence: 'AAAKCCCK' },
      { accession: 'sp|Q2|CAS5_ECOLI', sequence: 'GGCCCK' },
      { accession: 'P3', sequence: '' },
    ],
    peptides: [
      { sequence: 'AAAK', proteins: [0, { protein: 2, start: 9 }] },
      { sequence: 'CCCK', adduct: 'U-H3O4P1', openms: 'CCCK(NuXL:U-H3O4P1)', mods: [{ position: 3, name: 'U-H3O4P1' }], proteins: [0, 1] },
    ],
    psms: [
      { peptide: 0, qValue: 0.001 },
      { peptide: 1, qValue: 0.002, site: 3, fdrGroup: 'short_XL' },
    ],
  })
  tables.psms.xl.adductMass[1] = 226.058973
  tables.psms.xl.siteScore[1] = 0.93
  return {
    id: 'xl',
    createdAt: '2026-11-01T00:00:00Z',
    design: syntheticDesign(['a.mzML']),
    psmFdr: 0.01,
    proteinFdr: 1,
    settings: { parameters: {}, fixedMods: [], database: 'db.fasta', rescore: false, contaminants: false, peptideFdr: 0.01, xlFdr: 0.01 },
    outcome: {
      tables,
      spectra: { predictions: false, load: () => Promise.reject(new Error('no spectra')) } as PsmSpectra,
      warnings: [],
      proteinsSaved: true,
      seconds: 1,
      nuxl: { xlFdr: 0.01, peptideFdr: 0.01, percolator: [false], notes: [[]] },
      summary: {
        files: [{ path: 'a.mzML', ms2Spectra: 10, percolator: null }],
        proteinFdrApplied: false,
        psmFdr: 0.01,
        proteinFdr: 1,
        decoyString: 'DECOY_',
        openSearch: false,
        modificationAnalysis: null,
      } as unknown as ProSEMultiSummary,
    },
  }
}

/** The text of each cell of the grid's rows, by column header (a badge's margin is no space: "XLU-H3O4P1"). */
function cells(target: HTMLElement): Record<string, string>[] {
  const headers = Array.from(target.querySelectorAll('[role="columnheader"]'), (h) => h.textContent!.trim())
  return Array.from(target.querySelectorAll('[role="row"]'))
    .map((row) => Array.from(row.querySelectorAll('[role="gridcell"]')))
    .filter((c) => c.length > 0)
    .map((c) => Object.fromEntries(c.map((cell, j) => [headers[j], cell.textContent!.replace(/\s+/g, ' ').trim()])))
}

describe('the cross-link cells', () => {
  let shown: Record<string, unknown> | null = null
  afterEach(() => {
    if (shown) unmount(shown)
    shown = null
    releaseResultsView()
    document.body.innerHTML = ''
  })

  function show(component: typeof PsmsTable | typeof PeptidesTable, props: Record<string, unknown>): HTMLElement {
    const target = document.createElement('div')
    document.body.append(target)
    shown = mount(component as never, { target, props: props as never })
    flushSync()
    return target
  }

  it('show the badge, the adduct and the site of a cross-link PSM, a dash for a peptide', () => {
    const view = resultsViewFor(result())
    view.psms.filters.kind = 'all'
    view.psms.hidden = view.psms.hidden.filter((h) => h !== 'fdrGroup')
    const target = show(PsmsTable, { view, level: view.psms, onOpen: () => {} })
    const rows = cells(target)
    expect(rows.map((r) => [r.Peptide, r.Adduct, r.Site, r['FDR group']])).toEqual([
      ['AAAK', '–', '–', 'Peptide'],
      ['CCCKU', 'XLU-H₃PO₄', 'K4', 'Short cross-link'], // (the adduct on K4 marked in the peptide)
    ])
    const adduct = target.querySelector('[title^="U-H₃PO₄"]')
    expect(adduct?.getAttribute('title')).toBe('U-H₃PO₄ · +226.0590 Da · nucleotide U')
    expect(target.querySelector('[title^="Cross-linked residue K4"]')?.getAttribute('title')).toBe('Cross-linked residue K4 (localization score 0.93)')
  })

  it('show the stripped sequence and where the peptide and its cross-link are in the proteins (1-based)', () => {
    const view = resultsViewFor(result())
    view.psms.filters.kind = 'all'
    const target = show(PsmsTable, { view, level: view.psms, onOpen: () => {} })
    expect(cells(target).map((r) => [r.Sequence, r.Start, r.End, r['Protein site']])).toEqual([
      ['AAAK', '1 +1', '4 +1', '–'],
      ['CCCK', '5 +1', '8 +1', 'P1 K8 +1'],
    ])
    expect(target.querySelector('[title^="P1 1–4"]')?.getAttribute('title')).toBe(
      'P1 1–4; P3 10–13?\n?: as the search recorded it; the protein’s sequence is unknown or does not have the peptide there',
    )
    expect(target.querySelector('[title^="P1 K8"]')?.getAttribute('title')).toBe('P1 K8; Q2 K6')
  })

  it('give a peptide row the site of its adduct in the proteins', () => {
    const view = resultsViewFor(result())
    view.peptides.filters.kind = 'all'
    const target = show(PeptidesTable, { view, level: view.peptides })
    expect(cells(target).map((r) => [r.Sequence, r.Start, r['Protein site']])).toEqual([
      ['AAAK', '1 +1', '–'],
      ['CCCK', '5 +1', 'P1 K8 +1'],
    ])
  })

  it('put the badge after the peptide when the Adduct column is hidden', () => {
    const view = resultsViewFor(result())
    expect(view.peptides.filters.kind).toBe('xl')
    view.peptides.toggleColumn('adduct', false)
    const target = show(PeptidesTable, { view, level: view.peptides })
    expect(cells(target).map((r) => r.Peptide)).toEqual(['CCCKUXL'])
  })
})
