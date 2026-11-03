// The results reader: ProSE's QPX outputs in a search folder (docs/parity.md) as the web app's result types,
// so that the web app's screens show them unchanged.
//
// The folder is the shim's (src-tauri/src/args.rs, run.rs): inputs.json (the inputs in order, with the
// links `<n>__<name>` ProSE saw and their stems), and in qpx/ the QPX views of ProSE's -qpx_extended:
// quantms.psm.parquet (the PSM rows of all inputs, in input order, with the optional columns but without the
// spectra), quantms.run.parquet (one row per input: its statistics and its rows in quantms.psm.parquet),
// quantms.provenance.parquet (the steps of the search with their parameters), quantms.pg.parquet (the protein
// groups: of several inputs the pooled inference), and of each input in qpx/runs/ <stem>.psm.parquet (the same rows
// with PeptDeep's prediction) and <stem>.mz.parquet (the QPX mz view of the spectra of its PSMs, filtered peaks), read
// by row group when a PSM is opened (a search of app 0.1.x has them in qpx/, next to quantms.*); mods/ (open search: the
// tables the provenance names), and database.fasta (with the contaminants). Without contaminants ProSE
// searched the user's FASTA: the reader asks for the path the provenance records (`database_file`), an
// absolute path, which the `files` callback has to serve too. The protein sequences and descriptions come
// from proteins.fasta (the identified proteins, if the folder has it), else the database, else they are left
// out with a warning (`SearchResult.warnings`).
//
// The `files` contract: resolve with the contents (all of the file, or the byte range asked for), or reject
// with `FileNotFound` (or any error or object with `notFound: true`, as a Tauri command can send it) when the
// file does not exist. Only that counts as a missing file; any other rejection fails the read, with the
// file's name in the message. A file that is there but cannot be read fails the read too, naming the file.

import type { FileMetaData } from 'hyparquet'
import { errorText } from '../format/error'
import {
  C13C12_MASSDIFF_U,
  countEnzymatic,
  generatedDecoy,
  isEnz,
  modificationMass,
  openmsString,
  pinEnzymeName,
  proformaString,
  webIonName,
  type DecoyGeneration,
  type Modification,
} from './derive'
import {
  chunkRange,
  footerOf,
  hasColumn,
  metadataOfTail,
  openParquet,
  partOfParquet,
  readLeaf,
  readStructList,
  startZstd,
  type LeafMode,
  type ParquetFile,
} from './parquet'
import { parameterFlag, parameterNumber, parseModificationAnalysis, readMeta, toSummary, type SearchMeta } from './summary'
import type { PredictedSpectra, ProSESummary, ProSEMultiSummary, ResultTables, StoredSpectra } from './types'

export { ZSTD } from './parquet'

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

/**
 * A search folder of the app's earlier layouts (summary.yaml and OpenMS' own Parquet files next to the QPX
 * files; or QPX files without the run and provenance views), which this version does not read.
 */
export class OldLayoutError extends Error {
  readonly oldLayout = true
  constructor() {
    super(
      'This search was saved by an earlier version of ProSE Desktop, whose results this version cannot read. ' +
        'Open it with that version, or run the search again.',
    )
    this.name = 'OldLayoutError'
  }
}

/** The peak filter of the stored spectra: the `top` most intense peaks per `window` Th, and the annotated ones. */
export interface PeakFilter {
  top: number
  window: number
}

/**
 * The peaks (the input's mz view) and PeptDeep's prediction (its psm file) of the PSMs of a row group, as the web
 * app's StoredSpectra and PredictedSpectra of those rows.
 */
export interface LoadedSpectra {
  /** the spectra of a row group of the input's mz view; the PSM's is spectrumRow (−1: none) */
  spectra: StoredSpectra
  spectrumRow: number
  /** the predictions of a row group of the input's psm file; the PSM's is row */
  predicted: PredictedSpectra
  row: number
  /** the peak filter ProSE applied to the input's spectra (the PSM view says so; its mz view's footer); null: every peak */
  peakFilter: PeakFilter | null
}

/** The peaks and predictions of the PSM rows, read when a PSM is opened. */
export interface PsmSpectra {
  /** ProSE predicted spectra (it has ONNX Runtime): some input has the NCE of a prediction */
  predictions: boolean
  /** The peaks and the prediction of PSM row `row` (of ResultTables.psms), read from its input's psm file. */
  load(row: number): Promise<LoadedSpectra>
}

export interface SearchResult {
  summary: ProSEMultiSummary
  tables: ResultTables
  /** the peaks and predictions of the PSMs (read when a PSM is opened) */
  spectra: PsmSpectra
  /** what could not be read and was left out, for the user (e.g. the protein sequences) */
  warnings: string[]
  /**
   * The protein sequences came from the folder's proteins.fasta, or there are no proteins: History need not
   * write proteins.fasta for this search (it does when this is false: history.ts, `openSearch`).
   */
  proteinsSaved: boolean
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
interface InputRecord {
  id: string
  index: number
  link: string
  stem: string
  name: string
  path: string
}

const utf8 = new TextDecoder()

/** ProSE's ln(hyperscore): the name of its feature column (as the web app names it) */
const HYPERSCORE = 'ln(hyperscore)'
const PEPTDEEP_FEATURES = ['ms2_cosine', 'ms2_spectral_angle', 'ms2_pearson', 'ms2_frac_pred_found', 'rt_abs_error']

/** The QPX views of the search (in qpx/). */
export const MERGED_PSMS = 'qpx/quantms.psm.parquet'
export const RUNS = 'qpx/quantms.run.parquet'
export const PROVENANCE = 'qpx/quantms.provenance.parquet'
const GROUPS = 'qpx/quantms.pg.parquet'

/** The columns -qpx_extended adds to every QPX psm view (besides the scores). */
const EXTENDED_COLUMNS = ['spectrum_reference', 'isotope_error', 'protein_mappings']

/** The columns of the predictions, in the per-input psm files only. */
const PREDICTION_COLUMNS = ['predicted_ion_type_array', 'predicted_mz_array', 'predicted_intensity_array']
/** The columns of the mz view the PSM view reads. */
const PEAK_COLUMNS = ['id', 'mz', 'intensity']

const first = (...values: number[]) => values.find((v) => !Number.isNaN(v)) ?? NaN

/** The larger of two numbers, ignoring NaN (C's fmax) */
const fmax = (a: number, b: number) => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : Math.max(a, b))

