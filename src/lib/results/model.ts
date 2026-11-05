// The results model: the engine's `ResultTables` aggregated per sample, for the three levels of the
// results view (proteins, peptides, PSMs). Everything is a typed array indexed by the row of its table
// (protein, peptide or PSM index); no per-row objects. `filters.ts` filters and sorts such indices,
// `csv.ts` writes them.

import type { DesignResolution, Sample } from '../design/model'
import type { ResultTables } from '../results/types'
import { markCovered } from './protein'

export type Level = 'proteins' | 'peptides' | 'psms'

/**
 * One column of the per-sample counts. `index` is the column's position in `ResultModel.samples` (the
 * `Sample.index` of the design is `designSample`), so `perSample[row * samples.length + index]` is the
 * count of the column.
 */
export type ResultSample = Sample & {
  /** The biological sample of the design (`DesignResolution.samples[designSample]`). */
  designSample: number
  /** Which measurement of the sample this column is (1, 2, ...); `null` when the column is the whole sample. */
  techReplicate: number | null
}

/** The columns of one condition, as `ResultModel.samples` indices, grouped by biological sample. */
export type ConditionColumns = {
  /** `null`: the samples without a condition, which count as one group. */
  name: string | null
  /** One entry per biological sample: its column (merged) or its columns (one per technical replicate). */
  samples: number[][]
}

/** The PSM counts of the peptides at one q-value cutoff. */
export type PeptideCounts = {
  /** Per peptide: its PSMs at or below the cutoff. */
  psms: Uint32Array
  /** `count × samples.length`: `psms` per column. */
  perSample: Uint32Array
  /** Per peptide: the biological samples (Condition + Replicate) with at least one of those PSMs. */
  foundIn: Uint16Array
}

export type ResultModel = {
  tables: ResultTables
  design: DesignResolution
  /**
   * The columns of the per-sample counts, in the order of the design. Without `showTechReplicates`
   * this is one column per biological sample of the searched files (the fractions and the technical
   * replicates of a sample are summed, and the sample counts as found if any of them found it).
   * With it, a sample that was measured more than once has one column per technical replicate
   * ("EGF 1 · TR1", "EGF 1 · TR2"; the fractions of one measurement are still summed), and the other
   * samples stay one column. A column belongs to a condition through `condition`. Splitting the
   * technical replicates only changes the count columns: "found in" always counts biological samples.
   */
  samples: ResultSample[]
  showTechReplicates: boolean
  /** `psms.score` is Percolator's (every file was rescored), else NuXL's (NuXL:score) for every PSM. */
  rescored: boolean
  /**
   * The search's cutoffs. Each PSM has that of its kind (`psmCutoff`): a peptide PSM `psmFdr` (OpenNuXL's peptide
   * FDR), a cross-link PSM (`tables.psms.xl.isXL`) `xlFdr`. A PSM above its cutoff is no evidence: it is not counted
   * anywhere, and the filters can only tighten the values.
   */
  psmFdr: number
  xlFdr: number
  proteinFdr: number
  conditionColumns: ConditionColumns[]
  /** Per PSM row: its column in `samples`. */
  psmSample: Uint16Array
  /** The cross-link PSMs within `xlFdr` (any, the key figures count them); 0: a search without cross-links. */
  xlPsms: number
  /**
   * The peptide (peptidoform) rows. `psms`, `perSample` and `foundIn` count the PSMs within `psmFdr`;
   * the Peptides table shows the counts at its own cutoff, which `peptideCounts` gives.
   */
  peptide: PeptideCounts & {
    /** Per peptide: the lowest q-value of any of its PSMs (NaN: none has one). The peptide level's FDR. */
    bestQ: Float64Array
    /**
     * Per peptide: the lowest peptide-level q-value of its peptide PSMs (`psms.xl.peptideQValue`; NaN: none has one).
     * A peptide without cross-link passes a peptide FDR only with this below it as well (`passesPeptideQ`).
     */
    bestPeptideQ: Float64Array
    /** Per peptide: the proteins it maps to (views of `tables.peptides.protein`). */
    proteins: Uint32Array[]
    /** Per peptide: 1 if it maps only to contaminants (`CON__` accessions). */
    contaminant: Uint8Array
    /** Per peptide: the mass of its adduct (Da, from its PSMs); NaN: none. */
    adductMass: Float64Array
    /** Per peptide: the cross-linked nucleotides of its PSMs, distinct, in the order met ('U', 'U,C'); '' none. */
    nucleotides: string[]
  }
  /** All protein counts are at the search's `psmFdr`: the protein filter is the protein q-value. */
  protein: {
    /** 0–1: the share of the protein's residues that the peptides with PSMs cover. */
    coverage: Float64Array
    /**
     * Its peptides with PSMs, counted by plain sequence: a sequence and its modified forms are one
     * peptide here (the Peptides table lists them as separate rows).
     */
    peptides: Uint32Array
    /** Their PSMs (a peptide shared by proteins counts for each of them). */
    psms: Uint32Array
    /** Of `psms`, the cross-link PSMs: a protein with any is cross-linked. */
    xlPsms: Uint32Array
    /** `count × samples.length`. */
    perSample: Uint32Array
    contaminant: Uint8Array
    /** The biological samples (Condition + Replicate) with at least one PSM. */
    foundIn: Uint16Array
    /**
     * The peptide references of each protein (also those without PSMs within `psmFdr`):
     * `peptide[offsets[p] .. offsets[p + 1]]` are its peptides and `ref` the matching indices into
     * `tables.peptides.protein/start/end` (the location in the protein).
     */
    members: { offsets: Uint32Array; peptide: Uint32Array; ref: Uint32Array }
  }
  /** Per column of `samples`: its design sample (the columns of one sample are adjacent). */
  columnSample: Uint16Array
  /**
   * Per PSM row: its curation mark (curation.ts: 0 none, 1 accepted, 2 rejected). The results view owns the array
   * and changes it in place (`ResultsView.curation`); a model of its own has one without marks.
   */
  curation: Uint8Array
  /** Per PSM row (only those with one): the user's note. Owned by the results view as `curation` is. */
  curationNotes: Map<number, string>
}

