<script lang="ts">
  // New search (mockup 1): spectra with the experimental design, the protein database, the search
  // settings and rescoring, with a sticky footer to start the search. mzML and FASTA files can be
  // dropped anywhere on the window (from the file manager: their paths, desktop.ts).
  import DatabaseCard from '$lib/components/search/DatabaseCard.svelte'
  import DesignTable from '$lib/components/search/DesignTable.svelte'
  import EmptyState from '$lib/components/search/EmptyState.svelte'
  import RescoringCard from '$lib/components/search/RescoringCard.svelte'
  import SearchFooter from '$lib/components/search/SearchFooter.svelte'
  import SettingsCard from '$lib/components/search/SettingsCard.svelte'
  import { Button } from '$lib/components/ui/button'
  import { onFileDrop } from '$lib/desktop'
  import { searchForm as form } from '$lib/search/form.svelte'

  let dragging = $state(false)

  /** "a", "a and b", "a, b and c" */
  const listed = (items: string[]) => (items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`)

  // Start over's tooltip names the example's own settings that go back to the preset's
  const startOverTitle = $derived.by(() => {
    const back = form.exampleSettingsInForce
    if (back.length === 0) return 'Removes the spectra and the database. Your settings stay.'
    return (
      `Removes the spectra and the database. Your settings stay, but the example's ${listed(back)} ` +
      `${back.length === 1 ? 'goes' : 'go'} back to the preset's.`
    )
  })

  $effect(() => {
    let stop: (() => void) | null = null
    let gone = false
    void onFileDrop({
      over: (on) => (dragging = on),
      drop: (paths) => void form.addFiles(paths),
    }).then((unlisten) => (gone ? unlisten() : (stop = unlisten)))
    return () => {
      gone = true
      stop?.()
    }
  })
</script>

<section data-testid="view-search" class="flex flex-col gap-4">
  <div class="flex flex-wrap items-start gap-x-4 gap-y-2">
    <div class="flex-1">
      <h1 class="mb-1 text-xl font-semibold tracking-tight">New search</h1>
      <p class="text-muted-foreground">Spectra and database stay on this computer.</p>
    </div>
    {#if form.files.length > 0 || form.database}
      <!-- the next search from scratch: no files, no database, the settings kept -->
      <Button
        variant="outline"
        size="sm"
        disabled={form.busy}
        title={startOverTitle}
        onclick={() => form.startOver()}>Start over</Button>
    {/if}
  </div>

  {#if form.files.length === 0}
    <EmptyState {dragging} />
  {:else}
    <div class={dragging ? 'rounded-lg ring-2 ring-foreground/30 ring-offset-2 ring-offset-muted' : ''}>
      <DesignTable />
    </div>
  {/if}
  <DatabaseCard />
  <SettingsCard />
  <RescoringCard />
  <SearchFooter />
</section>
