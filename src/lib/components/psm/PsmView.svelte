<script lang="ts">
  // The PSM view (mockup 3), over the PSM table (`list`, right under the spectrum and its mass errors, so that the arrow
  // keys in the table go through the PSMs while the spectrum stays in sight): breadcrumb, Prev/Next and "Export spectrum
  // (SVG)"; the peptide with
  // its fragment ladder; whether the PSM is a cross-link, its adduct and cross-linked residue, its FDR group and q-value
  // at that group's FDR; the spectrum with NuXL's own annotation (the hit's fragment_annotation: shifted ions, marker
  // ions, precursor, immonium and internal ions) on the observed peaks read from the input mzML (of a .raw or .d, the mzML
  // of its spectra the search wrote), or, when they cannot be read, on the peaks NuXL annotated; mirrored against the
  // theoretical b/y spectrum of the linear peptide (psm/annotate.ts), with ion, charge, shift, precursor and loss toggles
  // (NuXL's precursor peaks shown unless switched off; the precursor's m/z is marked in the spectrum always); the ion
  // table, the fragment mass errors of the annotated ions shown, each against its m/z as OpenNuXL computes it
  // (psm/nuxl-theoretical.ts; a strip that can be collapsed, remembered in displaySettings.massErrors) and the PSM's
  // features (NuXL's scores). The logic is in nuxl-psm.ts.
  // The toolbar's "Measure" and "Label" (one at a time) are the tools of pyopenms-viewer and openms-viewer on the
  // observed peaks (SpectrumMirror, psm/measure.ts): Δm/z between two peaks, with what it may be (a residue of the
  // search, a nucleotide or fragment adduct of its, for a cross-link a residue it may be on with a fragment adduct), and
  // texts of one's own; kept per spectrum for the session, as the viewers keep them (view.psmMarks: the PSMs of one
  // spectrum, its ranks and candidates, share them; those shown on NuXL's annotated peaks, which differ from PSM to PSM,
  // are kept per PSM), cleared with "Clear Δ" and "Clear labels". M and L switch the tools (as openms-viewer's Ctrl+M
  // and Ctrl+L), unless what has the focus takes the keys. Esc first cancels what is half done (a measurement, a label
  // being written) or the selection, then leaves the tool, then closes the view; Delete removes what is selected.
  import { signedNumber } from '$lib/format/number'
  import { errorText } from '$lib/format/error'
  import { Button, buttonVariants } from '$lib/components/ui/button'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import Marker from '$lib/components/results/Marker.svelte'
  import { download } from '$lib/download'
  import { adductLabel, peptideView, type PeptideView } from '$lib/format/peptide'
  import { annotatePeaks, type ModificationMass } from '$lib/psm/annotate'
  import { nuxlPeptide, nuxlTheoreticalMz, searchChemistry, type NuxlChemistry, type NuxlPeptide } from '$lib/psm/nuxl-theoretical'
  import { fragmentTolerance, modificationList, spectrumPeaks, svgFileName, ION_TYPES, type IonType } from '$lib/psm/psm'
  import { exportSpectrumSvg } from '$lib/psm/svg-export'
  import { baseName, passesPeptideQ } from '$lib/results/model'
  import { formatQValue, parseAccession, parseDescription, spectrumName as nameOfSpectrum } from '$lib/results/display'
  import type { LoadedSpectra, PsmSpectra } from '$lib/results/read'
  import type { PeakAnnotationResult } from '$lib/results/types'
  import type { ResultsView } from '$lib/results/view.svelte'
  import { defaultsOf } from '$lib/settings/parameters'
  import { NUXL_PARAMETERS } from '$lib/settings/nuxl'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import XIcon from '@lucide/svelte/icons/x'
  import RulerIcon from '@lucide/svelte/icons/ruler'
  import TagIcon from '@lucide/svelte/icons/tag'
  import { deltaCandidates, NO_MARKS, type PsmMarks, type SpectrumTool } from '$lib/psm/measure'
  import { cn } from '$lib/utils'
  import { displaySettings } from '$lib/format/settings.svelte'
  import { tick, type Snippet } from 'svelte'
  import PositionCell from '$lib/components/results/PositionCell.svelte'
  import { siteCellTitle, siteView } from '$lib/components/results/position-cells'
  import FragmentLadder from './FragmentLadder.svelte'
  import IonTable from './IonTable.svelte'
  import PsmFeatures from './PsmFeatures.svelte'
  import SpectrumMirror, { type Bottom, type PlotGroup } from './SpectrumMirror.svelte'
  import {
    annotatedShare,
    fdrOf,
    groupNuxl,
    legendOf,
    linearPeptide,
    massErrors,
    nuxlCharges,
    nuxlIonTable,
    nuxlLadder,
    percent,
    placeAnnotation,
    resolveNuxlOptions,
    siteResidues,
    visibleNuxl,
    LOSS_TOGGLES,
    type LocalToggles,
    type LossToggle,
    type NuxlOptions,
  } from './nuxl-psm'

  let {
    view,
    onClose,
    onBreadcrumb,
    list,
  }: {
    view: ResultsView
    /** Back to where the PSM came from (Esc, ✕). */
    onClose: () => void
    /** A breadcrumb: the Proteins or Peptides tab, the protein's panel, the PSM table of the peptide. */
    onBreadcrumb: (to: { tab: 'proteins' | 'peptides' } | { protein: number } | { peptide: number }) => void
    /** The PSM table (with its filter row), shown right under the spectrum and its mass errors. */
    list?: Snippet
  } = $props()

  const uid = $props.id()
  const m = $derived(view.model)
  const ps = $derived(m.tables.psms)
  const pt = $derived(m.tables.peptides)
  const xl = $derived(ps.xl)
  const row = $derived(view.psm?.row ?? 0)
  const k = $derived(ps.peptide[row])
  const charge = $derived(ps.charge[row])
  const sequence = $derived(pt.sequence[k])
  const fixedMods = $derived(view.result.settings.fixedMods)
  const peptide: PeptideView = $derived(peptideView(pt, k, fixedMods))
  const spectrumName = $derived(nameOfSpectrum(ps.nativeId[row]))

  // the cross-link
  const isXL = $derived(xl.isXL[row] === 1)
  const adduct = $derived(adductLabel(xl.adduct[row] ?? ''))
  const adductMass = $derived(xl.adductMass[row])
  const site = $derived(xl.site[row])
  const localized = $derived(isXL && site >= 0 && site < sequence.length)
  const siteScore = $derived(xl.siteScore[row])
  const siteSequence = $derived(xl.siteSequence[row] ?? '')
  const fdrGroup = $derived(xl.fdrGroup[row] ?? '')
  /** The search's two FDRs: a cross-link counts at the cross-link FDR, a peptide at the peptide FDR. */
  const fdrs = $derived(
    view.result.outcome.nuxl ?? { xlFdr: view.result.settings.xlFdr ?? view.result.psmFdr, peptideFdr: view.result.settings.peptideFdr ?? view.result.psmFdr },
  )
  const fdr = $derived(fdrOf(isXL, fdrs))
  const qValue = $derived(ps.qValue[row])
  // (a peptide PSM also by its peptide-level q-value, as OpenNuXL filters it)
  const peptideQ = $derived(xl.peptideQValue[row])
  const passes = $derived(!(qValue > fdr.cutoff) && (isXL || passesPeptideQ(peptideQ, fdr.cutoff)))

  // the search's settings: the parameters it changed, else OpenNuXL's defaults
  const parameters = $derived(view.result.settings.parameters)
  const defaults = defaultsOf(NUXL_PARAMETERS)
  const tolerance = $derived(fragmentTolerance(parameters, defaults))
  // the peaks of the PSM: read from its input mzML (a .raw/.d's converted spectra) when it is opened
  const source = $derived(view.result.outcome.spectra)
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
  const observed = $derived(spectra?.data && spectra.data.missing === null ? spectrumPeaks(spectra.data.spectra, spectra.data.spectrumRow) : null)
  const nuxlPeaks = $derived(spectra?.data?.annotation ?? [])
  /** Why the observed peaks are not shown (the reader's words), when they are not. */
  const missing = $derived(spectra?.data && !observed ? (spectra.data.missing ?? 'The spectrum has no peaks.') : null)
  /**
   * The peaks shown: the observed ones, else those NuXL annotated (their intensities relative, as NuXL scored the
   * spectrum); null without either.
   */
  const peaks = $derived.by(() => {
    if (observed) return { mz: observed.mz, intensity: observed.intensity, observed: true }
    if (nuxlPeaks.length === 0) return null
    return { mz: Float32Array.from(nuxlPeaks, (p) => p.mz), intensity: Float32Array.from(nuxlPeaks, (p) => p.intensity), observed: false }
  })

  // NuXL's annotation on the peaks shown
  const placed = $derived(placeAnnotation(nuxlPeaks, observed ? observed.mz : null, tolerance))
  const charges = $derived(nuxlCharges(charge, placed.matches))
  /** Shifted, marker, immonium and internal ions: chosen here, for the PSMs of this view. */
  let local = $state<LocalToggles>({ shifted: true, marker: true, immonium: true, internal: false })
  const options: NuxlOptions = $derived(resolveNuxlOptions(view.psmOptions, local, charges))
  const shown = $derived(visibleNuxl(placed.matches, options))
  const nuxlGroups = $derived(peaks ? groupNuxl(shown, peaks.mz, peaks.intensity) : [])
  const groups: PlotGroup[] = $derived(
    nuxlGroups.map((g) => ({
      peak: g.peak,
      mz: g.mz,
      intensity: g.intensity,
      label: g.label,
      color: g.color,
      ions: g.matches.map((x) => x.text),
      kinds: [...new Set(g.matches.map((x) => x.category))].join(' '),
    })),
  )
  const legend = $derived(legendOf(nuxlGroups.flatMap((g) => g.matches.map((x) => x.category)).concat(options.ions.length > 0 ? ['prefix', 'suffix'] : [])))
  const share = $derived(peaks ? annotatedShare(nuxlGroups, peaks.intensity) : null)

  // the linear peptide's theoretical spectrum (the lower half, the ion table)
  const linear = $derived(linearPeptide(pt.openms[k]))
  /** The masses of the peptide's modifications by name, for a name the Unimod table does not have. */
  const modificationMass: ModificationMass = $derived.by(() => {
    const masses = new Map<string, number>()
    for (let i = pt.modOffsets[k]; i < pt.modOffsets[k + 1]; i++) masses.set(pt.modName[i], pt.modMass[i])
    return (name: string) => masses.get(name)
  })
  /** The theoretical ions of the types shown, up to the highest charge shown, without losses; an error as text. */
  function theoreticalIons(): { result: PeakAnnotationResult | null; error: string | null } {
    try {
      const mz = peaks?.mz ?? new Float32Array(0)
      const intensity = peaks?.intensity ?? new Float32Array(0)
      const o = { tolerance: tolerance.value, unit: tolerance.unit, maxCharge: Math.max(1, ...options.charges), ions: ION_TYPES.filter((t) => options.ions.includes(t)), losses: false, precursor: false }
      return { result: annotatePeaks(mz, intensity, linear, charge, o, modificationMass), error: null }
    } catch (e) {
      return { result: null, error: String((e as Error)?.message ?? e) }
    }
  }
  const plain = $derived(theoreticalIons())
  const annotationError = $derived(plain.error)
  const theoretical = $derived((plain.result?.theoretical ?? []).filter((t) => options.charges.includes(t.charge)))
  // the mass errors: each annotated ion shown against its m/z as OpenNuXL computes it, from its label (the shifted ions
  // with the search's fragment adducts: of its preset, else its NuXL:fragment_adducts, else OpenNuXL's)
  const chemistry: NuxlChemistry = $derived(searchChemistry(parameters, view.result.outcome.nuxl?.preset) ?? { adducts: new Map(), markers: new Map() })
  const hitPeptide: NuxlPeptide | null = $derived.by(() => {
    const na = xl.adduct[row] ?? ''
    try {
      return nuxlPeptide(pt.openms[k], modificationMass, na === 'none' ? '' : na, isXL || na !== '' ? adductMass : NaN)
    } catch {
      return null
    }
  })
  // (a peptide that cannot be read: every ion shown is left out, and the strip says so)
  const errors = $derived(
    peaks
      ? massErrors(shown, peaks.mz, hitPeptide ? (x) => nuxlTheoreticalMz(x.label, x.ion.charge, hitPeptide, chemistry, x.mz).mz : null)
      : { matches: [], omitted: 0 },
  )
  const table = $derived(plain.result ? nuxlIonTable(theoretical, shown, sequence.length, options) : null)
  const cuts = $derived(nuxlLadder(shown, sequence.length))

  const bottomLabel = $derived(isXL ? 'Theoretical b/y of the linear peptide · without the adduct-shifted ions' : 'Theoretical ions of the peptide')
  const bottom: Bottom = $derived.by(() => {
    if (annotationError) return { kind: 'status', label: bottomLabel, message: 'The theoretical spectrum could not be computed' }
    const matched = new Set((plain.result?.matches ?? []).map((x) => x.ion))
    return {
      kind: 'ions',
      label: bottomLabel,
      ions: theoretical.map((t) => ({ mz: t.mz, height: 0.55, type: t.type, ion: t.ion, faint: !matched.has(t.ion) })),
    }
  })

  const reference = $derived.by(() => {
    let base = 0
    for (let i = 0; i < (peaks?.intensity.length ?? 0); i++) base = Math.max(base, peaks!.intensity[i])
    return { intensity: base, text: peaks?.observed ? 'base peak' : 'strongest annotated peak' }
  })

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
  /** The peptide as the breadcrumb writes it: "DY(U)HTVLGAR". */
  const peptideCrumb = $derived.by(() => {
    const label = (mod: { label: string } | undefined) => (mod ? `(${mod.label})` : '')
    const core = peptide.residues.map((r) => `${r.residue}${label(r.mod)}`).join('')
    return `${peptide.nTerm ? `(${peptide.nTerm.label})` : ''}${core}${peptide.cTerm ? `(${peptide.cTerm.label})` : ''}`
  })
  const proforma = $derived(pt.proforma[k])
  const fileName = $derived(baseName(m.tables.files[ps.file[row]] ?? ''))

  const headerLine = $derived.by(() => {
    const rt = ps.rt[row]
    const err = ps.precursorErrorPpm[row]
    return [
      m.samples[m.psmSample[row]]?.label,
      `${charge}+`,
      Number.isFinite(ps.mz[row]) ? `m/z ${ps.mz[row].toFixed(4)}` : null,
      rt >= 0 ? `RT ${(rt / 60).toFixed(1)} min` : null,
      Number.isFinite(err) ? `${signedNumber(err, 1)} ppm` : null,
    ]
      .filter((p) => p)
      .join(' · ')
  })
  const adductText = $derived(adduct === '' ? '' : Number.isFinite(adductMass) && adductMass !== 0 ? `${adduct} (${signedNumber(adductMass, 4)} Da)` : adduct)
  const siteText = $derived(localized ? `${sequence[site]}${site + 1}` : 'not localized')
  /** The cross-linked residue in the peptide's first protein ("Cas7 K137", 1-based; all of them in its tooltip). */
  const proteinSite = $derived(localized ? siteView(m, k, site) : null)
  /** What the header says of the cross-link, for screen readers and the tooltip. */
  const crossLinkText = $derived(
    isXL
      ? `Cross-link with ${adductText || 'an adduct'}, ${localized ? `on ${siteText}${Number.isFinite(siteScore) ? ` (localization score ${siteScore.toFixed(2)})` : ''}${proteinSite ? `, ${proteinSite.text}${proteinSite.inexact ? '?' : ''} in the protein` : ''}` : 'not localized'}`
      : adduct !== ''
        ? `Peptide with the adduct ${adductText}, not cross-linked`
        : 'Peptide, no cross-link',
  )

  const neighbours = $derived(view.psmNeighbours)

  const spectrumTitle = $derived.by(() => {
    const listed = modificationList(pt, k, fixedMods)
    const what = peaks?.observed === false ? "NuXL's annotated peaks" : 'Annotated spectrum'
    return `${what} of ${sequence}${listed.length > 0 ? ` (${listed.join(', ')})` : ''}, ${charge}+, ${spectrumName}${isXL ? `, a cross-link with ${adductText}` : ''}. Below it is the theoretical spectrum of the linear peptide.`
  })
  const spectrumDescription = $derived(
    peaks
      ? `${groups.length} of ${peaks.mz.length} peaks carry NuXL's annotation as shown.` +
          ' a, b and c ions are blue, x, y and z ions orange, ions shifted by the nucleotide green, marker ions violet, other ions dark grey and peaks without annotation light grey.' +
          (share && Number.isFinite(share.intensityFraction) ? ` The annotated peaks carry ${Math.round(share.intensityFraction * 100)} % of the intensity.` : '') +
          ` In the upper half, 100 % is the ${reference.text}. In the lower half, every ion has the same height${isXL ? '; the adduct-shifted ions are not among them' : ''}.`
      : '',
  )

  /** What the menu's button says: the losses and further ions on ("H₂O, NH₃, marker", "none"). */
  const moreSummary = $derived.by(() => {
    const on: string[] = LOSS_TOGGLES.filter((l) => options.losses.includes(l.id)).map((l) => (l.id === 'other' ? 'other' : l.label.replace(' loss', '')))
    if (options.marker) on.push('marker')
    if (options.immonium) on.push('immonium')
    if (options.internal) on.push('internal')
    return on.length > 0 ? on.join(', ') : 'none'
  })
  const moreOn = $derived(options.losses.length > 0 || options.marker || options.immonium || options.internal)
  /** The PSM's precursor, marked in the spectrum at its m/z. */
  const precursorMark = $derived(Number.isFinite(ps.mz[row]) ? { mz: ps.mz[row], charge } : null)

  // the toggles: a choice of ions, charges, losses and precursor becomes the user's (no longer automatic) for all PSMs
  function setIon(type: IonType, on: boolean) {
    const ions = new Set(options.ions)
    if (on) ions.add(type)
    else ions.delete(type)
    view.psmOptions.ions = ION_TYPES.filter((t) => ions.has(t))
  }
  function setCharge(c: number, on: boolean) {
    const chosen = new Set(options.charges)
    if (on) chosen.add(c)
    else chosen.delete(c)
    view.psmOptions.charges = [...chosen].sort()
  }
  function setLoss(id: LossToggle, on: boolean) {
    const chosen = new Set<string>(options.losses)
    if (on) chosen.add(id)
    else chosen.delete(id)
    view.psmOptions.losses = [...chosen]
  }

  let mirror = $state<SpectrumMirror | null>(null)

  // the tools: one at a time; what they made, per spectrum (the view keeps it for the session)
  let tool = $state<SpectrumTool>(null)
  /** A measurement is half made, or a label being written (the mirror's, while there is one). */
  let toolPending = $state(false)
  // (another PSM: the mirror goes while its peaks are read, and with it what was half made)
  $effect.pre(() => {
    void row
    toolPending = false
  })
  /** Whose marks these are: the spectrum's (its file and native ID), or the PSM's on NuXL's annotated peaks. */
  const marksKey = $derived(peaks && !peaks.observed ? `psm ${row}` : `${ps.file[row]} ${ps.nativeId[row]}`)
  const marks = $derived(view.psmMarks[marksKey] ?? NO_MARKS)
  function setMarks(next: PsmMarks) {
    view.psmMarks[marksKey] = next
  }
  const stringsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  /** The residues the cross-link may be on: its site, else the candidates of NuXL's localization. */
  const crossLinked = $derived(
    !isXL ? [] : localized ? [sequence[site]] : siteResidues(siteSequence, -1).flatMap((r) => (r.candidate ? [r.residue] : [])),
  )
  /**
   * What a Δm/z may be: the residues (with the search's modifications), its nucleotides and fragment adducts, the
   * cross-linked residues with a fragment adduct; at 1+, and 2+ while 2+ fragments are shown.
   */
  const measure = $derived({
    tolerance,
    candidates: deltaCandidates(
      stringsOf(parameters['modifications:fixed'] ?? defaults['modifications:fixed']),
      stringsOf(parameters['modifications:variable'] ?? defaults['modifications:variable']),
      searchChemistry(parameters, view.result.outcome.nuxl?.preset),
      crossLinked,
    ),
    charges: options.charges.includes(2) ? [1, 2] : [1],
  })
  function setTool(next: SpectrumTool) {
    tool = tool === next ? null : next
  }
  const pending = $derived(toolPending && mirror !== null)
  const toolHint = $derived(
    tool === 'measure'
      ? pending
        ? 'Click the second peak · Esc cancels'
        : 'Click two peaks for their Δm/z'
      : tool === 'label'
        ? pending
          ? 'Enter keeps the label · Esc cancels'
          : 'Click a peak to label it'
        : '',
  )
  function exportSvg() {
    const svg = mirror?.svgElement()
    if (!svg) return
    void download(svgFileName(proforma, ps.nativeId[row]), exportSpectrumSvg(svg), 'image/svg+xml')
  }

  // the Export menu's "Spectrum (SVG)" does what the button does
  $effect(() => {
    view.spectrumExporter = peaks ? exportSvg : null
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
      // what is half done (or selected) first, then the tool, then the view
      if (mirror?.cancel()) return
      if (tool) tool = null
      else onClose()
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      if (ownsKeys(event.target)) return
      if (mirror?.deleteSelection()) event.preventDefault()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (ownsKeys(event.target)) return
      event.preventDefault()
      void step(event.key === 'ArrowLeft' ? -1 : 1)
    } else if (event.key === 'm' || event.key === 'M' || event.key === 'l' || event.key === 'L') {
      if (ownsKeys(event.target) || !peaks) return
      event.preventDefault()
      setTool(event.key.toLowerCase() === 'm' ? 'measure' : 'label')
    }
  }

  const toggle =
    'inline-flex h-[26px] min-w-[30px] cursor-pointer items-center justify-center rounded-md border bg-background px-2 text-xs text-muted-foreground select-none hover:text-foreground peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50'
  /** The tools' buttons: the toggles' look (pressed: the primary colour), with an icon. */
  const tool_ =
    'inline-flex h-[26px] cursor-pointer items-center justify-center gap-1 rounded-md border bg-background px-2 text-xs text-muted-foreground select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground'
  const toolOn = 'border-primary bg-primary text-primary-foreground hover:text-primary-foreground'
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
              <span class="min-w-0 truncate">no protein</span>
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
        disabled={!peaks}
        title={spectra === null ? 'Reading the spectrum' : !peaks ? 'The spectrum has no peaks to export' : undefined}
        onclick={exportSvg}>Export spectrum (SVG)</Button>
      <Button variant="ghost" size="icon-sm" aria-label="Close the PSM view" title="Back (Esc)" onclick={onClose}>
        <XIcon aria-hidden="true" />
      </Button>
    </div>
  </header>

  <div class="mt-1 flex flex-wrap items-end gap-x-5" bind:clientWidth={ladderRow}>
    <FragmentLadder {peptide} {cuts} available={ladderRow} />
    <p class="pb-3 text-xs text-muted-foreground tabular-nums" data-testid="psm-header">
      {headerLine}{#if ps.decoy[row]}<Marker text="decoy" />{/if}
    </p>
  </div>
  <!-- the cross-link: adduct, residue (the candidates of the localization marked), FDR group and q-value at its FDR -->
  <p class="mt-1 mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums" data-testid="psm-crosslink" title={crossLinkText}>
    <span class="sr-only">{crossLinkText}.</span>
    <span aria-hidden="true" class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      {#if isXL}
        <span class="xl-badge" data-testid="xl-badge">cross-link</span>
      {:else}
        <span class="rounded-[4px] border px-1 py-px text-[10.5px] leading-none">peptide</span>
      {/if}
      {#if adduct !== ''}
        <span data-testid="psm-adduct">adduct <span class="font-mono text-foreground">{adduct}</span>{#if Number.isFinite(adductMass) && adductMass !== 0}{' '}({signedNumber(adductMass, 4)} Da){/if}</span>
      {/if}
      {#if isXL}
        <span data-testid="psm-site">
          {#if localized}
            on <span class="font-medium text-foreground">{siteText}</span>{#if Number.isFinite(siteScore)}{' '}(score {siteScore.toFixed(2)}){/if}
          {:else}
            not localized
          {/if}
        </span>
        {#if proteinSite}
          <span data-testid="psm-protein-site" class="text-foreground" title={`In the protein (1-based): ${siteCellTitle(m, k, site, true, siteSequence)}`}
            >{'· '}<span class="font-medium"><PositionCell view={proteinSite} plain /></span>{siteSequence !== '' ? ' ·' : ''}</span>
        {/if}
        {#if siteSequence !== ''}
          <span class="site-sequence font-mono" data-testid="site-sequence" title="The residues the cross-link may be on (NuXL's localization), the best one underlined"
            >{#each siteResidues(siteSequence, localized ? site : -1) as r, i (i)}<span class:candidate={r.candidate} class:site={r.site}>{r.residue}</span>{/each}</span>
        {/if}
      {/if}
    </span>
    {#if fdrGroup !== ''}<span aria-hidden="true">· FDR group {fdrGroup}</span>{/if}
    <span data-testid="psm-q">· q {formatQValue(qValue)} at the {fdr.name} of {percent(fdr.cutoff)}{#if !passes}<Marker
          text={qValue > fdr.cutoff ? `above the ${fdr.name}` : `peptide q-value ${formatQValue(peptideQ)}, not below the ${fdr.name}`} />{/if}</span>
  </p>

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
        <!-- 1+ to the highest charge NuXL annotated (2+ at least, for a precursor of 2+ or more) -->
        {#each charges as c (c)}
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
      <label class="relative" title="Ions shifted by a fragment of the cross-linked nucleotide">
        <input
          type="checkbox"
          class="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          aria-label="Shifted ions"
          checked={options.shifted}
          onchange={(e) => (local.shifted = e.currentTarget.checked)} />
        <span class={toggle}>shifted</span>
      </label>
      <label class="relative" title="The precursor peaks NuXL annotated, with their losses and nucleotide shifts (the precursor's m/z is marked in the spectrum always)">
        <input
          type="checkbox"
          class="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
          aria-label="Precursor peaks"
          data-testid="precursor-toggle"
          checked={options.precursor}
          onchange={(e) => (view.psmOptions.precursor = e.currentTarget.checked)} />
        <span class={toggle}>precursor</span>
      </label>
      <label class="relative" title="The fragment mass errors under the spectrum">
        <input
          type="checkbox"
          class="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
          aria-label="Mass errors"
          data-testid="mass-errors-toggle"
          checked={displaySettings.massErrors}
          onchange={(e) => (displaySettings.massErrors = e.currentTarget.checked)} />
        <span class={toggle}>mass errors</span>
      </label>
      <!-- the tools on the observed peaks (one at a time) and what clears what they made -->
      <div class="flex items-center gap-1" role="group" aria-label="Tools" data-testid="spectrum-tools">
        <button
          type="button"
          class={cn(tool_, tool === 'measure' && toolOn)}
          aria-pressed={tool === 'measure'}
          title="Measure (M): click two peaks for their Δm/z (and what it may be); a click on a measurement selects it, Delete removes it"
          disabled={!peaks}
          data-testid="tool-measure"
          onclick={() => setTool('measure')}><RulerIcon class="size-3.5" aria-hidden="true" />Measure</button>
        <button
          type="button"
          class={tool_}
          disabled={marks.measurements.length === 0}
          title="Remove the measurements of this spectrum"
          data-testid="clear-measurements"
          onclick={() => setMarks({ ...marks, measurements: [] })}>Clear Δ</button>
        <button
          type="button"
          class={cn(tool_, tool === 'label' && toolOn)}
          aria-pressed={tool === 'label'}
          title="Label (L): click a peak to give it a label of your own; a click on a label selects it, Delete removes it, a double click edits it"
          disabled={!peaks}
          data-testid="tool-label"
          onclick={() => setTool('label')}><TagIcon class="size-3.5" aria-hidden="true" />Label</button>
        <button
          type="button"
          class={tool_}
          disabled={marks.labels.length === 0}
          title="Remove your labels of this spectrum"
          data-testid="clear-labels"
          onclick={() => setMarks({ ...marks, labels: [] })}>Clear labels</button>
        <!-- (as wide as the longest hint while a tool is on: the hint changes between the clicks, the toolbar does not) -->
        {#if toolHint}<span class="ml-1 inline-block w-56 truncate text-muted-foreground" title={toolHint} data-testid="tool-hint">{toolHint}</span>{/if}
      </div>
      <!-- the neutral losses and the other ions: one menu, its button says what is on -->
      <div class="flex items-center gap-1">
        <span id="{uid}-more" class="mr-1 text-muted-foreground">Also</span>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'h-[26px] gap-1 px-2 text-xs font-normal', moreOn && 'border-primary')}
            aria-label="Neutral losses and other ions: {moreSummary}">
            {moreSummary}<ChevronDown class="size-3.5 text-muted-foreground" aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content class="w-auto min-w-56" align="start">
            <DropdownMenu.Group>
              <DropdownMenu.GroupHeading class="text-xs font-medium text-muted-foreground">Neutral losses</DropdownMenu.GroupHeading>
              {#each LOSS_TOGGLES as l (l.id)}
                <DropdownMenu.CheckboxItem
                  checked={options.losses.includes(l.id)}
                  onCheckedChange={(on) => setLoss(l.id, on)}
                  title={l.id === 'other' ? 'The other losses NuXL annotates, such as of side chains' : undefined}>{l.label}</DropdownMenu.CheckboxItem>
              {/each}
            </DropdownMenu.Group>
            <DropdownMenu.Separator />
            <DropdownMenu.Group>
              <DropdownMenu.GroupHeading class="text-xs font-medium text-muted-foreground">Other ions</DropdownMenu.GroupHeading>
              <DropdownMenu.CheckboxItem checked={options.marker} onCheckedChange={(on) => (local.marker = on)} title="Marker ions of the nucleotides (MI:)"
                >Marker ions</DropdownMenu.CheckboxItem>
              <DropdownMenu.CheckboxItem checked={options.immonium} onCheckedChange={(on) => (local.immonium = on)}>Immonium ions</DropdownMenu.CheckboxItem>
              <DropdownMenu.CheckboxItem checked={options.internal} onCheckedChange={(on) => (local.internal = on)}>Internal fragments</DropdownMenu.CheckboxItem>
            </DropdownMenu.Group>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </div>
    </div>

    {#if peaks}
      {#if missing}
        <p class="pb-1 text-xs text-muted-foreground" role="status" data-testid="peaks-missing-note">
          {missing} Shown are the peaks NuXL annotated, with their intensities as NuXL scored the spectrum.
        </p>
      {:else if placed.unplaced > 0}
        <p class="pb-1 text-xs text-muted-foreground" data-testid="unplaced-note">
          {placed.unplaced} of NuXL's annotated {placed.unplaced + placed.matches.length === 1 ? 'peak has' : 'peaks have'} no observed peak within ±{tolerance.value}
          {tolerance.unit}.
        </p>
      {/if}
      <SpectrumMirror
        bind:this={mirror}
        mz={peaks.mz}
        intensity={peaks.intensity}
        {groups}
        {reference}
        upper={peaks.observed ? 'Observed' : "NuXL's annotated peaks"}
        {legend}
        {bottom}
        title={spectrumTitle}
        description={spectrumDescription}
        errors={displaySettings.massErrors ? { ...errors, tolerance } : null}
        {tool}
        {marks}
        onmarks={setMarks}
        {measure}
        precursor={precursorMark}
        bind:pending={toolPending} />
      {#if annotationError}
        <p class="pb-1 text-xs text-muted-foreground" role="status">The theoretical spectrum could not be computed: {annotationError}</p>
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
        <p class="font-medium">No peaks to show</p>
        <p class="mx-auto mt-1 max-w-[44rem] text-xs text-muted-foreground">
          {missing ?? 'The spectrum has no peaks.'} NuXL annotated no peaks of this PSM either, so its spectrum cannot be shown or exported. The table below
          lists the theoretical ions of the peptide.
        </p>
      </div>
    {/if}
  </div>

  {#if list}
    <!-- the PSM table right under the spectrum: its height fixed, so that the spectrum stays in sight while the keys go
         through the PSMs -->
    <div class="mt-3 flex h-[clamp(220px,36vh,420px)] flex-none flex-col gap-2" data-testid="psm-list">
      {@render list()}
    </div>
  {/if}

  <!-- below the spectrum (and its mass errors, and the table): the ion table and the features side by side; what does not fit wraps -->
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
      <PsmFeatures model={m} {row} {fixedMods} matched={share} />
    </div>
  </div>
</section>

<style>
  .xl-badge {
    border-radius: 4px;
    border: 1px solid var(--mod-border);
    background: var(--mod-bg);
    color: var(--mod-fg);
    padding: 1px 4px;
    font-size: 10.5px;
    line-height: 1;
    font-weight: 500;
  }
  .site-sequence {
    letter-spacing: 0.02em;
  }
  .site-sequence .candidate {
    background: var(--mod-bg);
    color: var(--mod-fg);
    border-radius: 2px;
  }
  .site-sequence .site {
    font-weight: 700;
    text-decoration: underline;
    text-decoration-color: var(--mod);
    text-underline-offset: 2px;
  }
</style>