//------------------------------------------------------------------------------
// The PSM rows

interface ListLeaf<T> {
  offsets: Uint32Array
  nullList: Uint8Array
  values: T
}

/** The PSM rows of the search: the columns of quantms.psm.parquet. */
interface PsmRows {
  count: number
  footer: Map<string, string>
  sequence: unknown[]
  charge: Float64Array
  pep: Float64Array
  decoy: unknown[]
  /** the scores: names as codes into `names` */
  scores: { offsets: Uint32Array; name: Int32Array; names: string[]; value: Float64Array }
  /** QPX modifications, as leaves: null if no row has one */
  modifications: Modifications | null
  /** QPX psm_id (as doubles): the identity of a row in the input's own psm file */
  psmId: Float64Array
  nativeId: unknown[]
  rt: ArrayLike<number>
  observedMz: ArrayLike<number>
  calculatedMz: ArrayLike<number>
  /** QPX isotope_error (observed minus theoretical); NaN: null */
  isotope: Float64Array
  /** protein_mappings: 1-based start and end, NaN: null */
  evidence: { offsets: Uint32Array; accession: unknown[]; aa_before: unknown[]; aa_after: unknown[]; start: Float64Array; end: Float64Array }
}

/** The QPX modifications of the rows: row r has the modifications offsets[r] .. offsets[r + 1], modification m the
 * positions positionOffsets[m] .. positionOffsets[m + 1] */
interface Modifications {
  offsets: Uint32Array
  name: Int32Array
  names: string[]
  accession: Int32Array
  accessions: string[]
  positionOffsets: Uint32Array
  position: Float64Array
}

function listLeaf<T>(file: ParquetFile, column: string, mode: LeafMode = 'values', groups?: number[]): ListLeaf<T> & { dictionary?: string[] } {
  const leaf = readLeaf(file, [column, 'list', 'element'], mode, groups)
  return { offsets: leaf.offsets!, nullList: leaf.nullList!, values: leaf.values as T, dictionary: leaf.dictionary }
}

/** A psm file without the columns of -qpx_extended. */
class NotExtended extends Error {}