/** Contaminants of the cRAP database carry this accession prefix. */
export const contaminantPrefix = 'CON__'

/** The q-value limit that applies: `maxQ`, but never above the search's cutoff (NaN or missing: the cutoff). */
export function qLimit(maxQ: number, cutoff: number): number {
  return maxQ <= cutoff ? maxQ : cutoff // false for NaN, too
}

/** The search's cutoff of PSM `i`: `xlFdr` for a cross-link, else `psmFdr` (the peptide FDR). */
export function psmCutoff(m: Pick<ResultModel, 'tables' | 'psmFdr' | 'xlFdr'>, i: number): number {
  return m.tables.psms.xl.isXL[i] ? m.xlFdr : m.psmFdr
}

/**
 * The q-value limits of a level's filter by kind: the peptide PSMs' (`maxQ`) and the cross-link PSMs' (`maxXlQ`),
 * each limited by its search cutoff (`qLimit`).
 */
export type QLimits = { peptide: number; xl: number }

export function qLimits(m: Pick<ResultModel, 'psmFdr' | 'xlFdr'>, maxQ: number, maxXlQ: number): QLimits {
  return { peptide: qLimit(maxQ, m.psmFdr), xl: qLimit(maxXlQ, m.xlFdr) }
}

/**
 * Whether PSM `i` passes the limits of its kind (`passesQ` at its search cutoff); a peptide PSM also by its
 * peptide-level q-value (`passesPeptideQ`), as OpenNuXL filters it.
 */
export function psmPasses(m: Pick<ResultModel, 'tables' | 'psmFdr' | 'xlFdr'>, i: number, limits: QLimits): boolean {
  const ps = m.tables.psms
  return ps.xl.isXL[i]
    ? passesQ(ps.qValue[i], limits.xl, m.xlFdr)
    : passesQ(ps.qValue[i], limits.peptide, m.psmFdr) && passesPeptideQ(ps.xl.peptideQValue[i], limits.peptide)
}

