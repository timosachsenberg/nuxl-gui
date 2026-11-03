<script lang="ts">
  // "Save as preset": the settings that differ from ProSE's defaults, kept by the app on this computer. A name
  // a user preset has already replaces that preset, and the dialog says so first (its button reads Replace).
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { searchForm as form } from '$lib/search/form.svelte'
  import { presetNamed } from '$lib/settings/presets'

  let { open = $bindable(false) }: { open?: boolean } = $props()

  let name = $state('')
  const existing = $derived(presetNamed(form.presets, name))
  const builtinName = $derived(existing?.builtin === true)
  const replaces = $derived(existing !== null && !existing.builtin)

  // a user preset is offered for overwriting, a built-in one is not
  $effect(() => {
    if (open) name = form.preset && !form.preset.builtin ? form.preset.name : ''
  })

  function save() {
    if (name.trim() === '' || builtinName) return
    form.saveAsPreset(name)
    open = false
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="gap-4 sm:max-w-sm">
    <Dialog.Header>
      <Dialog.Title>Save as preset</Dialog.Title>
      <Dialog.Description>
        The app saves the settings that differ from ProSE's defaults on this computer. Percolator and PeptDeep are not
        part of a preset.
      </Dialog.Description>
    </Dialog.Header>
    <form
      class="grid gap-1.5"
      onsubmit={(e) => {
        e.preventDefault()
        save()
      }}>
      <Label for="preset-name" class="text-xs">Name</Label>
      <Input id="preset-name" class="h-8 text-[13px] md:text-[13px]" bind:value={name} autocomplete="off" />
      {#if builtinName}
        <p class="text-xs text-destructive">A built-in preset has this name.</p>
      {:else if replaces}
        <p class="text-xs text-muted-foreground" data-testid="preset-replaces">
          A preset of this name exists. Saving replaces its settings with these.
        </p>
      {/if}
    </form>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (open = false)}>Cancel</Button>
      <Button size="sm" disabled={name.trim() === '' || builtinName} onclick={save}>{replaces ? 'Replace' : 'Save'}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
