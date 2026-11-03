// The results reader: OpenNuXL's outputs in a search folder (docs/design.md §2, §5) as the web app's result types, so
// that the results screens of ProSE desktop show them.
//
// The folder is the shim's: inputs.json (the inputs in order, with the links `<n>__<name>` OpenNuXL read and their
// stems), and in nuxl/ per input `<stem>.outputs.json` (written when its run has ended successfully; the reader's only
// way to the files OpenNuXL derived, whose names it never guesses) naming its filtered files: `xls`, every target
// cross-link PSM with its q-value, and `peptides`, every target peptide PSM with its q-value (NuXLFDR: one hit per
// spectrum, the spectrum's top hit, decoys removed, the hit score the q-value). An input without outputs.json did not
// finish: it has no PSMs, with a warning. The protein descriptions come from proteins.fasta (the identified proteins,
// once History wrote it), else database.fasta (the FASTA with the contaminants), else the user's FASTA (database.json,
// an absolute path the `files` callback has to serve too); the sequences are the idXML's ProteinHits' (OpenNuXL writes
// them), else the FASTA's.
//
// The peaks of a PSM are read when it is opened (`SearchResult.spectra`), from its input mzML by byte range: by the
// file's index, else by scanning it (mzml.ts). When the file cannot be read (moved, an imported project), the load
// resolves without peaks and says why; the PSM view then has NuXL's own annotated peaks (`LoadedSpectra.annotation`).
//
// The `files` contract: resolve with the contents (all of the file, or the byte range asked for), or reject with
// `FileNotFound` (or any error or object with `notFound: true`, as a Tauri command can send it) when the file does not
// exist. Only that counts as a missing file; any other rejection fails the read, with the file's name in the message.
// A file that is there but cannot be read fails the read too, naming the file.

import { errorText } from '../format/error'
import { parseFragmentAnnotation, type NuxlPeak } from '../psm/nuxl-annotation'
import { C13C12_MASSDIFF_U, parseOpenmsSequence, proformaString, tableModifications, type Modification } from './derive'
import { numberColumn, readIdXML, textColumn, type IdXML, type IdXMLSearchParameters } from './idxml'
import { readSpectrum, spectrumIndex, SpectrumError, type MzmlSpectrum, type ReadRange, type SpectrumIndex } from './mzml'
import { passesPeptideQ } from './model'
import { parseOutputs, toSummary, type InputCounts, type NuxlSummary, type RunOutputs } from './summary'
import type { CrossLinkColumns, PredictedSpectra, ProSEMultiSummary, ResultTables, StoredSpectra } from './types'

/** A part of a file: its last `tail` bytes (all of a smaller file), or `length` bytes from `offset` (fewer at its end). */
export type ByteRange = { tail: number } | { offset: number; length: number }

/**
 * The contents of a file of the search folder by its name relative to the folder (or an absolute path): all
 * of it, or the bytes of `range`. A file that does not exist: reject with FileNotFound (or anything with
 * `notFound: true`).
 */
export type SearchFiles = (name: string, range?: ByteRange) => Promise<Uint8Array>

/** The bytes of `range` of a file's contents `bytes` (for a `SearchFiles` that has the whole file at hand). */
export function bytesOfRange(bytes: Uint8Array, range?: ByteRange): Uint8Array {
  if (!range) return bytes
  if ('tail' in range) return bytes.subarray(Math.max(0, bytes.length - range.tail))
  const start = Math.min(range.offset, bytes.length)
  return bytes.subarray(start, Math.min(bytes.length, start + range.length))
}

/** The rejection of `SearchFiles` for a file that does not exist. */
export class FileNotFound extends Error {
  readonly notFound = true
  constructor(name: string) {
    super(`${name} does not exist.`)
    this.name = 'FileNotFound'
  }
}

/** Whether `files` rejected because the file does not exist. */
export function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { notFound?: unknown }).notFound === true
}

/** A peak filter of stored spectra (ProSE stored the top peaks per window); NuXL desktop reads every peak: null. */
export interface PeakFilter {
  top: number
  window: number
}

/**
 * The peaks of a PSM's spectrum, as the web app's StoredSpectra (of that one spectrum) and an empty PredictedSpectra
 * (there is no PeptDeep), and NuXL's own annotation of it.
 */
export interface LoadedSpectra {
  /** the spectrum read from the input mzML: spectrum 0, or none (psmSpectrum[0] −1) when `missing` says why */
  spectra: StoredSpectra
  /** the PSM's entry of spectra.psmSpectrum: 0 */
  spectrumRow: number
  /** empty: NuXL desktop has no prediction */
  predicted: PredictedSpectra
  row: number
  /** null: every peak of the file */
  peakFilter: PeakFilter | null
  /**
   * Why the spectrum has no peaks, for the PSM view (the input mzML is not where it was searched, an imported project
   * has no inputs, the file has no spectrum of the PSM's native ID, its peaks are MS-Numpress-compressed, ...);
   * null: the peaks are there
   */
  missing: string | null
  /**
   * NuXL's annotated peaks of the PSM (psms.xl.annotation, parsed), by ascending m/z: the labels of the observed peaks
   * (shifted ions, marker ions, precursor and immonium ions; psm/nuxl-annotation.ts `classifyLabel`), and the peaks
   * to show when `missing` (their intensities relative, as NuXL scored them)
   */
  annotation: NuxlPeak[]
}

