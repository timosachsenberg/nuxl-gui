// The New search form: files with their design fields, the database, the settings and the rescoring
// switches. Kept outside the view so that it survives a visit to another view. Files are paths (the
// system's dialog, drag and drop, the example), never read by the page: the shim's `inspect_files`
// gives their sizes and counts.

import { resolveDesign, type DesignInput } from '../design/model'
import type { DesignFields, DesignUpdate } from '../design/paste'
import { errorText, exampleFiles, inspectFiles, type FileFacts, type InputFile } from '../desktop'
import { changedParameters, copyValue, copyValues, defaultsOf, sameValue, type ParamEntry } from '../settings/parameters'
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, deletePreset, loadPresets, renamePreset, savePreset, type Preset } from '../settings/presets'
import { PROSE_PARAMETERS } from '../settings/prose'
import { formatBytes } from '../format/bytes'
import { formatPercent } from '../format/fdr'
import { isFasta, isMzML } from './files'

export type FileRow = DesignFields & {
  id: string
  file: InputFile
  /** From the mzML header; null if the header does not say. */
  spectra: number | null
  /** Why ProSE cannot search the file (cut off, not mzML, no spectra: `FileFacts.problem`); the search cannot start. */
  problem: string | null
}

/**
 * The database: its proteins and residues once counted (null while counting), or why it could not be
 * read (`error`), or why ProSE cannot search it (`problem`: no entries, an accession twice, ...); the search
 * cannot start with either. `warnings`: what ProSE treats specially (a FASTA's entries listed twice, searched once).
 */
export type DatabaseChoice = {
  file: InputFile
  proteins: number | null
  residues: number | null
  error: string | null
  problem: string | null
  warnings: string[]
}

/** A cell of the design table whose text is not valid (`DesignCell`): the search cannot start until it is corrected. */
export type InvalidCell = { row: string; label: string; text: string }

/** The entries of the bundled cRAP FASTA (`src-tauri/resources/fasta/crap.fasta`), and their residues. */
export const CRAP_PROTEINS = 116
export const CRAP_RESIDUES = 38459

/**
 * The example: OpenMS' small E. coli run (Ecoli_MS2_small.mzML: LTQ Orbitrap XL, CID, 139 MS2 spectra) searched
 * twice as two replicates of condition "example", against the E. coli K-12 proteins (targets only: ProSE makes
 * the decoys). The shim gives the bundled run under the two names. Its own settings (`settings`), each group of
 * which goes back to the preset's on its own when the example is left (`#leaveExample`): its fragments are measured
 * in the ion trap, so the fragment tolerance is 0.5 Da; the run is too small for a PSM FDR of 1 %: Percolator's
 * q-values are (decoys + 1) / targets, so its ~80 PSMs reach 1.2 % at best (and none passes 1 %), and the PSM FDR is
 * 2 %; it is too small for a protein FDR as well (about 60 proteins: none would pass 1 %), so the protein FDR is off
 * (0) and its proteins are listed without one. Everything else is the preset's.
 */
export const EXAMPLE = {
  names: ['Ecoli_1.mzML', 'Ecoli_2.mzML'],
  fasta: 'Ecoli_K12_proteome.fasta',
  condition: 'example',
  settings: [
    { label: 'fragment tolerance', parameters: { 'fragment:mass_tolerance': 0.5, 'fragment:mass_tolerance_unit': 'Da' } },
    { label: 'PSM FDR', parameters: { 'FDR:PSM': 0.02 } },
    { label: 'protein FDR', parameters: { 'FDR:protein': 0 } },
  ],
} as const

/**
 * The notice for a preset that searches without decoys (decoys 'ignore') but has an FDR: the FDR is off then (the form
 * shows it off and sends none, `searchPlan.fdrBlocked`); null for any other preset.
 */
