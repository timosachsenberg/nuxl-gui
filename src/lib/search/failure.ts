// An error of a search for people: where it happened (the stage and file of the last progress report)
// and what happened, led by how OpenNuXL ended (a crash's signal, an exit code), with its last lines on
// stderr (or OpenMS' own text) as a secondary detail and the path of the kept log. OpenNuXL runs once per input
// file, so the file of the last report is where it happened. After a run of a Thermo .raw or Bruker .d input, the shim
// writes its spectra as mzML for the PSM view (FileConverter, in that file's part of the progress).

import { isRaw, isTimsD } from './files'

export type FailureStage = {
  /** The last progress label ("Searching broken.mzML (2 of 2)..."). */
  label: string
  /** The input file of the last progress report; -1 outside the files. */
  file: number
  /** The names of the files of the search, in request order. */
  files: string[]
  /** How long no progress had been reported when the error came (ms). */
  silentMs: number
}

export type Failure = {
  /** "While searching file 2 of 2 (broken.mzML)" */
  context: string
  /** What happened, in one or two sentences. */
  summary: string
  /** OpenNuXL's last lines on stderr; else OpenMS' raw text, when the summary shortens it. */
  detail: string | null
  /** Where the search's whole log was kept. */
  log?: string
  /**
   * The search, when OpenNuXL finished it but its results could not be read: it is kept in History and can be
   * opened again from there.
   */
  searchId?: string
}

/** Without a report for this long, the engine was in a step that reports no progress (Percolator). */
export const SILENT_MS = 2000

const steps: [RegExp, string][] = [
  [/^Starting OpenNuXL/, 'While starting OpenNuXL'],
  [/^Starting OpenMS/, 'While starting OpenMS'],
  [/^Preparing the database/, 'While preparing the database'],
  [/^Reading the files/, 'While reading the files'],
  [/^Reading the results/, 'While reading the results'],
]

// OpenMS' exceptions read "<message> - due to that error of type <Name> in: <source>@<line>-<function>",
// or "<message> in: <source>@<line>-<function>", where the location may also be empty
const DUE_TO = / - due to that error of type /
const LOCATION = /\s+in:\s*(?:\S+@\d+-[^]*)?$/

function stageOf(stage: FailureStage, message: string): string {
  const n = stage.files.length
  if (stage.file >= 0 && stage.file < n) {
    const file = n === 1 ? stage.files[0] : `file ${stage.file + 1} of ${n} (${stage.files[stage.file]})`
    // Percolator's step of the file ("Percolator: run.mzML (2 of 3)…")
    if (/^Percolator\b/.test(stage.label.trim())) return `While rescoring ${file} with Percolator`
    // the conversion of a .raw or .d after its search ("Preparing the spectra of run.raw for the PSM view (1 of 2)..."),
    // not OpenNuXL's own filtering step ("Preparing the spectra of run.raw (1 of 2)...")
    if (/^Preparing the spectra of .+ for the PSM view\b/.test(stage.label.trim())) return `While preparing the spectra of ${file} for the PSM view`
    // the file's step was running, but in a part that reports nothing: its last label would mislead
    const silent = stage.silentMs > SILENT_MS ? ', in a step without progress reports (e.g. Percolator)' : ''
    return `While searching ${file}${silent}`
  }
  const label = stage.label.trim().replace(/(\.\.\.|…)$/, '')
  // the count of the database's proteins, which a search started during it waits for
  if (/^Counting proteins/.test(label)) {
    const database = /^(.+?) cannot be read \(/.exec(message)?.[1]
    return database ? `While counting the proteins of ${database}` : 'While counting the proteins'
  }
  return steps.find(([pattern]) => pattern.test(label))?.[1] ?? (label ? `During “${label}”` : 'During the search')
}

/** OpenMS' exception text without its type and source location; null if it is not one. */
function exceptionText(message: string): string | null {
  const due = message.search(DUE_TO)
  if (due >= 0) return message.slice(0, due)
  const location = LOCATION.exec(message)
  return location ? message.slice(0, location.index) : null
}

/** What OpenMS' parse error says of the file it was reading: an mzML, or a vendor file (not parsed as XML by the app). */
function parseHint(stage: FailureStage): string {
  const name = stage.file >= 0 ? stage.files[stage.file] : undefined
  if (name !== undefined && isRaw(name)) return ' The file may be incomplete or not a valid Thermo .raw file.'
  if (name !== undefined && isTimsD(name)) return ' The folder may be incomplete or not a valid Bruker timsTOF .d folder.'
  return ' The file may be incomplete or not valid mzML.'
}

/** How OpenNuXL ended, its last lines and its kept log (`search://failed`); all optional. */
export type FailureOutput = { ended?: string | null; detail?: string | null; log?: string | null }

export function describeFailure(stage: FailureStage, message: string, output: FailureOutput = {}): Failure {
  const context = stageOf(stage, message)
  const raw = exceptionText(message)
  let summary = message
  let detail: string | null = null
  if (raw !== null) {
    let text = raw.trim().replace(/:$/, '')
    if (!/[.!?]$/.test(text)) text += '.'
    const hint = /parse error/i.test(text) && !/fasta/i.test(text) ? parseHint(stage) : ''
    summary = `${text}${hint}`
    detail = message
  }
  // how OpenNuXL ended leads: "OpenNuXL crashed (signal 11, SIGSEGV): <its last words>"
  if (output.ended) {
    const words = summary.trim().replace(/^Error:\s*/, '')
    summary = words === '' ? `${output.ended}.` : `${output.ended}: ${words}`
  }
  return {
    context,
    summary,
    detail: output.detail || detail,
    ...(output.log ? { log: output.log } : {}),
  }
}
