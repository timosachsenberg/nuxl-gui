// The columns of the three tables: what their sort keys and CSV columns mean. A column is named by
// its id ("psms", "qValue", "sample:1"); `sortRows` takes an id as key and `toCsv` a list of ids.
// The per-sample counts of proteins and peptides are the columns "sample:<n>" (n = the index into
// `ResultModel.samples`); in `toCsv` the id "samples" stands for all of them.
//
// The peptide counts ("psms", "foundIn", "sample:<n>") depend on the cutoff of the Peptides table
// (see `peptideCounts`): the getters get the counts to read as their third argument.

import { parseAccession, parseDescription } from './display'
import { baseName, type Level, type PeptideCounts, type ResultModel } from './model'
import { proteinXlSites } from './protein'

type Get<T> = (m: ResultModel, row: number, peptideCounts: PeptideCounts) => T

export type ColumnDef = {
  /** The header in a CSV file. */
  header: string
  /** The value, for a column that sorts and prints as a number (NaN = missing). */
  number?: Get<number>
  /** The value, for a column that sorts and prints as text. */
  text?: Get<string>
  /** How the column prints in a CSV file when that differs from the number or text. */
  csv?: Get<string>
  /** The CSV cells are text (and need protection against spreadsheet formulas), not numbers. */
  csvText: boolean
  /**
   * A text column of native IDs: it sorts by the scan number when every row has one, else in natural
   * order (digits as numbers, "frame=5" before "frame=12").
   */
  natural?: boolean
}

const num = (header: string, number: Get<number>, csv?: Get<string>): ColumnDef => ({ header, number, csv, csvText: false })
const str = (header: string, text: Get<string>, csv?: Get<string>): ColumnDef => ({ header, text, csv, csvText: true })
/** A column that sorts by a number and prints as text. */
const label = (header: string, number: Get<number>, csv: Get<string>): ColumnDef => ({ header, number, csv, csvText: true })

const accessions = (m: ResultModel, peptide: number) =>
  Array.from(m.peptide.proteins[peptide], (p) => m.tables.proteins.accession[p])

/**
 * An accession as the tables show it (`parseAccession`): "P02768" for "sp|P02768|ALBU_HUMAN", a contaminant
 * without its CON__. The accession columns sort by it (not by the FASTA's prefixes); the CSV has the accession.
 */
const shown = (accession: string | undefined) => (accession === undefined ? '' : parseAccession(accession).id)

const proteins: Record<string, ColumnDef> = {
  accession: str('Accession', (m, p) => shown(m.tables.proteins.accession[p]), (m, p) => m.tables.proteins.accession[p]),
  // the gene name (GN=) of a UniProt-style description; '' without one
  gene: str('Gene', (m, p) => parseDescription(m.tables.proteins.description[p]).gene ?? ''),
  description: str('Description', (m, p) => m.tables.proteins.description[p]),
  // the best PSM score; the header names it (see `columnDef`)
  score: num('Score', (m, p) => m.tables.proteins.score[p]),
  length: num('Length', (m, p) => m.tables.proteins.sequence[p].length),
  coverage: num('Coverage (%)', (m, p) => m.protein.coverage[p], (m, p) => (m.protein.coverage[p] * 100).toFixed(1)),
  peptides: num('Peptides', (m, p) => m.protein.peptides[p]),
  psms: num('PSMs', (m, p) => m.protein.psms[p]),
  // NuXL: the cross-linked residues and the cross-link PSMs, at the search's cross-link FDR
  xlSites: num('XL sites', (m, p) => proteinXlSites(m)[p]),
  xlPsms: num('XL PSMs', (m, p) => m.protein.xlPsms[p]),
  foundIn: num('Found in', (m, p) => m.protein.foundIn[p]),
  contaminant: num('Contaminant', (m, p) => m.protein.contaminant[p]),
  decoy: num('Decoy', (m, p) => m.tables.proteins.decoy[p]),
}

const peptides: Record<string, ColumnDef> = {
  // ProForma, as the table has it: all modifications, fixed ones too
  peptide: str('Peptide', (m, k) => m.tables.peptides.proforma[k]),
  sequence: str('Sequence', (m, k) => m.tables.peptides.sequence[k]),
  length: num('Length', (m, k) => m.tables.peptides.sequence[k].length),
  proteins: str('Proteins', (m, k) => shown(accessions(m, k)[0]), (m, k) => accessions(m, k).join(';')),
  psms: num('PSMs', (_, k, c) => c.psms[k]),
  bestQ: num('Best PSM q-value', (m, k) => m.peptide.bestQ[k]),
  foundIn: num('Found in', (_, k, c) => c.foundIn[k]),
  contaminant: num('Contaminant', (m, k) => m.peptide.contaminant[k]),
  decoy: num('Decoy', (m, k) => m.tables.peptides.decoy[k]),
  // NuXL: the nucleic acid adduct ('' none) and whether the peptide is a cross-link
  adduct: str('Adduct', (m, k) => m.tables.peptides.adduct[k]),
  crossLink: num('Cross-link', (m, k) => m.tables.peptides.isXL[k]),
}

