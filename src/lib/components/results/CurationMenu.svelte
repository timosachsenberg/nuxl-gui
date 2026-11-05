<script lang="ts">
  // "Mark shown" of the PSM table: accepts, rejects or unmarks every PSM the table shows (its filters and the
  // search's cutoffs), e.g. all PSMs of a peptide or a cross-link ("Open in PSM table"), and takes the last of these
  // back (Undo). The marks are those of the PSM view's Accept and Reject (results/curation.ts, view.curateMany).
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { ACCEPTED, NONE, REJECTED, type Mark } from '$lib/results/curation'
  import { formatCount } from '$lib/results/display'
  import type { LevelState, ResultsView } from '$lib/results/view.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'

  let { view, level }: { view: ResultsView; level: LevelState } = $props()

  const shown = $derived(level.rows.length)
  const n = $derived(formatCount(shown))
  const what = $derived(shown === 1 ? 'PSM' : 'PSMs')
  const undoText = $derived.by(() => {
    const bulk = view.lastBulk
    if (!bulk) return null
    const verb = bulk.mark === ACCEPTED ? 'accepting' : bulk.mark === REJECTED ? 'rejecting' : 'unmarking'
    return `Undo ${verb} ${formatCount(bulk.rows.length)} ${bulk.rows.length === 1 ? 'PSM' : 'PSMs'}`
  })

  function mark(m: Mark) {
    view.curateMany(level.rows, m)
  }
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-expanded:bg-muted"
    data-testid="curation-menu">
    Mark shown<ChevronDown class="size-3.5" aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-auto min-w-56">
    <DropdownMenu.Item disabled={shown === 0} onSelect={() => mark(ACCEPTED)}>✓ Accept the {n} {what} shown</DropdownMenu.Item>
    <DropdownMenu.Item disabled={shown === 0} onSelect={() => mark(REJECTED)}>✗ Reject the {n} {what} shown</DropdownMenu.Item>
    <DropdownMenu.Item disabled={shown === 0} onSelect={() => mark(NONE)}>Remove the marks of the {n} {what} shown</DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item disabled={undoText === null} onSelect={() => view.undoCurateMany()}>{undoText ?? 'Undo'}</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
