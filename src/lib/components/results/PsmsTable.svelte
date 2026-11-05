<script lang="ts">
  // The PSMs of the open result (the best hit of each spectrum), cross-links and peptides. A cross-link has the
  // "XL" badge in its Adduct column (after the peptide when that column is not there, as in the list beside the
  // PSM view), its adduct in monospace (its mass in the tooltip) and its cross-linked residue ("K9"). A row opens
  // the PSM view (`onOpen`); while it is open, the table stands under its spectrum (`follow`: the arrow keys go
  // through the PSMs, the view showing each). `compact` makes it a narrow list (peptide, charge, sample, q-value
  // and precursor error). A decoy PSM is marked after the peptide. The Curation column shows the user's mark
  // (accepted ✓, rejected ✗; the compact list too).
  import PeptideSequence from '$lib/components/PeptideSequence.svelte'
  import { adductLabel, peptideView } from '$lib/format/peptide'
  import { siteName } from '$lib/results/columns'
  import { ACCEPTED, MARK_NAMES, REJECTED } from '$lib/results/curation'
  import { psmSite } from '$lib/results/positions'
  import { baseName } from '$lib/results/model'
  import { formatQCompact, formatQValue, formatScore, spectrumLabel } from '$lib/results/display'
  import type { LevelState, ResultsView } from '$lib/results/view.svelte'
  import { adductTitle, fdrGroupLabel, fixed, signed, siteScoreText, tableColumns, type CellDef } from './cells'
  import DataTable from './DataTable.svelte'
  import Marker from './Marker.svelte'
  import PositionCell from './PositionCell.svelte'
  import { rangeCellTitle, rangeView, siteCellTitle, siteView } from './position-cells'
  import ProteinRefs from './ProteinRefs.svelte'

  let {
    view,
    level,
    onOpen,
    compact = false,
    follow = false,
  }: { view: ResultsView; level: LevelState; onOpen: (psm: number) => void; compact?: boolean; follow?: boolean } = $props()

  const m = $derived(view.model)
  const ps = $derived(m.tables.psms)
  const xl = $derived(ps.xl)
  const fixedMods = $derived(view.result.settings.fixedMods)
  /** The Adduct column is there: the "XL" badge goes in it, else after the peptide. */
  const adductShown = $derived(!compact && level.visible.some((s) => s.id === 'adduct'))

  /** The peptide's tooltip, with what its markers say (they may be cut off in a narrow column). */
  function withMarks(text: string, i: number): string {
    const marks = [xl.isXL[i] ? `cross-link${xl.adduct[i] ? ` with ${adductLabel(xl.adduct[i])}` : ''}` : null, ps.decoy[i] ? 'decoy' : null].filter(
      (x) => x !== null,
    )
    return marks.length > 0 ? `${text} (${marks.join(', ')})` : text
  }

  const XL_TITLE = 'Cross-link: the peptide is linked to a nucleotide'

  /** The tooltip of the site: the residue, the score and the residues it may be on (lower case in OpenNuXL's sequence). */
  function siteTitle(i: number): string {
    const site = siteName(m, i)
    const score = xl.siteScore[i]
    const where = xl.siteSequence[i] ? ` · possible residues in lower case: ${xl.siteSequence[i]}` : ''
    if (site === '') return xl.isXL[i] ? `Not localized${where}` : ''
    return `Cross-linked residue ${site}${score === score ? ` (localization score ${siteScoreText(score)})` : ''}${where}`
  }

  /** The PSM's curation mark (read with the count of changes: the marks change in place). */
  function markOf(i: number): number {
    void view.curationVersion
    return m.curation[i]
  }

  /** The PSM's note ('' none; read with the count of changes, as the marks). */
  function noteOf(i: number): string {
    void view.curationVersion
    return m.curationNotes.get(i) ?? ''
  }

  function cells(id: string): CellDef {
    switch (id) {
      case 'curation':
        return { cell: () => curationCell, cellTitle: (i) => MARK_NAMES[markOf(i)] || 'Not curated' }
      case 'note':
        return { cell: (i) => noteOf(i), cellTitle: (i) => noteOf(i) || undefined }
      case 'peptide':
        return { cell: () => peptideCell, cellTitle: (i) => withMarks(m.tables.peptides.proforma[ps.peptide[i]], i) }
      case 'sequence':
        return { cell: (i) => m.tables.peptides.sequence[ps.peptide[i]], cellTitle: (i) => m.tables.peptides.sequence[ps.peptide[i]], class: 'font-mono text-[12.5px]' }
      case 'proteinStart':
      case 'proteinEnd': {
        const end = id === 'proteinEnd'
        return {
          cell: (i) => (rangeView(m, ps.peptide[i], end) ? (end ? endCell : startCell) : '–'),
          cellTitle: (i) => rangeCellTitle(m, ps.peptide[i]),
          placeholder: (i) => rangeView(m, ps.peptide[i], end) === null,
        }
      }
      case 'proteinSite':
        return {
          cell: (i) => (siteView(m, ps.peptide[i], psmSite(m, i)) ? proteinSiteCell : '–'),
          cellTitle: (i) => siteCellTitle(m, ps.peptide[i], psmSite(m, i), xl.isXL[i] === 1, xl.siteSequence[i]),
          placeholder: (i) => siteView(m, ps.peptide[i], psmSite(m, i)) === null,
        }
      case 'proteins':
        return {
          cell: () => proteinsCell,
          cellTitle: (i) => Array.from(m.peptide.proteins[ps.peptide[i]], (p) => m.tables.proteins.accession[p]).join('\n'),
        }
      case 'sample':
        return { cell: (i) => m.samples[m.psmSample[i]].label, cellTitle: (i) => m.samples[m.psmSample[i]].label }
      case 'scan':
        return { cell: (i) => spectrumLabel(ps.nativeId[i]), cellTitle: (i) => ps.nativeId[i] }
      case 'charge':
        return { cell: (i) => String(ps.charge[i]) }
      case 'mz':
        return { cell: (i) => fixed(ps.mz[i], 4) }
      case 'rt':
        // negative or unknown (NaN): "–"
        return { cell: (i) => (ps.rt[i] >= 0 ? fixed(ps.rt[i] / 60, 2) : '–'), placeholder: (i) => !(ps.rt[i] >= 0) }
      case 'precursorError':
        return { cell: (i) => signed(ps.precursorErrorPpm[i], 2) }
      case 'score':
        return { cell: (i) => formatScore(ps.score[i], ps.qValue[i]) }
      case 'qValue':
        return { cell: (i) => formatQValue(ps.qValue[i]) }
      case 'pep':
        return { cell: (i) => formatQValue(ps.pep[i]) }
      case 'file':
        return { cell: (i) => baseName(m.tables.files[ps.file[i]]) }
      case 'isotopeError':
        return { cell: (i) => String(ps.isotopeError[i]) }
      case 'crossLink':
        return { cell: (i) => (xl.isXL[i] ? xlCell : ''), cellTitle: (i) => (xl.isXL[i] ? XL_TITLE : undefined) }
      case 'adduct':
        return {
          cell: (i) => (xl.adduct[i] === '' && !xl.isXL[i] ? '–' : adductCell),
          cellTitle: (i) => adductTitle(xl.adduct[i], xl.adductMass[i], xl.nucleotide[i], xl.isXL[i] === 1) || (xl.isXL[i] ? XL_TITLE : undefined),
          placeholder: (i) => xl.adduct[i] === '' && !xl.isXL[i],
        }
      case 'adductMass':
        return { cell: (i) => (xl.adduct[i] === '' ? '–' : signed(xl.adductMass[i], 4)), placeholder: (i) => xl.adduct[i] === '' }
      case 'nucleotide':
        return { cell: (i) => xl.nucleotide[i] || '–', placeholder: (i) => xl.nucleotide[i] === '', class: 'font-mono' }
      case 'site':
        return {
          cell: (i) => siteName(m, i) || '–',
          cellTitle: (i) => siteTitle(i) || undefined,
          placeholder: (i) => xl.site[i] < 0,
          class: 'font-mono text-[12.5px]',
        }
      case 'siteScore':
        return { cell: (i) => siteScoreText(xl.siteScore[i]), placeholder: (i) => xl.siteScore[i] !== xl.siteScore[i] }
      case 'fdrGroup':
        return { cell: (i) => fdrGroupLabel(xl.fdrGroup[i]), cellTitle: (i) => xl.fdrGroup[i] }
      default:
        return { cell: () => '' }
    }
  }

  /** The list beside the PSM view: these columns, narrower. */
  const compactColumns: Record<string, { width: number | 'auto'; header?: string; title?: string }> = {
    peptide: { width: 'auto' },
    charge: { width: 32 },
    sample: { width: 88 },
    qValue: { width: 64, header: 'q' },
    precursorError: { width: 58, header: 'Δ ppm', title: 'Precursor mass error (ppm)' },
    curation: { width: 28, header: '✓', title: 'Curation: accepted (✓) or rejected (✗)' },
  }

  const columns = $derived.by(() => {
    if (!compact) return tableColumns(level.visible, cells)
    // (one sample: its column would say the same on every row, and the peptides get the room)
    const specs = Object.entries(compactColumns).flatMap(([id, narrow]) => {
      if (id === 'sample' && m.samples.length <= 1) return []
      const spec = level.specs.find((s) => s.id === id)
      return spec ? [{ ...spec, ...narrow }] : []
    })
    return tableColumns(specs, (id) =>
      id === 'precursorError'
        ? { cell: (i: number) => signed(ps.precursorErrorPpm[i], 1) }
        : id === 'qValue'
          ? { cell: (i: number) => formatQCompact(ps.qValue[i]), cellTitle: (i: number) => String(ps.qValue[i]) }
          : cells(id),
    )
  })

  let table = $state<DataTable | null>(null)
  /** Makes the row the grid's active one, scrolls it into view and gives the grid the focus. */
  export function focusRow(row: number | null): void {
    table?.focusRow(row)
  }
