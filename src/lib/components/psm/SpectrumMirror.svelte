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
  // strip of the fragment mass errors: one dot per annotated ion shown with a theoretical m/z (a/b/c, x/y/z, shifted,
  // marker, precursor, immonium and internal ions, in their colours of the spectrum), its error in the unit of the
  // search's fragment tolerance (ppm, or Da), its area by its peak's intensity, the band the tolerance; the m/z labels
  // come below it.
  // It is part of the SVG, so "Export spectrum (SVG)" has it too.
  //
  // The tools (`tool`, the PSM view's toolbar; psm/measure.ts, as in pyopenms-viewer and openms-viewer): with
  // "Measure", a click snaps to the nearest peak above the axis and marks it, the pointer then draws a dotted line to the
  // peak it would snap to with the live Δm/z, and a second click keeps the measurement (`marks`, through `onmarks`): an
  // orange bracket above the higher peak with its Δm/z and what it may be ("≈ Y"), drawn over the labels: it goes up
  // above the labels it would meet and hides none, its dotted lines start above the labels of their peaks. With "Label",
  // a click on a peak opens a text field there (Enter keeps, Esc cancels; an empty text removes the peak's label); the
  // labels stand above their peaks in a colour of their own, placed before NuXL's (which then keep clear of them, also
  // of one that found no room and stands right above its peak all the same). A click on a bracket or a label selects
  // it, a second click deselects it (Delete removes it: the caller's keys, `deleteSelection`), a double click on a label
  // edits it; with a tool on, a click at the top of a peak is the tool's, even under a bracket (not under a label of the
  // user's: that is where it is clicked). The measurements and
  // labels are part of the SVG and its export; the pointer's marks and the selection (an overlay) are not.
  import { signedNumber } from '$lib/format/number'
  import { errorStats, errorTickDigits, fragmentError, ionLabel, COLORS, type Tolerance } from '$lib/psm/psm'
  import {
    bracketAt,
    deltaText,
    labelIndexAt,
    layoutBrackets,
    measurementText,
    snapPeak,
    withLabel,
    NO_MARKS,
    type Box,
    type DeltaContext,
    type PeakPoint,
    type PsmMarks,
    type SpectrumTool,
  } from '$lib/psm/measure'
  import { untrack } from 'svelte'
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
    tool = null,
    marks = NO_MARKS,
    onmarks = () => {},
    measure = null,
    pending = $bindable(false),
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
    /**
     * The fragment mass errors under the spectrum: the ions with their colours, the search's fragment tolerance and
     * `omitted`, the annotated ions shown that have no theoretical m/z (not in the strip).
     */
    errors?: { matches: ColoredMatch[]; tolerance: Tolerance; omitted?: number } | null
    /** The tool that clicks on the observed peaks use. */
    tool?: SpectrumTool
    /** The user's measurements and labels of this spectrum. */
    marks?: PsmMarks
    /** Keeps changed `marks`. */
    onmarks?: (next: PsmMarks) => void
    /** What a Δm/z may be: the search's fragment tolerance, the masses, the charges (psm/measure.ts); null: the Δ alone. */
    measure?: DeltaContext | null
    /** Out: a measurement is half made or a label is being written (Esc cancels it). */
    pending?: boolean
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
  /** The right end of the m/z axis. */
  const xEnd = $derived(Math.max(M.left + 10, width - M.right))
  const x = $derived(scale(domain, [M.left, xEnd]))
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

  /** Where a peak's stick ends (clipped at 100 %). */
  const topOf = (p: PeakPoint) => upper(Math.min(1, p.intensity / ref))
  /** The baseline of a label right above a peak (above its clip mark, when clipped). */
  const labelBase = (p: PeakPoint) => topOf(p) - (p.intensity / ref > 1 ? 9 : 4)

  /**
   * The labels: the user's first (each where it fits, else right above its peak all the same), then those of the
   * matched peaks, the most intense first, clear of the user's, those without room left out.
   */
  const placedLabels = $derived.by(() => {
    const order = [...groups].sort((p, q) => q.intensity - p.intensity)
    const lineHeight = 15
    const own = marks.labels.map((l) => ({ x: x(l.mz), y: labelBase(l), width: textWidth(l.text, 11) * 1.1 + 12 }))
    const ownYs = placeLabels(own, { lineHeight, tries: 4, top: plotTop + 10 })
    const user = marks.labels.map((l, i) => ({ ...own[i], y: ownYs[i] ?? Math.max(plotTop + 10, own[i].y), top: topOf(l), text: l.text, mz: l.mz }))
    const boxOf = (l: { x: number; y: number; width: number }): Box => ({ x0: l.x - l.width / 2, x1: l.x + l.width / 2, y0: l.y - lineHeight, y1: l.y })
    const ys = placeLabels(
      order.map((g) => {
        // (the labels are semibold: a tenth wider than the estimate, and room between them on both axes, so that
        // the shifted ions of a cross-link stay apart where they crowd)
        return { x: x(g.mz), y: labelBase(g), width: textWidth(g.label, 11) * 1.1 + 12 }
      }),
      { lineHeight, tries: 4, top: plotTop + 10, taken: user.map(boxOf) },
    )
    const out: { x: number; y: number; text: string; ions: string; key: number; mz: number; width: number }[] = []
    order.forEach((g, i) => {
      const y = ys[i]
      if (y !== null) out.push({ x: x(g.mz), y, text: g.label, ions: g.kinds, key: g.peak, mz: g.mz, width: textWidth(g.label, 11) * 1.1 + 12 })
    })
    return { user, nuxl: out, boxes: [...user, ...out].map(boxOf) }
  })
  const labels = $derived(placedLabels.nuxl)
  const userLabels = $derived(placedLabels.user)

  /** The measurements' brackets with their labels ("Δ163.063 ≈ Y"), above the higher of their peaks and the labels. */
  const measurementTexts = $derived(marks.measurements.map((m) => measurementText(m, measure)))
  const brackets = $derived(
    layoutBrackets(
      marks.measurements.map((m, i) => ({ xa: x(m.a.mz), ya: topOf(m.a), xb: x(m.b.mz), yb: topOf(m.b), width: textWidth(measurementTexts[i], 11) * 1.1 + 8 })),
      { top: plotTop + 14, labels: placedLabels.boxes },
    ),
  )

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
  const omitted = $derived(errors?.omitted ?? 0)
  /** The annotated ions shown, with and without a theoretical m/z. */
  const shownIons = $derived((errors?.matches.length ?? 0) + omitted)
  const ions = (n: number) => (n === 1 ? '1 annotated ion' : `${n} annotated ions`)
  const errorHeader = $derived(
    !errors
      ? ''
      : errors.matches.length === 0
        ? omitted === 0
          ? 'Fragment mass error · no annotated ion shown'
          : `Fragment mass error · ${omitted === 1 ? 'the annotated ion shown has' : `none of the ${omitted} annotated ions shown has`} a theoretical m/z`
        : `Fragment mass error of the annotated ions · mean ${errorText(stats.mean)}${Number.isFinite(stats.sd) ? ` · SD ${errorText(stats.sd).replace(/^[+−-]/, '')}` : ''} · dot size = intensity` +
          (omitted > 0 ? ` · ${omitted} of ${shownIons} without a theoretical m/z` : ''),
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
        ? omitted === 0
          ? ' Below it, no annotated ion is shown, so no mass error is shown.'
          : ` Below it, no mass error is shown: ${omitted === 1 ? 'the annotated ion shown has' : `none of the ${omitted} annotated ions shown has`} a theoretical m/z.`
        : ` Below it, the mass error in ${unit} of ${omitted === 0 ? (errors.matches.length === 1 ? 'the annotated ion shown' : `each of the ${errors.matches.length} annotated ions shown`) : `${errors.matches.length} of the ${ions(shownIons)} shown (${omitted} ${omitted === 1 ? 'has' : 'have'} no theoretical m/z)`} is drawn under its peak, against its theoretical m/z as OpenNuXL computes it (shifted ions with the nucleotide fragment, marker ions as the fragment plus a proton), within the tolerance of ±${errors.tolerance.value} ${unit}, in the colours of the spectrum.` +
          ` The mean error is ${errorText(stats.mean)}${Number.isFinite(stats.sd) ? `, the standard deviation ${errorText(stats.sd).replace(/^[+−-]/, '')}` : ''}.`,
  )

  /** The measurements and labels for screen readers. */
  const marksDescription = $derived.by(() => {
    const parts: string[] = []
    if (marks.measurements.length > 0) {
      const each = marks.measurements.map(
        (m, i) => `${measurementTexts[i].replace(/^Δ/, 'Δm/z ')} between m/z ${Math.min(m.a.mz, m.b.mz).toFixed(3)} and ${Math.max(m.a.mz, m.b.mz).toFixed(3)}`,
      )
      parts.push(` Measured: ${each.join('; ')}.`)
    }
    if (marks.labels.length > 0) parts.push(` Your labels: ${marks.labels.map((l) => `“${l.text}” at m/z ${l.mz.toFixed(4)}`).join('; ')}.`)
    return parts.join('')
  })

  // the tools: the peak a measurement starts at, the peak the pointer would snap to, what is selected, the text field
  let start = $state<number | null>(null)
  let hover = $state<number | null>(null)
  let selected = $state<{ kind: 'measurement' | 'label'; index: number } | null>(null)
  let editor = $state<{ mz: number; intensity: number; text: string } | null>(null)
  /** What the tools did, for screen readers. */
  let status = $state('')
  let container = $state<HTMLDivElement | null>(null)
  /** The selection, while what it selects is there. */
  const selection = $derived(
    selected && selected.index < (selected.kind === 'measurement' ? marks.measurements.length : marks.labels.length) ? selected : null,
  )
  // (another spectrum or tool: what was half made goes; another spectrum: the selection too)
  $effect.pre(() => {
    void [mz, tool]
    untrack(() => {
      start = null
      hover = null
      editor = null
    })
  })
  $effect.pre(() => {
    void mz
    untrack(() => (selected = null))
  })
  $effect(() => {
    pending = start !== null || editor !== null
  })

  const pointOf = (i: number): PeakPoint => ({ mz: mz[i], intensity: intensity[i] })
  const mzAt = (at: number) => domain[0] + ((at - M.left) / (xEnd - M.left)) * (domain[1] - domain[0])
  /** The observed peak a pointer at (`at`, `py`) snaps to, or -1: above the axis only. */
  function snapAt(at: number, py: number): number {
    if (py < plotTop - 4 || py > mid + 4 || at < M.left - 10 || at > xEnd + 10) return -1
    return snapPeak(mz, x, mzAt, (i) => topOf(pointOf(i)), at, py)
  }
  function pointer(event: MouseEvent): { at: number; py: number } {
    const box = svg?.getBoundingClientRect()
    return { at: event.clientX - (box?.left ?? 0), py: event.clientY - (box?.top ?? 0) }
  }
  /** The user label whose text is at (`at`, `py`), or -1. */
  function userLabelAt(at: number, py: number): number {
    return userLabels.findIndex((l) => at >= l.x - l.width / 2 && at <= l.x + l.width / 2 && py >= l.y - 13 && py <= l.y + 3)
  }

  /** Whether (`at`, `py`) is at the top of the peak `i` (within 8 px on screen): a click there is the tool's. */
  function atTopOf(i: number, at: number, py: number): boolean {
    return i >= 0 && Math.hypot(x(mz[i]) - at, topOf(pointOf(i)) - py) <= 8
  }

  function onclick(event: MouseEvent) {
    const { at, py } = pointer(event)
    // a label or a bracket first (not while a measurement is half made: its second peak may be under one; nor a
    // bracket at the top of a peak with a tool on: a tall peak may reach into it)
    if (start === null) {
      const l = userLabelAt(at, py)
      if (l >= 0) {
        const again = selection?.kind === 'label' && selection.index === l
        return select(
          again ? null : { kind: 'label', index: l },
          again ? 'Label deselected.' : `Label “${marks.labels[l].text}” selected; Delete removes it, a double click edits it.`,
        )
      }
      const b = tool && atTopOf(snapAt(at, py), at, py) ? -1 : bracketAt(brackets, at, py)
      if (b >= 0) {
        const again = selection?.kind === 'measurement' && selection.index === b
        return select(again ? null : { kind: 'measurement', index: b }, again ? 'Measurement deselected.' : `Measurement ${measurementTexts[b]} selected; Delete removes it.`)
      }
    }
    selected = null
    if (tool === 'measure') {
      const i = snapAt(at, py)
      if (i < 0) return
      container?.focus({ preventScroll: true })
      if (start === null) {
        start = i
        status = `Measuring from m/z ${mz[i].toFixed(3)}: click the second peak (Esc cancels).`
      } else if (i !== start) {
        const m = { a: pointOf(start), b: pointOf(i) }
        start = null
        onmarks({ ...marks, measurements: [...marks.measurements, m] })
        status = `Measured ${measurementText(m, measure)}.`
      }
    } else if (tool === 'label') {
      const i = snapAt(at, py)
      if (i >= 0) openEditor(pointOf(i))
    }
  }

  function select(next: typeof selected, said: string) {
    selected = next
    status = said
    container?.focus({ preventScroll: true })
  }

  function ondblclick(event: MouseEvent) {
    const { at, py } = pointer(event)
    const l = userLabelAt(at, py)
    if (l >= 0) openEditor(marks.labels[l])
  }

  /** The text field at a peak: its label's text, if it has one. */
  function openEditor(p: PeakPoint) {
    const at = labelIndexAt(marks.labels, p.mz)
    const peak = at >= 0 ? marks.labels[at] : p
    editor = { mz: peak.mz, intensity: peak.intensity, text: at >= 0 ? marks.labels[at].text : '' }
    selected = null
  }
  function commitEditor() {
    const e = editor
    if (!e) return
    editor = null
    onmarks({ ...marks, labels: withLabel(marks.labels, e, e.text) })
    status = e.text.trim() === '' ? `Label at m/z ${e.mz.toFixed(4)} removed.` : `Label “${e.text.trim()}” at m/z ${e.mz.toFixed(4)}.`
    container?.focus({ preventScroll: true })
  }
  function oneditorkeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitEditor()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      editor = null
      container?.focus({ preventScroll: true })
    }
  }

  /** Cancels what is half done, else the selection; whether there was something (Esc: the caller's keys). */
  export function cancel(): boolean {
    if (editor) editor = null
    else if (start !== null) {
      start = null
      status = 'Measurement cancelled.'
    } else if (selection) selected = null
    else return false
    return true
  }

  /** Removes the selected measurement or label; whether one was (Delete, Backspace: the caller's keys). */
  export function deleteSelection(): boolean {
    const s = selection
    if (!s) return false
    selected = null
    if (s.kind === 'measurement') {
      status = `Measurement ${measurementTexts[s.index]} removed.`
      onmarks({ ...marks, measurements: marks.measurements.filter((_, i) => i !== s.index) })
    } else {
      status = `Label “${marks.labels[s.index].text}” removed.`
      onmarks({ ...marks, labels: marks.labels.filter((_, i) => i !== s.index) })
    }
    return true
  }

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
    if (tool) {
      const i = snapAt(px0, py)
      hover = i < 0 ? null : i
      // (a measurement half made: the live Δm/z says it, no tooltip over the brackets)
      if (start !== null) return void (tip = null)
    }
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

