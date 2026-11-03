<script lang="ts">
  // The PSM view (mockup 3), beside the PSM table: breadcrumb, Prev/Next and "Export spectrum (SVG)";
  // the peptide with its fragment ladder; the spectrum annotated (psm/annotate.ts, the web module's
  // annotatePeaks in TypeScript), mirrored against PeptDeep's prediction, which ProSE wrote for every
  // PSM (its input's QPX psm file, read when the PSM is opened), or the theoretical spectrum, with ion,
  // charge and loss toggles; the
  // ion table, the fragment mass errors and the PSM's features. A PSM whose peaks the search did not
  // keep shows its ladder, theoretical ions and features. An open search's unlocalized mass shift is
  // shown, and the annotation is of the peptide without it. A PSM of a co-isolated precursor is marked, and the
  // other PSMs of the same spectrum are linked (results/coisolated.ts).
  import { signedNumber } from '$lib/format/number'
  import { errorText } from '$lib/format/error'
  import { Button, buttonVariants } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import Marker from '$lib/components/results/Marker.svelte'
  import { download } from '$lib/download'
  import { massShift, peptideView, psmProforma, type PeptideView } from '$lib/format/peptide'
  import { annotatePeaks, type ModificationMass } from '$lib/psm/annotate'
  import {
    annotationOptions,
    fragmentCharges,
    fragmentTolerance,
    groupByPeak,
    instrumentOf,
    ionTable,
    ladderCuts,
    lossOptions,
    matchedByReference,
    matchSummary,
    modificationList,
    nceFor,
    onePlusHidden,
    precursorOptions,
    predictedIons,
    resolveOptions,
    similarityText,
    spectrumPeaks,
    svgFileName,
    visibleMatches,
    visibleTheoretical,
    withPrecursor,
    ION_TYPES,
    type IonType,
    type PsmOptions,
  } from '$lib/psm/psm'
  import { exportSpectrumSvg } from '$lib/psm/svg-export'
  import { COISOLATED_TITLE, chimericRank, isCoisolated, sameSpectrum } from '$lib/results/coisolated'
  import { baseName } from '$lib/results/model'
  import { formatQValue, parseAccession, parseDescription, scanNumber } from '$lib/results/display'
  import type { LoadedSpectra, PsmSpectra } from '$lib/results/read'
  import type { PeakAnnotationResult } from '$lib/results/types'
  import type { ResultsView } from '$lib/results/view.svelte'
  import { defaultsOf } from '$lib/settings/parameters'
  import { PROSE_PARAMETERS } from '$lib/settings/prose'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import XIcon from '@lucide/svelte/icons/x'
  import { cn } from '$lib/utils'
  import { tick } from 'svelte'
  import FragmentLadder from './FragmentLadder.svelte'
  import IonTable from './IonTable.svelte'
  import PsmFeatures from './PsmFeatures.svelte'
  import SpectrumMirror, { type Bottom } from './SpectrumMirror.svelte'

  let {
    view,
    onClose,
    onBreadcrumb,
  }: {
    view: ResultsView
    /** Back to where the PSM came from (Esc, ✕). */
    onClose: () => void
    /** A breadcrumb: the Proteins or Peptides tab, the protein's panel, the PSM table of the peptide. */
    onBreadcrumb: (to: { tab: 'proteins' | 'peptides' } | { protein: number } | { peptide: number }) => void
  } = $props()

  const uid = $props.id()
  const m = $derived(view.model)
  const ps = $derived(m.tables.psms)
  const pt = $derived(m.tables.peptides)
  const row = $derived(view.psm?.row ?? 0)
  const k = $derived(ps.peptide[row])
  const charge = $derived(ps.charge[row])
  const sequence = $derived(pt.sequence[k])
  const fixedMods = $derived(view.result.settings.fixedMods)
  const peptide: PeptideView = $derived(peptideView(pt, k, fixedMods))
  const shift = $derived(massShift(ps.deltaMass[row]))
  /** The shift as a number on the page (a real minus); `shift` is the ProForma text. */
  const shiftText = $derived(shift === null ? null : signedNumber(ps.deltaMass[row], 4))
  const scan = $derived(scanNumber(ps.nativeId[row]))
  // (no spectrum reference: ProSE stored no spectrum for the PSM, the reader gives none)
  const spectrumName = $derived(scan !== null ? `scan ${scan}` : ps.nativeId[row] ? `spectrum ${ps.nativeId[row]}` : 'spectrum not referenced')

  // the search's settings: the parameters it changed, else ProSE's defaults
  const parameters = $derived(view.result.settings.parameters)
  const defaults = defaultsOf(PROSE_PARAMETERS)
  const tolerance = $derived(fragmentTolerance(parameters, defaults))
  const instrument = $derived(instrumentOf(parameters, defaults))
  // The peaks and PeptDeep's prediction of the PSM: read from its input's psm file when it is opened
  const source = $derived(view.result.outcome.spectra)
  // ProSE wrote PeptDeep's predictions (none at all: a tool without ONNX Runtime)
  const onnx = $derived(source.predictions)
  // (raw: the spectra are large typed arrays, and `source` is compared by identity)
  let loaded = $state.raw<{ row: number; source: PsmSpectra; data: LoadedSpectra | null; error: string | null } | null>(null)
  $effect(() => {
    const [r, s] = [row, source]
    let current = true
    s.load(r).then(
      (data) => {
        if (current) loaded = { row: r, source: s, data, error: null }
      },
      (e: unknown) => {
        if (current) loaded = { row: r, source: s, data: null, error: errorText(e) }
      },
    )
    return () => {
      current = false
    }
  })
  /** The spectra of this PSM; null while they are read. */
  const spectra = $derived(loaded && loaded.row === row && loaded.source === source ? loaded : null)
  const peaks = $derived(spectra?.data ? spectrumPeaks(spectra.data.spectra, spectra.data.spectrumRow) : null)
  // ProSE stored the spectra filtered (its -qpx_peak_top and -qpx_peak_window, in the footer of the input's mz view)
  const peakFilter = $derived(spectra?.data?.peakFilter ?? null)
  const mods = $derived.by(() => {
    const out: { name: string; residue: string }[] = []
    for (let i = pt.modOffsets[k]; i < pt.modOffsets[k + 1]; i++) out.push({ name: pt.modName[i], residue: sequence[pt.modPosition[i]] ?? '' })
    return out
  })
  /** The masses of the peptide's modifications by name, for a name the Unimod table does not have. */
  const modificationMass: ModificationMass = $derived.by(() => {
    const masses = new Map<string, number>()
    for (let i = pt.modOffsets[k]; i < pt.modOffsets[k + 1]; i++) masses.set(pt.modName[i], pt.modMass[i])
    return (name: string) => masses.get(name)
  })
  const losses = $derived(lossOptions(mods))
  const options: PsmOptions = $derived(resolveOptions(view.psmOptions, { charge, losses, onnx }))
  const engineOptions = $derived(annotationOptions(options, tolerance))
  const nce = $derived(nceFor(view.result.outcome.summary.files[ps.file[row]], peaks?.collisionEnergy ?? NaN, parameters))

  /** Annotates the PSM's peaks (none: the theoretical ions alone); an error as text. */
  function annotate(o: Parameters<typeof annotatePeaks>[4]): { result: PeakAnnotationResult | null; error: string | null } {
    try {
      const mz = peaks?.mz ?? new Float32Array(0)
      const intensity = peaks?.intensity ?? new Float32Array(0)
      return { result: annotatePeaks(mz, intensity, pt.openms[k], charge, o, modificationMass), error: null }
    } catch (e) {
      return { result: null, error: String((e as Error)?.message ?? e) }
    }
  }

  // the annotation (also without peaks: its theoretical ions make the ion table)
  const annotation = $derived(annotate(engineOptions))

  // the precursor peaks, asked for apart: the annotation makes them at `maxCharge` only, which is the
  // precursor's charge here (and not the fragments' 1 or 2)
  const precursorAnnotation = $derived(options.precursor ? annotate(precursorOptions(tolerance, charge)) : null)
  const precursorResult = $derived(precursorAnnotation?.result ?? null)
  /** Why the precursor peaks are missing although they were asked for. */
  const precursorError = $derived(precursorAnnotation?.error ?? null)

  const fragments = $derived(annotation.result)
  const result = $derived(fragments ? withPrecursor(fragments, precursorResult) : null)
  const annotationError = $derived(annotation.error)

  const shown = $derived(result ? visibleMatches(result.matches, options) : [])
  const groups = $derived(result && peaks ? groupByPeak(shown, peaks.mz, peaks.intensity) : [])
  const theoretical = $derived(result ? visibleTheoretical(result.theoretical, options) : [])
  const table = $derived(result ? ionTable(result.theoretical, shown, sequence.length, options) : null)
  const cuts = $derived(ladderCuts(shown, sequence.length))
  const summary = $derived(result && peaks ? matchSummary(shown, theoretical, peaks.intensity) : null)
  /** Nothing matches with 1+ fragments hidden, and 1+ would: a hint with a button that shows them. */
  const hiddenOnePlus = $derived(result !== null && peaks !== null && onePlusHidden(result.matches, options))

  // PeptDeep's prediction for the lower half, as ProSE wrote it for this PSM (at the NCE of its file)
  const prediction = $derived(spectra?.data ? predictedIons(spectra.data.predicted, spectra.data.row) : [])

  const bottom: Bottom = $derived.by(() => {
    if (options.bottom === 'theoretical') {
      if (!result) return { kind: 'status', label: 'Theoretical', message: 'Computing the theoretical spectrum…', failed: false }
      const matched = new Set(shown.map((s) => s.ion))
      return {
        kind: 'ions',
        label: 'Theoretical',
        relative: false,
        ions: theoretical.map((t) => ({ mz: t.mz, height: 0.55, type: t.type, ion: t.ion, faint: !matched.has(t.ion) })),
      }
    }
    const label = `PeptDeep · ${nce.label} · ${instrument} · 100 % = strongest predicted b/y`
    if (spectra === null) return { kind: 'status', label: 'PeptDeep', message: 'Reading the prediction…', failed: false }
    if (prediction.length === 0) {
      return { kind: 'status', label: 'PeptDeep', message: 'ProSE wrote no prediction for this PSM', failed: true }
    }
    const ions = prediction
      .filter((p) => (options.ions as string[]).includes(p.type) && options.charges.includes(p.charge))
      .map((p) => ({ mz: p.mz, height: p.intensity, type: p.type, ion: p.ion, faint: false }))
    return { kind: 'ions', label, relative: true, ions }
  })

  /** PeptDeep's similarity that the search computed (over all ions), whenever the search has it. */
  const similarity = $derived(similarityText(ps.featureNames, ps.features, row))

  /**
   * The observed half's 100 %: against PeptDeep, the strongest matched b or y peak (as PeptDeep scales
   * its prediction); against the theoretical spectrum, or without a matched b or y, the base peak.
   */
  const reference = $derived.by(() => {
    let base = 0
    for (let i = 0; i < (peaks?.intensity.length ?? 0); i++) base = Math.max(base, peaks!.intensity[i])
    const matched = options.bottom === 'peptdeep' ? matchedByReference(groups, options) : null
    return matched !== null ? { intensity: matched, text: 'strongest matched b/y' } : { intensity: base, text: 'base peak' }
  })

  /** The prediction is on its way: the spectrum is not exported meanwhile. */
  const pending = $derived(bottom.kind === 'status' && !bottom.failed)


  // breadcrumb and header
  const proteinRow = $derived.by(() => {
    const origin = view.psm?.origin
    if (origin?.kind === 'panel') return origin.protein
    const filter = view.psms.filters.proteinFilter
    const refs = m.peptide.proteins[k]
    if (filter !== undefined && refs.includes(filter)) return filter
    return refs.length > 0 ? refs[0] : null
  })
  const proteinCrumb = $derived.by(() => {
    if (proteinRow === null) return null
    const accession = m.tables.proteins.accession[proteinRow]
    const gene = parseDescription(m.tables.proteins.description[proteinRow]).gene
    const more = m.peptide.proteins[k].length - 1
    return { text: `${gene ?? parseAccession(accession).id}${more > 0 ? ` +${more}` : ''}`, title: accession }
  })
  /** The peptide as the breadcrumb writes it: "AVM(ox)DDFAAFVEK", after its shift. */
  const peptideCrumb = $derived.by(() => {
    const label = (mod: { label: string } | undefined) => (mod ? `(${mod.label})` : '')
    const core = peptide.residues.map((r) => `${r.residue}${label(r.mod)}`).join('')
    return `${shift ? `[${shift}]?` : ''}${peptide.nTerm ? `(${peptide.nTerm.label})` : ''}${core}${peptide.cTerm ? `(${peptide.cTerm.label})` : ''}`
  })
  const proforma = $derived(psmProforma(pt.proforma[k], ps.deltaMass[row]))
  const fileName = $derived(baseName(m.tables.files[ps.file[row]] ?? ''))

  const headerLine = $derived.by(() => {
    const rt = ps.rt[row]
    const err = ps.precursorErrorPpm[row]
    return [
      m.samples[m.psmSample[row]]?.label,
      `${charge}+`,
      Number.isFinite(ps.mz[row]) ? `m/z ${ps.mz[row].toFixed(4)}` : null,
      rt >= 0 ? `RT ${(rt / 60).toFixed(1)} min` : null,
      `q ${formatQValue(ps.qValue[row])}`,
      // an open search's shift is the whole mass difference: no error is left to show
      Number.isFinite(err) && shift === null ? `${signedNumber(err, 1)} ppm` : null,
    ]
      .filter((p) => p)
      .join(' · ')
  })

  const neighbours = $derived(view.psmNeighbours)

  /** The other PSMs of this spectrum (co-isolated precursors), as links: "VHGEEDPTKK 3+". */
  const mates = $derived(
    sameSpectrum(ps, row).map((j) => {
      const [sequence, rank] = [pt.sequence[ps.peptide[j]], chimericRank(ps, j)]
      const which = rank >= 2 ? ', a co-isolated precursor' : rank === 1 ? ', the precursor the spectrum was taken of' : ''
      return { row: j, sequence, charge: ps.charge[j], coisolated: rank >= 2, decoy: ps.decoy[j] === 1, title: `Open the PSM of ${sequence}, ${ps.charge[j]}+${which}` }
    }),
  )

  const spectrumTitle = $derived.by(() => {
    const listed = modificationList(pt, k, fixedMods)
    const below = options.bottom === 'peptdeep' ? `PeptDeep's prediction at ${nce.label}` : 'the theoretical spectrum'
    return `Annotated spectrum of ${sequence}${listed.length > 0 ? ` (${listed.join(', ')})` : ''}, ${charge}+, ${spectrumName}. Below it is ${below}.`
  })
  const spectrumDescription = $derived(
    peaks
      ? `${groups.length} of ${peaks.mz.length} peaks are matched. b ions are blue, y ions orange, other ions dark grey and unmatched peaks light grey.` +
          (summary ? ` ${summary.matched} of the ${summary.total} ions shown are matched, and their peaks carry ${Math.round(summary.intensityFraction * 100)} % of the intensity.` : '') +
          ` In the upper half, 100 % is the ${reference.text}.` +
          (options.bottom === 'peptdeep' ? ' In the lower half, 100 % is the strongest predicted b or y ion.' : ' In the lower half, every ion has the same height.') +
          (similarity ? ` ${similarity.replace(' (search)', '')}, as the search computed it over all ions.` : '')
      : '',
  )

  /** What the losses menu's button says: the losses on, and the precursor ("CH₄SO · precursor", "none"). */
  const moreSummary = $derived.by(() => {
    const on = losses.filter((l) => options.losses.includes(l.formula)).map((l) => (l.formula === 'other' ? 'other' : l.label))
    if (options.precursor) on.push('precursor')
    return on.length > 0 ? on.join(', ') : 'none'
  })
  const moreOn = $derived(options.losses.length > 0 || options.precursor)

  // the toggles: a choice made here becomes the user's (no longer automatic) for all PSMs
  function setIon(type: IonType, on: boolean) {
    const ions = new Set(options.ions)
    if (on) ions.add(type)
    else ions.delete(type)
    view.psmOptions.ions = ION_TYPES.filter((t) => ions.has(t))
  }
  function setCharge(c: number, on: boolean) {
    const charges = new Set(options.charges)
    if (on) charges.add(c)
    else charges.delete(c)
    view.psmOptions.charges = [...charges].sort()
  }
  function setLoss(formula: string, on: boolean) {
    const chosen = new Set(options.losses)
    if (on) chosen.add(formula)
    else chosen.delete(formula)
    view.psmOptions.losses = [...chosen]
  }

  let mirror = $state<SpectrumMirror | null>(null)
  function exportSvg() {
    const svg = mirror?.svgElement()
    if (!svg) return
    void download(svgFileName(proforma, ps.nativeId[row]), exportSpectrumSvg(svg), 'image/svg+xml')
  }

  // the Export menu's "Spectrum (SVG)" does what the button does
  $effect(() => {
    view.spectrumExporter = peaks && !pending ? exportSvg : null
    return () => (view.spectrumExporter = null)
  })

  let ladderRow = $state(0)
  let heading = $state<HTMLElement | null>(null)
  let prevButton = $state<HTMLElement | null>(null)
  let nextButton = $state<HTMLElement | null>(null)
  /** Moves the keyboard focus into the view (to its heading, which names the PSM). */
  export function focus(): void {
    heading?.focus()
  }

  /** Previous or next PSM; the focus stays on the button, or goes to the other one when this one is done. */
  async function step(direction: 1 | -1) {
    const from = document.activeElement
    view.stepPsm(direction)
    await tick()
    if (from === prevButton || from === nextButton) {
      const own = direction < 0 ? prevButton : nextButton
      const other = direction < 0 ? nextButton : prevButton
      if (own && !(own as HTMLButtonElement).disabled) own.focus()
      else other?.focus()
    }
  }

  /** Keys that belong to what has the focus: typing, a grid, radio buttons, menus. */
  function ownsKeys(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="grid"], [role="tablist"], [role="menu"], [role="listbox"], [role="dialog"]')) {
      return true
    }
    return false
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key === 'Escape') {
      if (event.target instanceof Element && event.target.closest('input[type="search"], input[type="text"], textarea, [role="dialog"], [role="menu"]')) return
      event.preventDefault()
      onClose()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (ownsKeys(event.target)) return
      event.preventDefault()
      void step(event.key === 'ArrowLeft' ? -1 : 1)
    }
  }

  const toggle =
    'inline-flex h-[26px] min-w-[30px] cursor-pointer items-center justify-center rounded-md border bg-background px-2 text-xs text-muted-foreground select-none hover:text-foreground peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50'
  const crumb = 'rounded-sm hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
