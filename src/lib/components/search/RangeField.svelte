<script lang="ts">
  // A range of two whole numbers ("2 – 5") in one field, e.g. the precursor charges. A range whose lowest value
  // is above its highest is marked (`invalid`, with `describedBy` saying why); the search does not start with it.
  import * as InputGroup from '$lib/components/ui/input-group'
  import { cn } from '$lib/utils'
  import NumberField from './NumberField.svelte'

  let {
    labelId,
    from,
    to,
    fromLabel,
    toLabel,
    min,
    max,
    invalid = false,
    describedBy,
    onFrom,
    onTo,
  }: {
    /** The id of the visible label of the field. */
    labelId: string
    from: number | undefined
    to: number | undefined
    fromLabel: string
    toLabel: string
    min?: number
    max?: number
    invalid?: boolean
    /** The id of the text that says why the range is not valid. */
    describedBy?: string
    onFrom: (value: number) => void
    onTo: (value: number) => void
  } = $props()
</script>

<InputGroup.Root
  class={cn('h-8 bg-background shadow-none', invalid && 'border-destructive ring-3 ring-destructive/20 dark:ring-destructive/40')}
  aria-labelledby={labelId}
  aria-invalid={invalid || undefined}
  aria-describedby={invalid ? describedBy : undefined}>
  <NumberField value={from} kind="int" {min} {max} inGroup fit ariaLabel={fromLabel} onChange={onFrom} class="flex-none pr-0" />
  <span class="px-1.5" aria-hidden="true">–</span>
  <NumberField value={to} kind="int" {min} {max} inGroup ariaLabel={toLabel} onChange={onTo} class="w-0 min-w-0 flex-1 pl-0" />
</InputGroup.Root>
