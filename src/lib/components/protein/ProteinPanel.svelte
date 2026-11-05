<script lang="ts">
  // The panel of one protein, at the right of the Proteins table: its accession and name, the share of
  // its sequence that peptides cover, its cross-linked residues and cross-link PSMs, the strip of its
  // peptides with the modified and cross-linked sites, and the tabs Coverage (the sequence as a map, with
  // the list of the cross-linked sites and their script for ChimeraX or PyMOL), Peptides (expanding to
  // their PSMs) and PSMs. A labelled region, not a dialog: the table beside it stays usable. Escape
  // closes it (Results handles the key, so that it works from the table as well); focus moves in when
  // it opens and back to the protein's row when it closes (Results does both).
  import Marker from '$lib/components/results/Marker.svelte'
  import { Button } from '$lib/components/ui/button'
  import { download } from '$lib/download'
  import * as Tabs from '$lib/components/ui/tabs'
  import { displaySettings } from '$lib/format/settings.svelte'
  import { adductLabel } from '$lib/format/peptide'
  import { formatCount, parseAccession, parseDescription } from '$lib/results/display'
  import { exportName } from '$lib/results/exports'
  import { proteinDetail, siteLabel } from '$lib/results/protein'
  import { structureFileStem, structureScript, uniprotAccession, type StructureViewer } from '$lib/results/structure'
  import type { ResultsView } from '$lib/results/view.svelte'
  import XIcon from '@lucide/svelte/icons/x'
  import CoverageMap from './CoverageMap.svelte'
  import CoverageStrip from './CoverageStrip.svelte'
  import ProteinPeptides from './ProteinPeptides.svelte'
  import ProteinPsms from './ProteinPsms.svelte'

  let {
    view,
    protein,
    onClose,
    onOpenPsmTable,
    onOpenPsm,
  }: {
    view: ResultsView
    /** The protein: a row of `tables.proteins`. */
    protein: number
    onClose: () => void
    /** "Open in PSM table": the PSMs tab, filtered by this protein, or by one of its peptides. */
    onOpenPsmTable: (filter: { protein: number } | { peptide: number }) => void
    /** A PSM of the panel: of a peptide of the Peptides tab (`peptide`), or of the PSMs tab (null). */
    onOpenPsm: (psm: number, peptide: number | null) => void
  } = $props()

  const m = $derived(view.model)
  const pr = $derived(m.tables.proteins)
  const fixedMods = $derived(view.result.settings.fixedMods)
  const detail = $derived(proteinDetail(m, protein, fixedMods))
  const accession = $derived(parseAccession(pr.accession[protein]))
  const description = $derived(parseDescription(pr.description[protein]))
  /** The line above the heading: accession (unless the heading is it, without a description), entry name, length. */
  const subline = $derived(
    [description.name ? accession.id : null, accession.entry, detail.length > 0 ? `${formatCount(detail.length)} aa` : null].filter((x): x is string => !!x),
  )
  const decoy = $derived(pr.decoy[protein] === 1)
  const fixedText = $derived(fixedMods.length > 0 ? fixedMods.join(', ') : 'none')

  // the peptide that is open in the Peptides tab (a row of `tables.peptides`): the strip shows it. The
  // view keeps it, so that it is still open when the user comes back from a PSM
  const selectedSpans = $derived(detail.peptides.find((e) => e.peptide === view.panelPeptide)?.spans ?? [])

  // the cross-linked sites as a script for ChimeraX or PyMOL (structure.ts); a failed save says why, for this protein
  const viewerNames: Record<StructureViewer, string> = { chimerax: 'ChimeraX', pymol: 'PyMOL' }
  const uniprot = $derived(uniprotAccession(pr.accession[protein]))
  let structureError = $state<{ protein: number; message: string } | null>(null)
  function structureTitle(viewer: StructureViewer): string {
    const name = viewerNames[viewer]
    return uniprot && !uniprot.isoform
      ? `Saves a script for ${name} that opens the AlphaFold DB model of ${uniprot.id} (${name} downloads it from EBI) and colours and labels the cross-linked sites`
      : `Saves a script for ${name} that colours and labels the cross-linked sites in a structure you open first (${uniprot ? `${uniprot.id} is an isoform` : 'the accession is not UniProt\'s'}, so it fetches no AlphaFold DB model)`
  }
  async function exportStructure(viewer: StructureViewer) {
    structureError = null
    const at = protein
    const input = {
      accession: pr.accession[protein],
      description: pr.description[protein],
      length: detail.length,
      sites: detail.xlSites,
      xlFdr: m.xlFdr,
      result: exportName(view.result),
    }
    try {
      await download(`${structureFileStem(input)}.${viewer === 'chimerax' ? 'cxc' : 'pml'}`, structureScript(viewer, input))
    } catch (e) {
      structureError = { protein: at, message: String((e as Error)?.message ?? e) }
    }
  }

  let heading = $state<HTMLElement | null>(null)
  /** Moves the keyboard focus into the panel (to its heading, which names the protein). */
  export function focus(): void {
    heading?.focus()
  }

  let section = $state<HTMLElement | null>(null)
  /** Moves the focus to the button of PSM `psm` if the panel lists it, else to the heading. */
  export function focusPsm(psm: number): void {
    const button = section?.querySelector<HTMLElement>(`[data-psm="${psm}"]`)
    if (button) button.focus()
    else heading?.focus()
  }

  const badge = 'inline-flex h-5 items-center rounded-[5px] border bg-muted px-[7px] text-[11.5px] font-medium whitespace-nowrap'