export function noFdrNotice(preset: Preset): string | null {
  const p = preset.parameters
  if (p.decoys !== 'ignore') return null
  const fdrs = (
    [
      ['PSM FDR', p['FDR:PSM']],
      ['protein FDR', p['FDR:protein']],
    ] as const
  ).filter(([, v]) => typeof v === 'number' && v > 0)
  if (fdrs.length === 0) return null
  const named = fdrs.map(([name, v]) => `${name} of ${formatPercent(v as number)}`).join(' and ')
  return (
    `The preset “${preset.name}” searches without decoys, so its ${named} ${fdrs.length === 1 ? 'is' : 'are'} off: ` +
    'ProSE cannot estimate an FDR without decoys. Choose other decoys under Protein database to control the FDR.'
  )
}

/** What "Remove all" or "Start over" removed: the rows, the database (Start over), the notices, the example's settings. */
export type Removed = {
  files: FileRow[]
  database: DatabaseChoice | null
  notices: string[]
  /** The example's settings the removal replaced, and the values it put in (Undo restores only over those). */
  parameters: Record<string, unknown>
  replacedWith: Record<string, unknown>
}

/** The name of a path's file (either separator). */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

let nextId = 0

function toInput(row: FileRow): DesignInput {
  return {
    id: row.id,
    fileName: row.file.name,
    fileSize: row.file.size,
    condition: row.condition,
    replicate: row.replicate,
    fraction: row.fraction,
    techReplicate: row.techReplicate,
  }
}

