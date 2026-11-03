<script lang="ts" module>
  /** An ion of the lower half, the theoretical spectrum (one height); `faint`: no peak within the tolerance. */
  export type BottomIon = { mz: number; height: number; type: string; ion: string; faint: boolean }

  /** The lower half: ions, or what is said instead (computing, or why it cannot be shown). */
  export type Bottom = { kind: 'ions'; label: string; ions: BottomIon[] } | { kind: 'status'; label: string; message: string }

  /** A peak of the upper half with its ions: drawn in `color`, labelled `label`, its ions (for the tooltip) `ions`. */
  export type PlotGroup = { peak: number; mz: number; intensity: number; label: string; color: string; ions: string[]; kinds: string }
</script>

<script lang="ts">
  // The annotated spectrum, mirrored (mockup 3): the observed peaks (or, without them, the peaks NuXL annotated)
  // above the axis, annotated ones in the colour of their kind with their ions as direct labels (the colours and the
  // legend are the caller's: components/psm/nuxl-psm.ts; unannotated peaks light grey); below the axis the
  // theoretical spectrum of the linear peptide. The upper half's 100 % is its base peak.
  //
  // Drawn by hand: each series is one path, so thousands of peaks stay a handful of nodes; labels are
  // placed most intense first and left out where they would collide. Hovering tells a peak's m/z,
  // intensity and ions; the ion table is the chart's table view. What only the page shows (the lower half
  // being computed) is marked `data-no-export`.
  //
  // Below the lower half, on the same m/z axis (one x scale, the same margins, so each dot sits under its peak), the
  // strip of the fragment mass errors: one dot per ion with a theoretical m/z, its error in the unit of the search's fragment
  // tolerance (ppm, or Da), its area by its peak's intensity, the band the tolerance; the m/z labels come below it.
  // It is part of the SVG, so "Export spectrum (SVG)" has it too.
  import { signedNumber } from '$lib/format/number'
  import { errorStats, errorTickDigits, fragmentError, ionLabel, COLORS, type Tolerance } from '$lib/psm/psm'
  import type { PeakMatch } from '$lib/results/types'
  import { typeColor, type ColoredMatch } from './nuxl-psm'
  import { clipMarks, mzDomain, nearest, niceTicks, placeLabels, placeLegend, px, scale, stickGroups, stickPath, stripFits, textWidth, wrapParts } from '$lib/psm/plot'

  let {
    mz,
    intensity,
    groups,
    reference,
    upper: upperName = 'Observed',
    legend: series,
    bottom,
    note = null,
    title,
    description,
    errors = null,
  }: {
    mz: Float32Array
    intensity: Float32Array
    /** The annotated peaks with their ions. */
    groups: PlotGroup[]
    /** The upper half's 100 %: an intensity, and what it is ("base peak"). */
    reference: { intensity: number; text: string }
    /** What the upper half is: "Observed", "NuXL's annotated peaks". */
    upper?: string
    /** The legend's series (unannotated peaks are added when there are any). */
    legend: { color: string; text: string }[]
    bottom: Bottom
    /** A note at the right of the lower half's label. */
    note?: string | null
    title: string
    description: string
    /** The fragment mass errors under the spectrum: the ions with their colours, and the search's fragment tolerance. */
    errors?: { matches: ColoredMatch[]; tolerance: Tolerance } | null
  } = $props()

  const uid = $props.id()
  /** The plot's own height; the strip below it has the bottom label and, if it does not fit beside it, a line for the note. */
  const plotHeight = 320
  const M = { left: 46, right: 14 }
  /** The lines of text above the plot, under it and over the error strip are 15 px apart. */
  const line = 15
  let width = $state(800)

  /** What the upper half is, at the top left. */
  const topLabel = $derived(`${upperName} · 100 % = ${reference.text}`)
  /**
   * The legend: the series that show, in a fixed order; beside the top label when both fit, else on
   * lines of their own under it (a narrow view), which move the plot down.
   */
  const legend = $derived.by(() => {
    const items: { color: string; text: string }[] = [...series]
    if (groups.length < mz.length) items.push({ color: COLORS.unmatched, text: 'not annotated' })
    // each item: the swatch (10 px), 5 px, the text, 7 px to the next
    const widths = items.map((item) => textWidth(item.text, 11) + 22)
    const placed = placeLegend(textWidth(topLabel, 11), widths, M.left, width - M.right)
    return { items: items.map((item, i) => ({ ...item, ...placed.items[i] })), lines: placed.lines }
  })
  /** The strip above the plot (what the upper half is, the legend) and the one below the axis labels. */
  const plotTop = $derived(24 + legend.lines * line)
  const plotBottom = $derived(plotTop + plotHeight - 66)
  const mid = $derived((plotTop + plotBottom) / 2)
  const font = "'Inter Variable', ui-sans-serif, system-ui, sans-serif"
  // the theme's colours (app.css); the SVG export resolves them in the light theme
  const ink = 'var(--plot-ink)'
  const muted = 'var(--plot-muted)'
  const halo = 'var(--plot-halo)'

  /** The lower half's label, broken into lines between its parts where the view is too narrow for it. */
  const bottomLines = $derived(wrapParts(bottom.label.split(' · '), width - M.left - M.right))
  /** The note moves to a line of its own when the label and it would meet (a narrow view). */
  const stacked = $derived(bottomLines.length > 1 || !stripFits(bottom.label, note, width - M.left - M.right))
  /** The lines the label and the note take below their first. */
  const bottomExtra = $derived((bottomLines.length - 1 + (note && stacked ? 1 : 0)) * line)
  /**
   * The lower half's label (and the note, on its own line when narrow): with the error strip right under the
   * lower half, else under the m/z labels.
   */
  const bottomLabelY = $derived(errors ? plotBottom + 16 : plotBottom + 36)
  /** The error strip: its header (one line or more), then its plot (errorTop to errorBottom). */
  const errorTop = $derived.by(() => bottomLabelY + bottomExtra + 30 + (errorLines.length - 1) * line)
  const errorBottom = $derived(errorTop + 84)
  /** The m/z labels sit below the lowest part: the lower half, or the error strip. */
  const axisBase = $derived(errors ? errorBottom : plotBottom)
  const H = $derived(errors ? axisBase + 24 : axisBase + 42 + bottomExtra)
  let svg = $state<SVGSVGElement | null>(null)

  /** The SVG (for "Export spectrum (SVG)"). */
  export function svgElement(): SVGSVGElement | null {
    return svg
  }

  const bottomIons = $derived(bottom.kind === 'ions' ? bottom.ions : [])
  const domain = $derived(mzDomain([mz, bottomIons.map((b) => b.mz)]))
  const x = $derived(scale(domain, [M.left, Math.max(M.left + 10, width - M.right)]))
  const ref = $derived(reference.intensity > 0 ? reference.intensity : 1)
  /** Upper half: the ratio to the reference (0–1) to y, with room for the labels of the tallest peaks. */
  const upper = $derived((r: number) => mid - r * (mid - plotTop - 18))
  /** Lower half: 0–1 to y. */
  const lower = $derived((r: number) => mid + r * (plotBottom - mid - 6))

  const groupOf = $derived(new Map(groups.map((g) => [g.peak, g])))

  /** The observed sticks: unannotated light grey, annotated by colour; above the reference clipped at 100 %. */
  const sticks = $derived.by(() => {
    const items: { mz: number; ratio: number; color: string }[] = []
    for (let i = 0; i < mz.length; i++) {
      const g = groupOf.get(i)
      items.push({ mz: mz[i], ratio: intensity[i] / ref, color: g ? g.color : COLORS.unmatched })
    }
    return stickGroups(items, x, upper)
  })

  /** The lower half's sticks, faint ones (theoretical ions without a match) apart. */
  const bottomSticks = $derived(
    stickGroups(
      bottomIons.map((b) => ({ mz: b.mz, ratio: b.height, color: typeColor(b.type), faint: b.faint })),
      x,
      lower,
    ),
  )

  /** The labels of the matched peaks, the most intense first; those without room are left out. */
  const labels = $derived.by(() => {
    const order = [...groups].sort((p, q) => q.intensity - p.intensity)
    const ys = placeLabels(
      order.map((g) => {
        const r = g.intensity / ref
        return { x: x(g.mz), y: upper(Math.min(1, r)) - (r > 1 ? 9 : 4), width: textWidth(g.label, 11) + 8 }
      }),
      { lineHeight: 12, tries: 4, top: plotTop + 10 },
    )
    const out: { x: number; y: number; text: string; ions: string; key: number }[] = []
    order.forEach((g, i) => {
      const y = ys[i]
      if (y !== null) out.push({ x: x(g.mz), y, text: g.label, ions: g.kinds, key: g.peak })
    })
    return out
  })

  const xTicks = $derived(niceTicks(domain[0], domain[1], Math.max(2, Math.floor((width - M.left - M.right) / 90))))

  // the error strip: the errors in the tolerance's unit, the band ±tolerance, a little room around it
  const unit = $derived(errors?.tolerance.unit ?? 'ppm')
  const errorOf = (m: PeakMatch) => fragmentError(m, mz, unit)
  const errorMax = $derived.by(() => {
    if (!errors) return 1
    const worst = Math.max(0, ...errors.matches.map((m) => Math.abs(errorOf(m))))
    return Math.max(errors.tolerance.value, worst) * 1.12 || 1
  })
  const ey = $derived(scale([errorMax, -errorMax], [errorTop, errorBottom]))
  const maxI = $derived.by(() => {
    let max = 0
    for (let i = 0; i < intensity.length; i++) if (intensity[i] > max) max = intensity[i]
    return max > 0 ? max : 1
  })
  // the large dots first, so that small ones stay visible on top
  const dots = $derived(
    errors
      ? [...errors.matches]
          .sort((p, q) => (intensity[q.peak] ?? 0) - (intensity[p.peak] ?? 0))
          .map((m) => ({ m, error: errorOf(m), r: 2.25 + 3.75 * Math.sqrt(Math.max(0, intensity[m.peak] ?? 0) / maxI) }))
      : [],
  )
  const stats = $derived(errors ? errorStats(errors.matches, errorOf) : { mean: NaN, sd: NaN, n: 0 })
  /** An error with its unit: ppm with one decimal, Da with three. */
  const errorText = (v: number) => `${signedNumber(v, unit === 'Da' ? 3 : 1)} ${unit}`
  /** Enough decimals that the ticks ±tolerance read as the tolerance (0.005 Da: three). */
  const tickDigits = $derived(errors ? errorTickDigits(errors.tolerance) : 1)
  const errorTick = (v: number) => signedNumber(v, tickDigits, { plus: false, trim: true })
  const errorHeader = $derived(
    !errors
      ? ''
      : errors.matches.length === 0
        ? 'Fragment mass error · no unshifted ion annotated'
        : `Fragment mass error of the unshifted ions · mean ${errorText(stats.mean)}${Number.isFinite(stats.sd) ? ` · SD ${errorText(stats.sd).replace(/^[+−-]/, '')}` : ''} · dot size = intensity`,
  )
  const toleranceText = $derived(errors ? `tolerance ±${errors.tolerance.value} ${unit}` : '')
  /**
   * The header over the error strip: the tolerance at the right of the line when both fit, else the
   * header and the tolerance as one text broken into lines (a narrow view).
   */
  const errorLines = $derived(
    !errors || stripFits(errorHeader, toleranceText, width - M.left - M.right)
      ? [errorHeader]
      : wrapParts([...errorHeader.split(' · '), toleranceText], width - M.left - M.right),
  )
  /** The strip for screen readers, in sentences. */
  const errorDescription = $derived(
    !errors
      ? ''
      : errors.matches.length === 0
        ? ' Below it, no unshifted ion is annotated, so no mass error is shown.'
        : ` Below it, the mass error in ${unit} of each of the ${errors.matches.length} unshifted annotated ions is shown under its peak, against the linear peptide's theoretical m/z, within the tolerance of ±${errors.tolerance.value} ${unit}.` +
          ` The mean error is ${errorText(stats.mean)}${Number.isFinite(stats.sd) ? `, the standard deviation ${errorText(stats.sd).replace(/^[+−-]/, '')}` : ''}.`,
  )

  // hover: the peak (or theoretical ion) under the pointer, the most intense within 6 px
  let tip = $state<{ x: number; y: number; lines: string[] } | null>(null)

  function strongestNear(values: ArrayLike<number>, heights: ArrayLike<number>, at: number): number {
    const i = nearest(values, at)
    if (i < 0) return -1
    let best = -1
    for (let j = i; j >= 0 && Math.abs(x(values[j]) - x(at)) <= 6; j--) if (best < 0 || heights[j] > heights[best]) best = j
    for (let j = i + 1; j < values.length && Math.abs(x(values[j]) - x(at)) <= 6; j++) if (best < 0 || heights[j] > heights[best]) best = j
    return best
  }

  function onpointermove(event: PointerEvent) {
    if (!svg) return
    const box = svg.getBoundingClientRect()
    const px0 = event.clientX - box.left
    const py = event.clientY - box.top
    if (px0 < M.left - 4 || px0 > width - M.right + 4 || py < plotTop - 4 || py > plotBottom) return void (tip = null)
    const at = domain[0] + ((px0 - M.left) / (width - M.left - M.right)) * (domain[1] - domain[0])
    if (py <= mid) {
      const i = strongestNear(mz, intensity, at)
      if (i < 0) return void (tip = null)
      const g = groupOf.get(i)
      const share = (intensity[i] / ref) * 100
      const lines = [`m/z ${mz[i].toFixed(4)} · ${share.toFixed(1)} %${share > 100 ? ' (clipped)' : ''}`]
      // (the error in the search's unit, as the strip below gives it, for the ions that have one)
      if (g) {
        for (const ion of g.ions) {
          const m = errors?.matches.find((e) => e.peak === i && e.ion === ion)
          lines.push(m ? `${ion} · ${errorText(errorOf(m))}` : ion)
        }
      } else lines.push('not annotated')
      tip = { x: x(mz[i]), y: py, lines }
    } else if (bottom.kind === 'ions' && bottomIons.length > 0) {
      const i = strongestNear(
        bottomIons.map((b) => b.mz),
        bottomIons.map((b) => b.height),
        at,
      )
      if (i < 0) return void (tip = null)
      const b = bottomIons[i]
      const what = b.faint ? ' · no peak' : ' · has a peak'
      tip = { x: x(b.mz), y: py, lines: [`${ionLabel(b.ion)} · m/z ${b.mz.toFixed(4)}${what}`] }
    } else {
      tip = null
    }
  }