</script>

<section
  bind:this={section}
  aria-label="Protein {accession.id}"
  data-testid="protein-panel"
  class="flex h-full min-h-0 flex-none flex-col border-l bg-background px-[18px] pt-4 pb-3"
  style:width="clamp(520px, 45vw, 640px)">
  <header class="flex items-start justify-between gap-2">
    <div class="min-w-0">
      <div class="truncate font-mono text-xs text-muted-foreground" title={pr.accession[protein]}>
        <!-- without a description the heading is the accession: the line above it does not repeat it -->
        {#each subline as part, j (j)}{j > 0 ? ' · ' : ''}{#if part === accession.id && j === 0 && description.name}<span data-testid="panel-accession">{part}</span>{:else}{part}{/if}{/each}{#if accession.contaminant}<Marker text="contaminant" />{/if}{#if decoy}<span data-testid="panel-decoy"><Marker text="decoy" /></span>{/if}
      </div>
      <h2
        bind:this={heading}
        tabindex="-1"
        class="mt-0.5 rounded-sm text-xl font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
        {description.name || accession.id}
      </h2>
    </div>
    <Button variant="ghost" size="icon-sm" aria-label="Close protein panel" onclick={onClose}>
      <XIcon aria-hidden="true" />
    </Button>
  </header>

  <div class="mt-2.5 flex flex-wrap gap-1.5">
    <span class={badge} data-testid="panel-coverage" title="Residues covered by peptides with PSMs at the search's PSM FDR"
      >Coverage {(detail.coverage * 100).toFixed(1)} %</span>
    <span class={badge} data-testid="panel-peptides" title="Peptides counted by plain sequence. Modified forms count once."
      >{formatCount(detail.sequences)} {detail.sequences === 1 ? 'peptide' : 'peptides'}</span>
    <span class={badge} data-testid="panel-psms">{formatCount(detail.psms)} PSMs</span>
    <span
      class="{badge} {detail.xlPsms > 0 ? 'border-violet-200 bg-violet-50 text-violet-900 dark:border-violet-400/30 dark:bg-violet-400/10 dark:text-violet-200' : 'text-muted-foreground'}"
      data-testid="panel-xl"
      title="Cross-link PSMs at the search's cross-link FDR, and the residues they put the nucleic acid on (localized cross-links only)"
      >{formatCount(detail.xlPsms)} XL {detail.xlPsms === 1 ? 'PSM' : 'PSMs'} · {detail.xlSites.length} cross-linked {detail.xlSites.length === 1 ? 'site' : 'sites'}</span>
    <span
      class="{badge} {detail.sites.length > 0 ? 'border-mod-border bg-mod-bg text-mod-fg' : 'text-muted-foreground'}"
      data-testid="panel-sites"
      title="Residues with a modification in peptides with PSMs. Fixed modifications are not counted."
      >{detail.sites.length} modified {detail.sites.length === 1 ? 'site' : 'sites'}</span>
  </div>

  <CoverageStrip {detail} selected={selectedSpans} />

  <Tabs.Root bind:value={view.panelTab} class="mt-2.5 flex min-h-0 flex-1 flex-col gap-2.5">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <Tabs.List>
        <Tabs.Trigger value="coverage" class="px-3 text-[13px]">Coverage</Tabs.Trigger>
        <Tabs.Trigger value="peptides" class="px-3 text-[13px]"
          >Peptides<span class="ml-1 text-xs font-normal text-muted-foreground tabular-nums">{formatCount(detail.peptides.length)}</span></Tabs.Trigger>
        <Tabs.Trigger value="psms" class="px-3 text-[13px]"
          >PSMs<span class="ml-1 text-xs font-normal text-muted-foreground tabular-nums">{formatCount(detail.psms)}</span></Tabs.Trigger>
      </Tabs.List>
      <Button variant="outline" size="sm" class="h-7 px-2.5 text-xs" onclick={() => onOpenPsmTable({ protein })}>Open in PSM table ›</Button>
    </div>

    <!-- only the open tab is rendered: the map of a long protein is thousands of nodes, the PSM list a sort -->
    <Tabs.Content value="coverage" class="min-h-0 flex-1 overflow-auto pt-1">
      {#if view.panelTab === 'coverage'}
        {#if detail.length === 0}
          <p class="py-8 text-center text-muted-foreground">This protein has no sequence in the result, so there is no coverage map.</p>
        {:else}
          <CoverageMap {detail} sequence={pr.sequence[protein]} />
        {/if}
        {#if detail.xlSites.length > 0}
          <p class="mt-3 text-xs leading-relaxed" data-testid="xl-site-list">
            <span class="font-medium">Cross-linked sites:</span>
            {#each detail.xlSites as site, i (site.position)}<span class="whitespace-nowrap"
                ><span class="font-mono font-medium text-violet-800 dark:text-violet-300">{siteLabel(site)}</span>
                <span class="text-muted-foreground">({site.adducts.map((a) => `${adductLabel(a.adduct) || 'no adduct'} ×${a.psms}`).join(', ')})</span></span
              >{#if i < detail.xlSites.length - 1}{', '}{/if}{/each}
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="structure-export">
            <span class="text-muted-foreground">On a 3D structure:</span>
            {#each ['chimerax', 'pymol'] as const as viewer (viewer)}
              <Button variant="outline" size="sm" class="h-6 px-2 text-xs" title={structureTitle(viewer)} onclick={() => exportStructure(viewer)}
                >{viewerNames[viewer]} script</Button>
            {/each}
            {#if structureError?.protein === protein}
              <span class="text-destructive" role="alert">{structureError.message}</span>
            {/if}
          </div>
        {:else if detail.xlPsms > 0}
          <p class="mt-3 text-xs text-muted-foreground" data-testid="xl-site-list">
            None of the cross-link PSMs of this protein is localized, so there are no cross-linked sites to mark.
          </p>
        {/if}
      {/if}
    </Tabs.Content>
    <Tabs.Content value="peptides" class="min-h-0 flex-1 overflow-auto">
      {#if view.panelTab === 'peptides'}
        <ProteinPeptides {view} {detail} bind:expanded={view.panelPeptide} onOpenPsm={(psm) => onOpenPsm(psm, view.panelPeptide)} {onOpenPsmTable} />
      {/if}
    </Tabs.Content>
    <Tabs.Content value="psms" class="flex min-h-0 flex-1 flex-col">
      {#if view.panelTab === 'psms'}
        <ProteinPsms {view} {detail} label="PSMs of {accession.id}" onOpenPsm={(psm) => onOpenPsm(psm, null)} />
      {/if}
    </Tabs.Content>
  </Tabs.Root>

  <!-- what a dot is, the strip says; this says what a marked residue is and what is not marked -->
  <p class="mt-2 text-xs text-muted-foreground" data-testid="panel-legend">
    {#if displaySettings.modMode === 'marked'}
      <span class="legend-mod">M<sup>ox</sup></span> modified residue, hover to see the modification · <span class="legend-xl">K</span> cross-linked
      residue{#if fixedMods.length > 0}{' · '}fixed
        modifications ({fixedText}) are not marked{/if}
    {:else}
      ProForma shows all modifications{#if fixedMods.length > 0}, including the fixed ones ({fixedText}). Only the others appear as
        modified-site dots{/if}
    {/if}
  </p>
</section>

<style>
  .legend-mod {
    font-family: var(--font-sequence);
    background: var(--mod-bg);
    color: var(--mod-fg);
    border-radius: 3px;
    padding: 0 1px;
    box-shadow: inset 0 -1.5px 0 var(--mod);
  }
  .legend-xl {
    font-family: var(--font-sequence);
    border-radius: 3px;
    padding: 0 1px;
    /* violet: a cross-linked residue (the coverage map's colours) */
    background: #ede9fe;
    color: #4c1d95;
    box-shadow: inset 0 -1.5px 0 #8b5cf6;
  }
  :global(.dark) .legend-xl {
    background: #2e1065;
    color: #ddd6fe;
  }
  .legend-mod sup {
    font-size: 9px;
    font-weight: 600;
    line-height: 0;
    margin-left: 1px;
  }
</style>