async function readRows(name: string, bytes: Uint8Array): Promise<PsmRows> {
  const flat = <T>(file: ParquetFile, column: string) => readLeaf(file, [column]).values as T
  return inFile(name, async () => {
    const qpx = openParquet(bytes)
    if (EXTENDED_COLUMNS.some((c) => !hasColumn(qpx, c))) {
      throw new NotExtended(`${name}: the QPX psm view has not the columns of ProSE's -qpx_extended`)
    }
    const scores = readStructList(qpx, 'additional_scores', ['score_name', 'score_value'], { score_name: 'codes' })
    const evidence = readStructList(qpx, 'protein_mappings', ['accession', 'aa_before', 'aa_after', 'start', 'end'])
    // the modifications (a list of structs with a list): as leaves, without an object per row; only if some row has any
    const modLeaf = readLeaf(qpx, ['modifications', 'list', 'element', 'name'], 'codes')
    const modified = modLeaf.offsets![qpx.rows] > 0
    let modifications: Modifications | null = null
    if (modified) {
      const accession = readLeaf(qpx, ['modifications', 'list', 'element', 'accession'], 'codes')
      const position = readLeaf(qpx, ['modifications', 'list', 'element', 'positions', 'list', 'element', 'position'])
      modifications = {
        offsets: modLeaf.offsets!,
        name: modLeaf.values as Int32Array,
        names: modLeaf.dictionary ?? [],
        accession: accession.values as Int32Array,
        accessions: accession.dictionary ?? [],
        positionOffsets: position.offsets2!,
        position: position.values as Float64Array,
      }
      if (position.offsets![qpx.rows] !== modLeaf.offsets![qpx.rows]) throw new Error('the modifications and their positions do not agree')
    }
    return {
      count: qpx.rows,
      footer: footerOf(qpx),
      sequence: flat<unknown[]>(qpx, 'sequence'),
      charge: flat<Float64Array>(qpx, 'charge'),
      pep: flat<Float64Array>(qpx, 'posterior_error_probability'),
      decoy: flat<unknown[]>(qpx, 'is_decoy'),
      scores: {
        offsets: scores.offsets,
        name: scores.score_name as Int32Array,
        names: scores.dictionaries.score_name ?? [],
        value: scores.score_value as Float64Array,
      },
      modifications,
      psmId: flat<Float64Array>(qpx, 'psm_id'),
      nativeId: flat<unknown[]>(qpx, 'spectrum_reference'),
      rt: flat<Float32Array>(qpx, 'rt'),
      observedMz: flat<Float32Array>(qpx, 'observed_mz'),
      calculatedMz: flat<Float32Array>(qpx, 'calculated_mz'),
      isotope: flat<Float64Array>(qpx, 'isotope_error'),
      evidence: {
        offsets: evidence.offsets,
        accession: evidence.accession as unknown[],
        aa_before: evidence.aa_before as unknown[],
        aa_after: evidence.aa_after as unknown[],
        start: evidence.start as Float64Array,
        end: evidence.end as Float64Array,
      },
    }
  })
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

/** The sequence as ProSE searches it: without the stop codons ('*') at its end. */
const searched = (sequence: string) => sequence.replace(/\*+$/, '')

/** The protein q-value of a pg row's additional_scores: the entry named q-value (any spelling). */
const isQValueName = (name: string) => name.toLowerCase().replace(/[^a-z]/g, '') === 'qvalue'

//------------------------------------------------------------------------------
// The reader

/** Reads the search folder that `files` serves. */
export async function readSearch(files: SearchFiles): Promise<SearchResult> {
  const zstd = startZstd()
  const warnings: string[] = []
  /** a file that may be missing: null if it does not exist */
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

  const inputs = await inFile('inputs.json', async () =>
    (JSON.parse(utf8.decode(await required('inputs.json'))) as InputRecord[]).sort((a, b) => a.index - b.index),
  )
  await zstd

  const [runBytes, provenanceBytes, psmBytes, groupBytes] = await Promise.all([
    optional(RUNS),
    optional(PROVENANCE),
    optional(MERGED_PSMS),
    optional(GROUPS),
  ])
  if (!runBytes || !provenanceBytes) {
    // the earlier layouts of the app's search folders: summary.yaml, or QPX files without these views
    if (psmBytes || (await optional('summary.yaml'))) throw new OldLayoutError()
    throw new Error(`The search folder has no results of ProSE (${RUNS}, ${PROVENANCE}).`)
  }
  const meta: SearchMeta = await inFile(`${RUNS}, ${PROVENANCE}`, () => readMeta(runBytes, provenanceBytes))
  if (meta.runs.length !== inputs.length) {
    throw new Error(`${RUNS}: ${meta.runs.length} runs, but the search has ${inputs.length} input(s).`)
  }
  let rows: PsmRows | null = null
  if (psmBytes) {
    try {
      rows = await readRows(MERGED_PSMS, psmBytes)
    } catch (e) {
      if (e instanceof NotExtended || (e as { cause?: unknown })?.cause instanceof NotExtended) {
        if (await optional('summary.yaml')) throw new OldLayoutError()
      }
      throw e
    }
  }
  // the rows of each input in quantms.psm.parquet: input k has rows from[k] .. from[k + 1]
  const from = [0]
  meta.runs.forEach((r) => from.push(from[from.length - 1] + r.psm_rows))
  const count = rows?.count ?? 0
  if (from[inputs.length] !== count) {
    throw new Error(`${MERGED_PSMS}: ${count} rows, but ${RUNS} gives its inputs ${from[inputs.length]}.`)
  }
  // an input without rows whose search reports PSMs: its psm file could not be written
  inputs.forEach((input, k) => {
    const r = meta.runs[k]
    if (r.psm_rows === 0 && r.search_status === 'EXECUTION_OK' && r.identified_spectra_count > 0) {
      warnings.push(
        `${input.name}: ProSE reports ${r.identified_spectra_count} target PSMs for it, but its results are not in the search folder, so its PSMs are not shown.`,
      )
    }
  })
  const S = meta.search
  const decoyString = S.get('decoy_string') ?? 'DECOY_'
  const decoyIsPrefix = (S.get('decoy_position') ?? 'prefix') === 'prefix'
  const hasDecoyMarker = (accession: string) =>
    decoyString !== '' && (decoyIsPrefix ? accession.startsWith(decoyString) : accession.endsWith(decoyString))
  const proteinFdrApplied = parameterFlag(meta.fdr, 'protein_fdr_applied')

  //------------------------------------------------------------------------------
  // Proteins and their groups: the protein groups of the QPX pg view (several inputs: the pooled inference;
  // without protein inference, one group per protein), with the FASTA

  const accession: string[] = []
  const ownDescription: string[] = []
  const proteinQ: number[] = []
  const proteinDecoy: number[] = []
  const group: number[] = []
  const proteinRow = new Map<string, number>()
  if (groupBytes) {
    const bytes = groupBytes
    await inFile(GROUPS, () => {
      const pg = openParquet(bytes)
      const members = readLeaf(pg, ['pg_accessions', 'list', 'element'])
      const names = readLeaf(pg, ['pg_names', 'list', 'element'])
      const isDecoy = readLeaf(pg, ['is_decoy']).values as unknown[]
      const groupQ = readLeaf(pg, ['global_qvalue']).values as Float64Array
      // the q-value of the group's first protein (once the protein FDR was applied): its additional_scores
      // entry 'q-value'
      const scores = readStructList(pg, 'additional_scores', ['score_name', 'score_value'], { score_name: 'codes' })
      const qName = (scores.dictionaries.score_name ?? []).map(isQValueName)
      const groupOf = new Map<string, number>()
      for (let r = 0; r < pg.rows; r++) {
        const begin = members.offsets![r]
        const end = members.offsets![r + 1]
        const list = Array.from({ length: end - begin }, (_, k) => String((members.values as unknown[])[begin + k]))
        // a group of several runs has a row per run
        const key = list.join('\u0000')
        let g = groupOf.get(key)
        if (g === undefined) {
          g = groupOf.size
          groupOf.set(key, g)
        }
        let q = groupQ[r]
        for (let k = scores.offsets[r]; k < scores.offsets[r + 1]; k++) {
          const c = (scores.score_name as Int32Array)[k]
          if (c >= 0 && qName[c]) {
            q = (scores.score_value as Float64Array)[k]
            break
          }
        }
        list.forEach((a, k) => {
          if (proteinRow.has(a)) return
          proteinRow.set(a, accession.length)
          accession.push(a)
          const own = names.offsets ? (names.values as unknown[])[names.offsets[r] + k] : null
          ownDescription.push(typeof own === 'string' ? own : '')
          proteinQ.push(proteinFdrApplied ? q : NaN)
          proteinDecoy.push(hasDecoyMarker(a) || (isDecoy[r] === true && list.length === 1) ? 1 : 0)
          group.push(g)
        })
      }
    })
  }
  const proteinCount = accession.length
  let proteinsSaved = proteinCount === 0
  const description = ownDescription.slice()
  const proteinSequence = new Array<string>(proteinCount).fill('')
  const proteinScore = new Float64Array(proteinCount).fill(NaN)
  if (proteinCount > 0) {
    // the sequences and descriptions: proteins.fasta (the identified proteins), else the database (the
    // folder's database.fasta with contaminants, else the user's FASTA), else none, with a warning
    let fasta = new Map<string, FastaEntry>()
    let identified = false
    const tried: string[] = []
    const sources: [string, boolean][] = [
      ['proteins.fasta', true],
      ['database.fasta', false],
      [S.get('database_file') ?? '', false],
    ]
    let found = false
    for (const [name, own] of sources) {
      if (name === '') continue
      try {
        const bytes = await files(name)
        fasta = readFasta(utf8.decode(bytes))
        identified = own
        proteinsSaved = own
        found = true
        break
      } catch (e) {
        tried.push(isNotFound(e) ? `${name} (not found)` : `${name} (${errorText(e)})`)
      }
    }
    if (!found) {
      warnings.push(`The protein sequences are not available, so there is no sequence coverage: none of ${tried.join(', ')} could be read.`)
    }
    const decoys: DecoyGeneration = {
      enzyme: S.get('enzyme') ?? '',
      keepInitialMet: parameterFlag(S, 'clip_nterm_methionine'),
      unspecific: S.get('enzyme_specificity') === 'none',
    }
    const generated = S.get('decoy_mode') === 'generated'
    for (let p = 0; p < proteinCount; p++) {
      const a = accession[p]
      const decoy = proteinDecoy[p] === 1
      // proteins.fasta has the proteins as searched, decoys included
      const listed = identified ? fasta.get(a) : undefined
      // a decoy ProSE generated is the decoy marker + the accession of its target (whose description it
      // gets, as in the web app); generated decoys also replace decoys of the FASTA
      const ofTarget = !listed && decoy && generated && decoyIsPrefix && hasDecoyMarker(a)
      const entry = listed ?? (ofTarget ? fasta.get(a.slice(decoyString.length)) : fasta.get(a))
      if (entry) {
        proteinSequence[p] = ofTarget ? generatedDecoy(searched(entry.sequence), decoys) : searched(entry.sequence)
        if (description[p] === '') description[p] = entry.description
      }
    }
  }

  //------------------------------------------------------------------------------
  // PSMs and their peptides

  let minCharge = parameterNumber(S, 'min_charge', Infinity)
  let maxCharge = parameterNumber(S, 'max_charge', -Infinity)
  if (rows) {
    for (const c of rows.charge) {
      minCharge = Math.min(minCharge, c)
      maxCharge = Math.max(maxCharge, c)
    }
  }

  // the features: ln(hyperscore), the standard .pin features (PercolatorInfile::getStandardFeatureSet
  // without the bookkeeping columns), the run's extra_features, PeptDeep's; those some PSM has
  const featureNames: string[] = [HYPERSCORE]
  const pin = new Set<string>()
  const addFeature = (name: string, isPin = false) => {
    if (name === '' || name === 'score' || name === HYPERSCORE || name === 'ln_hyperscore' || featureNames.includes(name)) return
    featureNames.push(name)
    if (isPin) pin.add(name)
  }
  const chargeFeatures: string[] = []
  for (let c = minCharge; Number.isFinite(c) && c <= maxCharge; c++) chargeFeatures.push(`charge${c}`)
  for (const name of ['CalcMass', 'mass', 'peplen', ...chargeFeatures, 'enzN', 'enzC', 'enzInt', 'dm', 'absdm']) addFeature(name, true)
  for (const name of (S.get('extra_features') ?? '').split(',')) addFeature(name.trim())
  for (const name of PEPTDEEP_FEATURES) addFeature(name)
  const nFeatures = featureNames.length
  const featureIndex = new Map(featureNames.map((n, j) => [n, j]))

  // the scores the columns need, by their QPX names: a slot of `values` below
  const SCORES = [
    'ln_hyperscore',
    'percolator_score',
    'global_qvalue',
    'percolator_qvalue',
    'percolator_pep',
    'precursor_mz_error_ppm',
    'isotope_error',
    'delta_mass',
  ] as const
  type ScoreName = (typeof SCORES)[number]
  const scoreSlot = new Map<string, number>(SCORES.map((n, k) => [n, k]))
  const values = new Float64Array(SCORES.length)
  const slot = (n: ScoreName) => scoreSlot.get(n)!
  const featureOfScore = new Map<string, number>()
  for (const [n, j] of featureIndex) if (!pin.has(n) && j > 0) featureOfScore.set(n, j)
  /** what a score name is for: [its slot or −1, its feature column or −1]; null: nothing */
  const uses = new Map<string, [number, number] | null>()
  const useOf = (name: string) => {
    let use = uses.get(name)
    if (use === undefined) {
      const [s, j] = [scoreSlot.get(name) ?? -1, featureOfScore.get(name) ?? -1]
      use = s < 0 && j < 0 ? null : [s, j]
      uses.set(name, use)
    }
    return use
  }
  // the columns of the .pin features
  const pinColumn = (name: string) => featureIndex.get(name)!
  const [calcMassJ, massJ, peplenJ, enzNJ, enzCJ, enzIntJ, dmJ, absdmJ] = ['CalcMass', 'mass', 'peplen', 'enzN', 'enzC', 'enzInt', 'dm', 'absdm'].map(pinColumn)
  const chargeColumns = chargeFeatures.map(pinColumn)
  const [hyperscoreS, percolatorScoreS, qS, percolatorQS, percolatorPepS, precursorErrorS, isotopeErrorS, deltaMassS] = SCORES.map(slot)
  const enzyme = pinEnzymeName(S.get('enzyme') ?? '')
  // QPX has the isotope error observed minus theoretical (column and additional_scores); Percolator saw
  // ProSE's meta value, whose sign 'report:isotope_error_convention' sets: its feature and dm have that sign
  const isotopeSign = S.get('isotope_error_convention') === 'theoretical_minus_observed' ? -1 : 1
  const isotopeFeatureJ = featureIndex.get('isotope_error') ?? -1

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
  const deltaMass = new Float64Array(count)
  const decoy = new Uint8Array(count)
  const features = new Float64Array(count * nFeatures).fill(NaN)
  const featurePresent = new Uint8Array(nFeatures)
  featurePresent[0] = 1

  const peptideRow = new Map<string, number>()
  const pt = {
    openms: [] as string[],
    proforma: [] as string[],
    sequence: [] as string[],
    decoy: [] as number[],
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

  const clampInt8 = (v: number) => (Number.isNaN(v) ? 0 : Math.max(-128, Math.min(127, Math.round(v))))

  if (rows) {
    const f = rows
    const scoreUses = f.scores.names.map(useOf)
    for (let k = 0; k < inputs.length; k++) psmFile.fill(k, from[k], from[k + 1])
    for (let i = 0; i < count; i++) {
      const r = i
      nativeId[i] = String(f.nativeId[r] ?? '')
      rt[i] = f.rt[r]
      const observed = f.observedMz[r]
      const calc = f.calculatedMz[r]
      mz[i] = observed
      const z = f.charge[r]
      charge[i] = clampInt8(z)
      decoy[i] = f.decoy[r] === true ? 1 : 0

      // the scores and the features among them
      values.fill(NaN)
      const row = i * nFeatures
      for (let k = f.scores.offsets[r]; k < f.scores.offsets[r + 1]; k++) {
        const c = f.scores.name[k]
        const use = c < 0 ? null : scoreUses[c]
        if (use === null) continue
        const v = f.scores.value[k]
        if (use[0] >= 0) values[use[0]] = v
        if (use[1] >= 0 && !Number.isNaN(v)) {
          features[row + use[1]] = use[1] === isotopeFeatureJ ? isotopeSign * v : v
          featurePresent[use[1]] = 1
        }
      }
      const hyperscore = values[hyperscoreS]
      const percolator = values[percolatorScoreS]
      const s = Number.isNaN(percolator) ? hyperscore : percolator
      score[i] = s
      qValue[i] = first(values[qS], values[percolatorQS])
      pep[i] = first(f.pep[r], values[percolatorPepS])
      // the isotope error of QPX (observed minus theoretical)
      const isotope = first(f.isotope[r], values[isotopeErrorS])
      isotopeError[i] = clampInt8(isotope)
      const corrected = observed - ((Number.isNaN(isotope) ? 0 : isotope) * C13C12_MASSDIFF_U) / z
      precursorErrorPpm[i] = first(values[precursorErrorS], calc > 0 ? ((corrected - calc) / calc) * 1e6 : NaN)
      deltaMass[i] = values[deltaMassS]
      features[row] = hyperscore

      // the .pin features (PercolatorInfile::stampPinFeaturesOnHits). Percolator saw every hit with its proteins, but a
      // hit whose proteins all failed the protein FDR has none left in QPX (one input: ProSE removes the references):
      // its features are those of the hit alone, without enzN and enzC, which need the residues around the peptide
      // in a protein
      const sequence = String(f.sequence[r] ?? '')
      const e0 = f.evidence.offsets[r]
      const set = (j: number, v: number) => {
        features[row + j] = v
        if (!Number.isNaN(v)) featurePresent[j] = 1
      }
      // Percolator's dm: corrected by ProSE's isotope error meta value as it is (with its convention's sign)
      const iso = Math.fround(isotopeSign * isotope)
      const dm = (Number.isNaN(iso) ? observed : observed - (iso * C13C12_MASSDIFF_U) / z) - calc
      set(calcMassJ, calc)
      set(massJ, observed)
      set(peplenJ, sequence.length)
      for (let c = 0; c < chargeColumns.length; c++) set(chargeColumns[c], minCharge + c === z ? 1 : 0)
      if (f.evidence.offsets[r + 1] > e0) {
        // a protein terminus ('-' in QPX) as OpenMS' '[' and ']', which Percolator's features were computed with
        const before = f.evidence.aa_before[e0] === '-' ? '[' : String(f.evidence.aa_before[e0] ?? '')
        const after = f.evidence.aa_after[e0] === '-' ? ']' : String(f.evidence.aa_after[e0] ?? '')
        set(enzNJ, isEnz(before.charAt(0), sequence.charAt(0), enzyme) ? 1 : 0)
        set(enzCJ, isEnz(sequence.charAt(sequence.length - 1), after.charAt(0), enzyme) ? 1 : 0)
      }
      set(enzIntJ, countEnzymatic(sequence, enzyme))
      set(dmJ, dm)
      set(absdmJ, Math.abs(dm))

      // its peptide, unique by the OpenMS string
      const mods = modificationsOf(f.modifications, r, sequence.length)
      const openms = openmsString(sequence, mods)
      let k = peptideRow.get(openms)
      if (k !== undefined) {
        peptide[i] = k
        peptideBest[k] = fmax(peptideBest[k], s)
        continue
      }
      k = pt.openms.length
      peptideRow.set(openms, k)
      peptide[i] = k
      peptideBest.push(s)
      pt.openms.push(openms)
      pt.proforma.push(proformaString(sequence, mods))
      pt.sequence.push(sequence)
      pt.decoy.push(decoy[i])
      for (const m of mods) {
        pt.modPosition.push(m.position)
        pt.modName.push(m.name)
        pt.modUnimod.push(m.unimod)
        pt.modMass.push(m.mass)
      }
      pt.modOffsets.push(pt.modPosition.length)
      // its proteins: the protein mappings of its first PSM whose protein is a row of the proteins
      for (let e = e0; e < f.evidence.offsets[r + 1]; e++) {
        const p = proteinRow.get(String(f.evidence.accession[e]))
        if (p === undefined) continue // a protein the protein FDR removed
        const protein = proteinSequence[p]
        // 1-based first and last position -> 0-based
        let begin = f.evidence.start[e] - 1
        let last = f.evidence.end[e] - 1
        let known = begin >= 0 && last >= begin
        const inSequence =
          known && last < protein.length && last - begin + 1 === sequence.length && protein.startsWith(sequence, begin)
        if (!inSequence) {
          const at = protein.indexOf(sequence)
          if (at >= 0 && sequence.length > 0) {
            begin = at
            last = at + sequence.length - 1
            known = true
          }
        }
        pt.protein.push(p)
        pt.start.push(known ? begin : 0)
        pt.end.push(known ? last + 1 : 0)
      }
      pt.proteinOffsets.push(pt.protein.length)
    }
  }

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

  const paths = inputs.map((r) => r.path)
  const tables: ResultTables = {
    files: paths,
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
    },
    peptides: {
      count: pt.openms.length,
      openms: pt.openms,
      proforma: pt.proforma,
      sequence: pt.sequence,
      decoy: Uint8Array.from(pt.decoy),
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
      qValue: Float64Array.from(proteinQ),
      decoy: Uint8Array.from(proteinDecoy),
      group: Int32Array.from(group),
    },
  }

  //------------------------------------------------------------------------------
  // Spectra and predictions: read from the inputs' psm files when a PSM is opened

  const spectra = psmSpectra(
    files,
    inputs.map((input) => input.stem),
    from,
    { nativeId, psmId: rows?.psmId ?? new Float64Array(0), precursorMz: mz, rt },
    meta.runs.some((r) => r.prediction_nce !== null),
  )

  //------------------------------------------------------------------------------
  // Summary

  let modificationAnalysis: ProSESummary['modificationAnalysis'] = null
  const deltaName = S.get('mod_analysis_delta_masses')
  const ptmName = S.get('mod_analysis_ptms')
  if (parameterFlag(S, 'open_search') && deltaName && ptmName) {
    const [deltas, ptms] = await Promise.all([optional(`mods/${deltaName}`), optional(`mods/${ptmName}`)])
    if (deltas && ptms) {
      modificationAnalysis = await inFile(`mods/{${deltaName},${ptmName}}`, () =>
        parseModificationAnalysis(utf8.decode(deltas), utf8.decode(ptms)),
      )
    }
  }
  // whether some PSM of each input has a q-value: a ProSE that does not report whether it applied the PSM FDR
  // skipped it for an input without
  const hasQValues = inputs.map((_, k) => {
    for (let i = from[k]; i < from[k + 1]; i++) if (!Number.isNaN(qValue[i])) return true
    return false
  })
  const summary = toSummary(meta, paths, modificationAnalysis, hasQValues)
  return { summary, tables, spectra, warnings, proteinsSaved }
}

/** The modifications of QPX row `r`, by position (−1 N-terminal, the length C-terminal, else 0-based). */
function modificationsOf(mods: Modifications | null, r: number, length: number): Modification[] {
  if (!mods || mods.offsets[r] === mods.offsets[r + 1]) return []
  const out: Modification[] = []
  for (let m = mods.offsets[r]; m < mods.offsets[r + 1]; m++) {
    const name = mods.name[m] < 0 ? '' : mods.names[mods.name[m]]
    const accession = /^UNIMOD:(\d+)$/i.exec(mods.accession[m] < 0 ? '' : mods.accessions[mods.accession[m]])
    const unimod = accession ? Number(accession[1]) : -1
    const mass = modificationMass(name, unimod)
    for (let k = mods.positionOffsets[m]; k < mods.positionOffsets[m + 1]; k++) {
      const position = mods.position[k]
      out.push({ position: position === 0 ? -1 : position === length + 1 ? length : position - 1, name, unimod, mass })
    }
  }
  return out.sort((a, b) => a.position - b.position)
}

//------------------------------------------------------------------------------
// The spectra of the PSMs: by row group of the inputs' psm and mz files

/** The row groups of an input's files that the PSM view keeps decoded (the last ones opened). */
const CACHED_GROUPS = 4

/** The PSM rows' values that the spectra are checked against. */
interface RowIdentity {
  /** the native ID of each PSM row (the mz view's `id` of its spectrum) */
  nativeId: string[]
  /** the psm_id of each PSM row (in the input's psm file the same) */
  psmId: Float64Array
  /** the precursor m/z of each PSM row (the spectrum's, when the mz view has none) */
  precursorMz: Float64Array
  /** the RT of each PSM row in seconds (NaN: unknown): its spectrum's scan_start_time */
  rt: Float64Array
}

/** A file's metadata and where its rows are: row group g has the rows starts[g] .. starts[g + 1]. */
interface Layout {
  metadata: FileMetaData
  starts: number[]
}

/** The row group of `row` and its row in it. */
function groupOf(layout: Layout, row: number): [number, number] {
  let g = 0
  while (g + 1 < layout.starts.length - 1 && row >= layout.starts[g + 1]) g++
  return [g, row - layout.starts[g]]
}

/**
 * The PsmSpectra of the PSM rows: the rows of input k are from[k] .. from[k + 1] of the PSM rows and the rows of
 * its psm file `qpx/runs/<stems[k]>.psm.parquet`, in order; its spectra are the rows of `qpx/runs/<stems[k]>.mz.parquet`,
 * one per spectrum in the order of its first PSM (else found by their ids). A search of app 0.1.x has these files next
 * to quantms.* (`qpx/<stems[k]>.*`): decided per input by its psm file, and used for its mz file too.
 */
function psmSpectra(files: SearchFiles, stems: string[], from: number[], rows: RowIdentity, predictions: boolean): PsmSpectra {
  const layouts = new Map<string, Promise<Layout>>()
  const predictionCache = new Map<string, Promise<{ psmId: Float64Array; predicted: PredictedSpectra }>>()
  const peakCache = new Map<string, Promise<{ id: unknown[]; startTime: Float32Array; spectra: StoredSpectra }>>()
  /** the inputs whose mz rows are found by their ids (the order of the PSMs did not give them) */
  const byIds = new Set<number>()
  const mzRows = new Map<number, Promise<Int32Array>>()
  /** The folder of input k's files ('qpx/runs/' or, of app 0.1.x, 'qpx/'), once `folderOf(k)` has resolved. */
  const folders = new Map<number, string>()
  const folderPromises = new Map<number, Promise<string>>()
  const psmName = (k: number) => `${folders.get(k) ?? 'qpx/runs/'}${stems[k]}.psm.parquet`
  const mzName = (k: number) => `${folders.get(k) ?? 'qpx/runs/'}${stems[k]}.mz.parquet`

  /** A value made once, kept until it fails. */
  const once = <K, T>(map: Map<K, Promise<T>>, key: K, make: () => Promise<T>): Promise<T> => {
    let p = map.get(key)
    if (!p) {
      p = make()
      p.catch(() => map.delete(key))
      map.set(key, p)
    }
    return p
  }

  /** The layout of the file `name` (its footer, read once). */
  const layoutOf = (name: string) =>
    once(layouts, name, () =>
      inFile(name, async () => {
        let metadata = metadataOfTail(await files(name, { tail: 1 << 16 }))
        if (typeof metadata === 'number') metadata = metadataOfTail(await files(name, { tail: metadata }))
        if (typeof metadata === 'number') throw new Error('its footer cannot be read')
        const starts = [0]
        for (const g of metadata.row_groups) starts.push(starts[starts.length - 1] + Number(g.num_rows))
        return { metadata, starts }
      }),
    )

  /**
   * Where input k's files are: qpx/runs/ if its psm file is there, else (app 0.1.x) qpx/. Decided once, from the tail
   * of the psm file (read anyway); if neither exists, the runs/ name is the one reported.
   */
  const folderOf = (k: number) =>
    once(folderPromises, k, async () => {
      const notFound = (e: unknown) => isNotFound((e as { cause?: unknown }).cause ?? e)
      const psm = (folder: string) => `${folder}${stems[k]}.psm.parquet`
      let folder = 'qpx/runs/'
      try {
        await layoutOf(psm(folder))
      } catch (e) {
        if (!notFound(e)) throw e
        try {
          await layoutOf(psm('qpx/'))
          folder = 'qpx/'
        } catch (old) {
          if (!notFound(old)) throw old
          throw e
        }
      }
      folders.set(k, folder)
      return folder
    })

  /** The columns `columns` of row group g of the file `name` (one byte range for all of them). */
  const groupFile = async (name: string, layout: Layout, g: number, columns: string[]) => {
    const ranges = layout.metadata.row_groups[g].columns
      .filter((c) => c.meta_data && columns.includes(c.meta_data.path_in_schema[0]))
      .map((c) => chunkRange(c.meta_data!))
    const present = new Set(layout.metadata.row_groups[g].columns.map((c) => c.meta_data?.path_in_schema[0]))
    const missing = columns.filter((c) => !present.has(c))
    if (missing.length > 0) throw new Error(`it has not the columns of ProSE's -qpx_extended (${missing.join(', ')})`)
    const start = Math.min(...ranges.map((r) => r.start))
    const end = Math.max(...ranges.map((r) => r.end))
    const bytes = await files(name, { offset: start, length: end - start })
    if (bytes.byteLength !== end - start) throw new Error(`${bytes.byteLength} bytes at ${start}, expected ${end - start}`)
    return partOfParquet(layout.metadata, bytes, start)
  }

  /** The predictions of row group g of input k's psm file, and its psm_id. */
  const predictionsOf = (k: number, layout: Layout, g: number) =>
    once(predictionCache, `${k}/${g}`, () =>
      inFile(psmName(k), async () => {
        const file = await groupFile(psmName(k), layout, g, ['psm_id', ...PREDICTION_COLUMNS])
        const groups = [g]
        const psmId = readLeaf(file, ['psm_id'], 'values', groups).values as Float64Array
        const ion = listLeaf<Int32Array>(file, 'predicted_ion_type_array', 'codes', groups)
        const ionNames = (ion.dictionary ?? []).map(webIonName)
        const predictedMz = listLeaf<Float32Array>(file, 'predicted_mz_array', 'values', groups)
        const predictedIntensity = listLeaf<Float32Array>(file, 'predicted_intensity_array', 'values', groups)
        const ions = Array.from(ion.values, (c) => (c < 0 ? '' : ionNames[c]))
        if (predictedMz.values.length !== ions.length || predictedIntensity.values.length !== ions.length) {
          throw new Error(`row group ${g} has other numbers of predicted ions, m/z and intensities`)
        }
        // (a row without a prediction has an empty range: its list is null)
        const predicted: PredictedSpectra = { psmOffsets: ion.offsets, ion: ions, mz: predictedMz.values, intensity: predictedIntensity.values }
        return { psmId, predicted }
      }),
    )

  /** The spectra of row group g of input k's mz view: StoredSpectra of its rows (spectrum s = row s), their ids. */
  const peaksOf = (k: number, layout: Layout, g: number) =>
    once(peakCache, `${k}/${g}`, () =>
      inFile(mzName(k), async () => {
        const file = await groupFile(mzName(k), layout, g, [...PEAK_COLUMNS, 'scan_start_time', 'precursors'])
        const groups = [g]
        const id = readLeaf(file, ['id'], 'values', groups).values as unknown[]
        const startTime = readLeaf(file, ['scan_start_time'], 'values', groups).values as Float32Array
        const peakMz = listLeaf<Float32Array>(file, 'mz', 'values', groups)
        const peakIntensity = listLeaf<Float32Array>(file, 'intensity', 'values', groups)
        const precursor = readLeaf(file, ['precursors', 'list', 'element', 'selected_ion_mz'], 'values', groups)
        const n = id.length
        const precursorMz = new Float64Array(n).fill(NaN)
        for (let r = 0; r < n; r++) {
          if (peakIntensity.offsets[r] !== peakMz.offsets[r] || peakIntensity.offsets[r + 1] !== peakMz.offsets[r + 1]) {
            throw new Error(`row ${r} of row group ${g} has other numbers of peak m/z and intensities`)
          }
          if (precursor.offsets![r + 1] > precursor.offsets![r]) precursorMz[r] = (precursor.values as Float32Array)[precursor.offsets![r]]
        }
        const spectra: StoredSpectra = {
          psmSpectrum: Int32Array.from({ length: n }, (_, r) => r),
          offsets: peakMz.offsets,
          mz: peakMz.values,
          intensity: peakIntensity.values,
          precursorMz,
          // not read: the web app took it as a fallback NCE for its own predictions; these are ProSE's
          collisionEnergy: new Float32Array(n).fill(NaN),
        }
        return { id, startTime, spectra }
      }),
    )

  /**
   * The mz row of each PSM row of input k (−1: none): the order of each spectrum's first PSM; if the mz view has another
   * number of rows (a PSM's spectrum not found), or that order turned out wrong (`byIds`), by the ids of all its rows.
   */
  const mzRowsOf = (k: number, layout: Layout) =>
    once(mzRows, k, async () => {
      const n = from[k + 1] - from[k]
      const out = new Int32Array(n).fill(-1)
      const first = new Map<string, number>()
      for (let r = 0; r < n; r++) {
        const id = rows.nativeId[from[k] + r]
        // no native ID (QPX spectrum_reference null): ProSE stored no spectrum for the PSM, and it has no mz row
        if (id === '') continue
        let m = first.get(id)
        if (m === undefined) {
          m = first.size
          first.set(id, m)
        }
        out[r] = m
      }
      const total = layout.starts[layout.starts.length - 1]
      if (total === first.size && !byIds.has(k)) return out
      // by the ids
      const rowOf = new Map<string, number>()
      for (let g = 0; g < layout.metadata.row_groups.length; g++) {
        const file = await inFile(mzName(k), () => groupFile(mzName(k), layout, g, ['id']))
        const ids = readLeaf(file, ['id'], 'values', [g]).values as unknown[]
        ids.forEach((id, r) => rowOf.set(String(id), layout.starts[g] + r))
      }
      for (let r = 0; r < n; r++) {
        const id = rows.nativeId[from[k] + r]
        out[r] = id === '' ? -1 : (rowOf.get(id) ?? -1)
      }
      return out
    })

  /** The peak filter of input k's mz view (its footer). */
  const filterOf = (layout: Layout): PeakFilter | null => {
    const footer = new Map((layout.metadata.key_value_metadata ?? []).map((kv) => [kv.key, kv.value ?? '']))
    const top = Number(footer.get('prose_peak_top') ?? 0)
    return top > 0 ? { top, window: Number(footer.get('prose_peak_window') ?? 0) } : null
  }

  /** Keeps the last CACHED_GROUPS row groups of each kind. */
  const trim = () => {
    for (const cache of [predictionCache, peakCache] as Map<string, unknown>[]) {
      const keys = [...cache.keys()]
      for (const key of keys.slice(0, Math.max(0, keys.length - CACHED_GROUPS))) cache.delete(key)
    }
  }
  /** Marks `key` of `cache` as used last. */
  const touch = <T>(cache: Map<string, T>, key: string) => {
    const p = cache.get(key)
    if (p) {
      cache.delete(key)
      cache.set(key, p)
    }
  }

  const noSpectra: StoredSpectra = {
    psmSpectrum: new Int32Array(0),
    offsets: new Uint32Array(1),
    mz: new Float32Array(0),
    intensity: new Float32Array(0),
    precursorMz: new Float64Array(0),
    collisionEnergy: new Float32Array(0),
  }

  return {
    predictions,
    async load(row: number): Promise<LoadedSpectra> {
      let k = 0
      while (k + 1 < from.length && row >= from[k + 1]) k++
      if (!(row >= 0) || k >= stems.length) throw new Error(`There is no PSM row ${row}.`)
      const local = row - from[k]

      // the prediction: the same row of the input's psm file (whose psm_id has to be the row's)
      await folderOf(k)
      const psmLayout = await layoutOf(psmName(k))
      if (psmLayout.starts[psmLayout.starts.length - 1] !== from[k + 1] - from[k]) {
        throw new Error(`${psmName(k)}: ${psmLayout.starts[psmLayout.starts.length - 1]} rows, but ${MERGED_PSMS} has ${from[k + 1] - from[k]} of this input`)
      }
      const [g, at] = groupOf(psmLayout, local)
      touch(predictionCache, `${k}/${g}`)
      const { psmId, predicted } = await predictionsOf(k, psmLayout, g)
      if (psmId[at] !== rows.psmId[row]) throw new Error(`${psmName(k)}: its row ${local} is another PSM than the search's (psm_id)`)

      // the spectrum: its row in the input's mz view (whose id has to be the PSM's native ID); none without the view
      let mzLayout: Layout | null = null
      try {
        mzLayout = await layoutOf(mzName(k))
      } catch (e) {
        if (!isNotFound((e as { cause?: unknown }).cause ?? e)) throw e
      }
      let spectra = noSpectra
      let spectrumRow = -1
      let peakFilter: PeakFilter | null = null
      /** The mz row of the PSM and its row group, checked against its native ID (null: none). */
      const spectrumOf = async (layout: Layout) => {
        const m = (await mzRowsOf(k, layout))[local]
        if (m < 0) return null
        const [mg, mat] = groupOf(layout, m)
        touch(peakCache, `${k}/${mg}`)
        const peaks = await peaksOf(k, layout, mg)
        return { m, mat, peaks, matches: String(peaks.id[mat]) === rows.nativeId[row] }
      }
      // (another load of this input may switch it to its ids meanwhile: one that began before must retry too)
      const byIdsBefore = byIds.has(k)
      let found = mzLayout ? await spectrumOf(mzLayout) : null
      if (mzLayout && found && !found.matches && !byIdsBefore) {
        // the order of the PSMs did not give the rows (spectra missing and others duplicated): by their ids, once
        if (!byIds.has(k)) {
          byIds.add(k)
          mzRows.delete(k)
        }
        found = await spectrumOf(mzLayout)
      }
      if (found && !found.matches) {
        throw new Error(`${mzName(k)}: its row ${found.m} is the spectrum ${String(found.peaks.id[found.mat])}, not the PSM's ${rows.nativeId[row]}`)
      }
      // the row of its native ID is another spectrum's (of several spectra of one native ID, the view has the first's):
      // the PSM has none
      const own =
        found !== null && (Number.isNaN(rows.rt[row]) || !(Math.abs(found.peaks.startTime[found.mat] * 60 - rows.rt[row]) > 0.05))
      if (mzLayout && found && own) {
        spectra = found.peaks.spectra
        spectrumRow = found.mat
        if (Number.isNaN(spectra.precursorMz[found.mat])) spectra.precursorMz[found.mat] = rows.precursorMz[row]
        peakFilter = filterOf(mzLayout)
      }
      trim()
      return { spectra, spectrumRow, predicted, row: at, peakFilter }
    },
  }
}
