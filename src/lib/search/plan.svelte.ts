// What the New search form amounts to: the one-line plan, why the search cannot start yet, and starting
// it: the form's values become the shim's search request (paths, OpenNuXL's parameters by the names the
// shim lets through, Percolator, the threads and the search's FDRs).

import type { SearchRequest } from '../desktop'
import { navigate } from '../route.svelte'
import { unknownModifications } from '../settings/modifications'
import { NUXL_PARAMETERS } from '../settings/nuxl'
import { copyValues, requestParameters } from '../settings/parameters'
import { CUSTOM_PROTOCOL, PROTOCOL_PARAMETERS } from '../settings/protocols'
import { boundsMessage, invertedRanges, outOfBounds, rangeMessage } from '../settings/ranges'
import { keepsOpenResult, showFinished } from './finished'
import { CRAP_PROTEINS, searchForm as form } from './form.svelte'
import { runSearch, searchRun } from './session.svelte'
import { toolState } from './tool.svelte'

/** Why the NuXL fields of the adducts do nothing with a protocol: OpenNuXL takes them from the protocol then. */
export const PROTOCOL_HINT = 'The protocol sets this. Choose the protocol “none (custom adducts)” to set it yourself.'

/** OpenNuXL skips Percolator for a run with fewer PSMs than this (it says so in its log). */
export const PERCOLATOR_MIN_PSMS = 1000

function unknownMessage(names: string[]): string {
  return (
    `${names.length === 1 ? 'Unknown modification' : 'Unknown modifications'}: ${names.join(', ')}. ` +
    `OpenMS does not know ${names.length === 1 ? 'this name' : 'these names'}. Choose from the list instead.`
  )
}

class SearchPlan {
  /** The custom protocol ("none"): OpenNuXL takes the nucleotides and adducts from the NuXL fields. */
  customProtocol = $derived(form.value('NuXL:presets') === CUSTOM_PROTOCOL)

  /** Why a parameter does nothing with the other settings (the request leaves it out then); null: it counts. */
  blockedReason(name: string): string | null {
    return !this.customProtocol && (PROTOCOL_PARAMETERS as readonly string[]).includes(name) ? PROTOCOL_HINT : null
  }

  /** "3 files in 2 samples · 20,652 proteins + 116 cRAP + decoys" */
  line = $derived.by(() => {
    const n = form.files.length
    if (n === 0) return form.adding > 0 ? 'Adding files…' : 'No spectra yet'
    const samples = form.design.samples.length
    const parts = [`${n} ${n === 1 ? 'file' : 'files'}${n > 1 ? ` in ${samples} ${samples === 1 ? 'sample' : 'samples'}` : ''}`]
    if (form.database) {
      const proteins = form.database.proteins
      const crap = form.contaminants ? ` + ${CRAP_PROTEINS} cRAP` : ''
      if (form.database.error) parts.push('the database cannot be read')
      else parts.push(proteins === null ? 'counting proteins…' : `${proteins.toLocaleString('en-US')} proteins${crap} + decoys`)
    } else {
      parts.push('no database yet')
    }
    return parts.join(' · ')
  })

  /** The example's note, a line of its own under the plan: what it is, its precursor tolerance, and that Percolator will skip it. */
  note = $derived.by(() => {
    if (!form.isExample) return null
    const tolerance = `${form.value('precursor:mass_tolerance')} ${form.value('precursor:mass_tolerance_unit')}`
    return (
      `OpenMS' test run of OpenNuXL (20 spectra, 5 proteins) with its ${tolerance} precursor tolerance. ` +
      `It has too few PSMs for Percolator, which OpenNuXL skips below ${PERCOLATOR_MIN_PSMS.toLocaleString('en-US')} PSMs.`
    )
  })

  /** Modification names OpenMS does not know. */
  unknownMods = $derived(unknownModifications(form.values, NUXL_PARAMETERS))

  /** Ranges of the settings whose lowest value is above the highest (charges 5–2): marked, and the search waits. */
  inverted = $derived(invertedRanges(form.values))

  /** Settings outside the bounds the form gives them (charges from 1, the longest adduct 0–4, ...): the search waits. */
  outside = $derived(outOfBounds(form.values, NUXL_PARAMETERS))