</script>

<div class="relative" bind:clientWidth={width}>
  <svg
    bind:this={svg}
    data-testid="spectrum"
    role="img"
    aria-labelledby="{uid}-title"
    aria-describedby="{uid}-desc"
    {width}
    height={H}
    viewBox="0 0 {width} {H}"
    font-family={font}
    class="block"
    {onpointermove}
    onpointerleave={() => (tip = null)}>
    <title id="{uid}-title">{title}</title>
    <desc id="{uid}-desc">{description}{errorDescription}</desc>

    <!-- grid: hairlines at the m/z ticks, in the spectrum and in the error strip -->
    {#each xTicks as t (t)}
      <line x1={px(x(t))} x2={px(x(t))} y1={plotTop} y2={plotBottom} stroke="var(--plot-band)" stroke-width="1" />
      {#if errors}<line x1={px(x(t))} x2={px(x(t))} y1={errorTop} y2={errorBottom} stroke="var(--plot-band)" stroke-width="1" />{/if}
    {/each}

    <!-- the peaks: unannotated light grey and thin, annotated in the colour of their kind -->
    {#each sticks as s (s.color)}
      {@const matched = s.color !== COLORS.unmatched}
      <path
        d={stickPath(s.xs, s.tops, mid)}
        stroke={s.color}
        stroke-width={matched ? 1.75 : 1}
        stroke-linecap={matched ? 'round' : 'butt'}
        fill="none"
        data-testid={matched ? 'matched-peaks' : 'unmatched-peaks'} />
      {#if s.clipped.length > 0}
        <path d={clipMarks(s.clipped, upper(1) - 1, true)} fill={s.color} data-testid="clipped-peaks" />
      {/if}
    {/each}

    <!-- the lower half -->
    {#each bottomSticks as s (`${s.color}/${s.faint}`)}
      <path
        d={stickPath(s.xs, s.tops, mid)}
        stroke={s.color}
        stroke-width={s.faint ? 1 : 1.25}
        stroke-opacity={s.faint ? 0.4 : 1}
        stroke-linecap="round"
        fill="none"
        data-testid="bottom-peaks" />
    {/each}
    {#if bottom.kind === 'status'}
      <text
        x={px((M.left + width - M.right) / 2)}
        y={px(mid + (plotBottom - mid) / 2)}
        text-anchor="middle"
        font-size="12"
        fill={muted}
        data-testid="bottom-status"
        data-no-export="">{bottom.message}</text>
    {/if}

    <!-- the fragment mass errors, under their peaks -->
    {#if errors}
      <g data-testid="mass-error">
        <text x={M.left} y={errorTop - 10} font-size="11" fill={muted} data-testid="error-stats"
          >{#each errorLines as text, i (i)}<tspan x={M.left} y={errorTop - 10 - (errorLines.length - 1 - i) * line}>{text}</tspan>{/each}</text>
        {#if errorLines.length === 1}
          <text x={width - M.right} y={errorTop - 10} text-anchor="end" font-size="10" fill={muted}>{toleranceText}</text>
        {/if}
        <rect
          x={M.left}
          y={px(ey(errors.tolerance.value))}
          width={Math.max(0, width - M.right - M.left)}
          height={Math.max(0, ey(-errors.tolerance.value) - ey(errors.tolerance.value))}
          fill="var(--plot-band)"
          fill-opacity="0.8"
          data-testid="tolerance-band" />
        {#each [errors.tolerance.value, 0, -errors.tolerance.value] as t (t)}
          <line x1={M.left} x2={width - M.right} y1={px(ey(t))} y2={px(ey(t))} stroke={t === 0 ? 'var(--plot-zero)' : 'var(--plot-rule)'} stroke-width="1" />
          <text x={M.left - 6} y={px(ey(t) + 3.5)} text-anchor="end" font-size="10" fill={muted}>{errorTick(t)}</text>
        {/each}
        <text x={M.left - 6} y={errorTop - 10} text-anchor="end" font-size="10" fill={muted} data-testid="error-unit">{unit}</text>
        {#each dots as d, i (i)}
          <circle
            cx={px(x(mz[d.m.peak]))}
            cy={px(ey(d.error))}
            r={px(d.r)}
            fill={d.m.color}
            stroke={halo}
            stroke-width="1.25"
            data-testid="error-dot"
            data-type={d.m.type}
            data-error={d.error}
            data-mz={mz[d.m.peak]}
            ><title>{d.m.ion} · m/z {mz[d.m.peak].toFixed(4)} · {errorText(d.error)}</title></circle>
        {/each}
      </g>
    {/if}

    <!-- the axis: the halves' baseline, the m/z labels below everything -->
    <line x1={M.left} x2={width - M.right} y1={mid} y2={mid} stroke={muted} stroke-width="1" />
    {#each xTicks as t (t)}
      {#if x(t) < width - M.right - 30}<text x={px(x(t))} y={axisBase + 15} text-anchor="middle" font-size="11" fill={muted}>{t}</text>{/if}
    {/each}
    <text x={width - M.right} y={axisBase + 15} text-anchor="end" font-size="11" fill={muted}>m/z</text>

    <!-- relative intensity, of the upper half's 100 % -->
    <g font-size="10" fill={muted} text-anchor="end">
      {#each [1, 0.5] as r (r)}
        <text x={M.left - 6} y={px(upper(r) + 3.5)}>{r * 100} %</text>
        <line x1={M.left - 3} x2={M.left} y1={px(upper(r))} y2={px(upper(r))} stroke={muted} stroke-width="1" />
      {/each}
    </g>

    <!-- direct labels of the matched peaks -->
    {#each labels as l (l.key)}
      <text
        x={px(l.x)}
        y={px(l.y)}
        text-anchor="middle"
        font-size="11"
        font-weight="600"
        fill={ink}
        stroke={halo}
        stroke-width="3"
        stroke-linejoin="round"
        paint-order="stroke"
        data-testid="peak-label"
        data-ions={l.ions}>{l.text}</text>
    {/each}

    <!-- above: what the upper half is and the legend; below: what the lower half is, a note -->
    <text x={M.left} y="14" font-size="11" fill={muted} data-testid="top-label">{topLabel}</text>
    {#each legend.items as item (item.text)}
      <g data-testid="legend-item" data-line={item.line}>
        <rect x={px(item.x)} y={5 + item.line * line} width="10" height="10" rx="2" fill={item.color} />
        <text x={px(item.x + 15)} y={14 + item.line * line} font-size="11" fill={ink}>{item.text}</text>
      </g>
    {/each}
    <text
      x={M.left}
      y={bottomLabelY}
      font-size="11"
      fill={muted}
      data-testid="bottom-label"
      data-no-export={bottom.kind === 'status' ? '' : undefined}
      >{#each bottomLines as text, i (i)}<tspan x={M.left} y={bottomLabelY + i * line}>{text}</tspan>{/each}</text>
    {#if note}
      <text
        x={stacked ? M.left : width - M.right}
        y={bottomLabelY + (stacked ? bottomLines.length * line : 0)}
        text-anchor={stacked ? 'start' : 'end'}
        font-size="11"
        fill={muted}
        data-testid="bottom-note"
        data-stacked={stacked ? '' : undefined}>{note}</text>
    {/if}
  </svg>

  {#if tip}
    <div
      class="pointer-events-none absolute z-10 rounded-md border bg-background px-2 py-1 text-xs whitespace-nowrap shadow-sm tabular-nums"
      style:left="{tip.x > width - 200 ? tip.x - 10 : tip.x + 10}px"
      style:top="{tip.y}px"
      style:transform={tip.x > width - 200 ? 'translate(-100%, -50%)' : 'translateY(-50%)'}
      data-testid="peak-tooltip">
      {#each tip.lines as line, i (i)}<div class={i === 0 ? 'text-foreground' : 'text-muted-foreground'}>{line}</div>{/each}
    </div>
  {/if}
</div>