/**
 * Whether a peptide PSM's peptide-level q-value (`psms.xl.peptideQValue`) passes the peptide FDR `limit`.
 * NuXLFDR::calculatePeptideAndXLQValueAndFilterAtPSMLevel filters the non-cross-linked PSMs at report:peptideFDR t
 * twice: it drops those whose 'peptide q-value' is t or more, then keeps those of PSM q-value at most t; it filters
 * only for 0 < t < 1. The shim runs it with report:peptideFDR 0 (no filter), so the app applies both. NaN (none)
 * passes.
 */
export function passesPeptideQ(peptideQ: number, limit: number): boolean {
  return !(limit > 0 && limit < 1 && peptideQ >= limit)
}

/**
 * Whether target PSM `i` is within the search's cutoffs, as OpenNuXL would have reported it: a cross-link at q ≤
 * `xlFdr`, a peptide at q ≤ `peptideFdr` and peptide q-value < `peptideFdr` (`passesPeptideQ`). A PSM without
 * q-value counts.
 */
export function withinCutoffs(ps: ResultTables['psms'], i: number, peptideFdr: number, xlFdr: number): boolean {
  return ps.xl.isXL[i] ? !(ps.qValue[i] > xlFdr) : !(ps.qValue[i] > peptideFdr) && passesPeptideQ(ps.xl.peptideQValue[i], peptideFdr)
}

/**
 * Whether a q-value passes `limit` (`qLimit` of the filter) at a level whose search cutoff is `cutoff`. A row
 * without a q-value (NaN: the search did not apply the FDR to it, e.g. the PSMs of a file without decoy PSMs, or the
 * proteins of a search without protein FDR) passes the search's own cutoff, which did not filter it, but no tighter
 * one: nothing shows that it would pass.
 */
export function passesQ(q: number, limit: number, cutoff: number): boolean {
  return q === q ? q <= limit : limit >= cutoff
}

/** The biological samples with a count in the row `base / nS`: columns of one sample are adjacent. */
function samplesFound(counts: Uint32Array, base: number, nS: number, columnSample: Uint16Array): number {
  let found = 0
  let last = -1
  for (let s = 0; s < nS; s++) {
    if (counts[base + s] > 0 && columnSample[s] !== last) {
      found++
      last = columnSample[s]
    }
  }
  return found
}

/**
 * The peptides' PSMs within the limits of their kind (`psmPasses`: a missing q-value counts at the search's cutoff
 * only), in total, per column and as samples found.
 */
function countPsms(
  c: Pick<ResultModel, 'tables' | 'psmFdr' | 'xlFdr' | 'psmSample' | 'columnSample'>,
  limits: QLimits,
): PeptideCounts {
  const t = c.tables
  const { psmSample, columnSample } = c
  const nPep = t.peptides.count
  const nS = columnSample.length
  const psms = new Uint32Array(nPep)
  const perSample = new Uint32Array(nPep * nS)
  const { peptide } = t.psms
  for (let i = 0; i < t.psms.count; i++) {
    if (!psmPasses(c, i, limits)) continue
    const k = peptide[i]
    psms[k]++
    perSample[k * nS + psmSample[i]]++
  }
  const foundIn = new Uint16Array(nPep)
  for (let k = 0; k < nPep; k++) foundIn[k] = samplesFound(perSample, k * nS, nS, columnSample)
  return { psms, perSample, foundIn }
}

const countsCache = new WeakMap<ResultModel, Map<string, PeptideCounts>>()
const cachedCutoffs = 8

/**
 * The peptides' PSM counts for a Peptides table whose "best PSM q-value" filters are `maxQ` (peptide PSMs) and
 * `maxXlQ` (cross-link PSMs; default: `maxQ`): the PSMs counted are those within min(limit, cutoff) of their kind,
 * so the numbers agree with the PSM table behind the same cutoffs. At or above the search's cutoffs (and for NaN)
 * this is `m.peptide`; other cutoffs are counted once (one pass over the PSMs) and the last few are kept. Use these
 * arrays for the peptide columns (`psms`, `sample:<n>`, `foundIn`) of that table, its sorting and its CSV.
 */
