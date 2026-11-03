<script lang="ts">
  import CloseGuard from '$lib/components/CloseGuard.svelte'
  import TopBar from '$lib/components/TopBar.svelte'
  import { Toaster } from '$lib/components/ui/sonner'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import { initHistory } from '$lib/history/history.svelte'
  import { readHash, router } from '$lib/route.svelte'
  import { loadTool } from '$lib/search/tool.svelte'
  import { initTheme } from '$lib/theme/theme.svelte'
  import History from './views/History.svelte'
  import NewSearch from './views/NewSearch.svelte'
  import Results from './views/Results.svelte'

  readHash()
  // the colour theme follows the system, or the user's choice (public/theme.js set it before the first paint)
  initTheme()
  // the ProSE tool: its version and whether it has ONNX Runtime (the search form needs it)
  void loadTool()
  // finished searches are saved to History; the list is read
  initHistory()
</script>

<svelte:window onhashchange={readHash} />

<Tooltip.Provider delayDuration={300}>
  <!-- the results use the whole width and the height of the window below the top bar (which wraps on
       narrow windows), at least 440 px: main takes what is left, the results fill it (absolutely) -->
  <div class={router.route.view === 'results' ? 'flex min-h-screen flex-col bg-muted/40' : 'min-h-screen bg-muted/40'}>
    <TopBar route={router.route} resultId={router.resultId} />
    {#if router.route.view === 'results'}
      <main class="relative min-h-[440px] flex-1">
        <Results id={router.route.id} />
      </main>
    {:else}
      <main class="mx-auto max-w-[1120px] px-5 pt-6 pb-24">
        {#if router.route.view === 'search'}
          <NewSearch />
        {:else}
          <History />
        {/if}
      </main>
    {/if}
  </div>
</Tooltip.Provider>

<CloseGuard />
<!-- notifications: a search that finished while the user was elsewhere (search/finished.ts) -->
<Toaster position="bottom-right" closeButton />
