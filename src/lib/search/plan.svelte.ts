// What the New search form amounts to: the one-line plan, why the search cannot start yet, and starting
// it: the form's values become the shim's search request (paths, ProSE's parameters by the names the
// shim lets through, the rescoring switches, the threads).

import type { SearchRequest } from '../desktop'
import { navigate } from '../route.svelte'
import { unknownModifications } from '../settings/modifications'
import { copyValues, requestParameters } from '../settings/parameters'
import { DECOY_LABELS } from '../settings/labels'
import { PROSE_PARAMETERS } from '../settings/prose'
import { boundsMessage, invertedRanges, outOfBounds, rangeMessage } from '../settings/ranges'
import { keepsOpenResult, showFinished } from './finished'
import { CRAP_PROTEINS, searchForm as form } from './form.svelte'
import { runSearch, searchRun } from './session.svelte'
import { toolState } from './tool.svelte'

/** The FDR parameters, which a search without decoys does not send (src-tauri/src/args.rs `FDR_PARAMETERS`). */
export const FDR_PARAMETERS = ['FDR:PSM', 'FDR:protein', 'FDR:protein_inference_PSM'] as const

/** Why the FDR fields are off and disabled without decoys. */
export const NO_FDR_HINT = `No FDR without decoys: choose “${DECOY_LABELS.auto}” or “${DECOY_LABELS.generate}” to control the FDR.`

function unknownMessage(names: string[]): string {
  return (
    `${names.length === 1 ? 'Unknown modification' : 'Unknown modifications'}: ${names.join(', ')}. ` +
    `ProSE does not know ${names.length === 1 ? 'this name' : 'these names'}. Choose from the list instead.`
  )
}

class SearchPlan {
  /** PeptDeep features need Percolator and a ProSE with ONNX Runtime (unknown while the tool is asked). */
  peptdeep = $derived(form.rescore && form.peptdeep && (toolState.info?.onnx ?? true))

  /**
   * Without decoys (decoys 'ignore', the database card's "None") ProSE cannot estimate an FDR and would skip a PSM or
   * protein FDR with only a warning in its log: the FDR fields are off and disabled then, and the request sends none
   * (`FDR_PARAMETERS`; the shim leaves them out too). The values stay for when the decoys come back.
   */
  fdrBlocked = $derived(form.value('decoys') === 'ignore')

  /** ProSE looks for co-isolated precursors (chimeric:enabled) only without database chunks; it ignores the switch then. */
  chimericBlocked = $derived(Number(form.value('database:chunk_size')) > 0)

  /** "6 files in 3 samples · 20,652 proteins + 116 cRAP + decoys" */
  line = $derived.by(() => {
    const n = form.files.length
    if (n === 0) return form.adding > 0 ? 'Adding files…' : 'No spectra yet'
    const samples = form.design.samples.length
    const parts = [`${n} ${n === 1 ? 'file' : 'files'}${n > 1 ? ` in ${samples} ${samples === 1 ? 'sample' : 'samples'}` : ''}`]
    if (form.database) {
      const proteins = form.database.proteins
      const decoys = form.value('decoys') === 'ignore' ? '' : ' + decoys'
      const crap = form.contaminants ? ` + ${CRAP_PROTEINS} cRAP` : ''
      if (form.database.error) parts.push('the database cannot be read')
      else parts.push(proteins === null ? 'counting proteins…' : `${proteins.toLocaleString('en-US')} proteins${crap}${decoys}`)
    } else {
      parts.push('no database yet')
    }
    return parts.join(' · ')
  })

  /**
   * The example's note, a line of its own under the plan (it wraps): its tolerance, its PSM FDR (2 %: Percolator's
   * (decoys + 1) / targets keeps a run this small above 1 %) and its protein FDR (off unless the user set one), and why
   * its results list the proteins without a protein FDR and say that Percolator fell back.
   */
  note = $derived.by(() => {
    if (!form.isExample) return null
    const tolerance = `${form.value('fragment:mass_tolerance')} ${form.value('fragment:mass_tolerance_unit')}`
    const psmFdr = `${Number((Number(form.value('FDR:PSM')) * 100).toPrecision(6))} %`
    return Number(form.value('FDR:protein')) > 0
      ? `Ion-trap example with a ${tolerance} fragment tolerance and a ${psmFdr} PSM FDR. ` +
          "The run is too small for 1 %, for a protein FDR and for Percolator's full model."
      : `Ion-trap example with a ${tolerance} fragment tolerance, a ${psmFdr} PSM FDR and no protein FDR: ` +
          "the run is too small for 1 % and for a protein FDR. It has too few PSMs for Percolator's full model."
  })