</script>

{#snippet peptideCell(i: number)}
  <PeptideSequence view={peptideView(m.tables.peptides, ps.peptide[i], fixedMods)} />{#if xl.isXL[i] && !adductShown}<Marker
      text="XL"
      strong
      title={XL_TITLE} />{/if}{#if ps.decoy[i]}<Marker text="decoy" />{/if}
{/snippet}

{#snippet xlCell(_: number)}
  <Marker text="XL" strong class="ml-0" />
{/snippet}

{#snippet adductCell(i: number)}
  {#if xl.isXL[i]}<Marker text="XL" strong class="mr-1.5 ml-0" />{/if}<span class="font-mono text-[12.5px]"
    >{adductLabel(xl.adduct[i]) || '–'}</span>
{/snippet}

{#snippet curationCell(i: number)}
  {@const mark = markOf(i)}
  {#if mark === ACCEPTED || mark === REJECTED}
    <span title={m.curationNotes.get(i)} class={mark === ACCEPTED ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'}
      ><span aria-hidden="true">{mark === ACCEPTED ? '✓' : '✗'}</span><span class={compact ? 'sr-only' : 'ml-1'}>{MARK_NAMES[mark]}</span></span>
  {/if}
{/snippet}

{#snippet proteinsCell(i: number)}
  <ProteinRefs model={m} peptide={ps.peptide[i]} />
{/snippet}

{#snippet startCell(i: number)}
  <PositionCell view={rangeView(m, ps.peptide[i], false)!} />
{/snippet}

{#snippet endCell(i: number)}
  <PositionCell view={rangeView(m, ps.peptide[i], true)!} />
{/snippet}

{#snippet proteinSiteCell(i: number)}
  <PositionCell view={siteView(m, ps.peptide[i], psmSite(m, i))!} />
{/snippet}

<DataTable
  bind:this={table}
  label="PSMs"
  rows={level.rows}
  {columns}
  sort={level.effectiveSort}
  onSort={(key) => level.sortBy(key)}
  onRowClick={onOpen}
  selected={level.selected}
  autoMinWidth={compact ? 80 : 220}
  followFocus={follow}
  empty={level.emptyText} />
