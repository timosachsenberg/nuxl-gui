<script lang="ts">
  // Where new searches are saved (src-tauri/src/location.rs; New search and History show it): the folder, "Change…"
  // (the system's folder dialog: the shim takes an empty folder, or one with NuXL's searches only, and says why not
  // otherwise) and, for a folder of the user's, "Use the default folder" (the app's data folder). The searches saved
  // so far stay where they are, and in History. Not while a search runs: its folder is chosen.
  import { Button } from '$lib/components/ui/button'
  import { chooseLocation, dismissLocationProblem, refreshLocation, searchesFolder, useDefaultLocation } from '$lib/history/history.svelte'
  import { searchRun } from '$lib/search/session.svelte'
  import { cn } from '$lib/utils'
  import { onMount } from 'svelte'

  let { class: className = '' }: { class?: string } = $props()

  onMount(() => void refreshLocation())

  const location = $derived(searchesFolder.location)
  const running = $derived(searchRun.status === 'running')
  const changeTitle = $derived(
    running
      ? 'The folder can be changed once the search has ended'
      : 'Choose the folder for the searches to come, e.g. on a drive with room: an empty folder (the dialog can make one), ' +
          "or one with NuXL's searches only. The searches saved so far stay where they are, and in History.",
  )
  const link = 'h-auto p-0 text-xs font-normal'
</script>

{#if location}
  <div class={cn('min-w-0 text-xs text-muted-foreground', className)} data-testid="searches-folder">
    <p class="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span>Searches are saved in</span>
      <span class="max-w-full min-w-0 truncate font-mono text-foreground" title={location.folder} data-testid="searches-folder-path">{location.folder}</span>
      {#if location.isDefault}<span>(the app's data folder)</span>{/if}
      <Button variant="link" size="xs" class={link} disabled={running || searchesFolder.busy} title={changeTitle} data-testid="searches-folder-change" onclick={() => void chooseLocation()}
        >Change…</Button>
      {#if !location.isDefault}
        <Button
          variant="link"
          size="xs"
          class={link}
          disabled={running || searchesFolder.busy}
          title={running ? 'The folder can be changed once the search has ended' : `New searches go to ${location.defaultFolder} again; those saved here stay in History`}
          data-testid="searches-folder-default"
          onclick={() => void useDefaultLocation()}>Use the default folder</Button>
      {/if}
    </p>
    {#if searchesFolder.problem}
      <p class="mt-1 text-destructive" role="alert" data-testid="searches-folder-problem">
        {searchesFolder.problem}
        <Button variant="link" size="xs" class="{link} ml-1 text-destructive" onclick={dismissLocationProblem}>Dismiss</Button>
      </p>
    {/if}
  </div>
{/if}
