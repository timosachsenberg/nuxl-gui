<script lang="ts">
  // The footer's text: the one-line plan (in full as its title: the footer may cut it), and beneath it the
  // example's note (it wraps), why the search cannot start, or how the last search ended.
  import { searchPlan as plan } from '$lib/search/plan.svelte'
  import { searchRun } from '$lib/search/session.svelte'
</script>

<div class="min-w-0 flex-1">
  <p class="truncate text-xs text-muted-foreground" data-testid="search-plan" title={plan.line}>{plan.line}</p>
  {#if plan.note && !plan.problemShown}
    <p class="line-clamp-2 text-xs leading-tight text-muted-foreground" data-testid="search-note">{plan.note}</p>
  {/if}
  {#if plan.problemShown}
    <p class="truncate text-xs text-foreground" id="start-problem" title={plan.problem}>{plan.problem}</p>
  {:else if searchRun.status === 'cancelled'}
    <p class="text-xs text-muted-foreground">The search was cancelled.</p>
  {:else if searchRun.status === 'failed'}
    <p class="text-xs text-destructive">
      {searchRun.failure?.searchId ? 'The results could not be read' : 'The search stopped'}: see the message above.
    </p>
  {/if}
</div>