  /** Modification names ProSE does not know. */
  unknownMods = $derived(unknownModifications(form.values, PROSE_PARAMETERS))

  /** Ranges of the settings whose lowest value is above the highest (charges 5–2): marked, and the search waits. */
  inverted = $derived(invertedRanges(form.values))

  /** Settings outside the bounds ProSE gives them (charges 1–20, ...): ProSE would refuse them, so the search waits. */
  outside = $derived(outOfBounds(form.values, PROSE_PARAMETERS))

  /** Why the search cannot start yet. */
  problem = $derived.by(() => {
    if (form.files.length === 0) return 'Add mzML files to start.'
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
    if (!this.fdrBlocked && !(Number(form.value('FDR:PSM')) > 0)) return 'Set a PSM FDR above 0 %.'
    if (this.unknownMods.length > 0) return unknownMessage(this.unknownMods)
    if (toolState.status === 'failed') return `ProSE cannot be run: ${toolState.error}`
    return null
  })

  /** The problem is shown in the footer (with files; without, the plan line says "No spectra yet"). */
  problemShown = $derived(this.problem !== null && form.files.length > 0)

  canStart = $derived(this.problem === null && searchRun.status !== 'running')
}

export const searchPlan = new SearchPlan()

/**
 * The shim's request for the form: the files and the database by path, the parameters that differ
 * from ProSE's defaults (by the names of the shim's allowlist), the rescoring switches and the threads
 * (0: all cores). Null without files or database.
 */
export function searchRequest(): SearchRequest | null {
  if (!form.database || form.files.length === 0) return null
  const values = $state.snapshot(form.values) as Record<string, unknown>
  const parameters = requestParameters(values, form.defaults)
  if (searchPlan.chimericBlocked) delete parameters['chimeric:enabled']
  if (searchPlan.fdrBlocked) for (const name of FDR_PARAMETERS) delete parameters[name]
  return {
    files: form.files.map((r) => ({ id: r.id, path: r.file.path })),
    database: form.database.file.path,
    contaminants: form.contaminants,
    settings: {
      parameters,
      rescore: form.rescore,
      peptdeep: searchPlan.peptdeep,
      threads: form.threads ?? 0,
    },
  }
}

/** Starts the search of the form; on success, opens its result (or says it finished: `showFinished`). */
export async function startSearch(): Promise<void> {
  const request = searchRequest()
  if (!searchPlan.canStart || !request || !form.database) return
  const values = $state.snapshot(form.values) as Record<string, unknown>
  const id = await runSearch(request, {
    design: $state.snapshot(form.design),
    // no FDR (a search without decoys; the protein FDR off, 0): no cutoff, every PSM or protein counts (the results'
    // cutoffs are q-values above 0)
    psmFdr: searchPlan.fdrBlocked ? 1 : Number(values['FDR:PSM']),
    proteinFdr: searchPlan.fdrBlocked ? 1 : Number(values['FDR:protein']) || 1,
    settings: {
      parameters: request.settings.parameters,
      fixedMods: (values['modifications:fixed'] as string[] | undefined) ?? [],
      database: form.database.file.name,
      rescore: request.settings.rescore,
      peptdeep: request.settings.peptdeep,
      contaminants: form.contaminants,
      presetId: form.presetId,
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
 * Back to New search with the inputs and settings of `result`, changed by `changes` (parameters,
 * e.g. { 'FDR:protein': 0.05 }). The user starts the search there.
 */
export function searchAgain(
  result: { settings: { presetId?: string; parameters: Record<string, unknown>; rescore: boolean; peptdeep: boolean; contaminants: boolean } },
  changes: Record<string, unknown>,
): void {
  const s = result.settings
  if (s.presetId !== undefined && form.presets.some((p) => p.id === s.presetId)) form.presetId = s.presetId
  form.overrides = copyValues({ ...s.parameters, ...changes })
  form.rescore = s.rescore
  form.peptdeep = s.peptdeep
  form.contaminants = s.contaminants
  navigate({ view: 'search' })
}