/** The peaks of the PSM rows, read when a PSM is opened. */
export interface PsmSpectra {
  /** PeptDeep predictions: never (NuXL desktop has no PeptDeep) */
  predictions: boolean
  /** The peaks of PSM row `row` (of ResultTables.psms). Rejects only for a row that is not one. */
  load(row: number): Promise<LoadedSpectra>
}

export interface SearchResult {
  summary: ProSEMultiSummary
  tables: ResultTables
  /** the peaks of the PSMs (read when a PSM is opened) */
  spectra: PsmSpectra
  /** what could not be read and was left out, for the user (an input whose run did not finish, the descriptions) */
  warnings: string[]
  /**
   * The protein sequences came from the folder's proteins.fasta, or there are no proteins: History need not
   * write proteins.fasta for this search (it does when this is false: history.ts, `openSearch`).
   */
  proteinsSaved: boolean
  /** NuXL's values of the search: its two FDRs, per file Percolator and OpenNuXL's notes, the scores' kind, the preset */
  nuxl: NuxlSummary
}

/** Runs `read` on the file `name`; an error names the file. */
async function inFile<T>(name: string, read: () => T | Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (e) {
    const message = errorText(e)
    if (message.startsWith(`${name}:`)) throw e
    throw new Error(`${name}: ${message}`, { cause: e })
  }
}

/** A record of inputs.json (args.rs `InputRecord`). */
export interface InputRecord {
  id: string
  index: number
  link: string
  stem: string
  name: string
  path: string
}

const utf8 = new TextDecoder()

/** The larger of two numbers, ignoring NaN (C's fmax) */
const fmax = (a: number, b: number) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b))

/** The FDR group of the peptide PSMs (the other groups are NuXL:fdr_group's: 'XL', 'short_XL'). */
const PEPTIDE_GROUP = 'peptide'

//------------------------------------------------------------------------------
// The folder's files

/** The helpers of a read: a file that may be missing (null), one that must be there, and JSON. */
function folder(files: SearchFiles) {
  const optional = (name: string, range?: ByteRange) =>
    files(name, range).catch((e: unknown) => {
      if (isNotFound(e)) return null
      throw new Error(`${name}: ${errorText(e)}`, { cause: e })
    })
  const required = async (name: string) => {
    const bytes = await optional(name)
    if (!bytes) throw new FileNotFound(name)
    return bytes
  }
  return { optional, required }
}

/** The inputs of the search, in order (inputs.json). */
async function readInputs(files: SearchFiles): Promise<InputRecord[]> {
  const { required } = folder(files)
  return inFile('inputs.json', async () => {
    const records: unknown = JSON.parse(utf8.decode(await required('inputs.json')))
    if (!Array.isArray(records)) throw new Error('it is not a list of the searched files')
    return (records as InputRecord[]).map((r, k) => ({ ...r, index: typeof r.index === 'number' ? r.index : k })).sort((a, b) => a.index - b.index)
  })
}

/** `nuxl/<stem>.outputs.json` of an input; null if its run did not finish. */
const outputsName = (input: InputRecord) => `nuxl/${input.stem}.outputs.json`

async function readOutputs(files: SearchFiles, input: InputRecord): Promise<RunOutputs | null> {
  const name = outputsName(input)
  const bytes = await folder(files).optional(name)
  return bytes ? inFile(name, () => parseOutputs(utf8.decode(bytes))) : null
}

/** A filtered file of a run, read. */
interface Part {
  /** the input (index into inputs) */
  k: number
  /** whose PSMs: the peptides' file or the cross-links' */
  kind: 'peptides' | 'xls'
  name: string
  id: IdXML
}

/** The filtered files of the runs (the peptides' first); a file that outputs.json names but is missing: a warning. */
async function readParts(files: SearchFiles, inputs: InputRecord[], runs: (RunOutputs | null)[], warnings: string[]): Promise<Part[]> {
  const { optional } = folder(files)
  const wanted: { k: number; kind: Part['kind']; name: string }[] = []
  inputs.forEach((input, k) => {
    const run = runs[k]
    if (!run) {
      warnings.push(`${input.name}: its search did not finish (the folder has no ${outputsName(input)}), so it has no PSMs.`)
      return
    }
    for (const kind of ['peptides', 'xls'] as const) {
      const name = run[kind]
      const what = kind === 'xls' ? 'cross-link' : 'peptide'
      if (name === null) warnings.push(`${input.name}: OpenNuXL wrote no file of its ${what} PSMs, so they are not shown.`)
      else wanted.push({ k, kind, name })
    }
  })
  const parts = await Promise.all(
    wanted.map(async (w) => {
      const bytes = await optional(w.name)
      if (!bytes) {
        warnings.push(`${inputs[w.k].name}: ${w.name} is missing, so its ${w.kind === 'xls' ? 'cross-link' : 'peptide'} PSMs are not shown.`)
        return null
      }
      // (the filtered files have one hit per spectrum; of a file with more, the first is the best)
      return { ...w, id: await inFile(w.name, () => readIdXML(bytes, { hitsPerIdentification: 1 })) }
    }),
  )
  return parts.filter((p): p is Part => p !== null)
}

