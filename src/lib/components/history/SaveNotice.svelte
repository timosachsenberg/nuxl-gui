<script lang="ts">
  // Says when a finished search could not be saved to History (and why), on Results and on History, with a
  // way to try again while the app still has what it was to save. Amber and never blocking: the results stay
  // usable.
  import { canRetrySave, dismissSaveStatus, history, retrySave } from '$lib/history/history.svelte'
  import Notice from '$lib/components/search/Notice.svelte'

  /** Only the notice of this search (Results); without, the last one (History). */
  let { id }: { id?: string } = $props()

  const save = $derived(history.save)
  const unsaved = $derived(save && save.state === 'unsaved' && (id === undefined || save.id === id) ? save : null)
</script>

{#if unsaved}
  <div role="status" data-testid="history-not-saved">
    <Notice onDismiss={dismissSaveStatus}>
      {unsaved.message}
      {#if canRetrySave(unsaved.id)}
        <button
          type="button"
          class="ml-1 font-medium underline underline-offset-2 hover:text-amber-950 dark:hover:text-amber-50"
          data-testid="history-retry-save"
          onclick={() => void retrySave(unsaved.id)}>Try again</button>
      {/if}
    </Notice>
  </div>
{/if}