const psms: Record<string, ColumnDef> = {
  // sorts by the file's position in the search, prints its name (without directories)
  file: label('File', (m, i) => m.tables.psms.file[i], (m, i) => baseName(m.tables.files[m.tables.psms.file[i]])),
  sample: label('Sample', (m, i) => m.psmSample[i], (m, i) => m.samples[m.psmSample[i]].label),
  nativeId: { ...str('Spectrum', (m, i) => m.tables.psms.nativeId[i]), natural: true },
  rt: num('RT (s)', (m, i) => m.tables.psms.rt[i]),
  mz: num('m/z', (m, i) => m.tables.psms.mz[i]),
  charge: num('Charge', (m, i) => m.tables.psms.charge[i]),
  // ProForma, as the peptide's (a localized adduct as its mass delta)
  peptide: str('Peptide', (m, i) => m.tables.peptides.proforma[m.tables.psms.peptide[i]]),
  sequence: str('Sequence', (m, i) => m.tables.peptides.sequence[m.tables.psms.peptide[i]]),
  proteins: str(
    'Proteins',
    (m, i) => shown(accessions(m, m.tables.psms.peptide[i])[0]),
    (m, i) => accessions(m, m.tables.psms.peptide[i]).join(';'),
  ),
  // Percolator's score when every file was rescored, else NuXL's (NuXL:score); the header names it (see `columnDef`)
  score: num('Score', (m, i) => m.tables.psms.score[i]),
  qValue: num('q-value', (m, i) => m.tables.psms.qValue[i]),
  pep: num('PEP', (m, i) => m.tables.psms.pep[i]),
  precursorErrorPpm: num('Precursor error (ppm)', (m, i) => m.tables.psms.precursorErrorPpm[i]),
  isotopeError: num('Isotope error', (m, i) => m.tables.psms.isotopeError[i]),
  decoy: num('Decoy', (m, i) => m.tables.psms.decoy[i]),
  // NuXL: the cross-link facts of the PSM (psms.xl)
  crossLink: num('Cross-link', (m, i) => m.tables.psms.xl.isXL[i]),
  adduct: str('Adduct', (m, i) => m.tables.psms.xl.adduct[i]),
  adductMass: num('Adduct mass (Da)', (m, i) => (m.tables.psms.xl.adduct[i] === '' ? NaN : m.tables.psms.xl.adductMass[i])),
  nucleotide: str('Nucleotide', (m, i) => m.tables.psms.xl.nucleotide[i]),
  // the cross-linked residue, 1-based as a residue is named ('K9'); sorts by its position, '' when not localized
  site: label(
    'Site',
    (m, i) => (m.tables.psms.xl.site[i] >= 0 ? m.tables.psms.xl.site[i] + 1 : NaN),
    (m, i) => siteName(m, i),
  ),
  siteScore: num('Site score', (m, i) => m.tables.psms.xl.siteScore[i]),
  fdrGroup: str('FDR group', (m, i) => m.tables.psms.xl.fdrGroup[i]),
}

/** The cross-linked residue of PSM `i` with its 1-based position ('K9'); '' when not localized. */
export function siteName(m: ResultModel, i: number): string {
  const site = m.tables.psms.xl.site[i]
  if (site < 0) return ''
  const residue = m.tables.peptides.sequence[m.tables.psms.peptide[i]][site] ?? ''
  return `${residue}${site + 1}`
}

const tables: Record<Level, Record<string, ColumnDef>> = { proteins, peptides, psms }

/**
 * The column `id` of a level, or `undefined`. "sample:<n>" is the count of sample column n (proteins
 * and peptides; the protein counts are at the search's PSM FDR, the peptide counts are the third
 * argument of the getter).
 */
export function columnDef(m: ResultModel, level: Level, id: string): ColumnDef | undefined {
  if (id === 'score' && level !== 'peptides') {
    const name = m.rescored ? 'Percolator score' : 'NuXL score'
    return { ...tables[level].score, header: level === 'psms' ? name : `Best ${name}` }
  }
  if (Object.hasOwn(tables[level], id)) return tables[level][id]
  const match = level !== 'psms' ? /^sample:(\d+)$/.exec(id) : null
  const sample = match ? Number(match[1]) : -1
  if (sample < 0 || sample >= m.samples.length) return undefined
  const nS = m.samples.length
  const header = m.samples[sample].label
  return level === 'proteins'
    ? num(header, (m, p) => m.protein.perSample[p * nS + sample])
    : num(header, (_, k, c) => c.perSample[k * nS + sample])
}

/** The ids of `columns` with "samples" replaced by "sample:0" ... "sample:<n - 1>". Unknown ids throw. */
export function expandColumns(m: ResultModel, level: Level, columns: string[]): string[] {
  const ids: string[] = []
  for (const id of columns) {
    if (id === 'samples' && level !== 'psms') for (let s = 0; s < m.samples.length; s++) ids.push(`sample:${s}`)
    else if (columnDef(m, level, id)) ids.push(id)
    else throw new Error(`Unknown column "${id}" of the ${level} table`)
  }
  return ids
}