/** Whether a score type is the q-value (NuXLFDR's filtered files: 'q-value'). */
const isQValueType = (type: string) => type.toLowerCase().replace(/[^a-z]/g, '') === 'qvalue'

/** The hit rows of a part: per identification with a target hit, its first hit. */
function targetHits(part: Part): { identification: number; hit: number }[] {
  const { identifications, hits } = part.id
  const decoy = textColumn(hits.params, 'target_decoy', hits.count)
  const out: { identification: number; hit: number }[] = []
  for (let i = 0; i < identifications.count; i++) {
    const h = identifications.hitOffsets[i]
    if (h === identifications.hitOffsets[i + 1]) continue
    // (NuXLFDR removed the decoys; one that is there is left out all the same)
    if (decoy[h] === 'decoy') continue
    out.push({ identification: i, hit: h })
  }
  return out
}

//------------------------------------------------------------------------------
// FASTA

interface FastaEntry {
  description: string
  sequence: string
}

/** The entries of a FASTA file by identifier (the header up to the first white space, as OpenMS' FASTAFile). */
function readFasta(text: string): Map<string, FastaEntry> {
  const entries = new Map<string, FastaEntry>()
  let id: string | null = null
  let description = ''
  let parts: string[] = []
  const flush = () => {
    if (id !== null && !entries.has(id)) entries.set(id, { description, sequence: parts.join('') })
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('>')) {
      flush()
      const header = line.slice(1).trim()
      const space = header.search(/\s/)
      id = space < 0 ? header : header.slice(0, space)
      description = space < 0 ? '' : header.slice(space).trim()
      parts = []
    } else if (id !== null && line !== '') {
      parts.push(line.replace(/\s+/g, ''))
    }
  }
  flush()
  return entries
}

/** The sequence as searched: without the stop codons ('*') at its end. */
const searched = (sequence: string) => sequence.replace(/\*+$/, '')

/** The user's FASTA of a search without contaminants (database.json `{ path }`); null if none. */
async function userDatabase(files: SearchFiles): Promise<string | null> {
  const bytes = await folder(files).optional('database.json')
  if (!bytes) return null
  return inFile('database.json', () => {
    const record = JSON.parse(utf8.decode(bytes)) as { path?: unknown }
    return typeof record.path === 'string' && record.path !== '' ? record.path : null
  })
}

//------------------------------------------------------------------------------
// The NuXL preset

/** The NuXL preset of the search: History's record (search.json), else the command line in nuxl.log; undefined: none. */
async function readPreset(files: SearchFiles): Promise<string | undefined> {
  const preset = (v: unknown) => (typeof v === 'string' && v !== '' && v !== 'none' ? v : undefined)
  try {
    const record = await files('search.json')
    const parameters = (JSON.parse(utf8.decode(record)) as { settings?: { parameters?: Record<string, unknown> } }).settings?.parameters
    const p = preset(parameters?.['NuXL:presets'])
    if (p) return p
  } catch {
    // (no record yet: the search has just ended)
  }
  try {
    // the first run's command line ('$ OpenNuXL ... -NuXL:presets RNA-UV (U) ...', the value perhaps quoted)
    const log = utf8.decode(await files('nuxl.log', { offset: 0, length: 1 << 16 }))
    const line = log.split('\n').find((l) => l.startsWith('$ '))
    const m = line ? /\s-NuXL:presets\s+(?:"([^"]*)"|'([^']*)'|(.+?))(?=\s+-[A-Za-z]|\s*$)/.exec(line) : null
    return m ? preset(m[1] ?? m[2] ?? m[3]) : undefined
  } catch {
    return undefined
  }
}

//------------------------------------------------------------------------------
// The reader

/** The UserParams of the hits that the reader reads, by the names OpenNuXL and Percolator give them. */
const P = {
  nuxlScore: 'NuXL:score',
  // the score before NuXLFDR set the q-value: `<score type>_score` (FalseDiscoveryRate), Percolator's svm
  svmScore: 'svm_score',
  // PercolatorAdapter's own (svm score, PEP)
  percolatorScore: 'MS:1001492',
  pep: 'MS:1001493',
  pepScore: 'Posterior Error Probability_score',
  precursorErrorPpm: 'precursor_mz_error_ppm',
  calcMass: 'CalcMass',
  isotopeError: 'isotope_error',
  isXL: 'NuXL:isXL',
  adduct: 'NuXL:NA',
  adductMass: 'NuXL:NA_MASS_z0',
  nucleotide: 'NuXL:NT',
  adductLength: 'NuXL:NA_length',
  site: 'NuXL:best_localization_position',
  siteScore: 'NuXL:best_localization_score',
  siteSequence: 'NuXL:best_localization',
  fdrGroup: 'NuXL:fdr_group',
  // FalseDiscoveryRate's peptide-level q-value (Constants::UserParam::PEPTIDE_Q_VALUE), which NuXLFDR also filters on
  peptideQValue: 'peptide q-value',
  annotation: 'fragment_annotation',
} as const