class SearchForm {
  files = $state<FileRow[]>([])
  database = $state<DatabaseChoice | null>(null)
  contaminants = $state(true)
  presets = $state<Preset[]>(loadPresets())
  presetId = $state(DEFAULT_PRESET_ID)
  /** The parameters set by the preset and the user, on top of ProSE's defaults. */
  overrides = $state<Record<string, unknown>>(
    copyValues(BUILTIN_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!.parameters),
  )
  rescore = $state(true)
  peptdeep = $state(false)
  /** The design table shows Tech. replicate, Fraction group and Sample. */
  advanced = $state(false)
  /** What adding, pasting or loading could not use. */
  notices = $state<string[]>([])
  exampleLoading = $state(false)
  /** Paths being inspected (the rows come when their sizes and counts are known). */
  adding = $state(0)
  /** The paths of the files being inspected (one that is added again meanwhile is the same file). */
  #pending = new Set<string>()
  /** The cells of the design table whose text is not valid, by row and column. */
  invalidCells = $state<Record<string, InvalidCell>>({})
  /** Files are being added or the example is loading: Remove all and Start over wait. */
  busy = $derived(this.adding > 0 || this.exampleLoading)
  /** What the last "Remove all" or "Start over" removed, for its Undo (until files or a database are chosen again). */
  removed = $state<Removed | null>(null)
  /** The example's settings (EXAMPLE.settings) are in force: set by loadExample (or an Undo), the example's files still there. */
  #exampleSettings = $state(false)
  /**
   * The example's own settings that are in force and unchanged, by their labels ('fragment tolerance', 'PSM FDR', 'protein
   * FDR'): leaving the example gives them back to the preset's (Start over's tooltip says so); one the user set since
   * stays (`#leaveExample`).
   */
  get exampleSettingsInForce(): string[] {
    if (!this.#exampleSettings) return []
    return EXAMPLE.settings.filter((group) => this.#holds(group.parameters)).map((group) => group.label)
  }

  /** The values of `parameters` are the form's. */
  #holds(parameters: Record<string, unknown>): boolean {
    return Object.entries(parameters).every(([name, value]) => sameValue(this.values[name], value))
  }

  /** Threads of the search (Advanced); null: all cores. */
  threads = $state<number | null>(null)
  /** The Advanced area of the settings is open. */
  advancedSettings = $state(false)

  /** ProSE's parameters by name (generated from the pinned tool). */
  entries = new Map(PROSE_PARAMETERS.map((e) => [e.name, e]))
  defaults: Record<string, unknown> = defaultsOf(PROSE_PARAMETERS)
  values = $derived<Record<string, unknown>>({ ...this.defaults, ...this.overrides })
  design = $derived(resolveDesign(this.files.map(toInput)))
  /** The files and the database are the bundled example's. */
  isExample = $derived(
    this.files.length === EXAMPLE.names.length &&
      this.files.every((r, i) => r.file.name === EXAMPLE.names[i]) &&
      this.database?.file.name === EXAMPLE.fasta,
  )
  preset = $derived(this.presets.find((p) => p.id === this.presetId) ?? null)
  /** The parameters whose values differ from the preset's. */
  modifiedNames = $derived.by(() => {
    const preset = this.preset?.parameters ?? {}
    return Object.keys({ ...preset, ...this.overrides }).filter(
      (name) => !sameValue(this.values[name], name in preset ? preset[name] : this.defaults[name]),
    )
  })
  /** The settings differ from the preset's. */
  modified = $derived(this.modifiedNames.length > 0)
  /**
   * The user changed settings of the preset: another preset would discard them (the example's own settings
   * in force are not the user's, and go with its files anyway).
   */
  get edited(): boolean {
    const example = new Set(
      EXAMPLE.settings.filter((g) => this.exampleSettingsInForce.includes(g.label)).flatMap((g) => Object.keys(g.parameters)),
    )
    return this.modifiedNames.some((name) => !example.has(name))
  }
  /** The cells of the design table that are not valid, of rows that are there, in table order. */
  get invalidCellList(): InvalidCell[] {
    const order = new Map(this.files.map((r, i) => [r.id, i]))
    return Object.values(this.invalidCells)
      .filter((c) => order.has(c.row))
      .sort((a, b) => order.get(a.row)! - order.get(b.row)!)
  }

  entry(name: string): ParamEntry | undefined {
    return this.entries.get(name)
  }

  value<T = unknown>(name: string): T {
    return this.values[name] as T
  }

  setParam(name: string, value: unknown) {
    this.overrides[name] = copyValue(value)
  }

  choosePreset(id: string) {
    const preset = this.presets.find((p) => p.id === id)
    if (!preset) return
    this.#exampleSettings = false
    this.presetId = id
    this.overrides = copyValues(preset.parameters)
    const notice = noFdrNotice(preset)
    if (notice) this.notices.push(notice)
  }

  /** Saves the settings that differ from ProSE's defaults as a user preset and selects it. */
  saveAsPreset(name: string): Preset {
    // (the settings become the user's own: the example's no longer go back when its files go)
    this.#exampleSettings = false
    const preset = savePreset(name, changedParameters($state.snapshot(this.values), this.defaults))
    this.presets = loadPresets()
    this.presetId = preset.id
    this.overrides = copyValues(preset.parameters)
    return preset
  }

  /** Renames the user preset `id` (the settings stay as they are). */
  renamePreset(id: string, name: string) {
    renamePreset(id, name)
    this.presets = loadPresets()
  }

  /**
   * Deletes the user preset `id`. The settings stay as they are; the preset they are shown against becomes the
   * default one if it was the deleted one (they are then "modified" if they differ from it).
   */
  deletePreset(id: string) {
    deletePreset(id)
    this.presets = loadPresets()
    if (this.presetId === id) this.presetId = DEFAULT_PRESET_ID
  }

  /** Marks the cell `column` of row `row` as not valid with `text` (`label` names it), or as valid (null). */
  setInvalidCell(row: string, column: string, label: string, text: string | null) {
    const key = `${row}\0${column}`
    if (text === null) {
      if (key in this.invalidCells) delete this.invalidCells[key]
    } else if (this.invalidCells[key]?.text !== text) {
      this.invalidCells[key] = { row, label, text }
    }
  }


  /**
   * Adds mzML files (by path) to the table; a FASTA becomes the database; anything else is reported. A path
   * that is in the table already (or twice in `paths`) is added once: the same file would be searched twice, as
   * two samples. Files ProSE cannot search (cut off, not mzML) join the table marked, and the search cannot
   * start with them. Resolves when the rows are there.
   */
  async addFiles(paths: Iterable<string>) {
    const list = [...paths]
    const skipped = list.filter((p) => !isMzML(fileName(p)) && !isFasta(fileName(p))).map(fileName)
    const database = list.filter((p) => isFasta(fileName(p))).pop()
    const listed = new Set([...this.files.map((r) => r.file.path), ...this.#pending])
    const spectra: string[] = []
    const again: string[] = []
    for (const p of list.filter((p) => isMzML(fileName(p)))) {
      if (listed.has(p)) again.push(fileName(p))
      else {
        listed.add(p)
        spectra.push(p)
      }
    }
    if (skipped.length > 0) {
      this.notices.push(
        `Not an mzML file: ${skipped.join(', ')}. Convert vendor files to mzML first, e.g. with ProteoWizard msconvert.`,
      )
    }
    if (again.length > 0) {
      const names = [...new Set(again)]
      this.notices.push(
        names.length === 1
          ? `${names[0]} is in the list already, so it was not added again: one file is searched once.`
          : `${names.join(', ')} are in the list already, so they were not added again: one file is searched once.`,
      )
    }
    if (database !== undefined) void this.setDatabase(database)
    if (spectra.length === 0) return
    this.adding++
    for (const p of spectra) this.#pending.add(p)
    try {
      const facts = await inspectFiles(spectra)
      const unreadable = facts.filter((f) => f.error !== null)
      // (rows join: the example's settings end, an Undo of a removal is no longer offered)
      if (facts.some((f) => f.error === null)) {
        this.#leaveExample()
        this.removed = null
      }
      for (const f of facts) if (f.error === null) this.#addRow(f, {})
      if (unreadable.length > 0) this.notices.push(...unreadable.map((f) => `${f.name}: ${f.error}`))
    } catch (e) {
      this.notices.push(`The files could not be added (${errorText(e)}).`)
    } finally {
      for (const p of spectra) this.#pending.delete(p)
      this.adding--
    }
  }

  #addRow(facts: FileFacts, fields: DesignFields) {
    const id = `f${++nextId}`
    const file: InputFile = { path: facts.path, name: facts.name, size: facts.size }
    this.files.push({ id, file, spectra: facts.spectra, problem: facts.problem ?? null, ...fields })
  }

  removeFile(id: string) {
    this.files = this.files.filter((r) => r.id !== id)
    this.#leaveExample()
  }

  /** "Remove all" of the Spectra card: no files, and none of the notices about them (Undo brings them back). */
  removeAllFiles() {
    if (this.busy) return
    this.#remove(false)
  }

  /**
   * "Start over": no files and no database; the settings (preset, parameters, rescoring) as they are, but for the
   * example's own (its fragment tolerance, its PSM and protein FDR), which go back to the preset's. Undo brings everything back.
   */
  startOver() {
    if (this.busy) return
    this.#remove(true)
  }

  /**
   * A removal whose Undo is still offered is part of the next one: "Remove all" then "Start over" removed the
   * files and then the database, and Undo brings back both.
   */
  #remove(database: boolean) {
    const earlier = this.removed
    const left = this.#leaveExampleWithUndo()
    const removed: Removed = {
      files: [...(earlier?.files ?? []), ...this.files],
      database: (database ? this.database : null) ?? earlier?.database ?? null,
      notices: [...(earlier?.notices ?? []), ...this.notices],
      // (the example's values that the earlier removal replaced are those to bring back)
      parameters: { ...left.parameters, ...earlier?.parameters },
      replacedWith: { ...left.replacedWith, ...earlier?.replacedWith },
    }
    if (removed.files.length > 0 || removed.database) this.removed = removed
    this.files = []
    this.notices = []
    if (database) this.database = null
  }

  /** Undo of the last "Remove all" or "Start over". */
  undoRemove() {
    const r = this.removed
    if (!r || this.busy) return
    this.removed = null
    this.files = [...r.files, ...this.files]
    this.notices = r.notices
    if (r.database) {
      this.database = r.database
      // a database whose count the removal cut short is counted again
      if (r.database.proteins === null && r.database.error === null) void this.setDatabase(r.database.file.path, { example: true })
    }
    // the example's settings come back, each group unless the user set others since the removal
    for (const group of EXAMPLE.settings) {
      const names = Object.keys(group.parameters).filter((name) => name in r.parameters)
      if (names.length === 0 || !names.every((name) => sameValue(this.values[name], r.replacedWith[name]))) continue
      for (const name of names) this.overrides[name] = copyValue(r.parameters[name])
      this.#exampleSettings = true
    }
  }

  /** `#leaveExample` for a removal: the example's values it replaced and what it put in their place. */
  #leaveExampleWithUndo(): { parameters: Record<string, unknown>; replacedWith: Record<string, unknown> } {
    const parameters = this.#leaveExample()
    const replacedWith = Object.fromEntries(Object.keys(parameters).map((name) => [name, copyValue(this.values[name])]))
    return { parameters, replacedWith }
  }

