// Co-isolated precursors (a search with chimeric:enabled): one MS2 spectrum can have PSMs of several
// precursors that were isolated together. ProSE ranks them in the feature chimeric_rank (one of the run's
// extra features, so a column of `tables.psms.features`): 1 for the precursor the spectrum was taken of, 2
// and up for the others of its isolation window. The PSM table marks the co-isolated PSMs, and the PSM view
// links the PSMs of the same spectrum (the same input and native ID).

import type { ResultTables } from './types'

type Psms = ResultTables['psms']

/** The feature of ProSE's rank of a PSM among the precursors of its spectrum. */
export const CHIMERIC_RANK = 'chimeric_rank'

/** The column of chimeric_rank in the features, per PSM table (-1: a search without co-isolated precursors). */
const rankColumns = new WeakMap<Psms, number>()

function rankColumn(psms: Psms): number {
  let j = rankColumns.get(psms)
  if (j === undefined) rankColumns.set(psms, (j = psms.featureNames.indexOf(CHIMERIC_RANK)))
  return j
}

/** ProSE's rank of PSM `i` among the precursors of its spectrum (1: the isolated one); NaN without one. */
export function chimericRank(psms: Psms, i: number): number {
  const j = rankColumn(psms)
  return j < 0 ? NaN : psms.features[i * psms.featureNames.length + j]
}

/** PSM `i` is of a co-isolated precursor: not the one its spectrum was taken of (chimeric rank 2 or more). */
export function isCoisolated(psms: Psms, i: number): boolean {
  return chimericRank(psms, i) >= 2
}

/**
 * The PSMs of each spectrum that has more than one, by input and native ID, per PSM table: made on the
 * first question, and only for a search with co-isolated precursors (other searches have one PSM per
 * spectrum).
 */
const spectra = new WeakMap<Psms, Map<string, number[]>>()

const spectrumKey = (psms: Psms, i: number) => `${psms.file[i]}\u0000${psms.nativeId[i]}`

function spectrumIndex(psms: Psms): Map<string, number[]> {
  let index = spectra.get(psms)
  if (!index) {
    index = new Map()
    if (rankColumn(psms) >= 0) {
      for (let i = 0; i < psms.count; i++) {
        // (no native ID: ProSE stored no spectrum for the PSM, which then shares nothing)
        if (psms.nativeId[i] === '') continue
        const key = spectrumKey(psms, i)
        const rows = index.get(key)
        if (rows) rows.push(i)
        else index.set(key, [i])
      }
      for (const [key, rows] of index) if (rows.length < 2) index.delete(key)
    }
    spectra.set(psms, index)
  }
  return index
}

/**
 * The other PSMs of PSM `i`'s spectrum (the same input and native ID), by chimeric rank, then in table
 * order. None for a search without co-isolated precursors.
 */
export function sameSpectrum(psms: Psms, i: number): number[] {
  if (psms.nativeId[i] === '' || rankColumn(psms) < 0) return []
  const rows = spectrumIndex(psms).get(spectrumKey(psms, i)) ?? []
  const rank = (r: number) => {
    const v = chimericRank(psms, r)
    return v === v ? v : Infinity
  }
  return rows.filter((r) => r !== i).sort((a, b) => rank(a) - rank(b) || a - b)
}

/** What the "co-isolated" marker means (its tooltip). */
export const COISOLATED_TITLE =
  'Co-isolated precursor: ProSE found this peptide in a spectrum taken of another precursor of its isolation window'