<div class="relative outline-none" bind:clientWidth={width} bind:this={container} tabindex="-1" data-testid="spectrum-area">
  <!-- (the clicks are the pointer's tools; what they make is listed in the description, and the toolbar's buttons and
       the keys clear and remove it) -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
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
    style:cursor={tool ? 'crosshair' : undefined}
    data-tool={tool ?? undefined}
    data-mz-domain="{domain[0]} {domain[1]}"
    data-x-range="{M.left} {xEnd}"
    {onpointermove}
    {onclick}
    {ondblclick}
    onpointerleave={() => {
      tip = null
      hover = null
    }}>
    <title id="{uid}-title">{title}</title>
    <desc id="{uid}-desc">{description}{errorDescription}{marksDescription}</desc>

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
            data-ion={d.m.ion}
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
        data-ions={l.ions}
        data-mz={l.mz}>{l.text}</text>
    {/each}

    <!-- the user's measurements: a bracket above the higher peak, dotted lines down to the peaks, the Δm/z -->
    {#each brackets as b, i (i)}
      {@const isSelected = selection?.kind === 'measurement' && selection.index === i}
      <g data-testid="measurement" data-text={measurementTexts[i]} data-selected={isSelected ? '' : undefined}>
        <line x1={px(b.xa)} x2={px(b.xb)} y1={px(b.y)} y2={px(b.y)} stroke="var(--plot-measure)" stroke-width="1.75" />
        {#if b.da - b.y > 1}<line x1={px(b.xa)} x2={px(b.xa)} y1={px(b.da)} y2={px(b.y)} stroke="var(--plot-measure)" stroke-width="1" stroke-dasharray="2 2" />{/if}
        {#if b.db - b.y > 1}<line x1={px(b.xb)} x2={px(b.xb)} y1={px(b.db)} y2={px(b.y)} stroke="var(--plot-measure)" stroke-width="1" stroke-dasharray="2 2" />{/if}
        <text
          x={px((b.xa + b.xb) / 2)}
          y={px(b.y - 4)}
          text-anchor="middle"
          font-size="11"
          font-weight="600"
          fill="var(--plot-measure)"
          stroke={halo}
          stroke-width="3"
          stroke-linejoin="round"
          paint-order="stroke">{measurementTexts[i]}</text>
        {#if isSelected}
          <!-- (the selection: the page's only, over the bracket in the colour of a selected one) -->
          <g data-no-export="" data-testid="measurement-selection">
            <rect
              x={px(b.box.x0 - 3)}
              y={px(b.box.y0 - 2)}
              width={px(b.box.x1 - b.box.x0 + 6)}
              height={px(b.y - b.box.y0 + 6)}
              rx="3"
              fill="var(--plot-measure-selected)"
              fill-opacity="0.12"
              stroke="var(--plot-measure-selected)"
              stroke-width="1" />
            <line x1={px(b.xa)} x2={px(b.xb)} y1={px(b.y)} y2={px(b.y)} stroke="var(--plot-measure-selected)" stroke-width="1.75" />
            <text
              x={px((b.xa + b.xb) / 2)}
              y={px(b.y - 4)}
              text-anchor="middle"
              font-size="11"
              font-weight="600"
              fill="var(--plot-measure-selected)">{measurementTexts[i]}</text>
          </g>
        {/if}
      </g>
    {/each}

    <!-- the user's labels, above their peaks (a leader line down to the peak when the label had to go up) -->
    {#each userLabels as l, i (i)}
      {@const isSelected = selection?.kind === 'label' && selection.index === i}
      <g data-testid="user-label" data-mz={l.mz} data-selected={isSelected ? '' : undefined}>
        {#if isSelected}
          <rect
            x={px(l.x - l.width / 2)}
            y={px(l.y - 13)}
            width={px(l.width)}
            height="17"
            rx="3"
            fill="var(--plot-user-label)"
            fill-opacity="0.12"
            stroke="var(--plot-user-label)"
            stroke-width="1"
            data-no-export="" />
        {/if}
        {#if l.top - l.y > 8}
          <line x1={px(l.x)} x2={px(l.x)} y1={px(l.y + 3)} y2={px(l.top - 2)} stroke="var(--plot-user-label)" stroke-width="1" stroke-dasharray="1 2" />
        {/if}
        <text
          x={px(l.x)}
          y={px(l.y)}
          text-anchor="middle"
          font-size="11"
          font-weight="600"
          fill="var(--plot-user-label)"
          stroke={halo}
          stroke-width="3"
          stroke-linejoin="round"
          paint-order="stroke">{l.text}</text>
      </g>
    {/each}

    <!-- the tools under the pointer (the page's only): the peak it would snap to, the start of a measurement, the
         live Δm/z to the peak under the pointer -->
    {#if tool && hover !== null && hover < mz.length}
      <circle
        cx={px(x(mz[hover]))}
        cy={px(topOf(pointOf(hover)))}
        r="4.5"
        fill="none"
        stroke={tool === 'measure' ? 'var(--plot-measure)' : 'var(--plot-user-label)'}
        stroke-width="1.5"
        data-testid="snap-ring"
        data-no-export="" />
    {/if}
    {#if start !== null && start < mz.length}
      {@const sx = x(mz[start])}
      {@const sy = topOf(pointOf(start))}
      <circle cx={px(sx)} cy={px(sy)} r="4" fill="var(--plot-measure)" stroke={halo} stroke-width="1" data-testid="measure-start" data-no-export="" />
      {#if hover !== null && hover !== start && hover < mz.length}
        {@const hx = x(mz[hover])}
        {@const hy = topOf(pointOf(hover))}
        <g data-testid="measure-preview" data-no-export="">
          <line x1={px(sx)} y1={px(sy)} x2={px(hx)} y2={px(hy)} stroke="var(--plot-measure)" stroke-width="1.25" stroke-dasharray="3 3" />
          <text
            x={px((sx + hx) / 2)}
            y={px(Math.max(plotTop + 10, Math.min(sy, hy) - 8))}
            text-anchor="middle"
            font-size="11"
            font-weight="600"
            fill="var(--plot-measure)"
            stroke={halo}
            stroke-width="3"
            stroke-linejoin="round"
            paint-order="stroke">{deltaText(Math.abs(mz[hover] - mz[start]))}</text>
        </g>
      {/if}
    {/if}

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

  {#if editor}
    {@const ex = x(editor.mz)}
    {@const ey0 = topOf(editor)}
    <div
      class="absolute z-20 rounded-md border bg-background p-1 shadow-sm"
      style:left="{Math.min(Math.max(0, ex - 80), Math.max(0, width - 170))}px"
      style:top="{Math.max(0, ey0 - 40)}px"
      data-testid="label-editor">
      <input
        type="text"
        class="h-6 w-40 rounded-sm border bg-background px-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        aria-label="Label for the peak at m/z {editor.mz.toFixed(4)} (Enter keeps it, Esc cancels; empty removes the label)"
        placeholder="Label for m/z {editor.mz.toFixed(2)}"
        value={editor.text}
        oninput={(e) => {
          if (editor) editor.text = e.currentTarget.value
        }}
        onkeydown={oneditorkeydown}
        onblur={commitEditor}
        {@attach (el) => el.focus()} />
    </div>
  {/if}

  <p class="sr-only" aria-live="polite" data-testid="tool-status">{status}</p>

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