/** A value of NuXL:NA or NuXL:NT that means none. */
const none = (s: string) => (s === 'none' || s === '?' || s === '-' ? '' : s)

/** Reads the search folder that `files` serves. */
export async function readSearch(files: SearchFiles): Promise<SearchResult> {
  const warnings: string[] = []
  const inputs = await readInputs(files)
  const runs = await Promise.all(inputs.map((input) => readOutputs(files, input)))
  const [parts, preset] = await Promise.all([readParts(files, inputs, runs, warnings), readPreset(files)])
  const params: IdXMLSearchParameters | undefined = parts.find((p) => p.id.searchParameters.length > 0)?.id.searchParameters[0]
  const decoyString = params?.params.get('PeptideIndexer:decoy_string') || 'DECOY_'

  // the rows: per part (input order, the peptides' file first) its target hits
  const rowsOf = parts.map(targetHits)
  const count = rowsOf.reduce((n, r) => n + r.length, 0)

  //------------------------------------------------------------------------------
  // Proteins: the ProteinHits of the parts, by accession

  const accession: string[] = []
  const description: string[] = []
  const proteinSequence: string[] = []
  const proteinDecoy: number[] = []
  const proteinRow = new Map<string, number>()
  /** per part: its proteins' rows */
  const partProtein = parts.map((part) =>
    Int32Array.from(part.id.proteins.accession, (a, j) => {
      let p = proteinRow.get(a)
      if (p === undefined) {
        p = accession.length
        proteinRow.set(a, p)
        accession.push(a)
        description.push(part.id.proteins.description[j])
        proteinSequence.push(searched(part.id.proteins.sequence[j]))
        proteinDecoy.push(part.id.proteins.targetDecoy[j] === 'decoy' || (decoyString !== '' && a.startsWith(decoyString)) ? 1 : 0)
      } else {
        if (proteinSequence[p] === '') proteinSequence[p] = searched(part.id.proteins.sequence[j])
        if (description[p] === '') description[p] = part.id.proteins.description[j]
      }
      return p
    }),
  )
  const proteinCount = accession.length
  let proteinsSaved = proteinCount === 0
  if (proteinCount > 0) {
    // the descriptions (and sequences the idXML lacks): proteins.fasta, else the database (the folder's
    // database.fasta with the contaminants, else the user's FASTA)
    const tried: string[] = []
    let fasta: Map<string, FastaEntry> | null = null
    const sources: [() => Promise<string | null>, boolean][] = [
      [async () => 'proteins.fasta', true],
      [async () => 'database.fasta', false],
      [() => userDatabase(files), false],
    ]
    for (const [source, own] of sources) {
      const name = await source()
      if (name === null) continue
      try {
        fasta = readFasta(utf8.decode(await files(name)))
        proteinsSaved = own
        break
      } catch (e) {
        tried.push(isNotFound(e) ? `${name} (not found)` : `${name} (${errorText(e)})`)
      }
    }
    if (fasta) {
      for (let p = 0; p < proteinCount; p++) {
        const entry = fasta.get(accession[p])
        if (!entry) continue
        if (description[p] === '') description[p] = entry.description
        if (proteinSequence[p] === '') proteinSequence[p] = searched(entry.sequence)
      }
    } else {
      const noSequence = proteinSequence.some((s) => s === '')
      warnings.push(
        noSequence
          ? `The protein sequences are not available, so there is no sequence coverage: none of ${tried.join(', ')} could be read.`
          : `The protein descriptions are not available: none of ${tried.join(', ')} could be read.`,
      )
    }
  }
  const proteinScore = new Float64Array(proteinCount).fill(NaN)

  //------------------------------------------------------------------------------
  // PSMs and their peptides

  // the features: the extra_features of the runs (NuXL's scores, which OpenNuXL hands to Percolator), those some PSM has
  const featureNames: string[] = []
  for (const part of parts) for (const s of part.id.searchParameters) for (const f of s.extraFeatures) if (!featureNames.includes(f)) featureNames.push(f)
  const nFeatures = featureNames.length

  const psmFile = new Uint16Array(count)
  const nativeId = new Array<string>(count)
  const rt = new Float64Array(count)
  const mz = new Float64Array(count)
  const charge = new Int8Array(count)
  const peptide = new Uint32Array(count)
  const score = new Float64Array(count)
  const qValue = new Float64Array(count)
  const pep = new Float64Array(count)
  const precursorErrorPpm = new Float64Array(count)
  const isotopeError = new Int8Array(count)
  const deltaMass = new Float64Array(count).fill(NaN)
  const decoy = new Uint8Array(count)
  const features = new Float64Array(count * nFeatures).fill(NaN)
  const featurePresent = new Uint8Array(nFeatures)
  const xl: CrossLinkColumns = {
    isXL: new Uint8Array(count),
    adduct: new Array<string>(count),
    adductMass: new Float64Array(count),
    nucleotide: new Array<string>(count),
    adductLength: new Uint8Array(count),
    site: new Int16Array(count),
    siteScore: new Float64Array(count),
    siteSequence: new Array<string>(count),
    fdrGroup: new Array<string>(count),
    peptideQValue: new Float64Array(count),
    annotation: new Array<string>(count),
  }

  const peptideRow = new Map<string, number>()
  const pt = {
    openms: [] as string[],
    proforma: [] as string[],
    sequence: [] as string[],
    adduct: [] as string[],
    isXL: [] as number[],
    modOffsets: [0],
    modPosition: [] as number[],
    modName: [] as string[],
    modUnimod: [] as number[],
    modMass: [] as number[],
    proteinOffsets: [0],
    protein: [] as number[],
    start: [] as number[],
    end: [] as number[],
  }
  const peptideBest: number[] = []
  // one scale in psms.score: Percolator's (svm_score) when every run was rescored, else NuXL's (NuXL:score) for all,
  // also those of a rescored run (OpenNuXL skips Percolator below 1000 PSMs, so a search can have both kinds)
  const rescored = (part: Part) => part.id.hits.params.has(P.svmScore) || part.id.hits.params.has(P.percolatorScore)
  const withHits = parts.filter((part) => part.id.hits.count > 0)
  const percolatorScores = withHits.length > 0 && withHits.every(rescored)
  const clampInt8 = (v: number) => (Number.isNaN(v) ? 0 : Math.max(-128, Math.min(127, Math.round(v))))

  let i = 0
  parts.forEach((part, partIndex) => {
    const { identifications: ids, hits } = part.id
    const n = hits.count
    const num = (name: string) => numberColumn(hits.params, name, n)
    const txt = (name: string) => textColumn(hits.params, name, n)
    const nuxlScore = num(P.nuxlScore)
    const svm = !percolatorScores ? null : hits.params.has(P.svmScore) ? num(P.svmScore) : num(P.percolatorScore)
    const pepOf = hits.params.has(P.pep) ? num(P.pep) : num(P.pepScore)
    const givenPpm = num(P.precursorErrorPpm)
    const calcMass = num(P.calcMass)
    const isotope = num(P.isotopeError)
    const isXL = num(P.isXL)
    const adduct = txt(P.adduct)
    const adductMass = num(P.adductMass)
    const nucleotide = txt(P.nucleotide)
    const adductLength = num(P.adductLength)
    const site = num(P.site)
    const siteScore = num(P.siteScore)
    const siteSequence = txt(P.siteSequence)
    const fdrGroup = txt(P.fdrGroup)
    const peptideQValue = num(P.peptideQValue)
    const annotation = txt(P.annotation)
    const featureColumns = featureNames.map((f) => (hits.params.has(f) ? num(f) : null))
    // the custom modifications of the run: OpenNuXL's precursor adducts by id, with their masses
    const definitions = new Map<string, number>()
    for (const s of part.id.searchParameters) for (const d of s.modificationDefinitions) if (!definitions.has(d.id)) definitions.set(d.id, d.monoMass)
    const qValues = ids.scoreType.some(isQValueType)
    if (!qValues && ids.count > 0) {
      warnings.push(`${part.name}: its scores are no q-values (score type ${ids.scoreType[0] || 'none'}), so its PSMs have none.`)
    }

    for (const { identification, hit: h } of rowsOf[partIndex]) {
      psmFile[i] = part.k
      nativeId[i] = ids.spectrumReference[identification]
      rt[i] = ids.rt[identification]
      const observed = ids.mz[identification]
      mz[i] = observed
      const z = hits.charge[h]
      charge[i] = z
      decoy[i] = 0
      const s = svm === null || Number.isNaN(svm[h]) ? nuxlScore[h] : svm[h]
      score[i] = s
      qValue[i] = qValues && isQValueType(ids.scoreType[identification]) ? hits.score[h] : NaN
      pep[i] = pepOf[h]
      const iso = isotope[h]
      isotopeError[i] = clampInt8(iso)
      // the precursor error: OpenNuXL's, if it agrees with the masses (CalcMass, the precursor m/z with the adduct, and
      // the isotope error; an older NuXLReport counted a localized adduct twice), else from the masses
      const calc = calcMass[h]
      const corrected = observed - ((Number.isNaN(iso) ? 0 : iso) * C13C12_MASSDIFF_U) / (z || 1)
      const computed = calc > 0 ? ((corrected - calc) / calc) * 1e6 : NaN
      const given = givenPpm[h]
      precursorErrorPpm[i] =
        Number.isFinite(given) && (Number.isNaN(computed) || Math.abs(given - computed) <= Math.max(1, Math.abs(computed) * 1e-3)) ? given : computed
      const row = i * nFeatures
      for (let j = 0; j < nFeatures; j++) {
        const c = featureColumns[j]
        if (c === null) continue
        const v = c[h]
        features[row + j] = v
        if (!Number.isNaN(v)) featurePresent[j] = 1
      }

      // the cross-link
      const crossLink = isXL[h] > 0 ? 1 : 0
      const na = none(adduct[h])
      xl.isXL[i] = crossLink
      xl.adduct[i] = na
      xl.adductMass[i] = na === '' || Number.isNaN(adductMass[h]) ? 0 : adductMass[h]
      xl.nucleotide[i] = none(nucleotide[h])
      xl.adductLength[i] = Math.max(0, Math.min(255, Number.isNaN(adductLength[h]) ? 0 : adductLength[h]))
      const at = crossLink && site[h] >= 0 ? site[h] : -1
      xl.site[i] = at
      xl.siteScore[i] = at >= 0 ? siteScore[h] : NaN
      xl.siteSequence[i] = crossLink && /[a-z]/.test(siteSequence[h]) ? siteSequence[h] : ''
      xl.fdrGroup[i] = part.kind === 'peptides' ? PEPTIDE_GROUP : fdrGroup[h] || 'XL'
      xl.peptideQValue[i] = peptideQValue[h]
      xl.annotation[i] = annotation[h]

      // its peptide, unique by the OpenMS string and the adduct
      const openms = hits.sequence[h]
      const key = `${openms}\u0000${na}`
      let k = peptideRow.get(key)
      if (k !== undefined) {
        peptide[i] = k
        peptideBest[k] = fmax(peptideBest[k], s)
        i++
        continue
      }
      let parsed: ReturnType<typeof parseOpenmsSequence>
      try {
        parsed = parseOpenmsSequence(openms)
      } catch (e) {
        throw new Error(`${part.name}: the peptide of spectrum ${nativeId[i]} cannot be read (${errorText(e)})`, { cause: e })
      }
      const sequence = parsed.sequence
      const mods = tableModifications(sequence, parsed.mods, (id) => {
        const mass = definitions.get(id)
        if (mass !== undefined && !Number.isNaN(mass)) return mass
        // (a run without modification_definitions: the adduct's mass, if the modification is the precursor adduct)
        return id === `NuXL:${na}` ? xl.adductMass[i] : NaN
      }).sort((a, b) => a.position - b.position)
      k = pt.openms.length
      peptideRow.set(key, k)
      peptide[i] = k
      peptideBest.push(s)
      pt.openms.push(openms)
      pt.proforma.push(proformaOf(sequence, mods))
      pt.sequence.push(sequence)
      pt.adduct.push(na)
      pt.isXL.push(crossLink)
      for (const m of mods) {
        pt.modPosition.push(m.position)
        pt.modName.push(m.name)
        pt.modUnimod.push(m.unimod)
        pt.modMass.push(m.mass)
      }
      pt.modOffsets.push(pt.modPosition.length)
      // its proteins: the peptide evidences of its first PSM (0-based start, inclusive end)
      for (let e = hits.evidenceOffsets[h]; e < hits.evidenceOffsets[h + 1]; e++) {
        const j = hits.protein[e]
        if (j < 0) continue
        const p = partProtein[partIndex][j]
        const protein = proteinSequence[p]
        let begin = hits.start[e]
        let last = hits.end[e]
        let known = begin >= 0 && last >= begin
        const inSequence = known && last < protein.length && last - begin + 1 === sequence.length && protein.startsWith(sequence, begin)
        if (!inSequence) {
          const found = protein.indexOf(sequence)
          if (found >= 0 && sequence.length > 0) {
            begin = found
            last = found + sequence.length - 1
            known = true
          }
        }
        pt.protein.push(p)
        pt.start.push(known ? begin : 0)
        pt.end.push(known ? last + 1 : 0)
      }
      pt.proteinOffsets.push(pt.protein.length)
      i++
    }
  })

  // the score of a protein: the best score of its PSMs
  for (let k = 0; k < pt.openms.length; k++) {
    for (let r = pt.proteinOffsets[k]; r < pt.proteinOffsets[k + 1]; r++) {
      proteinScore[pt.protein[r]] = fmax(proteinScore[pt.protein[r]], peptideBest[k])
    }
  }

  // only the features some PSM has
  const kept = featureNames.map((_, j) => j).filter((j) => featurePresent[j])
  let keptFeatures = features
  if (kept.length !== nFeatures) {
    keptFeatures = new Float64Array(count * kept.length)
    for (let r = 0; r < count; r++) for (let c = 0; c < kept.length; c++) keptFeatures[r * kept.length + c] = features[r * nFeatures + kept[c]]
  }

  const tables: ResultTables = {
    files: inputs.map((r) => r.path),
    psms: {
      count,
      file: psmFile,
      nativeId,
      rt,
      mz,
      charge,
      peptide,
      score,
      qValue,
      pep,
      precursorErrorPpm,
      isotopeError,
      deltaMass,
      decoy,
      featureNames: kept.map((j) => featureNames[j]),
      features: keptFeatures,
      xl,
    },
    peptides: {
      count: pt.openms.length,
      openms: pt.openms,
      proforma: pt.proforma,
      sequence: pt.sequence,
      decoy: new Uint8Array(pt.openms.length),
      adduct: pt.adduct,
      isXL: Uint8Array.from(pt.isXL),
      modOffsets: Uint32Array.from(pt.modOffsets),
      modPosition: Int16Array.from(pt.modPosition),
      modName: pt.modName,
      modUnimod: Int32Array.from(pt.modUnimod),
      modMass: Float64Array.from(pt.modMass),
      proteinOffsets: Uint32Array.from(pt.proteinOffsets),
      protein: Uint32Array.from(pt.protein),
      start: Uint32Array.from(pt.start),
      end: Uint32Array.from(pt.end),
    },
    proteins: {
      count: proteinCount,
      accession,
      description,
      sequence: proteinSequence,
      score: proteinScore,
      // no protein FDR
      qValue: new Float64Array(proteinCount).fill(NaN),
      decoy: Uint8Array.from(proteinDecoy),
      // no protein inference: a group per protein
      group: Int32Array.from({ length: proteinCount }, (_, p) => p),
    },
  }

  //------------------------------------------------------------------------------
  // Summary

  const first = runs.find((r) => r !== null)
  const peptideFdr = first?.fdr.peptide ?? 1
  const xlFdr = first?.fdr.xl ?? 1
  const counts: InputCounts[] = inputs.map((input, k) => ({ path: input.path, outputs: runs[k], targetPsms: 0 }))
  for (let r = 0; r < count; r++) {
    const fdr = runs[psmFile[r]]?.fdr
    const cutoff = xl.isXL[r] ? (fdr?.xl ?? xlFdr) : (fdr?.peptide ?? peptideFdr)
    // (a peptide PSM also by its peptide-level q-value, as NuXLFDR filters it: model.ts passesPeptideQ)
    if (!(qValue[r] > cutoff) && (xl.isXL[r] === 1 || passesPeptideQ(xl.peptideQValue[r], cutoff))) counts[psmFile[r]].targetPsms++
  }
  const summary = toSummary(counts, {
    databaseFile: params?.db ?? '',
    enzyme: params?.params.get('PeptideIndexer:enzyme') || params?.enzyme || '',
    decoyString,
  })
  const nuxl: NuxlSummary = {
    xlFdr,
    peptideFdr,
    percolator: runs.map((r) => r?.percolator ?? false),
    percolatorScores,
    notes: runs.map((r) => r?.notes ?? []),
    ...(preset !== undefined ? { preset } : {}),
  }

  return { summary, tables, spectra: psmSpectra(files, inputs, tables.psms), warnings, proteinsSaved, nuxl }
}

