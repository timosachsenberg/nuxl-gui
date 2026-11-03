<script lang="ts">
  // Counts of named things as horizontal bars (a bar chart of one series, so one colour; or stacked, with `segments`:
  // each item's `parts` in their colours, e.g. peptide and cross-link PSMs): the PSMs of each file, of each adduct or
  // amino acid. The name at the left, the value at the bar's end. The bars are at most 16 px thick with the data end
  // rounded, drawn from one baseline. Hovering a row names the item in full. The numbers are also in the
  // table under the chart (`ChartCard`).
  import { hBarPath, fitText } from '$lib/format/chart'
  import { formatCount } from '$lib/results/display'
  import { px, textWidth } from '$lib/psm/plot'
  import ChartTooltip from './ChartTooltip.svelte'

  let {
    title,
    description,
    items,
    color,
    unit = 'PSMs',
    testid = 'file-chart',
    mono = false,
    segments,
  }: {
    title: string
    description: string
    /** The bars: `file` is the name at the left (a file, an adduct, an amino acid). */
    items: { file: string; count: number; parts?: number[] }[]
    color: string
    /** Stacked bars: the colour and name of each of the items' `parts` (which add up to `count`). */
    segments?: { name: string; color: string }[]
    unit?: string
    /** `data-testid` of the chart. */
    testid?: string
    /** The names in monospace (formulas, residues). */
    mono?: boolean
  } = $props()

  const uid = $props.id()
  const font = "'Inter Variable', ui-sans-serif, system-ui, sans-serif"
  const monoFont = "'Liberation Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
  // the theme's colours (app.css)
  const ink = 'var(--plot-ink)'
  const rowHeight = 28
  const barHeight = 16
  const maxName = 230

  let width = $state(520)
  // (a monospace character is about 0.6 em)
  const nameWidth = (name: string) => (mono ? name.length * 7.3 : textWidth(name, 12))
  const longest = $derived(Math.max(0, ...items.map((i) => nameWidth(i.file))))
  const labelWidth = $derived(Math.min(maxName, Math.ceil(longest)))
  const max = $derived(Math.max(1, ...items.map((i) => i.count)))
  const valueWidth = $derived(textWidth(formatCount(max), 12) + 10)
  const x0 = $derived(labelWidth + 12)
  const span = $derived(Math.max(20, width - x0 - valueWidth - 6))
  const height = $derived(items.length * rowHeight + 8)

  /** The segments of a stacked bar `length` long: each part's start and width; `last`: the one with the rounded end. */
  function stack(parts: number[], length: number): { x: number; w: number; last: boolean }[] {
    const total = parts.reduce((a, b) => a + b, 0) || 1
    const lastPart = parts.findLastIndex((p) => p > 0)
    let at = x0
    return parts.map((p, j) => {
      const w = (p / total) * Math.max(2, length)
      const s = { x: at, w, last: j === lastPart }
      at += w
      return s
    })
  }
  const tipOf = (row: number): string[] => {
    const item = items[row]
    const lines = [item.file, `${formatCount(item.count)} ${unit}`]
    if (segments && item.parts) segments.forEach((s, j) => lines.push(`${s.name} · ${formatCount(item.parts![j] ?? 0)}`))
    return lines
  }

  let hover = $state<{ row: number; y: number } | null>(null)
  function onpointermove(event: PointerEvent) {
    const box = (event.currentTarget as SVGSVGElement).getBoundingClientRect()
    const row = Math.floor((event.clientY - box.top - 4) / rowHeight)
    hover = row >= 0 && row < items.length ? { row, y: 4 + row * rowHeight + rowHeight / 2 } : null
  }
</script>

<div class="relative" bind:clientWidth={width}>
  <svg
    data-testid={testid}
    role="img"
    aria-labelledby="{uid}-title"
    aria-describedby="{uid}-desc"
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    font-family={font}
    class="block"
    {onpointermove}
    onpointerleave={() => (hover = null)}>
    <title id="{uid}-title">{title}</title>
    <desc id="{uid}-desc">{description}</desc>
    {#if hover}<rect x="0" y={4 + hover.row * rowHeight} {width} height={rowHeight} fill="var(--plot-band)" />{/if}
    <line x1={x0} x2={x0} y1="4" y2={height - 4} stroke="var(--plot-axis)" stroke-width="1" />
    {#each items as item, i (i)}
      {@const top = 4 + i * rowHeight + (rowHeight - barHeight) / 2}
      {@const length = (item.count / max) * span}
      <text x={labelWidth} y={px(top + barHeight / 2 + 4)} text-anchor="end" font-size="12" fill={ink} font-family={mono ? monoFont : undefined} data-testid="file-name">{fitText(item.file, maxName, 12)}</text>
      {#if item.count > 0 && segments && item.parts}
        <g data-testid="file-bar">
          {#each stack(item.parts, length) as s, j (j)}<path d={s.last ? hBarPath(s.x, top, s.w, barHeight, 4) : `M${px(s.x)} ${px(top)}h${px(s.w)}v${barHeight}h${px(-s.w)}Z`} fill={segments[j].color} data-testid="file-bar-part" />{/each}
        </g>
      {:else if item.count > 0}<path d={hBarPath(x0, top, Math.max(2, length), barHeight, 4)} fill={color} data-testid="file-bar" />{:else}<path d="" data-testid="file-bar" />{/if}
      <text x={px(x0 + Math.max(2, length) + 6)} y={px(top + barHeight / 2 + 4)} font-size="12" fill={ink} data-testid="file-value">{formatCount(item.count)}</text>
    {/each}
  </svg>
  {#if hover}<ChartTooltip x={x0 + 20} y={hover.y} lines={tipOf(hover.row)} {width} />{/if}
</div>
