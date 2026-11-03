import { describe, expect, it } from 'vitest'
import { chimericRank, isCoisolated, sameSpectrum } from './coisolated'
import { makeTables } from './synthetic'

// Co-isolated precursors: ProSE's chimeric_rank among the PSM features, and the PSMs of one spectrum.

/** PSMs of two inputs: scan 1 of input 0 has three precursors, scan 2 one, scan 1 of input 1 two. */
function tables(ranks: number[] | null) {
  const t = makeTables({
    files: ['a.mzML', 'b.mzML'],
    proteins: [{ accession: 'P1', sequence: 'AAAAAKCCCCCKDDDDDKEEEEEK' }],
    peptides: ['AAAAAK', 'CCCCCK', 'DDDDDK', 'EEEEEK'].map((sequence) => ({ sequence, proteins: [0] })),
    psms: [
      { peptide: 0, file: 0, nativeId: 'scan=1' },
      { peptide: 1, file: 0, nativeId: 'scan=2' },
      { peptide: 2, file: 0, nativeId: 'scan=1' },
      { peptide: 3, file: 1, nativeId: 'scan=1' },
      { peptide: 1, file: 0, nativeId: 'scan=1' },
      { peptide: 0, file: 1, nativeId: 'scan=1' },
      // (no spectrum stored: no native ID)
      { peptide: 2, file: 0, nativeId: '' },
      { peptide: 3, file: 0, nativeId: '' },
    ],
  })
  if (ranks === null) return t
  // two features, chimeric_rank the second
  const features = new Float64Array(ranks.length * 2)
  ranks.forEach((r, i) => ((features[i * 2] = 5), (features[i * 2 + 1] = r)))
  return { ...t, psms: { ...t.psms, featureNames: ['ln(hyperscore)', 'chimeric_rank'], features } }
}

describe('co-isolated precursors', () => {
  it('reads the chimeric rank, and marks rank 2 and up as co-isolated', () => {
    const { psms } = tables([1, 1, 3, 2, 2, 1, 1, 2])
    expect(chimericRank(psms, 0)).toBe(1)
    expect(chimericRank(psms, 2)).toBe(3)
    expect([0, 1, 2, 3, 4, 5].map((i) => isCoisolated(psms, i))).toEqual([false, false, true, true, true, false])
  })

  it('has none in a search without them', () => {
    const { psms } = tables(null)
    expect(chimericRank(psms, 0)).toBeNaN()
    expect(isCoisolated(psms, 0)).toBe(false)
    expect(sameSpectrum(psms, 0)).toEqual([])
  })

  it('links the PSMs of the same spectrum: same input and native ID, by rank', () => {
    const { psms } = tables([1, 1, 3, 2, 2, 1, 1, 2])
    expect(sameSpectrum(psms, 0)).toEqual([4, 2])
    expect(sameSpectrum(psms, 2)).toEqual([0, 4])
    expect(sameSpectrum(psms, 4)).toEqual([0, 2])
    // scan=1 of the other input is another spectrum
    expect(sameSpectrum(psms, 3)).toEqual([5])
    expect(sameSpectrum(psms, 5)).toEqual([3])
    // alone in its spectrum
    expect(sameSpectrum(psms, 1)).toEqual([])
    // no native ID: no spectrum to share
    expect(sameSpectrum(psms, 6)).toEqual([])
    expect(sameSpectrum(psms, 7)).toEqual([])
  })
})