export function peptideCounts(m: ResultModel, maxQ: number, maxXlQ = maxQ): PeptideCounts {
  const limits = qLimits(m, maxQ, maxXlQ)
  if (limits.peptide >= m.psmFdr && limits.xl >= m.xlFdr) return m.peptide
  let cache = countsCache.get(m)
  if (!cache) countsCache.set(m, (cache = new Map()))
  const key = `${limits.peptide} ${limits.xl}`
  let counts = cache.get(key)
  if (!counts) {
    counts = countPsms(m, limits)
    if (cache.size >= cachedCutoffs) cache.delete(cache.keys().next().value!)
    cache.set(key, counts)
  }
  return counts
}

export const baseName = (path: string) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)

/**
 * `rescored`: the PSMs' scores are Percolator's, every file rescored (it names the score columns; default false).
 * `psmFdr` (the peptide PSMs'), `xlFdr` (the cross-link PSMs'; default `psmFdr`) and `proteinFdr` are the cutoffs
 * of the search that made `t` (0 < q ≤ 1); the counts depend on them. The design must be that of the searched files: the same number
 * of rows, in the same order, each file named as the row says (`tables.files[i]` may carry
 * directories, e.g. `/input/<i>/<fileName>`).
 */
export function buildModel(
  t: ResultTables,
  d: DesignResolution,
  opts: { showTechReplicates: boolean; psmFdr: number; xlFdr?: number; proteinFdr: number; rescored?: boolean; curation?: Uint8Array; curationNotes?: Map<number, string> },
): ResultModel {
  const { showTechReplicates, psmFdr, proteinFdr } = opts
  const xlFdr = opts.xlFdr ?? psmFdr
  const rescored = opts.rescored ?? false
  for (const [name, value] of [['psmFdr', psmFdr], ['xlFdr', xlFdr], ['proteinFdr', proteinFdr]] as const) {
    if (!(value > 0 && value <= 1)) throw new Error(`${name} must be a q-value above 0 and at most 1, not ${value}`)
  }

  // The columns: the design rows are in the order of the searched files.
  const nFiles = t.files.length
  if (d.rows.length !== nFiles) {
    throw new Error(`The design has ${d.rows.length} rows but ${nFiles} files were searched`)
  }
  for (let i = 0; i < nFiles; i++) {
    if (baseName(t.files[i]) !== baseName(d.rows[i].fileName)) {
      throw new Error(`The design does not match the searched files: file ${i + 1} is "${t.files[i]}" but the design row says "${d.rows[i].fileName}"`)
    }
  }
  const measurements = new Map<number, Set<number>>() // design sample -> its technical replicates
  for (let i = 0; i < nFiles; i++) {
    const row = d.rows[i]
    const seen = measurements.get(row.sample)
    if (seen) seen.add(row.techReplicate)
    else measurements.set(row.sample, new Set([row.techReplicate]))
  }
  const samples: ResultSample[] = []
  const columnOf = new Map<string, number>()
  for (const designSample of [...measurements.keys()].sort((a, b) => a - b)) {
    const base = d.samples[designSample]
    const techs = [...measurements.get(designSample)!].sort((a, b) => a - b)
    if (showTechReplicates && techs.length > 1) {
      for (const tech of techs) {
        columnOf.set(`${designSample}\0${tech}`, samples.length)
        samples.push({ ...base, index: samples.length, label: `${base.label} · TR${tech}`, designSample, techReplicate: tech })
      }
    } else {
      for (const tech of techs) columnOf.set(`${designSample}\0${tech}`, samples.length)
      samples.push({ ...base, index: samples.length, designSample, techReplicate: null })
    }
  }
  const fileColumn = new Uint16Array(nFiles)
  for (let i = 0; i < nFiles; i++) fileColumn[i] = columnOf.get(`${d.rows[i].sample}\0${d.rows[i].techReplicate}`)!
  const columnSample = Uint16Array.from(samples, (s) => s.designSample)

  // the columns of each condition, by biological sample (samples are ordered by condition already)
  const byCondition = new Map<string | null, Map<number, number[]>>()
  for (const s of samples) {
    let bySample = byCondition.get(s.condition)
    if (!bySample) byCondition.set(s.condition, (bySample = new Map()))
    const columns = bySample.get(s.designSample)
    if (columns) columns.push(s.index)
    else bySample.set(s.designSample, [s.index])
  }
  const conditionColumns: ConditionColumns[] = [...byCondition].map(([name, bySample]) => ({
    name,
    samples: [...bySample.values()],
  }))

  const nS = samples.length
  const ps = t.psms
  const pt = t.peptides
  const pr = t.proteins

  // PSMs -> columns, and the peptides' counts and best q-values
  const psmSample = new Uint16Array(ps.count)
  for (let i = 0; i < ps.count; i++) psmSample[i] = fileColumn[ps.file[i]]
  const nPep = pt.count
  const bestQ = new Float64Array(nPep).fill(NaN)
  for (let i = 0; i < ps.count; i++) {
    const k = ps.peptide[i]
    const q = ps.qValue[i]
    if (q === q && !(q >= bestQ[k])) bestQ[k] = q // the first q-value replaces NaN
  }
  const bestPeptideQ = new Float64Array(nPep).fill(NaN)
  for (let i = 0; i < ps.count; i++) {
    if (ps.xl.isXL[i]) continue
    const k = ps.peptide[i]
    const q = ps.xl.peptideQValue[i]
    if (q === q && !(q >= bestPeptideQ[k])) bestPeptideQ[k] = q
  }
  // a PSM above the search's cutoff of its kind is no evidence
  const atSearch = { tables: t, psmFdr, xlFdr, psmSample, columnSample }
  const limits = { peptide: psmFdr, xl: xlFdr }
  const { psms: pepPsms, perSample: pepPer, foundIn: pepFoundIn } = countPsms(atSearch, limits)
  // the peptides' cross-link PSMs (a peptide's PSMs are normally all of its kind), adduct masses and nucleotides
  const pepXlPsms = new Uint32Array(nPep)
  const adductMass = new Float64Array(nPep).fill(NaN)
  const nucleotideSets: (string[] | null)[] = new Array(nPep).fill(null)
  let xlPsms = 0
  for (let i = 0; i < ps.count; i++) {
    const k = ps.peptide[i]
    if (ps.xl.adduct[i] !== '' && adductMass[k] !== adductMass[k]) adductMass[k] = ps.xl.adductMass[i]
    const nt = ps.xl.nucleotide[i]
    if (nt !== '') {
      const set = nucleotideSets[k]
      if (!set) nucleotideSets[k] = [nt]
      else if (!set.includes(nt)) set.push(nt)
    }
    if (ps.xl.isXL[i] && psmPasses(atSearch, i, limits)) {
      pepXlPsms[k]++
      if (!ps.decoy[i]) xlPsms++
    }
  }
  const nucleotides = nucleotideSets.map((set) => (set ? set.join(',') : ''))

  const refOffsets = pt.proteinOffsets
  const nRefs = refOffsets[nPep]
  const pepProteins: Uint32Array[] = new Array(nPep)
  const pepContaminant = new Uint8Array(nPep)
  const nProt = pr.count
  const proContaminant = new Uint8Array(nProt)
  for (let p = 0; p < nProt; p++) proContaminant[p] = pr.accession[p].startsWith(contaminantPrefix) ? 1 : 0
  for (let k = 0; k < nPep; k++) {
    const from = refOffsets[k]
    const to = refOffsets[k + 1]
    pepProteins[k] = pt.protein.subarray(from, to)
    let all = to > from
    for (let r = from; r < to && all; r++) all = proContaminant[pt.protein[r]] === 1
    pepContaminant[k] = all ? 1 : 0
  }

  // proteins -> their peptide references (CSR)
  const memberOffsets = new Uint32Array(nProt + 1)
  for (let r = 0; r < nRefs; r++) memberOffsets[pt.protein[r] + 1]++
  for (let p = 0; p < nProt; p++) memberOffsets[p + 1] += memberOffsets[p]
  const memberPeptide = new Uint32Array(nRefs)
  const memberRef = new Uint32Array(nRefs)
  const cursor = memberOffsets.slice(0, nProt)
  for (let k = 0; k < nPep; k++) {
    for (let r = refOffsets[k]; r < refOffsets[k + 1]; r++) {
      const at = cursor[pt.protein[r]]++
      memberPeptide[at] = k
      memberRef[at] = r
    }
  }

  // The proteins' counts. A peptide's PSMs count once for each of its proteins, even when it lists a
  // protein twice; the peptides are counted by plain sequence.
  const sequenceId = new Uint32Array(nPep)
  const ids = new Map<string, number>()
  for (let k = 0; k < nPep; k++) {
    let id = ids.get(pt.sequence[k])
    if (id === undefined) ids.set(pt.sequence[k], (id = ids.size))
    sequenceId[k] = id
  }
  const seenSequence = new Int32Array(ids.size).fill(-1) // the last protein that counted the sequence
  const seenPeptide = new Int32Array(nPep).fill(-1)
  const proPeptides = new Uint32Array(nProt)
  const proPsms = new Uint32Array(nProt)
  const proXlPsms = new Uint32Array(nProt)
  const proPer = new Uint32Array(nProt * nS)
  const proFoundIn = new Uint16Array(nProt)
  for (let p = 0; p < nProt; p++) {
    for (let m = memberOffsets[p]; m < memberOffsets[p + 1]; m++) {
      const k = memberPeptide[m]
      if (pepPsms[k] === 0 || seenPeptide[k] === p) continue
      seenPeptide[k] = p
      proPsms[p] += pepPsms[k]
      proXlPsms[p] += pepXlPsms[k]
      for (let s = 0; s < nS; s++) proPer[p * nS + s] += pepPer[k * nS + s]
      if (seenSequence[sequenceId[k]] !== p) {
        seenSequence[sequenceId[k]] = p
        proPeptides[p]++
      }
    }
    proFoundIn[p] = samplesFound(proPer, p * nS, nS, columnSample)
  }

  // coverage: the union of the peptides' stretches, marked in a scratch strip (the protein panel
  // uses the same `markCovered`)
  let longest = 0
  for (let p = 0; p < nProt; p++) longest = Math.max(longest, pr.sequence[p].length)
  const strip = new Uint8Array(longest)
  const members = { offsets: memberOffsets, peptide: memberPeptide, ref: memberRef }
  const coverage = new Float64Array(nProt)
  for (let p = 0; p < nProt; p++) {
    const length = pr.sequence[p].length
    if (length > 0) coverage[p] = markCovered(strip, length, members, p, pepPsms, pt.start, pt.end) / length
  }

  return {
    tables: t,
    design: d,
    samples,
    showTechReplicates,
    rescored,
    psmFdr,
    xlFdr,
    proteinFdr,
    conditionColumns,
    psmSample,
    xlPsms,
    peptide: {
      bestQ,
      bestPeptideQ,
      psms: pepPsms,
      perSample: pepPer,
      foundIn: pepFoundIn,
      proteins: pepProteins,
      contaminant: pepContaminant,
      adductMass,
      nucleotides,
    },
    protein: {
      coverage,
      peptides: proPeptides,
      psms: proPsms,
      xlPsms: proXlPsms,
      perSample: proPer,
      contaminant: proContaminant,
      foundIn: proFoundIn,
      members,
    },
    columnSample,
    curation: opts.curation ?? new Uint8Array(t.psms.count),
    curationNotes: opts.curationNotes ?? new Map(),
  }
}
