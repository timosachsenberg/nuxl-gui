// The state of the Results view for the open result: the active tab, and per level (proteins,
// peptides, PSMs) one filter state, the sort order, the selected row and the hidden columns. The
// rows of a level are derived from these: the table cells, the sort order and the CSV all read the
// same filter state (the same cutoffs: one for the peptide PSMs, one for the cross-links). Kept outside the view, so that it survives a visit to New search.

import { curationStoreFor } from '../desktop'
import { formatPercent, formatQ } from '../format/fdr'
import type { PsmOptionState } from '../psm/psm'
import type { PsmMarks } from '../psm/measure'
import type { OpenResult } from '../search/session.svelte'
import { columnDef } from './columns'
import { toCsv, toTsv } from './csv'
import { cleanNote, curationChanged, NONE, readCuration, writeCuration, type CuratedPsm, type Mark } from './curation'
import { levelTotal } from './figures'
import { applyFilters, initialFilters, sortRows, type FilterState } from './filters'
import { buildModel, peptideCounts, type Level, type ResultModel } from './model'
import { columnSpecs, csvColumns, defaultHidden, visibleSpecs } from './table-columns'

export type Tab = 'overview' | 'proteins' | 'peptides' | 'psms' | 'samples' | 'qc'
/** The tabs of the protein panel. */
export type PanelTab = 'coverage' | 'peptides' | 'psms'
export type SortDir = 'asc' | 'desc'
export type SortState = { key: string; dir: SortDir }

/**
 * Where the open PSM came from: the PSM table, or the protein panel (a PSM of one of its peptides, or
 * of its PSMs tab). From the panel the PSM table shows the PSMs of that protein (and peptide) while
 * the PSM is open; `restore` is the table's filter state before, which it gets back when the PSM closes.
 */
export type PsmOrigin =
  | { kind: 'psms' }
  | { kind: 'panel'; protein: number; peptide: number | null; restore: FilterState }

/** The PSM open in the PSM view (a row of `tables.psms`) and where it came from. */
export type OpenPsm = { row: number; origin: PsmOrigin }

/** How a level is sorted at first: proteins and peptides by PSMs, PSMs by q-value. */
const defaultSort: Record<Level, SortState> = {
  proteins: { key: 'psms', dir: 'desc' },
  peptides: { key: 'psms', dir: 'desc' },
  psms: { key: 'qValue', dir: 'asc' },
}

/** The sort keys of the curation columns: they read the marks and notes, which change in place. */
const curationKeys = new Set(['curation', 'curationNote', 'acceptedPsms', 'rejectedPsms'])

/** What "Mark shown" last did, for its Undo: the PSM rows and the marks they had before. */
export type BulkCuration = { rows: Uint32Array; before: Uint8Array; mark: Mark }

export class LevelState {
  readonly level: Level
  readonly #view: ResultsView
  filters: FilterState = $state()!
  sort: SortState = $state()!
  /** The selected row (a protein, peptide or PSM index), or null. */
  selected = $state<number | null>(null)
  hidden = $state<string[]>([])

  constructor(view: ResultsView, level: Level) {
    this.#view = view
    this.level = level
    this.filters = initialFilters(view.model, level)
    this.sort = { ...defaultSort[level] }
    this.hidden = defaultHidden(columnSpecs(view.model, level), view.model)
  }