/**
 * The peptide in ProForma (derive.ts `proformaString`): Unimod modifications by name, the others (OpenNuXL's adducts)
 * as their mass deltas ('AEADNLDDK[+226.0590]K'); one of unknown mass by its name.
 */
function proformaOf(sequence: string, mods: Modification[]): string {
  return proformaString(
    sequence,
    mods.map((m) => (m.unimod > 0 || Number.isNaN(m.mass) ? m : { ...m, name: '' })),
  )
}

/**
 * The target PSMs of a search within its FDRs (peptides and cross-links of every input), as the summary of
 * `readSearch` counts them, from its runs' filtered files only (History's count of a search whose results are not
 * read yet). Rejects if a file cannot be read, naming it.
 */
export async function countTargetPsms(files: SearchFiles): Promise<number> {
  const warnings: string[] = []
  const inputs = await readInputs(files)
  const runs = await Promise.all(inputs.map((input) => readOutputs(files, input)))
  const parts = await readParts(files, inputs, runs, warnings)
  let n = 0
  for (const part of parts) {
    const run = runs[part.k]!
    const cutoff = part.kind === 'xls' ? run.fdr.xl : run.fdr.peptide
    const { identifications: ids, hits } = part.id
    const qValues = ids.scoreType.some(isQValueType)
    const peptideQ = part.kind === 'xls' ? null : numberColumn(hits.params, P.peptideQValue, hits.count)
    for (const { hit } of targetHits(part)) {
      if (qValues && hits.score[hit] > cutoff) continue
      // (a peptide PSM also by its peptide-level q-value, as NuXLFDR filters it)
      if (peptideQ && !passesPeptideQ(peptideQ[hit], cutoff)) continue
      n++
    }
  }
  return n
}


