<script lang="ts">
  import { fdrChoices, formatPercent, formatQ, parsePercent, parsePercentOrOff, percentNumber } from '$lib/format/fdr'
  import { cn } from '$lib/utils'

  let {
    value = $bindable(0.01),
    max,
    off = false,
    disabled = false,
    id,
    'aria-label': ariaLabel,
    'aria-describedby': describedBy,
    class: className,
  }: {
    /** the cutoff as a q-value (0.01 is 1 %) */
    value?: number
    /** the largest cutoff allowed (a q-value): longer values are rejected and their chips disabled */
    max?: number
    /** 0 is allowed and means no cutoff (the protein FDR: ProSE applies none): the field says "off", with an Off chip */
    off?: boolean
    /** not editable (the value shows, the chips are disabled) */
    disabled?: boolean
    id?: string
    'aria-label'?: string
    'aria-describedby'?: string
    class?: string
  } = $props()

  // what the user is typing, until the field loses focus or a chip is picked
  let draft = $state<string | null>(null)
  // the value before the user started typing: an invalid entry gives it back, never the valid prefix that was typed
  // on the way ("150" is no 15 %)
  let before: number | null = null
  let input = $state<HTMLInputElement | null>(null)

  const parse = (typedText: string) => (off ? parsePercentOrOff(typedText) : parsePercent(typedText))
  const text = $derived(draft ?? (off && value === 0 ? 'off' : percentNumber(value)))
  const typed = $derived(draft === null ? value : parse(draft))
  const tooLarge = (q: number) => max !== undefined && q > max * (1 + 1e-9)
  /** a q-value the field takes: above 0 (or 0 where it can be off), at most 1 */
  const inRange = (q: number) => Number.isFinite(q) && (q > 0 || (off && q === 0)) && q <= 1
  // (the value itself can be out of range too: ProSE's default PSM FDR is 0, which a reset to the default sets)
  const invalid = $derived(!disabled && (typed === null || !inRange(typed) || tooLarge(typed)))
  /** the field holds the word "off" (no percent sign then) */
  const saysOff = $derived(/^\s*off\s*$/i.test(text))
  function hintOf(q: number | null): string {
    if (q === null || !inRange(q)) return off ? 'off, or > 0 – 100 %' : '> 0 – 100 %'
    if (tooLarge(q)) return `at most ${formatPercent(max!)}`
    // off has no q-value; a typed 0 gets the word beside it
    if (q === 0) return saysOff ? '' : 'off'
    return formatQ(q)
  }
  const hint = $derived(hintOf(typed))

  function edit(event: Event & { currentTarget: HTMLInputElement }) {
    if (draft === null) before = value
    draft = event.currentTarget.value
    const q = parse(draft)
    if (q !== null && !tooLarge(q)) value = q
    else if (before !== null && value !== before) value = before
  }

  /** The field loses focus: it shows the value again (an invalid entry: the one before it). */
  function leave() {
    draft = null
    before = null
  }

  function choose(q: number) {
    leave()
    value = q
  }
</script>

<div class={cn('grid gap-2', className)}>
  <!-- a click anywhere in the field focuses the input; the keyboard goes to the input itself -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class={cn(
      'flex h-9 w-full min-w-0 cursor-text items-center gap-1 rounded-md border border-input bg-transparent px-2.5 shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30',
      disabled && 'cursor-not-allowed opacity-50',
    )}
    aria-invalid={invalid}
    onclick={() => input?.focus()}>
    <input
      bind:this={input}
      {id}
      {disabled}
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      class="min-w-[1ch] bg-transparent text-[13px] outline-none"
      style:width="{Math.max(text.length, 1) + 0.5}ch"
      inputmode="decimal"
      autocomplete="off"
      spellcheck="false"
      value={text}
      oninput={edit}
      onblur={leave} />
    {#if !saysOff}
      <span class="text-[13px]">%</span>
    {/if}
    <span class={cn('ml-auto pl-2 text-[13px] whitespace-nowrap tabular-nums', invalid ? 'text-destructive' : 'text-muted-foreground')}
      >{hint}</span>
  </div>
  <div class="flex gap-1.5">
    {#each off ? [0, ...fdrChoices] : fdrChoices as q (q)}
      {@const active = value === q}
      <button
        type="button"
        class={cn(
          'h-6 rounded-full border px-2.5 text-xs whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50',
          active ? 'border-foreground text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
        aria-pressed={active}
        disabled={disabled || tooLarge(q)}
        onclick={() => choose(q)}>{q === 0 ? 'Off' : formatPercent(q)}</button
      >
    {/each}
  </div>
</div>