  /** Why the search cannot start yet. */
  problem = $derived.by(() => {
    if (form.files.length === 0) return 'Add spectra (mzML, .raw or .d) to start.'
    if (form.adding > 0) return 'Adding files…'
    const unsearchable = form.files.filter((r) => r.problem)
    if (unsearchable.length === 1) return `${unsearchable[0].problem} Remove it to start the search.`
    if (unsearchable.length > 1) return `${unsearchable.length} files cannot be searched (see Spectra). Remove them to start the search.`
    const cells = form.invalidCellList
    if (cells.length > 0) {
      const more = cells.length > 1 ? ` (and ${cells.length - 1} more)` : ''
      return `${cells[0].label}${more}: “${cells[0].text}” is not a whole number of at least 1. Correct it, or empty the cell.`
    }
    if (!form.database) return 'Choose a FASTA database to start.'
    if (form.database.error) return `${form.database.file.name} cannot be read (${form.database.error}). Choose it again, or another FASTA file.`
    if (form.database.proteins === null) return 'Counting the proteins of the database…'
    if (form.database.problem) return `${form.database.problem} Choose another FASTA file.`
    if (this.inverted.length > 0) return rangeMessage(this.inverted[0], form.values)
    if (this.outside.length > 0) return boundsMessage(this.outside[0], form.values)
    if (!(Number(form.value('peptideFdr')) > 0)) return 'Set a peptide FDR above 0 %.'
    if (!(Number(form.value('xlFdr')) > 0)) return 'Set a cross-link FDR above 0 %.'
    if (this.unknownMods.length > 0) return unknownMessage(this.unknownMods)
    if (toolState.status === 'failed') return `OpenNuXL cannot be run: ${toolState.error}`
    return null
  })

  /** The problem is shown in the footer (with files; without, the plan line says "No spectra yet"). */
  problemShown = $derived(this.problem !== null && form.files.length > 0)

  canStart = $derived(this.problem === null && searchRun.status !== 'running')
}

export const searchPlan = new SearchPlan()

/** A fraction in (0, 1] (an FDR of the form; anything else is 1 %, which the problem line does not let through). */
function fraction(value: unknown): number {
  const n = Number(value)
  return n > 0 && n <= 1 ? n : 0.01
}

/**
 * The shim's request for the form: the files and the database by path, OpenNuXL's parameters that differ from its
 * defaults (by the names of the shim's allowlist; those of the adducts only with the custom protocol), Percolator,
 * the threads (0: all cores) and the FDRs of the peptide and the cross-link PSMs (fractions, never parameters).
 * Null without files or database.
 */
export function searchRequest(): SearchRequest | null {
  if (!form.database || form.files.length === 0) return null
  const values = $state.snapshot(form.values) as Record<string, unknown>
  const parameters = requestParameters(values, NUXL_PARAMETERS)
  if (!searchPlan.customProtocol) for (const name of PROTOCOL_PARAMETERS) delete parameters[name]
  return {
    files: form.files.map((r) => ({ id: r.id, path: r.file.path })),
    database: form.database.file.path,
    contaminants: form.contaminants,
    settings: {
      parameters: parameters as SearchRequest['settings']['parameters'],
      rescore: form.rescore,
      threads: form.threads ?? 0,
      peptideFdr: fraction(values.peptideFdr),
      xlFdr: fraction(values.xlFdr),
    },
  }
}

/** Starts the search of the form; on success, opens its result (or says it finished: `showFinished`). */
export async function startSearch(): Promise<void> {
  const request = searchRequest()
  if (!searchPlan.canStart || !request || !form.database) return
  const values = $state.snapshot(form.values) as Record<string, unknown>
  const { peptideFdr, xlFdr } = request.settings
  const id = await runSearch(request, {
    design: $state.snapshot(form.design),
    // (OpenNuXL has no protein FDR: every protein of the PSMs within their FDRs counts)
    psmFdr: peptideFdr,
    proteinFdr: 1,
    settings: {
      parameters: request.settings.parameters,
      fixedMods: (values['modifications:fixed'] as string[] | undefined) ?? [],
      database: form.database.file.name,
      rescore: request.settings.rescore,
      contaminants: form.contaminants,
      presetId: form.presetId,
      peptideFdr,
      xlFdr,
    },
  }, keepsOpenResult)
  if (id !== null) showFinished(id)
}

/**
 * New search still holds the inputs of `result`: the same files, by name and order, and the same
 * database. It can then search them again with other settings. A result from History or a project
 * file has no files of its own, so it qualifies only when New search holds them again.
 */
export function canSearchAgain(result: { design: { rows: { fileName: string }[] }; settings: { database: string } }): boolean {
  const rows = result.design.rows
  return (
    form.database?.file.name === result.settings.database &&
    form.files.length === rows.length &&
    form.files.every((r, i) => r.file.name === rows[i].fileName)
  )
}

/**
 * Back to New search with the inputs and settings of `result`, changed by `changes` (parameters by name, or the
 * FDRs: e.g. { xlFdr: 0.05 }). The user starts the search there.
 */
export function searchAgain(
  result: {
    settings: { presetId?: string; parameters: Record<string, unknown>; rescore: boolean; contaminants: boolean; peptideFdr?: number; xlFdr?: number }
  },
  changes: Record<string, unknown> = {},
): void {
  const s = result.settings
  if (s.presetId !== undefined && form.presets.some((p) => p.id === s.presetId)) form.presetId = s.presetId
  const fdrs = Object.fromEntries((['peptideFdr', 'xlFdr'] as const).filter((k) => typeof s[k] === 'number').map((k) => [k, s[k]]))
  form.overrides = copyValues({ ...s.parameters, ...fdrs, ...changes })
  form.rescore = s.rescore
  form.contaminants = s.contaminants
  navigate({ view: 'search' })
}
