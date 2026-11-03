<script lang="ts">
  // The Spectra card before any file is added: add or drop mzML files, or try the example. Files are
  // chosen in the system's dialog (their paths; nothing is copied).
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { chooseFiles } from '$lib/desktop'
  import { searchForm as form } from '$lib/search/form.svelte'
  import NoticeList from './NoticeList.svelte'

  let { dragging = false }: { dragging?: boolean } = $props()

  async function add() {
    const paths = await chooseFiles('spectra')
    if (paths.length > 0) await form.addFiles(paths)
  }
</script>

<Card.Root size="sm" class="gap-3 rounded-lg shadow-none">
  <Card.Header class="flex items-center gap-2.5">
    <Card.Title class="text-[14px] font-semibold">Spectra</Card.Title>
  </Card.Header>
  <Card.Content class="flex flex-col gap-3">
    <div
      class="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md border border-dashed px-5 py-6 transition-colors {dragging
        ? 'border-foreground/40 bg-muted/60'
        : 'border-border bg-muted/30'}">
      <div class="min-w-0 flex-1">
        <p class="font-medium">Drop mzML files here, or add them</p>
        <p class="text-xs text-muted-foreground">
          One file, or a whole experiment with conditions, replicates and fractions. A FASTA file dropped here becomes the
          database.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Button size="sm" disabled={form.adding > 0} onclick={add}>Add files</Button>
        <Button variant="outline" size="sm" disabled={form.busy} onclick={() => form.loadExample()}>
          {form.exampleLoading ? 'Loading the example…' : 'Try the example'}
        </Button>
      </div>
    </div>
    {#if form.removed}
      {@const n = form.removed.files.length}
      <p class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" role="status" data-testid="removed-note">
        {n > 0 ? `Removed ${n} ${n === 1 ? 'file' : 'files'}${form.removed.database ? ' and the database' : ''}.` : 'Removed the database.'}
        <Button variant="outline" size="sm" class="h-6 px-2 text-xs" disabled={form.busy} onclick={() => form.undoRemove()}>Undo</Button>
      </p>
    {/if}
    <p class="text-xs text-muted-foreground">
      The example is a small E. coli run with 139 spectra. It is searched twice, as two replicates, against the E. coli
      proteome. The run is too small for a PSM FDR of 1 % (its PSMs reach 1.2 % at best), so its PSM FDR is 2 %, and too
      small for a protein FDR, so its proteins are listed without one. It also has too few PSMs for Percolator's full
      model, which the results note.
    </p>
    <NoticeList items={form.notices.map((message, k) => ({ message, onDismiss: () => form.notices.splice(k, 1) }))} />
  </Card.Content>
</Card.Root>
