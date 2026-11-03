// @vitest-environment happy-dom
/// <reference types="node" />
// The PSM view on the example search (fixtures/example: OpenNuXL's test output, one input with peptides and
// cross-links; the input mzML is the app's example): the cross-link in the header (adduct, residue, the candidates of
// the localization, FDR group, q-value at the cross-link FDR), the observed peaks with NuXL's annotation, and, when the
// input mzML is not there, the reason in a quiet note and NuXL's annotated peaks instead.
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { flushSync, mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import { input } from '../../design/fixtures'
import { resolveDesign } from '../../design/model'
import { bytesOfRange, FileNotFound, readSearch, type SearchFiles } from '../../results/read'
import { releaseResultsView, resultsViewFor, type ResultsView } from '../../results/view.svelte'
import type { OpenResult } from '../../search/session.svelte'
import PsmView from './PsmView.svelte'

// from the root of the project: under happy-dom, import.meta.url is not a file URL
const fixture = join(process.cwd(), 'src/lib/results/fixtures/example')
const MZML = join(process.cwd(), 'src-tauri/resources/example/OpenNuXL_1_input.mzML')

/** The example's folder; its input mzML there or not. */
function files(withMzml: boolean): SearchFiles {
  return async (name, range) => {
    const path = /^\d+__.*\.mzML$/.test(name) ? (withMzml ? MZML : null) : name.startsWith('/') ? null : join(fixture, name)
    if (path === null) throw new FileNotFound(name)
    try {
      return bytesOfRange(new Uint8Array(readFileSync(path)), range)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFound(name)
      throw e
    }
  }
}

async function open(withMzml: boolean): Promise<OpenResult> {
  const read = await readSearch(files(withMzml))
  return {
    id: 'example',
    createdAt: '2026-11-01T00:00:00Z',
    design: resolveDesign(read.tables.files.map((f, i) => input(basename(f), { condition: 'control', replicate: i + 1 }))),
    psmFdr: 0.01,
    proteinFdr: 1,
    settings: { parameters: {}, fixedMods: [], database: 'OpenNuXL_1_input.fasta', rescore: false, contaminants: false, peptideFdr: 0.01, xlFdr: 0.01 },
    outcome: { ...read, seconds: 1 },
  }
}

const rowOf = (view: ResultsView, sequence: string) => {
  const { psms, peptides } = view.model.tables
  const row = Array.from(psms.peptide).findIndex((k) => peptides.sequence[k] === sequence)
  expect(row, sequence).toBeGreaterThanOrEqual(0)
  return row
}

/** Waits for the spectrum of the PSM to be read. */
async function settle(target: HTMLElement) {
  for (let i = 0; i < 50 && target.querySelector('[data-testid="spectrum-loading"]'); i++) {
    await new Promise((r) => setTimeout(r, 10))
    await tick()
    flushSync()
  }
}

describe('the PSM view', () => {
  let shown: Record<string, unknown> | null = null
  afterEach(() => {
    if (shown) unmount(shown)
    shown = null
    releaseResultsView()
    document.body.innerHTML = ''
  })

  async function show(withMzml: boolean, sequence: string) {
    const view = resultsViewFor(await open(withMzml))
    view.psm = { row: rowOf(view, sequence), origin: { kind: 'psms' } }
    const target = document.createElement('div')
    document.body.append(target)
    shown = mount(PsmView, { target, props: { view, onClose: () => {}, onBreadcrumb: () => {} } })
    flushSync()
    await settle(target)
    return { view, target, text: (id: string) => target.querySelector(`[data-testid="${id}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? null }
  }

  it('says that the PSM is a cross-link, with its adduct, residue, FDR group and q-value at the cross-link FDR', async () => {
    const { target, text } = await show(true, 'DYHTVLGAR')
    expect(text('xl-badge')).toBe('cross-link')
    expect(text('psm-adduct')).toBe('adduct U-H₃PO₄ (+226.0590 Da)')
    expect(text('psm-site')).toBe('on Y2 (score 0.82)')
    const residues = Array.from(target.querySelectorAll('[data-testid="site-sequence"] span'))
    expect(residues.map((r) => r.textContent).join('')).toBe('DYHTVLGAR')
    expect(residues.filter((r) => r.classList.contains('candidate')).map((r) => r.textContent)).toEqual(['Y'])
    expect(residues.filter((r) => r.classList.contains('site')).map((r) => r.textContent)).toEqual(['Y'])
    expect(text('psm-crosslink')).toContain('FDR group XL')
    expect(text('psm-q')).toBe('· q < 0.001 at the cross-link FDR of 1 %')
    // the screen reader's sentence
    expect(text('psm-crosslink')).toContain('Cross-link with U-H₃PO₄ (+226.0590 Da), on Y2 (localization score 0.82).')
  })

  it("shows the observed peaks with NuXL's annotation, and the linear peptide below", async () => {
    const { target, text } = await show(true, 'DYHTVLGAR')
    expect(target.querySelector('[data-testid="peaks-missing-note"]')).toBeNull()
    expect(text('top-label')).toBe('Observed · 100 % = base peak')
    const labels = Array.from(target.querySelectorAll('[data-testid="peak-label"]')).map((l) => l.textContent)
    // (labels that would collide are left out: the view is narrow under happy-dom)
    expect(labels.length).toBeGreaterThan(0)
    expect(labels.every((l) => l !== null && l.length > 0)).toBe(true)
    const paths = Array.from(target.querySelectorAll('[data-testid="matched-peaks"]')).map((p) => p.getAttribute('stroke'))
    expect(paths).toEqual(expect.arrayContaining(['var(--ion-b)', 'var(--ion-y)', 'var(--mod)', 'var(--ion-marker, #8b5cf6)']))
    expect(target.querySelector('[data-testid="spectrum"] desc')?.textContent).toMatch(/^\d+ of 179 peaks carry NuXL's annotation as shown/)
    const legend = Array.from(target.querySelectorAll('[data-testid="legend-item"]')).map((l) => l.textContent)
    expect(legend).toEqual(['a/b/c ions', 'x/y/z ions', 'shifted ions', 'marker ions', 'other ions', 'not annotated'])
    expect(text('bottom-label')).toContain('without the adduct-shifted ions')
    expect(target.querySelectorAll('[data-testid="error-dot"]').length).toBeGreaterThan(0)
    // the ion table has the shifted b ions beside the theoretical ones
    expect(target.querySelector('[data-testid="ion-table"] th[aria-label="b⁺ shifted"]')).not.toBeNull()
    expect(target.querySelector('[data-testid="ion-table"] td[data-shifted][data-ion="b2+U-H₃PO₄+"]')).not.toBeNull()
    expect(target.querySelector('[data-testid="ion-table"] td[data-ion="b2+U-H₃PO₄+"] .shift')?.textContent).toContain('+U-H₃PO₄')
    expect(target.querySelector('[data-testid="fragment-ladder"] [data-shifted]')).not.toBeNull()
    expect(text('nuxl-scores')).toContain('total_loss_score')
    // no PeptDeep any more
    expect(target.textContent).not.toContain('PeptDeep')
  })

  it("says why the observed peaks are missing, and shows NuXL's annotated peaks instead", async () => {
    const { view, target, text } = await show(false, 'DYHTVLGAR')
    const loaded = await view.result.outcome.spectra.load(view.psm!.row)
    expect(loaded.missing).not.toBeNull()
    expect(text('peaks-missing-note')).toContain(loaded.missing!)
    expect(text('peaks-missing-note')).toContain('Shown are the peaks NuXL annotated')
    expect(text('top-label')).toBe("NuXL's annotated peaks · 100 % = strongest annotated peak")
    expect(target.querySelector('[data-testid="spectrum"]')).not.toBeNull()
    expect(target.querySelectorAll('[data-testid="peak-label"]').length).toBeGreaterThan(0)
    expect(target.querySelector('[data-testid="spectrum-missing"]')).toBeNull()
    expect(view.spectrumExporter).not.toBeNull()
  })

  it('says when a cross-link is not localized, and when a peptide PSM is above the peptide FDR', async () => {
    const xl = await show(true, 'VEDVHPISERPQYFSGDGK')
    expect(xl.text('psm-site')).toBe('not localized')
    expect(xl.text('psm-adduct')).toBe('adduct UU-H₃PO₄ (+532.0843 Da)')
    unmount(shown!)
    shown = null
    releaseResultsView()
    document.body.innerHTML = ''

    const peptide = await show(true, 'YTPYLGR')
    expect(peptide.target.querySelector('[data-testid="xl-badge"]')).toBeNull()
    expect(peptide.text('psm-crosslink')).toContain('Peptide, no cross-link.')
    expect(peptide.text('psm-q')).toBe('· q 0.2 at the peptide FDR of 1 %above the peptide FDR')
    expect(peptide.text('bottom-label')).toBe('Theoretical ions of the peptide')
  })
})
