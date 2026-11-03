<script lang="ts">
  // The top bar's theme menu: System (the default: the system's light or dark), Light or Dark, kept
  // on this computer. The button shows the theme on the page, a sun or a moon.
  import { buttonVariants } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { theme } from '$lib/theme/theme.svelte'
  import type { ThemePreference } from '$lib/theme/theme'
  import { cn } from '$lib/utils'
  import Monitor from '@lucide/svelte/icons/monitor'
  import Moon from '@lucide/svelte/icons/moon'
  import Sun from '@lucide/svelte/icons/sun'

  const choices: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
    { value: 'system', label: 'System', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ]

  const label = $derived(
    `Theme: ${theme.preference === 'system' ? `System (${theme.current === 'dark' ? 'dark' : 'light'})` : theme.preference === 'dark' ? 'Dark' : 'Light'}`,
  )
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'size-7 text-muted-foreground hover:text-foreground')}
    title={label}
    aria-label={label}
    data-testid="theme-menu">
    {#if theme.current === 'dark'}<Moon class="size-4" aria-hidden="true" />{:else}<Sun class="size-4" aria-hidden="true" />{/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-auto min-w-36" align="end">
    <DropdownMenu.Label class="text-xs font-normal text-muted-foreground">Theme</DropdownMenu.Label>
    <DropdownMenu.RadioGroup bind:value={() => theme.preference, (value) => (theme.preference = value as ThemePreference)}>
      {#each choices as choice (choice.value)}
        <DropdownMenu.RadioItem value={choice.value} data-testid="theme-{choice.value}">
          <choice.icon class="size-3.5 text-muted-foreground" aria-hidden="true" />{choice.label}
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
