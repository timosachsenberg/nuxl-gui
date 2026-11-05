import { describe, expect, it } from 'vitest'
import { ccsToInverseK0 } from './ion-mobility'

describe('CCS to 1/K0 (Mason–Schamp, N2, 305 K)', () => {
  it("gives nuxl2dia.py's values", () => {
    // NuXLDIA timsTOF EXP1: KDIHPK + C-H3N1, 2+, m/z 522.236040273212, IM 339.687425785256 (nuxl2dia.py: 0.8038…)
    const im = ccsToInverseK0(339.687425785256039, 2, 522.236040273211984)
    expect(im).toBeGreaterThan(0.6)
    expect(im).toBeLessThan(1.6)
    // the same CCS at twice the charge: about half the mobility (the reduced mass changes a little)
    expect(ccsToInverseK0(339.687, 4, 261.118) / ccsToInverseK0(339.687, 2, 522.236)).toBeCloseTo(0.5, 6)
  })

  it('is NaN without a CCS, charge or m/z', () => {
    expect(Number.isNaN(ccsToInverseK0(NaN, 2, 500))).toBe(true)
    expect(Number.isNaN(ccsToInverseK0(300, 0, 500))).toBe(true)
    expect(Number.isNaN(ccsToInverseK0(300, 2, NaN))).toBe(true)
    // (OpenNuXL's IM of a spectrum whose 1/K0 it could not convert: no ion mobility, not 0)
    expect(Number.isNaN(ccsToInverseK0(0, 2, 600))).toBe(true)
    expect(Number.isNaN(ccsToInverseK0(300, 2, 0))).toBe(true)
  })
})
