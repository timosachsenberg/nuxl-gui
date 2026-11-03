<script lang="ts">
  // The web app's top bar without its engine chip and update notice (the desktop app has neither):
  // the OpenMS logo and the wordmark, the views, on Results the result's chip and its Export menu, and a running search's
  // progress on the other views; at the right end the theme menu.
  // the unmodified logo of OpenMS/Assets (src/assets/logo/README.txt), 180 px: sharp at 36 px on HiDPI screens;
  // its lettering is black, so in dark it stands on a light plate
  import openmsLogo from '../../assets/logo/openms-logo.png'
  import { Badge } from '$lib/components/ui/badge'
  import { formatHash, type Route, type View } from '$lib/route'
  import { exportName } from '$lib/results/exports'
  import { resultsViewFor } from '$lib/results/view.svelte'
  import { openResult, searchProgress } from '$lib/search/session.svelte'
  import ExportMenu from './results/ExportMenu.svelte'
  import { cn } from '$lib/utils'
  import SearchProgress from './search/SearchProgress.svelte'
  import ThemeMenu from './ThemeMenu.svelte'

  let { route, resultId }: { route: Route; resultId: string | null } = $props()

  const items: { view: View; label: string }[] = [
    { view: 'search', label: 'New search' },
    { view: 'results', label: 'Results' },
    { view: 'history', label: 'History' },
  ]

  // "Results" returns to the result that was open last
  function hrefOf(view: View): string {
    return formatHash(view === 'results' ? { view, id: resultId } : { view })
  }

  // on Results: the open result, and its Export menu
  const result = $derived(
    route.view === 'results' && openResult.current !== null && openResult.current.id === route.id ? openResult.current : null,
  )
  const resultView = $derived(result ? resultsViewFor(result) : null)
  const resultChip = $derived.by(() => {
    if (!result) return ''
    const files = result.design.rows.length
    const finished = new Date(result.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    const s = Math.round(result.outcome.seconds)
    const took = s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`
    return `${exportName(result)} · ${files} ${files === 1 ? 'file' : 'files'} · finished ${finished} · ${took}`
  })
</script>

<!-- One row of 52 px: the result's chip (flex basis 0) shrinks and truncates before anything wraps; at
     1100 px or less the subtitle hides and the gaps narrow; on windows of 900 px or less (max-[901px]:
     width < 901px) the chip takes a second row. Should the fixed items still not fit (a running search's
     progress, a narrow window), the right-hand group wraps to a row of its own instead of overflowing. -->
<header
  class="flex min-h-[52px] flex-wrap items-center gap-x-6 gap-y-1.5 border-b bg-background px-5 py-2.5 *:shrink-0 max-[1101px]:gap-x-4">
  <div class="flex items-center gap-2 text-[15px] font-semibold tracking-tight whitespace-nowrap">
    <img src={openmsLogo} alt="OpenMS" width="36" height="36" class="size-9 select-none dark:rounded-md dark:bg-zinc-100 dark:p-0.5" draggable="false" data-testid="openms-logo" />
    <span>ProSE<small class="ml-1.5 text-xs font-normal text-muted-foreground max-[1101px]:hidden">OpenMS search engine</small></span>
  </div>
  <nav aria-label="Main" class="flex gap-1">
    {#each items as item (item.view)}
      {@const active = route.view === item.view}
      <a
        href={hrefOf(item.view)}
        aria-current={active ? 'page' : undefined}
        class={cn(
          'rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors',
          active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}>{item.label}</a
      >
    {/each}
  </nav>
  {#if result}
    <div
      class="flex min-w-0 flex-1 basis-0 items-center gap-6 shrink! max-[901px]:order-last max-[901px]:basis-full max-[901px]:gap-4">
      <Badge
        variant="outline"
        class="block h-6 max-w-[28rem] min-w-0 shrink truncate bg-background px-2.5 leading-[22px] font-normal text-muted-foreground"
        title={resultChip}
        data-testid="result-chip">{resultChip}</Badge>
    </div>
  {/if}
  <!-- the right-hand side -->
  <div class="ml-auto flex items-center gap-x-6 max-[1101px]:gap-x-4">
    {#if searchProgress.running && route.view !== 'search'}
      <!-- a search runs on while the user is elsewhere: its progress, and the way back to it -->
      <a
        href={formatHash({ view: 'search' })}
        class="rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        title="{searchProgress.label}. Click to go back to New search."
        aria-label="Search running{searchProgress.indeterminate ? '' : `, ${searchProgress.percent} %`}: back to New search"
        data-testid="topbar-search-progress">
        <SearchProgress compact />
      </a>
    {/if}
    {#if resultView}
      <ExportMenu view={resultView} />
    {/if}
    <ThemeMenu />
  </div>
</header>
