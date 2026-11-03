<script lang="ts">
  // One of OpenNuXL's parameters in the "All parameters" dialog, its control chosen by its type: a switch (a flag,
  // or a "true"/"false" choice), a select of the allowed values, a number, text, a list (one per line, or checkboxes
  // of the allowed values, or the modification picker). A parameter that does nothing with the other settings (the
  // adducts with a protocol: `blocked`) is disabled and says why; a switch is off then. An empty text runs with
  // OpenNuXL's default (the shim passes no argument for it): the field shows that default and says so.
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import { Textarea } from '$lib/components/ui/textarea'
  import { choiceLabel } from '$lib/settings/labels'
  import { emptyTextDefault, type ParamEntry } from '$lib/settings/parameters'
  import ChoiceSelect from './ChoiceSelect.svelte'
  import ModificationsField from './ModificationsField.svelte'
  import NumberField from './NumberField.svelte'

  let {
    entry,
    id,
    labelId,
    value,
    onChange,
    blocked = null,
  }: {
    entry: ParamEntry
    id: string
    labelId: string
    value: unknown
    onChange: (value: unknown) => void
    /** Why the parameter does nothing with the other settings (it is then disabled); null: it counts. */
    blocked?: string | null
  } = $props()

  const list = $derived(Array.isArray(value) ? (value as unknown[]) : [])
  const lines = $derived(list.map(String).join('\n'))
  /** A choice of "true" and "false" (peptide:clip_nterm_methionine): a switch that keeps the strings. */
  const textSwitch = $derived(
    entry.type === 'string' && entry.validStrings?.length === 2 && entry.validStrings.includes('true') && entry.validStrings.includes('false'),
  )
  /** OpenNuXL's default of a text left empty, which then applies (null: none, or the text is not empty). */
  const fallback = $derived(emptyTextDefault(entry))
  const emptyText = $derived(fallback !== null && (value === '' || value === null || value === undefined))
  const describedBy = $derived(blocked ? `${id}-blocked` : emptyText ? `${id}-default` : undefined)

  function fromLines(text: string) {
    const items = text.split('\n').map((s) => s.trim()).filter(Boolean)
    if (entry.type === 'string[]') onChange(items)
    else {
      const numbers = items.map((s) => Number(s.replace(',', '.')))
      if (numbers.every(Number.isFinite) && (entry.type !== 'int[]' || numbers.every(Number.isInteger))) onChange(numbers)
    }
  }

  function toggle(option: string, on: boolean) {
    const current = list.map(String)
    onChange(on ? [...current, option] : current.filter((s) => s !== option))
  }
</script>

{#if entry.type === 'bool' || textSwitch}
  {@const on = textSwitch ? value === 'true' : value === true}
  <Switch
    {id}
    aria-labelledby={labelId}
    aria-describedby={describedBy}
    checked={on && !blocked}
    disabled={blocked !== null}
    onCheckedChange={(c) => onChange(textSwitch ? String(c) : c)} />
{:else if entry.type === 'string' && entry.validStrings}
  <ChoiceSelect
    {id}
    disabled={blocked !== null}
    value={String(value)}
    options={entry.validStrings.map((v) => ({ value: v, label: choiceLabel(entry.name, v) }))}
    onChange={(v) => onChange(v)} />
{:else if entry.type === 'int' || entry.type === 'double'}
  <NumberField
    {id}
    kind={entry.type}
    min={entry.min}
    max={entry.max}
    value={Number(value)}
    onChange={(v) => onChange(v)} />
{:else if entry.type === 'string[]' && entry.validStrings && entry.validStrings.length > 40}
  <ModificationsField
    {labelId}
    kind={entry.name.split(':').pop() ?? ''}
    value={list.map(String)}
    options={entry.validStrings}
    onChange={(v) => onChange(v)} />
{:else if entry.type === 'string[]' && entry.validStrings}
  <div class="flex flex-wrap gap-x-4 gap-y-1.5" role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
    {#each entry.validStrings as option (option)}
      <label class="inline-flex items-center gap-1.5 text-xs">
        <Checkbox checked={list.includes(option)} disabled={blocked !== null} onCheckedChange={(c) => toggle(option, c === true)} />
        <span class="font-mono">{option}</span>
      </label>
    {/each}
  </div>
{:else if entry.type.endsWith('[]')}
  <Textarea
    {id}
    rows={Math.min(6, Math.max(2, list.length))}
    class="min-h-0 bg-background font-mono text-xs shadow-none"
    placeholder="one per line"
    disabled={blocked !== null}
    aria-describedby={describedBy}
    value={lines}
    onchange={(e) => fromLines(e.currentTarget.value)} />
{:else}
  <Input
    {id}
    class="h-8 bg-background text-[13px] shadow-none md:text-[13px]"
    autocomplete="off"
    spellcheck="false"
    placeholder={fallback ?? undefined}
    disabled={blocked !== null}
    aria-describedby={describedBy}
    value={value === null || value === undefined ? '' : String(value)}
    oninput={(e) => onChange(e.currentTarget.value)} />
{/if}
{#if blocked}
  <p id="{id}-blocked" class="text-xs text-foreground">{blocked}</p>
{:else if emptyText && entry.type === 'string' && !entry.validStrings && !textSwitch}
  <p id="{id}-default" class="text-xs text-muted-foreground">Left empty, OpenNuXL uses its default “{fallback}”.</p>
{/if}