</script>

<svelte:window {onkeydown} />

<section
  class="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-5 pt-3.5 pb-6"
  aria-labelledby="{uid}-heading"
  data-testid="psm-view">
  <!-- The breadcrumb and the PSM's name take what the buttons leave them, at least 16rem: in a narrow view the
       buttons go to a row of their own. The crumbs stay on one line, the protein and the peptide truncated (their
       whole text is their tooltip). -->
  <header class="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
    <div class="flex min-w-0 flex-[1_1_16rem] flex-wrap items-baseline gap-x-1 text-xs text-muted-foreground" data-testid="psm-breadcrumb">
      <nav aria-label="Breadcrumb" class="max-w-full min-w-0">
        <ol class="flex min-w-0 items-baseline gap-x-1 whitespace-nowrap">
          <li class="shrink-0"><button type="button" class={crumb} onclick={() => onBreadcrumb({ tab: 'proteins' })}>Proteins</button> ›</li>
          <li class="flex min-w-0 items-baseline gap-x-1">
            {#if proteinCrumb && proteinRow !== null}
              <button type="button" class="{crumb} min-w-0 truncate font-medium text-foreground" title={proteinCrumb.title} onclick={() => onBreadcrumb({ protein: proteinRow! })}
                >{proteinCrumb.text}</button>
              <span class="sr-only">({proteinCrumb.title})</span>
            {:else}
              <span class="min-w-0 truncate">below protein FDR</span>
            {/if}
            <span>›</span>
          </li>
          <li class="shrink-0"><button type="button" class={crumb} onclick={() => onBreadcrumb({ tab: 'peptides' })}>Peptides</button> ›</li>
          <li class="flex min-w-0 items-baseline gap-x-1">
            <button type="button" class="{crumb} max-w-[22rem] min-w-0 truncate font-medium text-foreground" title="Show the PSMs of {proforma} in the PSM table" onclick={() => onBreadcrumb({ peptide: k })}
              >{peptideCrumb}</button>
            <span>›</span>
          </li>
        </ol>
      </nav>
      <h2
        bind:this={heading}
        id="{uid}-heading"
        tabindex="-1"
        class="max-w-full min-w-0 truncate rounded-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        title="PSM in {fileName}, {spectrumName}">
        PSM in {fileName}, {spectrumName}
      </h2>
      <!-- the focus can stay in the list beside the view: say which PSM opened -->
      <p class="sr-only" aria-live="polite">PSM {peptideCrumb}, {charge}+, {spectrumName} ({fileName})</p>
    </div>
    <div class="ml-auto flex flex-none items-center gap-1.5">
      <Button
        bind:ref={prevButton}
        variant="outline"
        size="sm"
        class="h-7 px-2.5 text-xs"
        aria-label="Previous PSM"
        title={neighbours.position < 0 ? "The list's filters hide this PSM" : 'Previous PSM in the list (←)'}
        aria-keyshortcuts="ArrowLeft"
        disabled={neighbours.prev === null}
        onclick={() => step(-1)}>‹ Prev</Button>
      <Button
        bind:ref={nextButton}
        variant="outline"
        size="sm"
        class="h-7 px-2.5 text-xs"
        aria-label="Next PSM"
        title={neighbours.position < 0 ? "The list's filters hide this PSM" : 'Next PSM in the list (→)'}
        aria-keyshortcuts="ArrowRight"
        disabled={neighbours.next === null}
        onclick={() => step(1)}>Next ›</Button>
      <Button
        variant="outline"
        size="sm"
        class="h-7 px-2.5 text-xs"
        disabled={!peaks || pending}
        title={spectra === null ? 'Reading the spectrum' : !peaks ? 'The spectrum was not stored' : pending ? 'Wait for the annotation and the prediction' : undefined}
        onclick={exportSvg}>Export spectrum (SVG)</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close the PSM view" title="Back (Esc)" onclick={onClose}>
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  </header>

  <div class="mt-1 flex flex-wrap items-end gap-x-5" bind:clientWidth={ladderRow}>
    <FragmentLadder {peptide} {cuts} {shift} available={ladderRow} />
    <p class="pb-3 text-xs text-muted-foreground tabular-nums" data-testid="psm-header">
      {#if shift}<span class="font-mono">[{shift}]?</span>{' · '}{/if}{headerLine}{#if ps.decoy[row]}<Marker text="decoy" />{/if}{#if isCoisolated(ps, row)}<Marker
          text="co-isolated"
          title={COISOLATED_TITLE} />{/if}
    </p>
  </div>
  {#if mates.length > 0}
    <!-- the PSMs of the other precursors of this spectrum: each opens here (the list beside keeps its place) -->
    <p class="-mt-1 mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-muted-foreground" data-testid="same-spectrum">
      <span>Same spectrum:</span>
      {#each mates as mate (mate.row)}
        <span class="whitespace-nowrap">
          <button type="button" class="{crumb} font-mono text-foreground" title={mate.title} onclick={() => view.openPsm(mate.row)}
            >{mate.sequence}</button>
          {mate.charge}+{#if mate.decoy}{' '}decoy{/if}{#if mate.coisolated}{' '}co-isolated{/if}
        </span>
      {/each}
    </p>
  {/if}
  {#if shift}
    <p class="-mt-1 mb-2 text-xs text-muted-foreground" data-testid="open-search-note">
      This PSM from the open search has a mass shift of {shiftText} Da at an unknown position. The annotation shows the peptide
      without the shift, so fragments that carry it are not annotated.
    </p>
  {/if}

  <div class="rounded-lg border bg-background px-3.5 pt-3 pb-2">
    <div class="mb-1 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <div class="flex items-center gap-1" role="group" aria-labelledby="{uid}-ions">
        <span id="{uid}-ions" class="mr-1 text-muted-foreground">Ions</span>
        {#each ION_TYPES as t (t)}
          <label class="relative">
            <input
              type="checkbox"
              class="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              aria-label="{t} ions"
              checked={options.ions.includes(t)}
              onchange={(e) => setIon(t, e.currentTarget.checked)} />
            <span class={toggle}>{t}</span>
          </label>
        {/each}
      </div>
      <div class="flex items-center gap-1" role="group" aria-labelledby="{uid}-charge">
        <span id="{uid}-charge" class="mr-1 text-muted-foreground">Charge</span>
        <!-- a 1+ precursor has 1+ fragments only -->
        {#each fragmentCharges(charge) as c (c)}
          <label class="relative">
            <input
              type="checkbox"
              class="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              aria-label="{c}+ fragments"
              checked={options.charges.includes(c)}
              onchange={(e) => setCharge(c, e.currentTarget.checked)} />
            <span class={toggle}>{c}+</span>
          </label>
        {/each}
      </div>
      <!-- the neutral losses and the precursor peaks: one menu, its button says what is on -->
      <div class="flex items-center gap-1">
        <span id="{uid}-more" class="mr-1 text-muted-foreground">Losses</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[26px] gap-1 px-2 text-xs font-normal', moreOn && 'border-primary')}
            aria-label="Losses and precursor peaks: {moreSummary}">
            {moreSummary}<ChevronDown class="size-3.5 text-muted-foreground" aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="w-auto min-w-56" align="start">
            <DropdownMenu.Group>
              <DropdownMenu.GroupHeading class="text-xs font-medium text-muted-foreground">Neutral losses</DropdownMenu.GroupHeading>
              {#each losses as l (l.formula)}
                <DropdownMenu.CheckboxItem
                  checked={options.losses.includes(l.formula)}
                  onCheckedChange={(on) => setLoss(l.formula, on)}
                  title={l.formula === 'other' ? 'Other neutral losses the engine finds, such as losses from side chains' : undefined}
                  >{l.formula === 'other' ? 'other losses' : `${l.label} loss${l.note ? ` (${l.note})` : ''}`}</DropdownMenu.CheckboxItem>
              {/each}
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
            <DropdownMenu.CheckboxItem checked={options.precursor} onCheckedChange={(on) => (view.psmOptions.precursor = on)}
              >Precursor peaks</DropdownMenu.CheckboxItem>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
      <div class="ml-auto flex items-center gap-1" role="radiogroup" aria-labelledby="{uid}-bottom">
        <span id="{uid}-bottom" class="mr-1 text-muted-foreground">Bottom</span>
        <label class="relative" title={onnx ? undefined : 'This search has no PeptDeep predictions, because ProSE ran without ONNX Runtime'}>
          <input
            type="radio"
            name="{uid}-bottom"
            class="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
            value="peptdeep"
            disabled={!onnx}
            checked={options.bottom === 'peptdeep'}
            onchange={() => (view.psmOptions.bottom = 'peptdeep')} />
          <span class={toggle}>PeptDeep prediction</span>
        </label>
        <label class="relative">
          <input
            type="radio"
            name="{uid}-bottom"
            class="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
            value="theoretical"
            checked={options.bottom === 'theoretical'}
            onchange={() => (view.psmOptions.bottom = 'theoretical')} />
          <span class={toggle}>Theoretical</span>
        </label>
      </div>
    </div>

    {#if peaks}
      <SpectrumMirror
        bind:this={mirror}
        mz={peaks.mz}
        intensity={peaks.intensity}
        {groups}
        {reference}
        {bottom}
        {similarity}
        title={spectrumTitle}
        description={spectrumDescription}
        errors={{ matches: shown, tolerance }}
        onTheoretical={() => (view.psmOptions.bottom = 'theoretical')} />
      {#if hiddenOnePlus}
        <p class="flex flex-wrap items-center gap-2 pb-1 text-xs text-muted-foreground" role="status" data-testid="oneplus-hint">
          No fragment peaks match. 1+ fragments are hidden.
          <Button variant="outline" size="sm" class="h-6 px-2 text-xs" onclick={() => setCharge(1, true)}>Show 1+</Button>
        </p>
      {/if}
      {#if peakFilter}
        <p class="pb-1 text-xs text-muted-foreground" data-testid="peak-filter-note">
          Showing the top {peakFilter.top} peaks per {peakFilter.window} m/z, plus every peak ProSE annotated.
        </p>
      {/if}
      {#if annotationError}
        <p class="pb-1 text-xs text-destructive" role="alert">The spectrum could not be annotated: {annotationError}</p>
      {:else if precursorError}
        <p class="pb-1 text-xs text-muted-foreground" role="status" data-testid="precursor-note">
          The precursor peaks could not be annotated ({precursorError.length > 90 ? `${precursorError.slice(0, 89)}…` : precursorError}), so the
          fragments are shown without them. To try again, switch Precursor peaks off and on.
        </p>
      {/if}
    {:else if spectra === null}
      <div class="my-2 rounded-md border border-dashed px-4 py-8 text-center text-xs text-muted-foreground" data-testid="spectrum-loading">
        Reading the spectrum…
      </div>
    {:else if spectra.error}
      <div class="my-2 rounded-md border border-dashed px-4 py-8 text-center" role="alert" data-testid="spectrum-error">
        <p class="font-medium">The spectrum could not be read</p>
        <p class="mx-auto mt-1 max-w-[44rem] text-xs text-muted-foreground">{spectra.error}</p>
      </div>
    {:else}
      <div class="my-2 rounded-md border border-dashed px-4 py-8 text-center" data-testid="spectrum-missing">
        <p class="font-medium">Spectrum not stored</p>
        {#if ps.nativeId[row] === ''}
          <!-- (ProSE leaves the spectrum reference out when it stored no spectrum for the PSM, e.g. for a second
               spectrum of a native ID) -->
          <p class="mx-auto mt-1 max-w-[44rem] text-xs text-muted-foreground" data-testid="spectrum-not-referenced">
            ProSE did not store a spectrum for this PSM. This happens, for example, when another spectrum of the run has
            the same native ID.
          </p>
        {/if}
        <p class="mx-auto mt-1 max-w-[44rem] text-xs text-muted-foreground">
          The result has no peaks for this PSM, so its spectrum cannot be shown, annotated or exported. A search saves the spectra of
          its PSMs within its PSM FDR. Results opened without them, such as the debug results, have none. The fragment ladder
          needs the peaks too, but the table below lists the theoretical ions.
        </p>
      </div>
    {/if}
  </div>

  <!-- below the spectrum (and its mass errors): the ion table and the features side by side; what does not fit wraps -->
  <div class="mt-3 flex flex-wrap items-start gap-3">
    <div class="max-w-full min-w-0 flex-none rounded-lg border bg-background px-2 py-2">
      {#if table}
        <IonTable {table} {peptide} label={sequence} />
      {:else}
        <p class="px-2 py-6 text-center text-xs text-muted-foreground">
          {annotationError ? `No ion table: ${annotationError}` : 'Computing the fragment ions…'}
        </p>
      {/if}
    </div>
    <div class="min-w-[260px] flex-[1_1_420px] rounded-lg border bg-background px-3.5 py-3">
      <PsmFeatures model={m} {row} {fixedMods} matched={summary} />
    </div>
  </div>
</section>
