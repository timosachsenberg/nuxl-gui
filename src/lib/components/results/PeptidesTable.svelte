<script lang="ts">
  // The peptides (peptidoforms with their adduct) of the open result, with PSM counts at the "best PSM q-value"
  // filters. A cross-linked peptide has the "XL" badge in its Adduct column (after the sequence when that column is
  // hidden), the adduct in monospace with its mass in the tooltip. A decoy is marked after its sequence, as the
  // Proteins table marks a decoy protein.
  import PeptideSequence from '$lib/components/PeptideSequence.svelte'
  import { adductLabel, peptideView } from '$lib/format/peptide'
  import { formatCount, formatQValue } from '$lib/results/display'
  import type { LevelState, ResultsView } from '$lib/results/view.svelte'
  import { adductTitle, tableColumns, sampleIndex, type CellDef } from './cells'
  import DataTable from './DataTable.svelte'
  import Marker from './Marker.svelte'
  import ProteinRefs from './ProteinRefs.svelte'

  let { view, level }: { view: ResultsView; level: LevelState } = $props()

  const m = $derived(view.model)
  const pt = $derived(m.tables.peptides)
  const nS = $derived(m.samples.length)
  const nBio = $derived(new Set(m.columnSample).size)
  const fixedMods = $derived(view.result.settings.fixedMods)
  /** The Adduct column is there: the "XL" badge goes in it, else after the peptide. */
  const adductShown = $derived(level.visible.some((s) => s.id === 'adduct'))
  const XL_TITLE = 'Cross-link: the peptide is linked to a nucleotide'

  function cells(id: string): CellDef {
    const counts = level.counts
    const s = sampleIndex(id)
    if (s >= 0) {
      const count = (k: number) => counts.perSample[k * nS + s]
      return { cell: (k) => (count(k) === 0 ? '–' : formatCount(count(k))), placeholder: (k) => count(k) === 0 }
    }
    switch (id) {
      case 'peptide':
        return {
          cell: () => peptideCell,
          cellTitle: (k) => {
            const marks = [pt.isXL[k] ? `cross-link${pt.adduct[k] ? ` with ${adductLabel(pt.adduct[k])}` : ''}` : null, pt.decoy[k] ? 'decoy' : null].filter((x) => x !== null)
            return marks.length > 0 ? `${pt.proforma[k]} (${marks.join(', ')})` : pt.proforma[k]
          },
        }
      case 'adduct':
        return {
          cell: (k) => (pt.adduct[k] === '' && !pt.isXL[k] ? '–' : adductCell),
          cellTitle: (k) => adductTitle(pt.adduct[k], m.peptide.adductMass[k], m.peptide.nucleotides[k], pt.isXL[k] === 1) || (pt.isXL[k] ? XL_TITLE : undefined),
          placeholder: (k) => pt.adduct[k] === '' && !pt.isXL[k],
        }
      case 'crossLink':
        return { cell: (k) => (pt.isXL[k] ? xlCell : ''), cellTitle: (k) => (pt.isXL[k] ? XL_TITLE : undefined) }
      case 'proteins':
        return { cell: () => proteinsCell, cellTitle: (k) => Array.from(m.peptide.proteins[k], (p) => m.tables.proteins.accession[p]).join('\n') }
      case 'psms':
        return { cell: (k) => formatCount(counts.psms[k]) }
      case 'foundIn':
        return { cell: (k) => `${counts.foundIn[k]} / ${nBio}`, class: 'text-muted-foreground' }
      case 'bestQ':
        return { cell: (k) => formatQValue(m.peptide.bestQ[k]) }
      case 'length':
        return { cell: (k) => String(pt.sequence[k].length) }
      default:
        return { cell: () => '' }
    }
  }

  const columns = $derived(tableColumns(level.visible, cells))
</script>

{#snippet peptideCell(k: number)}
  <PeptideSequence view={peptideView(pt, k, fixedMods)} />{#if pt.isXL[k] && !adductShown}<Marker text="XL" strong title={XL_TITLE} />{/if}{#if pt.decoy[k]}<Marker
      text="decoy" />{/if}
{/snippet}

{#snippet xlCell(_: number)}
  <Marker text="XL" strong class="ml-0" />
{/snippet}

{#snippet adductCell(k: number)}
  {#if pt.isXL[k]}<Marker text="XL" strong class="mr-1.5 ml-0" />{/if}<span class="font-mono text-[12.5px]">{adductLabel(pt.adduct[k]) || '–'}</span>
{/snippet}

{#snippet proteinsCell(k: number)}
  <ProteinRefs model={m} peptide={k} />
{/snippet}

<DataTable
  label="Peptides"
  rows={level.rows}
  {columns}
  sort={level.effectiveSort}
  onSort={(key) => level.sortBy(key)}
  onRowClick={(k) => (level.selected = k)}
  selected={level.selected}
  empty={level.emptyText} />
