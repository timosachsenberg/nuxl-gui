// The New search form: files with their design fields, the database, the settings (OpenNuXL's parameters and the
// search's FDRs) and the rescoring switch. Kept outside the view so that it survives a visit to another view. Files are paths (the
// system's dialog, drag and drop, the example), never read by the page: the shim's `inspect_files`
// gives their sizes and counts.

import { resolveDesign, type DesignInput } from '../design/model'
import type { DesignFields, DesignUpdate } from '../design/paste'
import { errorText, exampleFiles, inspectFiles, type FileFacts, type InputFile } from '../desktop'
import { NUXL_PARAMETERS } from '../settings/nuxl'
import { changedParameters, copyValue, copyValues, defaultsOf, sameValue, SEARCH_SETTINGS, type ParamEntry } from '../settings/parameters'
import { BUILTIN_PRESETS, DEFAULT_PRESET_ID, deletePreset, loadPresets, renamePreset, savePreset, type Preset } from '../settings/presets'
import { CUSTOM_PROTOCOL, PROTOCOL_PARAMETERS, protocolParameters } from '../settings/protocols'
import { formatBytes } from '../format/bytes'
import { isFasta, isMzML, unsearchableReason } from './files'

export type FileRow = DesignFields & {
  id: string
  file: InputFile
  /** From the mzML header; null if the header does not say. */
  spectra: number | null
  /** Why OpenNuXL cannot search the file (cut off, not mzML, no spectra: `FileFacts.problem`); the search cannot start. */
  problem: string | null
}

/**
 * The database: its proteins and residues once counted (null while counting), or why it could not be
 * read (`error`), or why OpenNuXL cannot search it (`problem`: no entries, an accession twice, ...); the search
 * cannot start with either. `warnings`: what the search treats specially (a FASTA's entries listed twice, searched once).
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
 * The example: OpenMS' test run of OpenNuXL (OpenNuXL_1_input.mzML: 20 MS2 spectra of a UV cross-linked
 * protein–RNA sample) against its five proteins (OpenNuXL_1_input.fasta; targets only: OpenNuXL makes the decoys), one
 * run of condition "example". Its own settings (`settings`), which go back to the preset's when the example is left
 * (`#leaveExample`): the precursor tolerance of OpenMS' test (10 ppm; OpenNuXL's default is 6 ppm). Everything else
 * is the preset's.
 */
export const EXAMPLE = {
  names: ['OpenNuXL_1_input.mzML'],
  fasta: 'OpenNuXL_1_input.fasta',
  condition: 'example',
  settings: [{ label: 'precursor tolerance', parameters: { 'precursor:mass_tolerance': 10, 'precursor:mass_tolerance_unit': 'ppm' } }],
} as const

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
  /** The parameters set by the preset and the user, on top of the defaults. */
  overrides = $state<Record<string, unknown>>(
    copyValues(BUILTIN_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!.parameters),
  )
  /** Percolator (`settings.rescore`). */
  rescore = $state(true)
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
   * The example's own settings that are in force and unchanged, by their labels ('precursor tolerance'): leaving the example gives them back to the preset's (Start over's tooltip says so); one the user set since
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

  /** OpenNuXL's parameters by name (generated from the OpenMS pin). */
  entries = new Map(NUXL_PARAMETERS.map((e) => [e.name, e]))
  /** OpenNuXL's defaults, and those of the search's own settings (the FDRs). */
  defaults: Record<string, unknown> = { ...defaultsOf(NUXL_PARAMETERS), ...SEARCH_SETTINGS }
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
  }

  /**
   * The cross-linking protocol (`NuXL:presets`). The custom one ("none") starts from the protocol chosen before: its
   * nucleotides and adducts go into the NuXL fields, unless the user has set those fields already.
   */
  setProtocol(name: string) {
    const before = String(this.values['NuXL:presets'])
    this.setParam('NuXL:presets', name)
    if (name !== CUSTOM_PROTOCOL) return
    const from = protocolParameters(before)
    if (!from) return
    const untouched = PROTOCOL_PARAMETERS.every((p) => sameValue(this.values[p], this.defaults[p]))
    if (untouched) for (const [p, v] of Object.entries(from)) this.setParam(p, v)
  }

  /** Saves the settings that differ from the defaults (OpenNuXL's, and the FDRs') as a user preset and selects it. */
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
   * Adds mzML files (by path) to the table; a FASTA becomes the database; anything else is reported (compressed
   * mzML and Thermo .raw files with what to do instead). A path that is in the table already (or twice in `paths`) is
   * added once: the same file would be searched twice, as two samples. Files OpenNuXL cannot search (cut off, not
   * mzML) join the table marked, and the search cannot start with them. Resolves when the rows are there.
   */
  async addFiles(paths: Iterable<string>) {
    const list = [...paths]
    const skipped = list.filter((p) => !isMzML(fileName(p)) && !isFasta(fileName(p))).map(fileName)
    const notices = unsearchableReason(skipped)
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
    this.notices.push(...notices)
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
   * example's own (its precursor tolerance), which go back to the preset's. Undo brings everything back.
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
   * The example's files are gone or joined by others: its own settings go back to the preset's (or OpenNuXL's
   * defaults), each group unless the user changed it since (then it is the user's: a tolerance and its unit go
   * together). Returns the example's values it replaced.
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

  /** Loads the example (its run and FASTA, its own settings) in place of the current files. */
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
      // the example's own settings (its precursor tolerance), whatever they were
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
