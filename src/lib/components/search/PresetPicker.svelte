<script lang="ts">
  // The preset of the search settings: its select, "modified" while the settings differ from it, and a menu to
  // rename or delete a user preset (built-in ones stay as they are). Choosing another preset after changing
  // settings asks first: the changes would be lost.
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis'
  import { Button, buttonVariants } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { searchForm as form } from '$lib/search/form.svelte'
  import { presetNamed, type Preset } from '$lib/settings/presets'
  import { cn } from '$lib/utils'
  import ChoiceSelect from './ChoiceSelect.svelte'

  const options = $derived(form.presets.map((p) => ({ value: p.id, label: p.name })))
  const userPreset = $derived(form.preset && !form.preset.builtin ? form.preset : null)

  /** The preset chosen while the settings were changed: asked about before it replaces them. */
  let switchTo = $state<Preset | null>(null)
  let switchOpen = $state(false)
  /** The select is drawn again after a switch that was not confirmed, so that it shows the preset in force. */
  let selectKey = $state(0)

  function choose(id: string) {
    if (id === form.presetId && !form.modified) return
    const preset = form.presets.find((p) => p.id === id)
    if (!preset) return
    if (!form.edited) {
      form.choosePreset(id)
      return
    }
    switchTo = preset
    switchOpen = true
  }

  function confirmSwitch() {
    if (switchTo) form.choosePreset(switchTo.id)
    switchTo = null
    switchOpen = false
  }

  $effect(() => {
    // closed without confirming (Cancel, Escape): the select goes back to the preset in force
    if (!switchOpen && switchTo !== null) {
      switchTo = null
      selectKey++
    }
  })

  let renameOpen = $state(false)
  let renameTo = $state('')
  const renameTaken = $derived.by(() => {
    const other = presetNamed(form.presets, renameTo)
    return other !== null && other.id !== userPreset?.id
  })

  function startRename() {
    if (!userPreset) return
    renameTo = userPreset.name
    renameOpen = true
  }

  function rename() {
    if (!userPreset || renameTo.trim() === '' || renameTaken) return
    form.renamePreset(userPreset.id, renameTo)
    renameOpen = false
  }

  let deleteOpen = $state(false)

  function remove() {
    if (userPreset) form.deletePreset(userPreset.id)
    deleteOpen = false
  }
</script>

<Label for="preset" class="font-normal text-muted-foreground">Preset</Label>
{#key selectKey}
  <ChoiceSelect id="preset" class="w-[230px]" value={form.presetId} {options} onChange={choose} />
{/key}
<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class={cn(buttonVariants({ variant: 'ghost', size: 'icon-xs' }), 'text-muted-foreground')}
    aria-label="Preset actions"
    data-testid="preset-menu"><EllipsisIcon /></DropdownMenu.Trigger>
  <DropdownMenu.Content class="w-auto min-w-44" align="start">
    <DropdownMenu.Item disabled={!userPreset} onSelect={startRename}>Rename preset…</DropdownMenu.Item>
    <DropdownMenu.Item disabled={!userPreset} variant="destructive" onSelect={() => (deleteOpen = true)}>Delete preset…</DropdownMenu.Item>
    {#if !userPreset}
      <p class="px-2 py-1 text-xs text-muted-foreground">Built-in presets cannot be renamed or deleted.</p>
    {/if}
  </DropdownMenu.Content>
</DropdownMenu.Root>
{#if form.modified}
  <span class="text-xs text-muted-foreground">modified</span>
{/if}

<Dialog.Root bind:open={switchOpen}>
  <Dialog.Content class="gap-4 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Discard your changes?</Dialog.Title>
      <Dialog.Description>
        You changed settings of “{form.preset?.name ?? 'the preset'}”. “{switchTo?.name}” replaces them with its own. To keep
        them, save them as a preset first.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (switchOpen = false)}>Keep my changes</Button>
      <Button size="sm" onclick={confirmSwitch}>Discard and switch</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={renameOpen}>
  <Dialog.Content class="gap-4 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Rename preset</Dialog.Title>
      <Dialog.Description>The preset's settings stay as they are.</Dialog.Description>
    </Dialog.Header>
    <form
      class="grid gap-1.5"
      onsubmit={(e) => {
        e.preventDefault()
        rename()
      }}>
      <Label for="preset-rename" class="text-xs">Name</Label>
      <Input id="preset-rename" class="h-8 text-[13px] md:text-[13px]" bind:value={renameTo} autocomplete="off" />
      {#if renameTaken}
        <p class="text-xs text-destructive">Another preset has this name.</p>
      {/if}
    </form>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (renameOpen = false)}>Cancel</Button>
      <Button size="sm" disabled={renameTo.trim() === '' || renameTaken} onclick={rename}>Rename</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={deleteOpen}>
  <Dialog.Content class="gap-4 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Delete this preset?</Dialog.Title>
      <Dialog.Description>
        This removes “{userPreset?.name}” from this computer. The settings on the page stay as they are.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (deleteOpen = false)}>Cancel</Button>
      <Button variant="destructive" size="sm" onclick={remove}>Delete</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