//------------------------------------------------------------------------------
// The spectra of the PSMs: from the input mzML, by byte range

/** The PSMs whose loads are kept (the last ones opened). */
const CACHED_LOADS = 8

/** The spectra of no PSM. */
const NO_PEAKS = (precursorMz: number): StoredSpectra => ({
  psmSpectrum: Int32Array.of(-1),
  offsets: Uint32Array.of(0),
  mz: new Float32Array(0),
  intensity: new Float32Array(0),
  precursorMz: Float64Array.of(precursorMz),
  collisionEnergy: Float32Array.of(NaN),
})

const NO_PREDICTION: PredictedSpectra = { psmOffsets: Uint32Array.of(0, 0), ion: [], mz: new Float32Array(0), intensity: new Float32Array(0) }

/** The spectrum `s` as the StoredSpectra of one spectrum (its precursor m/z the PSM's when the file has none). */
function storedSpectra(s: MzmlSpectrum, precursorMz: number): StoredSpectra {
  return {
    psmSpectrum: Int32Array.of(0),
    offsets: Uint32Array.of(0, s.mz.length),
    mz: Float32Array.from(s.mz),
    intensity: s.intensity,
    precursorMz: Float64Array.of(Number.isNaN(s.precursorMz) ? precursorMz : s.precursorMz),
    collisionEnergy: Float32Array.of(s.collisionEnergy),
  }
}

