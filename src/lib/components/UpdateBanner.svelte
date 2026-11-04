<script lang="ts">
  // Under the top bar, when the check at start found a newer release (update.svelte.ts): "NuXL 0.4.0 is available",
  // Download (its page in the system's browser) and Not now (the banner stays away for that version).
  import { Button } from '$lib/components/ui/button'
  import { dismissUpdate, downloadFromBanner, updateState } from '$lib/update/update.svelte'
  import CircleArrowUp from '@lucide/svelte/icons/circle-arrow-up'
  import ExternalLink from '@lucide/svelte/icons/external-link'
</script>

<!-- the live region is always there (empty without a banner), so that screen readers read the banner when it comes -->
<div role="status" data-testid="update-banner-region">
  {#if updateState.banner}
    <div
      class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-background px-5 py-1.5 text-sm"
      data-testid="update-banner">
      <CircleArrowUp class="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span>
        <span class="font-medium">NuXL {updateState.banner.version} is available</span>
        {#if updateState.appVersion}<span class="text-muted-foreground">(this is {updateState.appVersion})</span>{/if}
      </span>
      <div class="flex items-center gap-1.5">
        <Button size="xs" onclick={() => void downloadFromBanner()} data-testid="update-download">
          Download<ExternalLink class="size-3" aria-hidden="true" />
        </Button>
        <Button size="xs" variant="ghost" class="text-muted-foreground" onclick={dismissUpdate} data-testid="update-dismiss">Not now</Button>
      </div>
      {#if updateState.openError?.from === 'banner'}
        <span class="basis-full text-xs text-destructive" role="alert">{updateState.openError.message}</span>
      {/if}
    </div>
  {/if}
</div>
