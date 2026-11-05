<script lang="ts">
  // The header's Export menu of the open result; at its end, Show search folder (the search's folder in the system's
  // file manager).
  import LibraryDialog from '$lib/components/results/LibraryDialog.svelte'
  import { buttonVariants } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { canShowFolder, showFolderTitle } from '$lib/history/folder'
  import { revealSearch, saveProjectFile } from '$lib/history/history.svelte'
  import { exportCsv, exportDesign, exportIdXML, idXMLFiles } from '$lib/results/exports'
  import type { ResultsView } from '$lib/results/view.svelte'
  import { cn } from '$lib/utils'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'

  let { view }: { view: ResultsView } = $props()

  // a disabled item keeps the pointer, so that its title says why
  const explained = 'data-disabled:pointer-events-auto data-disabled:cursor-not-allowed'

  let open = $state(false)
  let canSpectrum = $state(false)
  let busy = $state(false)
  let projecting = $state(false)
  /** How far the project file is written (0–1); null before the writing starts (the save dialog). */
  let written = $state<number | null>(null)
  let error = $state<string | null>(null)
  let libraryOpen = $state(false)

  function openChange(next: boolean) {
    open = next
    if (next) {
      canSpectrum = view.psm !== null && view.spectrumExporter !== null
    }
  }

  async function guard(action: () => unknown) {
    error = null
    try {
      await action()
    } catch (e) {
      error = String((e as Error)?.message ?? e)
    }
  }

  /**
   * The search's folder as a project file (a zip; large for a large search), written where the user chooses:
   * the dialog first, then the writing, with its percentage on the menu's button.
   */
  async function project() {
    busy = true
    projecting = true
    written = null
    error = null
    try {
      await saveProjectFile(view.result, (fraction) => (written = fraction))
    } catch (e) {
      error = `Project: ${String((e as Error)?.message ?? e)}`
    } finally {
      busy = false
      projecting = false
      written = null
    }
  }

  async function idXML(input: number) {
    busy = true
    error = null
    try {
      await exportIdXML(view.result, input)
    } catch (e) {
      error = `idXML: ${String((e as Error)?.message ?? e)}`
    } finally {
      busy = false
    }
  }
</script>

{#if error}
  <span class="max-w-72 truncate text-xs text-destructive" role="alert" title={error}>{error}</span>
{/if}
<DropdownMenu.Root {open} onOpenChange={openChange}>
  <DropdownMenu.Trigger class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-7 gap-1 px-2.5 text-xs')} disabled={busy}>
    {#if projecting}Saving project…{#if written !== null}<span class="tabular-nums">{Math.floor(written * 100)} %</span>{/if}{:else if busy || view.exporting}Exporting…{:else}Export{/if}<ChevronDown class="size-3.5" aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-auto min-w-52" align="end">
    <DropdownMenu.Item disabled={view.level === null || view.exporting} onSelect={() => guard(() => exportCsv(view))}
      >CSV (current view)</DropdownMenu.Item>
    <DropdownMenu.Item onSelect={() => guard(() => exportDesign(view.result))}>Design (design.tsv)</DropdownMenu.Item>
    <DropdownMenu.Item
      disabled={!canSpectrum}
      title={canSpectrum ? undefined : 'Open a PSM with a stored spectrum first'}
      class={explained}
      onSelect={() => guard(() => view.spectrumExporter?.())}>Spectrum (SVG)</DropdownMenu.Item>
    <DropdownMenu.Item
      disabled={view.exporting}
      title="Saves the search's results as one file that you can open in NuXL desktop elsewhere. It contains OpenNuXL's outputs, which name folders on this computer, such as those of the database and the search. The spectra files (mzML, .raw, .d), the spectra converted from .raw and .d files and the log are not included: there, the PSM view shows the annotated peaks only."
      onSelect={project}>Project (.nuxl)</DropdownMenu.Item>
    <DropdownMenu.Item
      title="A DIA-NN library of the search's target peptides and localized cross-links with NuXL's b and y ions, at FDRs you choose, and DIA-NN's declarations of the adducts"
      onSelect={() => (libraryOpen = true)}>Spectral library (DIA-NN TSV)…</DropdownMenu.Item>
    <DropdownMenu.Separator />
    {#each idXMLFiles(view.result) as f (f.input)}
      <DropdownMenu.Item
        title="Every PSM of OpenNuXL's run of this file, targets and decoys, before the FDR filter"
        onSelect={() => idXML(f.input)}>{f.label}</DropdownMenu.Item>
    {/each}
    <DropdownMenu.Separator />
    <DropdownMenu.Item
      disabled={!canShowFolder(view.result.id)}
      title={canShowFolder(view.result.id) ? showFolderTitle() : 'This result has no search folder of NuXL to show'}
      class={explained}
      data-testid="export-show-folder"
      onSelect={() => guard(() => revealSearch(view.result.id))}>Show search folder</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
<LibraryDialog {view} bind:open={libraryOpen} />