  /** The rows that pass the filters, in table order. */
  readonly kept = $derived.by(() => {
    // (the curation filter reads the marks, which change in place)
    if (this.level !== 'proteins' && this.filters.curation !== 'any') void this.#view.curationVersion
    return applyFilters(this.#view.model, this.level, this.filters)
  })

  /** The sort that applies: the chosen one, or the default if its column is gone (e.g. a sample column). */
  readonly effectiveSort = $derived.by(() =>
    columnDef(this.#view.model, this.level, this.sort.key) ? this.sort : defaultSort[this.level],
  )

  /** The rows of the table: filtered and sorted. */
  readonly rows = $derived.by(() => {
    if (curationKeys.has(this.effectiveSort.key)) void this.#view.curationVersion
    return sortRows(this.#view.model, this.level, this.kept, this.effectiveSort.key, this.effectiveSort.dir, this.filters)
  })

  /** The peptide counts the cells show (at the peptide cutoff on the Peptides level). */
  readonly counts = $derived.by(() =>
    this.level === 'peptides' ? peptideCounts(this.#view.model, this.filters.maxQ, this.filters.maxXlQ) : peptideCounts(this.#view.model, NaN),
  )

  /** The rows at the search's cutoff, before the user's filters ("n of total"). */
  readonly total = $derived.by(() => levelTotal(this.#view.model, this.level, this.filters.showDecoys))

  /**
   * What the table says without rows: the filters hide everything, or nothing passed the search's cutoffs. A search
   * without a target PSM says so on every level, with the likely cause.
   */
  readonly emptyText = $derived.by(() => {
    const what = { proteins: 'proteins', peptides: 'peptides', psms: 'PSMs' }[this.level]
    if (this.total > 0) return `No ${what} match the filters.`
    const m = this.#view.model
    const q = (q: number) => `${formatPercent(q)}, ${formatQ(q)}`
    // the peptide PSMs and the cross-links have their own cutoffs: one when they are the same
    const psmCutoffs =
      m.psmFdr === m.xlFdr
        ? `the search's FDR (${q(m.psmFdr)})`
        : `the search's peptide FDR (${q(m.psmFdr)}) and cross-link FDR (${q(m.xlFdr)})`
    if (levelTotal(m, 'psms', false) === 0) {
      return `No PSMs pass ${psmCutoffs}. The database may not match the organism of the sample.`
    }
    return `No ${what} pass ${psmCutoffs}.`
  })

  readonly specs = $derived.by(() => columnSpecs(this.#view.model, this.level))
  readonly visible = $derived.by(() => visibleSpecs(this.specs, this.hidden))

  /** Sorts by `key`: a new column starts descending for numbers and ascending for text; the same column flips. */
  sortBy(key: string): void {
    if (this.effectiveSort.key === key) {
      this.sort = { key, dir: this.effectiveSort.dir === 'asc' ? 'desc' : 'asc' }
    } else {
      const numeric = columnDef(this.#view.model, this.level, key)?.number !== undefined
      this.sort = { key, dir: numeric ? 'desc' : 'asc' }
    }
  }

  toggleColumn(id: string, show: boolean): void {
    this.hidden = show ? this.hidden.filter((h) => h !== id) : [...this.hidden, id]
  }

  /** The CSV of the view: the visible columns, the filtered and sorted rows (peptides in ProForma). */
  csv(): string {
    return toCsv(this.#view.model, this.level, this.rows, csvColumns(this.visible), this.filters)
  }

  /** The same as a tab-separated table (`toTsv`). */
  tsv(): string {
    return toTsv(this.#view.model, this.level, this.rows, csvColumns(this.visible), this.filters)
  }
}

/**
 * Where the curation of a result is kept (its search folder's `curation.json`, desktop.ts): `load` resolves with
 * the file's text, or null when there is none; `save` writes it.
 */
export type CurationStore = { load(): Promise<string | null>; save(text: string): Promise<void> }

export class ResultsView {
  readonly result: OpenResult
  tab = $state<Tab>('proteins')
  /** "Show technical replicates separately" (the Columns menu): one count column per measurement. */
  showTechReplicates = $state(false)
  /** A CSV export is being written (the button says "Exporting…"). */
  exporting = $state(false)
  /**
   * The protein open in the panel at the right of the Proteins table (a row of `tables.proteins`), or
   * null. The panel belongs to the Proteins tab; the protein stays open while another tab shows.
   */
  panel = $state<number | null>(null)
  /** The panel's tab: Peptides is the one the mockup opens with. */
  panelTab = $state<PanelTab>('peptides')
  /** The peptide expanded in the panel's Peptides tab (a row of `tables.peptides`), or null. */
  panelPeptide = $state<number | null>(null)

  /**
   * The PSM view: the PSM open beside the PSM table (which narrows to a list), or null. "Previous" and
   * "Next" go through the rows of the PSM table as it is sorted and filtered.
   */
  psm = $state.raw<OpenPsm | null>(null)
  /** The toggles of the PSM view's spectrum, kept from one PSM to the next. */
  psmOptions = $state<PsmOptionState>({ ions: ['b', 'y'], charges: null, losses: null, precursor: true })
  /**
   * The measurements and labels the user made on the PSM view's spectra ("Measure", "Label"), by spectrum ("<file>
   * <native ID>", as the viewers keep them: the PSMs of one spectrum share them), or by PSM on NuXL's annotated peaks
   * ("psm <row>"): kept for the session, so that another PSM and back finds them again.
   */
  psmMarks = $state<Record<string, PsmMarks>>({})
  /** Saves the spectrum of the open PSM as SVG: set by the PSM view while it shows a spectrum (the Export menu's item). */
  spectrumExporter: (() => void) | null = null

  /**
   * The curation marks per PSM row (curation.ts; the model's `curation` is this array), changed in place by
   * `curate`; `curationVersion` counts the changes, so that what shows the marks reads it.
   */
  readonly curation: Uint8Array
  /** The user's notes by PSM row (the model's `curationNotes`), changed in place by `setNote`. */
  readonly curationNotes = new Map<number, string>()
  curationVersion = $state(0)
  /** The last "Mark shown" (`curateMany`), which `undoCurateMany` takes back; null: none. */
  lastBulk = $state.raw<BulkCuration | null>(null)
  /** Why the marks could not be read or saved, or null. */
  curationError = $state<string | null>(null)
  readonly #store: CurationStore | null
  /** The curated PSMs of the file that are none of this result, written back as they were. */
  #unmatched: CuratedPsm[] = []
  /** The marks were read (or there were none to read): saving before would lose them. */
  #loaded = false
  #saving = false
  #dirty = false

  /**
   * The PSMs' scores are Percolator's: every file was rescored (the reader's `nuxl.percolatorScores`). With only
   * some rescored, the reader gives every PSM NuXL's score, so that one column has one scale.
   */
  readonly rescored: boolean

  /**
   * The cross-link PSMs' cutoff (OpenNuXL's XL FDR): the request's, else the runs' (`outcome.nuxl`), else the
   * peptide PSMs'.
   */
  readonly xlFdr: number

  readonly model: ResultModel = $derived.by(() =>
    buildModel(this.result.outcome.tables, this.result.design, {
      showTechReplicates: this.showTechReplicates,
      psmFdr: this.result.psmFdr,
      xlFdr: this.xlFdr,
      proteinFdr: this.result.proteinFdr,
      rescored: this.rescored,
      curation: this.curation,
      curationNotes: this.curationNotes,
    }),
  )

  readonly proteins: LevelState
  readonly peptides: LevelState
  readonly psms: LevelState

  constructor(result: OpenResult, store: CurationStore | null = null) {
    this.result = result
    this.curation = new Uint8Array(result.outcome.tables.psms.count)
    this.#store = store
    const summary = result.outcome.summary
    this.rescored =
      result.outcome.nuxl?.percolatorScores ?? (summary.files.length > 0 && summary.files.every((f) => f.percolator?.applied === true))
    const fdr = (x: unknown): x is number => typeof x === 'number' && x > 0 && x <= 1
    this.xlFdr = [result.settings?.xlFdr, result.outcome.nuxl?.xlFdr].find(fdr) ?? result.psmFdr
    this.proteins = new LevelState(this, 'proteins')
    this.peptides = new LevelState(this, 'peptides')
    this.psms = new LevelState(this, 'psms')
    this.loaded = store ? this.#load(store) : Promise.resolve()
    if (!store) this.#loaded = true
  }

  /** Resolves when the saved marks have been read (at once without a store). */
  readonly loaded: Promise<void>

  async #load(store: CurationStore): Promise<void> {
    try {
      const text = await store.load()
      if (text !== null) {
        const { marks, notes, unmatched } = readCuration(this.model, text)
        // what the user marked meanwhile wins
        for (let i = 0; i < marks.length; i++) if (this.curation[i] === NONE) this.curation[i] = marks[i]
        for (const [i, note] of notes) if (!this.curationNotes.has(i)) this.curationNotes.set(i, note)
        this.#unmatched = unmatched
        this.#changed()
      }
      this.#loaded = true
      if (this.#dirty) void this.#save()
    } catch (e) {
      // (not loaded: the marks of this session are not saved, so that they do not overwrite the file)
      this.curationError = `The curation could not be read: ${String((e as Error)?.message ?? e)}`
    }
  }

  /** Writes the marks; one write at a time, the last marks last. */
  async #save(): Promise<void> {
    this.#dirty = true
    if (!this.#store || !this.#loaded || this.#saving) return
    this.#saving = true
    try {
      while (this.#dirty) {
        this.#dirty = false
        await this.#store.save(writeCuration(this.model, this.curation, this.curationNotes, this.#unmatched))
      }
      this.curationError = null
    } catch (e) {
      this.curationError = `The curation could not be saved: ${String((e as Error)?.message ?? e)}`
    } finally {
      this.#saving = false
    }
  }

  /**
   * Marks PSM `i` (accepted, rejected, or NONE to take the mark away) and saves the marks. When it is the open PSM
   * and the PSM table's filters now hide it (e.g. "Not curated"), the view goes on to the PSM after it (or before).
   */
  curate(i: number, mark: Mark): void {
    if (!this.#isPsm(i) || this.curation[i] === mark) return
    const open = this.psm?.row === i ? this.psmNeighbours : null
    this.curation[i] = mark
    this.#changed()
    void this.#save()
    if (open && this.psm && !this.psms.kept.includes(i)) {
      const target = open.next ?? open.prev
      if (target !== null) {
        this.psms.selected = target
        this.psm = { row: target, origin: this.psm.origin }
      }
    }
  }

  /** The marks or notes changed: what shows them reads them again. */
  #changed(): void {
    curationChanged()
    this.curationVersion++
  }

  /** Sets the note of PSM `i` (`cleanNote`; empty: no note) and saves it. */
  setNote(i: number, text: string): void {
    if (!this.#isPsm(i)) return
    const note = cleanNote(text)
    if ((this.curationNotes.get(i) ?? '') === note) return
    if (note) this.curationNotes.set(i, note)
    else this.curationNotes.delete(i)
    this.#changed()
    void this.#save()
  }

  /**
   * "Mark shown": gives the PSM rows `rows` (the PSM table as filtered) the mark `mark` (NONE: takes their marks away)
   * and saves once. `undoCurateMany` gives them back the marks they had.
   */
  curateMany(rows: Uint32Array, mark: Mark): void {
    const valid = rows.filter((i) => this.#isPsm(i))
    if (valid.length === 0) return
    const before = Uint8Array.from(valid, (i) => this.curation[i])
    for (const i of valid) this.curation[i] = mark
    this.lastBulk = { rows: valid, before, mark }
    this.#changed()
    void this.#save()
  }

  /** Takes back the last "Mark shown". */
  undoCurateMany(): void {
    const bulk = this.lastBulk
    if (!bulk) return
    bulk.rows.forEach((i, j) => (this.curation[i] = bulk.before[j]))
    this.lastBulk = null
    this.#changed()
    void this.#save()
  }

  /** The PSMs with a mark or a note. */
  curatedCount(): number {
    void this.curationVersion
    let n = 0
    for (let i = 0; i < this.curation.length; i++) if (this.curation[i] !== NONE || this.curationNotes.has(i)) n++
    return n
  }

  /** The PSM rows with a mark or a note, in the PSM table's order (whatever its filters). */
  curatedRows(): Uint32Array {
    void this.curationVersion
    const rows: number[] = []
    for (let i = 0; i < this.curation.length; i++) if (this.curation[i] !== NONE || this.curationNotes.has(i)) rows.push(i)
    const sort = this.psms.effectiveSort
    return sortRows(this.model, 'psms', Uint32Array.from(rows), sort.key, sort.dir, this.psms.filters)
  }

  /**
   * Splits or merges the technical replicates' count columns. A level sorted by a sample column stays
   * sorted by that sample: by its first measurement when split, by the whole sample when merged.
   */
  setShowTechReplicates(on: boolean): void {
    if (on === this.showTechReplicates) return
    const before = this.model.samples
    this.showTechReplicates = on
    const after = this.model.samples
    for (const level of [this.proteins, this.peptides, this.psms]) {
      const match = /^sample:(\d+)$/.exec(level.sort.key)
      const old = match ? before[Number(match[1])] : undefined
      if (!old) continue
      const next = after.find(
        (s) =>
          s.designSample === old.designSample &&
          (s.techReplicate === old.techReplicate || s.techReplicate === null || old.techReplicate === null),
      )
      if (next) level.sort = { key: `sample:${next.index}`, dir: level.sort.dir }
    }
  }

  /**
   * Opens the panel of protein `p` (a row of the Proteins table) and selects its row. What is no
   * protein (a peptide below the protein FDR has none, an index out of range) opens nothing.
   */
  openProtein(p: number): void {
    if (!Number.isInteger(p) || p < 0 || p >= this.model.tables.proteins.count) return
    this.psm = null
    if (p !== this.panel) this.panelPeptide = null
    this.proteins.selected = p
    this.panel = p
  }

  /** Closes the panel; the protein's row stays selected. */
  closeProtein(): void {
    this.panel = null
  }

  /**
   * "Open in PSM table": the PSM table shows the PSMs of one `protein`, or of one `peptide` (a row of
   * `tables.peptides`: "All n in the PSM table"), and only those. A chip ("Protein: <accession>",
   * "Peptide: <ProForma>") says so and removes the filter. The table is at the search's cutoffs, of all kinds and
   * adducts, without text filter or the other restriction, and shows contaminants or decoys if the protein or
   * peptide is one.
   */
  filterBy(what: { protein: number } | { peptide: number }): void {
    const m = this.model
    const f = this.psms.filters
    const index = 'protein' in what ? what.protein : what.peptide
    const count = 'protein' in what ? m.tables.proteins.count : m.tables.peptides.count
    if (!Number.isInteger(index) || index < 0 || index >= count) return
    this.psm = null
    const contaminant = 'protein' in what ? m.protein.contaminant[index] : m.peptide.contaminant[index]
    const decoy = 'protein' in what ? m.tables.proteins.decoy[index] : m.tables.peptides.decoy[index]
    this.psms.filters = {
      ...f,
      text: '',
      maxQ: m.psmFdr,
      maxXlQ: m.xlFdr,
      kind: 'all',
      adduct: '',
      nucleotide: '',
      proteinFilter: 'protein' in what ? index : undefined,
      peptideFilter: 'peptide' in what ? index : undefined,
      hideContaminants: contaminant ? false : f.hideContaminants,
      showDecoys: decoy ? true : f.showDecoys,
    }
    this.tab = 'psms'
  }

  /**
   * Opens PSM `i` (a row of `tables.psms`) in the PSM view, from the PSM table: the PSMs tab with the
   * PSM selected. A filter that hides it is lifted (text, protein and peptide filters, the cutoffs,
   * the kind, adduct and nucleotide filters that exclude it, contaminants or decoys as far as it is one), so that
   * it is a row of the list beside the view.
   */
  openPsm(i: number): void {
    if (!this.#isPsm(i)) return
    const m = this.model
    const ps = m.tables.psms
    const level = this.psms
    if (!level.kept.includes(i)) {
      const f = level.filters
      const xl = ps.xl.isXL[i] === 1
      level.filters = {
        ...f,
        text: '',
        maxQ: m.psmFdr,
        maxXlQ: m.xlFdr,
        kind: f.kind === 'all' || (f.kind === 'xl') === xl ? f.kind : 'all',
        adduct: f.adduct === ps.xl.adduct[i] ? f.adduct : '',
        nucleotide: f.nucleotide === ps.xl.nucleotide[i] ? f.nucleotide : '',
        proteinFilter: undefined,
        peptideFilter: undefined,
        hideContaminants: m.peptide.contaminant[ps.peptide[i]] ? false : f.hideContaminants,
        showDecoys: ps.decoy[i] ? true : f.showDecoys,
      }
    }
    level.selected = i
    this.tab = 'psms'
    // from the PSM view itself (the list beside it), the PSM keeps where it came from
    this.psm = { row: i, origin: this.psm?.origin ?? { kind: 'psms' } }
  }

  /**
   * Opens PSM `i` from the protein panel: a PSM of the open protein's peptide `peptide` (the Peptides
   * tab), or of the protein (`peptide` null: the PSMs tab). The list beside the view is the PSM table
   * with the protein and the peptide as filters (as "Open in PSM table" makes it), at the search's
   * cutoffs and of all kinds; the table gets its filters back when the PSM closes.
   */
  openPsmFromPanel(i: number, peptide: number | null): void {
    const protein = this.panel
    if (!this.#isPsm(i) || protein === null) return
    const m = this.model
    const ps = m.tables.psms
    const level = this.psms
    const restore = this.psm?.origin.kind === 'panel' ? this.psm.origin.restore : { ...level.filters }
    level.filters = {
      ...restore,
      text: '',
      maxQ: m.psmFdr,
      maxXlQ: m.xlFdr,
      kind: 'all',
      adduct: '',
      nucleotide: '',
      proteinFilter: protein,
      peptideFilter: peptide ?? undefined,
      hideContaminants: m.peptide.contaminant[ps.peptide[i]] ? false : restore.hideContaminants,
      showDecoys: ps.decoy[i] ? true : restore.showDecoys,
    }
    level.selected = i
    this.tab = 'psms'
    this.psm = { row: i, origin: { kind: 'panel', protein, peptide, restore } }
  }

  /**
   * Closes the PSM view and says where it came from. Back to the PSM table, the PSM stays selected;
   * back to the protein panel, the PSM table gets its filters back and the Proteins tab shows.
   */
  closePsm(): PsmOrigin | null {
    const open = this.psm
    if (!open) return null
    this.psm = null
    if (open.origin.kind === 'panel') {
      this.psms.filters = open.origin.restore
      this.tab = 'proteins'
    }
    return open.origin
  }

  /** The PSMs before and after the open one in the PSM table as sorted and filtered (null: none). */
  get psmNeighbours(): { prev: number | null; next: number | null; position: number; count: number } {
    const rows = this.psms.rows
    const position = this.psm ? rows.indexOf(this.psm.row) : -1
    return {
      prev: position > 0 ? rows[position - 1] : null,
      next: position >= 0 && position + 1 < rows.length ? rows[position + 1] : null,
      position,
      count: rows.length,
    }
  }

  /** Opens the PSM before (-1) or after (1) the open one, if there is one. */
  stepPsm(direction: 1 | -1): void {
    const { prev, next } = this.psmNeighbours
    const target = direction < 0 ? prev : next
    if (target === null || !this.psm) return
    this.psms.selected = target
    this.psm = { row: target, origin: this.psm.origin }
  }

  #isPsm(i: number): boolean {
    return Number.isInteger(i) && i >= 0 && i < this.model.tables.psms.count
  }

  /** The level of the active tab, or null on Overview, Samples and QC. */
  get level(): LevelState | null {
    return this.tab === 'proteins' || this.tab === 'peptides' || this.tab === 'psms' ? this[this.tab] : null
  }

  /** The design has technical replicates (a sample measured more than once). */
  get hasTechReplicates(): boolean {
    const seen = new Set<string>()
    for (const row of this.result.design.rows) {
      const key = `${row.sample}\0${row.techReplicate}`
      seen.add(key)
    }
    return seen.size > new Set(this.result.design.rows.map((r) => r.sample)).size
  }
}

/** The view of the open result. Its own effect root owns its deriveds, so that they keep working
 * after the component that first asked for it unmounts (the state survives a visit to New search). */
let cached: { view: ResultsView; destroy: () => void } | null = null

/** Releases the view of the open result (its model and caches), e.g. when another result opens. */
export function releaseResultsView(): void {
  cached?.destroy()
  cached = null
}

/** The view state of `result`: the same object while the same result stays open, a new one for another result. */
export function resultsViewFor(result: OpenResult, store: CurationStore | null = curationStoreFor(result.id)): ResultsView {
  if (cached?.view.result !== result) {
    cached?.destroy()
    let view: ResultsView | undefined
    const destroy = $effect.root(() => {
      view = new ResultsView(result, store)
    })
    // (the server build of Svelte, which the unit tests run on, does not run effect roots)
    cached = { view: view ?? new ResultsView(result, store), destroy }
  }
  return cached.view
}
