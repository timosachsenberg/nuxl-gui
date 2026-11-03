<script lang="ts">
  // The error of the last search: where it happened (stage and file), what happened, and ProSE's own
  // text as a collapsed detail. A search whose results could not be read is kept in History: it can be
  // opened again from here.
  import CircleAlertIcon from '@lucide/svelte/icons/circle-alert'
  import * as Alert from '$lib/components/ui/alert'
  import { Button } from '$lib/components/ui/button'
  import { history, openAgain } from '$lib/history/history.svelte'
  import { clearRunMessage, searchRun } from '$lib/search/session.svelte'

  let box = $state<HTMLElement | null>(null)
  // shown above the footer: scrolled into view when it appears
  $effect(() => {
    box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  /** Opening the search again: running, or why it failed. */
  let retrying = $state(false)
  let retryError = $state<string | null>(null)

  /** Whether History has the search (its record was saved when ProSE ended). */
  function saved(id: string): boolean {
    const save = history.save
    if (save?.id === id) return save.state === 'saved'
    return history.entries.some((e) => e.id === id && e.error === null)
  }

  async function openSearchAgain(id: string) {
    retrying = true
    retryError = null
    try {
      await openAgain(id)
      clearRunMessage()
    } catch (e) {
      retryError = String((e as Error)?.message ?? e)
    } finally {
      retrying = false
    }
  }
</script>

{#if searchRun.status === 'failed' && searchRun.failure}
  {@const failure = searchRun.failure}
  <Alert.Root bind:ref={box} variant="destructive" class="scroll-mb-20 border-destructive/30" data-testid="search-error">
    <CircleAlertIcon />
    <Alert.Title class="font-semibold">{failure.searchId ? 'The results could not be read' : 'The search stopped'}</Alert.Title>
    <Alert.Description class="text-[12.5px]">
      <p class="text-foreground"><span class="font-medium">{failure.context}:</span> {failure.summary}</p>
      {#if failure.searchId}
        <p class="mt-1 text-foreground" data-testid="search-error-kept">
          {saved(failure.searchId)
            ? 'ProSE finished the search, and it is saved in History. You can open it again here or from History.'
            : 'ProSE finished the search, but it could not be saved to History yet.'}
        </p>
      {/if}
      {#if retryError}
        <p class="mt-1 text-foreground" data-testid="search-error-retry">Opening it again failed: {retryError}</p>
      {/if}
      {#if failure.detail || failure.log}
        <details class="mt-1 text-muted-foreground" data-testid="search-error-detail">
          <summary class="cursor-pointer text-xs select-none hover:text-foreground">ProSE's output</summary>
          {#if failure.detail}
            <p class="mt-1 font-mono text-[11.5px] break-all whitespace-pre-line">{failure.detail}</p>
          {/if}
          {#if failure.log}
            <p class="mt-1 text-xs break-all">Full log: <span class="font-mono">{failure.log}</span></p>
          {/if}
        </details>
      {/if}
      <div class="mt-2 flex gap-2">
        {#if failure.searchId}
          {@const id = failure.searchId}
          <Button variant="outline" size="sm" class="text-foreground" disabled={retrying} onclick={() => openSearchAgain(id)}>
            {retrying ? 'Opening…' : 'Open again'}
          </Button>
        {/if}
        <Button variant="outline" size="sm" class="text-foreground" onclick={clearRunMessage}>Dismiss</Button>
      </div>
    </Alert.Description>
  </Alert.Root>
{/if}