  /**
   * The example's files are gone or joined by others: its own settings go back to the preset's (or ProSE's
   * defaults), each group unless the user changed it since (then it is the user's: a tolerance and its unit go
   * together, each FDR on its own). Returns the example's values it replaced.
   */
  #leaveExample(): Record<string, unknown> {
    if (!this.#exampleSettings) return {}
    this.#exampleSettings = false
    const preset = this.preset?.parameters ?? {}
    const replaced: Record<string, unknown> = {}
    for (const group of EXAMPLE.settings) {
      if (!this.#holds(group.parameters)) continue
      for (const [name, value] of Object.entries(group.parameters)) {
        replaced[name] = value
        if (name in preset) this.overrides[name] = copyValue(preset[name])
        else delete this.overrides[name]
      }
    }
    return replaced
  }

  setField<K extends keyof DesignFields>(id: string, field: K, value: DesignFields[K]) {
    const row: DesignFields | undefined = this.files.find((r) => r.id === id)
    if (row) row[field] = value
  }

  /** Pasted or loaded design fields for rows of the table. */
  applyUpdates(updates: DesignUpdate[]) {
    for (const { index, fields } of updates) {
      const row = this.files[index]
      if (row) Object.assign(row, fields)
    }
  }

  /**
   * Chooses the FASTA at `path` as the database; its proteins and residues are counted by the shim. Another
   * database than the example's ends the example's settings.
   */
  async setDatabase(path: string, options: { example?: boolean } = {}) {
    if (!options.example) this.#leaveExample()
    this.removed = null
    const file: InputFile = { path, name: fileName(path), size: 0 }
    const choice: DatabaseChoice = { file, proteins: null, residues: null, error: null, problem: null, warnings: [] }
    this.database = choice
    let error: string | null = null
    let facts: FileFacts | null = null
    try {
      facts = (await inspectFiles([path]))[0]
      error = facts.error
    } catch (e) {
      error = errorText(e)
    }
    // (another database may have been chosen meanwhile)
    if (this.database?.file.path !== path) return
    // (without a final period: it goes into the app's own sentence)
    if (error !== null || !facts) this.database = { ...choice, error: (error ?? 'unknown').replace(/\.$/, '') }
    else
      this.database = {
        file: { ...file, size: facts.size },
        proteins: facts.proteins,
        residues: facts.residues,
        error: null,
        problem: facts.problem ?? null,
        warnings: facts.warnings ?? [],
      }
  }

  /** Loads the example (two replicates of one file and its FASTA, its own settings) in place of the current files. */
  async loadExample() {
    if (this.exampleLoading) return
    this.exampleLoading = true
    try {
      const example = await exampleFiles()
      const facts = await inspectFiles(example.spectra)
      const broken = facts.find((f) => f.error !== null)
      if (broken) throw new Error(broken.error!)
      this.files = []
      this.notices = []
      this.removed = null
      for (const f of facts) this.#addRow(f, { condition: EXAMPLE.condition })
      void this.setDatabase(example.database, { example: true })
      // the example's own settings (its fragment tolerance, the protein FDR off), whatever they were
      for (const group of EXAMPLE.settings) for (const [name, value] of Object.entries(group.parameters)) this.setParam(name, value)
      this.#exampleSettings = true
    } catch (e) {
      this.notices.push(`The example could not be loaded (${errorText(e).replace(/\.$/, '')}).`)
    } finally {
      this.exampleLoading = false
    }
  }

  /** "6 files · 1.9 GB" */
  get filesLine(): string {
    const bytes = this.files.reduce((sum, r) => sum + r.file.size, 0)
    return `${this.files.length} ${this.files.length === 1 ? 'file' : 'files'} · ${formatBytes(bytes)}`
  }
}

export const searchForm = new SearchForm()