/** The input mzML of a PSM, as a range reader: its link in the folder, else (moved links) the path it was searched at. */
interface InputFile {
  name: string
  read: ReadRange
}

/**
 * The PsmSpectra of the PSM rows: the spectrum of row r is psms.nativeId[r] of the input psms.file[r], read from
 * the input's mzML through `files` by byte range (by its link name, else its absolute path). The spectrum index of
 * each input is made once (from its index, else by scanning it).
 */
function psmSpectra(files: SearchFiles, inputs: InputRecord[], psms: ResultTables['psms']): PsmSpectra {
  const indexes = new Map<number, Promise<{ file: InputFile; index: SpectrumIndex }>>()
  const loads = new Map<number, Promise<LoadedSpectra>>()

  /** The input's mzML: the first of its link and its path that exists. A refusal (an imported project) is final. */
  const fileOf = async (input: InputRecord): Promise<InputFile> => {
    const names = [...new Set([input.link, input.path].filter((n) => n !== ''))]
    for (const name of names) {
      const read: ReadRange = (range) => files(name, range)
      try {
        await read({ tail: 1 })
        return { name, read }
      } catch (e) {
        if (!isNotFound(e)) throw new SpectrumError(`${input.name} cannot be read: ${errorText(e)}`)
      }
    }
    throw new SpectrumError(`${input.name} is not at ${input.path} any more, so its spectra cannot be read.`)
  }

  const indexOf = (k: number, rescan = false) => {
    let p = rescan ? undefined : indexes.get(k)
    if (!p) {
      p = (async () => {
        const file = await fileOf(inputs[k])
        const index = await spectrumIndex(file.read, { scan: rescan })
        return { file, index }
      })()
      p.catch(() => indexes.delete(k))
      indexes.set(k, p)
    }
    return p
  }

  const read = async (row: number): Promise<LoadedSpectra> => {
    const annotation = parseFragmentAnnotation(psms.xl.annotation[row] ?? '')
    const result = (spectra: StoredSpectra, missing: string | null): LoadedSpectra => ({
      spectra,
      spectrumRow: 0,
      predicted: NO_PREDICTION,
      row: 0,
      peakFilter: null,
      missing,
      annotation,
    })
    const k = psms.file[row]
    const input = inputs[k]
    const id = psms.nativeId[row]
    if (!input) return result(NO_PEAKS(psms.mz[row]), 'The PSM has no input file.')
    if (id === '') return result(NO_PEAKS(psms.mz[row]), 'The PSM has no native ID of its spectrum.')
    let file: InputFile | null = null
    try {
      let found = await indexOf(k)
      file = found.file
      let spectrum = await readSpectrum(file.read, found.index, id)
      if (spectrum === null && found.index.source === 'index') {
        // an index that does not fit the file (offsets elsewhere): the file's spectra by scanning it, once
        found = await indexOf(k, true)
        spectrum = await readSpectrum(found.file.read, found.index, id)
      }
      if (spectrum === null) return result(NO_PEAKS(psms.mz[row]), `${input.name}: the spectrum ${id} is not where the file's index says.`)
      return result(storedSpectra(spectrum, psms.mz[row]), null)
    } catch (e) {
      // whatever keeps the peaks from the PSM view (the file not there, refused, no such spectrum, its peaks in a
      // format the app does not read, a broken file): it says why, and shows NuXL's annotated peaks
      const message = errorText(e)
      if (message.startsWith(`${input.name} `)) return result(NO_PEAKS(psms.mz[row]), message)
      const own = file && message.startsWith(`${file.name}: `) ? message.slice(file.name.length + 2) : message
      return result(NO_PEAKS(psms.mz[row]), `${input.name}: ${own}`)
    }
  }

  return {
    predictions: false,
    load(row: number): Promise<LoadedSpectra> {
      if (!(Number.isInteger(row) && row >= 0 && row < psms.count)) return Promise.reject(new Error(`There is no PSM row ${row}.`))
      let p = loads.get(row)
      if (p) loads.delete(row)
      else p = read(row)
      loads.set(row, p)
      for (const key of [...loads.keys()].slice(0, Math.max(0, loads.size - CACHED_LOADS))) loads.delete(key)
      return p
    },
  }
}
