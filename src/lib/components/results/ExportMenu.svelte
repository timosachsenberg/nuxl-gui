<script lang="ts">
  // The header's Export menu of the open result.
  import { buttonVariants } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { saveProjectFile } from '$lib/history/history.svelte'
  import { exportCsv, exportDesign, exportIdXML, idXMLFile } from '$lib/results/exports'
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

  async function idXML() {
    busy = true
    error = null
    try {
      await exportIdXML(view.result)
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
      title="Saves the search's results as one file that you can open in ProSE elsewhere. It contains ProSE's outputs, which name folders on this computer, such as those of the database and the search. The mzML files and the log are not included."
      onSelect={project}>Project (.prose)</DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onSelect={idXML}>{idXMLFile(view.result).label}</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
