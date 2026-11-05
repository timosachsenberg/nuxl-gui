import { describe, expect, it } from 'vitest'
import { fitIrt, readIrtReference, referenceText, toIrt } from './irt'

describe('the iRT reference', () => {
  it("reads EasyPQP's columns (AverageExperimentalRetentionTime, NormalizedRetentionTime), rows with both", () => {
    const text =
      'PrecursorMz\tNormalizedRetentionTime\tAverageExperimentalRetentionTime\n' +
      '270.16\t-41.98\t1061.8\n' +
      '270.16\t-41.98\t1061.8\n' +
      '300.1\t\t1200\n' +
      '310.2\t10.5\t1500\n'
    expect(readIrtReference(text)).toEqual({ rt: [1061.8, 1061.8, 1500], irt: [-41.98, -41.98, 10.5] })
  })

  it('prefers RT and iRT, as nuxl2dia.py', () => {
    expect(readIrtReference('RT\tiRT\tNormalizedRetentionTime\r\n10\t1\t99\r\n')).toEqual({ rt: [10], irt: [1] })
  })

  it('says which column it lacks', () => {
    expect(() => readIrtReference('RT\tother\n1\t2\n')).toThrow('no iRT or NormalizedRetentionTime column')
    expect(() => readIrtReference('iRT\n1\n')).toThrow('no RT or AverageExperimentalRetentionTime column')
  })

  it('reads a gzip-compressed reference', async () => {
    const text = 'RT\tiRT\n1\t2\n'
    const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())
    expect(await referenceText(gz)).toBe(text)
    expect(await referenceText(new TextEncoder().encode(text))).toBe(text)
  })
})

describe('the iRT fit', () => {
  it('is the least-squares line (not n/(n−1) too steep)', () => {
    // iRT = 2 RT − 10, with noise that cancels: Sxy 1000, Sxx 500 (nuxl2dia.py's fallback: 1000/3 / 125 = 2.67)
    const fit = fitIrt([0, 10, 20, 30], [-9, 9, 29, 51])
    expect(fit.slope).toBeCloseTo(2, 12)
    expect(fit.intercept).toBeCloseTo(-10, 12)
    expect(fit.points).toBe(4)
    expect(toIrt(fit, 15)).toBeCloseTo(20, 12)
    expect(Number.isNaN(toIrt(fit, NaN))).toBe(true)
    expect(Number.isNaN(toIrt(null, 15))).toBe(true)
  })

  it('needs two retention times', () => {
    expect(() => fitIrt([1], [2])).toThrow('one row')
    expect(() => fitIrt([], [])).toThrow('no row')
    expect(() => fitIrt([5, 5], [1, 2])).toThrow('the same retention time')
  })
})
