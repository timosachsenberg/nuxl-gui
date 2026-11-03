import { describe, expect, it } from 'vitest'
import { sampleDesign, sampleTables } from './fixtures'
import { buildModel } from './model'
import { binEdges, countInBins, niceStep, precursorErrors, psmsPerFile, scoreDistribution, symmetricEdges } from './qc'

const model = (opts: { psmFdr: number; rescored?: boolean }, edit?: (t: ReturnType<typeof sampleTables>) => void) => {
  const tables = sampleTables()
  edit?.(tables)
  return buildModel(tables, sampleDesign(), { showTechReplicates: false, proteinFdr: 1, ...opts })
}

describe('bins', () => {
  it('picks the smallest round step that keeps the bins under the limit', () => {
    expect(niceStep(10, 10)).toBe(1)
    expect(niceStep(9.42, 30)).toBe(0.5)
    expect(niceStep(30, 32)).toBe(1)
    expect(niceStep(1.2, 32)).toBe(0.05)
    expect(niceStep(0, 32)).toBe(1) // no span: a unit step
  })

  it('makes round edges that cover the range', () => {
    expect(binEdges(20, 50, 32)).toEqual(Array.from({ length: 31 }, (_, i) => 20 + i))
    const edges = binEdges(-4.05, 5.37, 32)
    expect(edges[0]).toBe(-4.5)
    expect(edges.at(-1)).toBe(5.5)
    expect(edges.length - 1).toBeLessThanOrEqual(32)
    expect(binEdges(5.37, 5.37, 32)).toEqual([5, 6]) // one value: one bin around it
  })

  it('makes edges around zero for symmetric data, with zero an edge', () => {
    const edges = symmetricEdges(5, 32)
    expect(edges[0]).toBe(-5)
    expect(edges.at(-1)).toBe(5)
    expect(edges).toContain(0)
    expect(edges.length % 2).toBe(1) // an even number of bins
    expect(symmetricEdges(0, 32)).toEqual([-1, 0, 1])
    expect(symmetricEdges(3.2, 32)[0]).toBe(-3.2) // the largest value is on the last edge, which closes its bin
  })

  it('counts values in [edge, next edge), the last bin closed, and skips what is outside or not a number', () => {
    const edges = [0, 1, 2, 3]
    expect(countInBins([0, 0.5, 1, 1.5, 2.999, 3, 3.1, -0.1, NaN], edges)).toEqual([2, 2, 2])
    expect(countInBins([], edges)).toEqual([0, 0, 0])
    // a value on an edge belongs to the bin that starts there, whatever the rounding of the edge
    expect(countInBins([0.3], [0.1, 0.2, 0.3, 0.4])).toEqual([0, 0, 1])
  })
})

describe('scoreDistribution', () => {
  it("shows the target PSMs at the search's cutoffs, peptides and cross-links, in shared bins", () => {
    // PSM FDR 5 %: PSMs 0–7 (q ≤ 0.05, scores 40 50 30 45 42 41 40 48); the decoy PSM 8 is left out.
    // PSMs 4–6 (peptide 2) are cross-links here.
    const d = scoreDistribution(model({ psmFdr: 0.05 }, (t) => t.psms.xl.isXL.set([1, 1, 1], 4)))!
    expect(d.scoreName).toBe('NuXL score')
    expect(d.nPeptides).toBe(5)
    expect(d.nCrossLinks).toBe(3)
    expect(d.edges[0]).toBe(30)
    expect(d.edges.at(-1)).toBe(50)
    expect(d.peptides).toHaveLength(d.edges.length - 1)
    expect(d.peptides.reduce((a, b) => a + b, 0)).toBe(5)
    expect(d.crossLinks.reduce((a, b) => a + b, 0)).toBe(3)
    expect(d.peptides.at(-1)).toBe(1) // score 50 is in the last, closed bin
    expect(d.unscored).toBe(0)
  })

  it('leaves the PSMs above the search FDR out', () => {
    const d = scoreDistribution(model({ psmFdr: 0.01 }))!
    expect(d.nPeptides).toBe(7)
    expect(d.nCrossLinks).toBe(0)
    expect(d.crossLinks.every((c) => c === 0)).toBe(true)
  })

  it('names the score after the rescoring and leaves unscored PSMs out', () => {
    const d = scoreDistribution(
      model({ psmFdr: 1, rescored: true }, (t) => {
        t.psms.score[2] = -100 // Percolator could not rescore it: q-value 1
        t.psms.qValue[2] = 1
        t.psms.score[3] = NaN
      }),
    )!
    expect(d.scoreName).toBe('Percolator score')
    expect(d.unscored).toBe(2)
    expect(d.nPeptides).toBe(6)
  })

  it('is null without PSMs at the cutoff', () => {
    expect(scoreDistribution(model({ psmFdr: 0.0001 }))).toBeNull()
  })
})

describe('precursorErrors', () => {
  const errors = (t: ReturnType<typeof sampleTables>) => t.psms.precursorErrorPpm.set([1, -2, 30, 3, -4, 5, NaN, 0.5, 9])

  it('bins the target PSMs at the cutoff around zero, and gives the median', () => {
    // PSM FDR 1 %: PSMs 0 1 3 4 5 6 7 with errors 1 -2 3 -4 5 NaN 0.5 (the decoy and PSM 2 are out)
    const e = precursorErrors(model({ psmFdr: 0.01 }, errors))!
    expect(e.considered).toBe(7)
    expect(e.n).toBe(6)
    expect(e.counts.reduce((a, b) => a + b, 0)).toBe(6)
    expect(e.edges[0]).toBe(-e.edges.at(-1)!)
    expect(e.edges).toContain(0)
    expect(e.median).toBeCloseTo(0.75) // -4 -2 0.5 1 3 5
  })

  it('keeps the axis at ±1 ppm at least: masses that are exact (the example) are one tall bar, not numerical noise stretched over the axis', () => {
    const e = precursorErrors(model({ psmFdr: 0.01 }, (t) => t.psms.precursorErrorPpm.set([1.2e-9, -1.2e-9, 3e-10, -4e-10, 1e-9, -2e-9, 5e-10, 0, 0])))!
    expect(e.edges[0]).toBe(-1)
    expect(e.edges.at(-1)).toBe(1)
    expect(e.n).toBe(7)
    expect(e.counts.reduce((a, b) => a + b, 0)).toBe(7)
    expect(e.counts[e.edges.indexOf(0)]).toBe(7) // the bin from 0 up
    expect(Math.abs(e.median)).toBeLessThan(1e-6)
  })

  it('is null without a precursor error', () => {
    expect(precursorErrors(model({ psmFdr: 0.01 }, (t) => t.psms.precursorErrorPpm.fill(NaN)))).toBeNull()
  })
})

describe('psmsPerFile', () => {
  it("counts the target PSMs at the cutoff per searched file, in the order of the search", () => {
    expect(psmsPerFile(model({ psmFdr: 0.01 }))).toEqual([
      { file: 'ctrl_a.mzML', count: 3 }, // PSMs 0 1 3 (the decoy is out)
      { file: 'egf_a.mzML', count: 4 }, // PSMs 4 5 6 7 (PSM 2 has q 0.02)
    ])
    expect(psmsPerFile(model({ psmFdr: 1 })).map((f) => f.count)).toEqual([3, 4 + 1]) // PSM 2 now counts
  })

  it('lists a file without PSMs with 0', () => {
    expect(psmsPerFile(model({ psmFdr: 0.0001 })).map((f) => f.count)).toEqual([0, 0])
  })
})
