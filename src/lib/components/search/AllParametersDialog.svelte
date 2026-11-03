<script lang="ts">
  // "All N parameters": every OpenNuXL option the app may set (the shim's allowlist), from OpenNuXL's option list of
  // the OpenMS pin made at build time (`NUXL_PARAMETERS`, src/lib/settings/nuxl.ts), by section, with OpenNuXL's own
  // descriptions. The FDRs, Percolator and the threads are the search's own settings, on the page only. Changes apply
  // at once to the same settings as the page's fields, so presets save them. The adducts' NuXL fields count only with
  // the custom protocol (`searchPlan.blockedReason`).
  import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import { searchForm as form } from '$lib/search/form.svelte'
  import { searchPlan } from '$lib/search/plan.svelte'
  import { rangeMessage } from '$lib/settings/ranges'
  import { dialogEntries, parameterSections, sameValue } from '$lib/settings/parameters'
  import ParameterField from './ParameterField.svelte'

  let { open = $bindable(false), initialFilter = '' }: { open?: boolean; initialFilter?: string } = $props()

  let filter = $state('')
  // each opening starts from the filter it is opened with ("NuXL:" for the adducts of the custom protocol)
  let wasOpen = false
  $effect.pre(() => {
    if (open && !wasOpen) filter = initialFilter
    wasOpen = open
  })
  let showAdvanced = $state(false)
  /** Parameters whose long description is shown in full. */
  let expanded = $state<string[]>([])
  const LONG = 220

  const entries = $derived(dialogEntries([...form.entries.values()]))
  const shown = $derived.by(() => {
    const q = filter.trim().toLowerCase()
    return entries.filter(
      (e) =>
        (showAdvanced || !e.tags.includes('advanced') || q !== '') &&
        (q === '' || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)),
    )
  })
  const sections = $derived(parameterSections(shown))
  const advancedCount = $derived(entries.filter((e) => e.tags.includes('advanced')).length)

  /** A default for people: text as is, lists comma-separated, switches on/off. */
  function defaultText(value: unknown): string {
    if (Array.isArray(value)) return value.length === 0 ? 'none' : value.join(', ')
    if (typeof value === 'boolean') return value ? 'on' : 'off'
    return value === '' || value === null || value === undefined ? 'empty' : String(value)
  }

  const fieldId = (name: string) => `param-${name.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const isChanged = (name: string) => !sameValue(form.values[name], form.defaults[name])
  /** The inverted range (lowest above highest) the parameter is part of. */
  const invertedRange = (name: string) => searchPlan.inverted.find((r) => r.min === name || r.max === name)
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
    <Dialog.Header class="gap-1 border-b px-5 pt-5 pb-3">
      <Dialog.Title class="text-[15px] font-semibold">All {entries.length} parameters</Dialog.Title>
      <Dialog.Description class="text-xs">
        OpenNuXL's parameters with their defaults and descriptions. Changes apply to this search right away. The common
        ones are also on the page, with the FDRs, Percolator and the threads. The nucleotides and adducts of the NuXL
        section count only with the protocol “none (custom adducts)”.
      </Dialog.Description>
      <div class="mt-2 flex flex-wrap items-center gap-3">
        <Input
          class="h-8 max-w-xs bg-background text-[13px] shadow-none md:text-[13px]"
          placeholder="Find a parameter"
          aria-label="Find a parameter"
          bind:value={filter} />
        <div class="flex items-center gap-2">
          <Switch id="show-advanced" size="sm" bind:checked={showAdvanced} />
          <Label for="show-advanced" class="text-xs font-normal">Show the {advancedCount} advanced parameters</Label>
        </div>
      </div>
    </Dialog.Header>

    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-3">
      {#each sections as section (section.name)}
        <section class="py-2">
          <h3 class="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{section.name}</h3>
          <div class="divide-y">
            {#each section.entries as entry (entry.name)}
              {@const id = fieldId(entry.name)}
              {@const changed = isChanged(entry.name)}
              {@const long = entry.description.length > LONG}
              {@const full = expanded.includes(entry.name)}
              <div class="grid gap-x-4 gap-y-1 py-2 sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <label for={id} id="{id}-label" class="truncate font-mono text-[12.5px]" title={entry.name}>{entry.name}</label>
                    {#if entry.tags.includes('advanced')}
                      <span class="rounded-sm bg-muted px-1 text-[10.5px] text-muted-foreground">advanced</span>
                    {/if}
                  </div>
                  {#if changed}
                    <button
                      type="button"
                      class="mt-0.5 inline-flex max-w-full items-center gap-1 rounded-sm text-[11.5px] text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      onclick={() => form.setParam(entry.name, form.defaults[entry.name])}
                      aria-label="Reset {entry.name} to its default">
                      <RotateCcwIcon class="size-3 shrink-0" /><span class="truncate">default: {defaultText(entry.value)}</span>
                    </button>
                  {/if}
                </div>
                <div class="grid min-w-0 gap-1">
                  <ParameterField
                    {entry}
                    {id}
                    labelId="{id}-label"
                    value={form.values[entry.name]}
                    blocked={searchPlan.blockedReason(entry.name)}
                    onChange={(v) => (entry.name === 'NuXL:presets' ? form.setProtocol(String(v)) : form.setParam(entry.name, v))} />
                  {#if invertedRange(entry.name)}
                    {@const inverted = invertedRange(entry.name)!}
                    <p class="text-xs text-destructive" data-testid="range-inverted">{rangeMessage(inverted, form.values)}</p>
                  {/if}
                  <p class="text-xs whitespace-pre-line text-muted-foreground {long && !full ? 'line-clamp-2' : ''}">
                    {entry.description}
                  </p>
                  {#if long}
                    <button
                      type="button"
                      class="justify-self-start rounded-sm text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                      aria-expanded={full}
                      onclick={() => (expanded = full ? expanded.filter((n) => n !== entry.name) : [...expanded, entry.name])}
                      >{full ? 'Less' : 'More'}</button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {:else}
        <p class="py-6 text-center text-muted-foreground">No parameter matches “{filter}”.</p>
      {/each}
    </div>

    <Dialog.Footer class="border-t px-5 py-3">
      <Button variant="outline" size="sm" disabled={!form.modified} onclick={() => form.choosePreset(form.presetId)}>
        Back to the preset
      </Button>
      <Button size="sm" onclick={() => (open = false)}>Done</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
