<script lang="ts">
  // The top bar's About menu: the app's version and OpenNuXL's, "Check for updates" with its result in place (the
  // latest version, a newer one with Download, or why it could not check), and the setting "Check for new versions
  // at start" (on by default; update.svelte.ts).
  import { Button, buttonVariants } from '$lib/components/ui/button'
  import * as Popover from '$lib/components/ui/popover'
  import { Switch } from '$lib/components/ui/switch'
  import { updateSettings } from '$lib/format/settings.svelte'
  import { toolState } from '$lib/search/tool.svelte'
  import { checkNow, loadAppVersion, openRelease, updateState } from '$lib/update/update.svelte'
  import { cn } from '$lib/utils'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Info from '@lucide/svelte/icons/info'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'

  const switchId = 'about-check-at-start'
  void loadAppVersion()

  const tool = $derived(
    toolState.status === 'ready' && toolState.info
      ? `OpenNuXL ${toolState.info.version}`
      : toolState.status === 'failed'
        ? 'OpenNuXL was not found'
        : 'OpenNuXL …',
  )
  const manual = $derived(updateState.manual)
</script>

<Popover.Root>
  <Popover.Trigger
    class={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'size-7 text-muted-foreground hover:text-foreground')}
    title="About NuXL"
    aria-label="About NuXL"
    data-testid="about-menu">
    <Info class="size-4" aria-hidden="true" />
  </Popover.Trigger>
  <Popover.Content class="w-80 gap-3" align="end" aria-label="About NuXL" data-testid="about-panel">
    <div class="grid gap-0.5">
      <p class="font-semibold" data-testid="about-version">NuXL {updateState.appVersion ?? ''}</p>
      <p class="text-xs text-muted-foreground" data-testid="about-tool">{tool}</p>
    </div>
    <div class="grid gap-2 border-t pt-3">
      <Button
        variant="outline"
        size="sm"
        class="justify-self-start"
        disabled={manual.status === 'checking'}
        onclick={() => void checkNow()}
        data-testid="update-check">
        {#if manual.status === 'checking'}<LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />{/if}
        Check for updates
      </Button>
      <!-- the result, read out when it comes -->
      <div class="text-xs empty:hidden" aria-live="polite" data-testid="update-result">
        {#if manual.status === 'checking'}
          <p class="text-muted-foreground">Checking…</p>
        {:else if manual.status === 'current'}
          <p>You have the latest version ({manual.version}).</p>
        {:else if manual.status === 'newer'}
          <div class="flex flex-wrap items-center gap-2">
            <p class="font-medium">NuXL {manual.version} is available.</p>
            <Button size="xs" onclick={() => void openRelease(manual.version, 'panel')} data-testid="update-result-download">
              Download<ExternalLink class="size-3" aria-hidden="true" />
            </Button>
          </div>
        {:else if manual.status === 'error'}
          <p class="text-destructive">Could not check: {manual.message}</p>
        {/if}
        {#if updateState.openError?.from === 'panel'}
          <p class="mt-1 text-destructive">{updateState.openError.message}</p>
        {/if}
      </div>
    </div>
    <div class="grid gap-1.5 border-t pt-3">
      <div class="flex items-center gap-2">
        <Switch
          id={switchId}
          size="sm"
          bind:checked={() => updateSettings.checkAtStart, (value) => (updateSettings.checkAtStart = value)}
          data-testid="update-at-start" />
        <label for={switchId} class="text-sm">Check for new versions at start</label>
      </div>
      <p class="text-xs text-muted-foreground">
        The check asks GitHub (api.github.com) for the latest release of NuXL. Nothing about your files or searches is
        sent; GitHub sees the IP address and the web view's standard headers (system and browser version, language).
      </p>
    </div>
  </Popover.Content>
</Popover.Root>
