import { describe, expect, it } from 'vitest'
import { libraryFragments, lossType } from './fragments'

describe('the loss type of a fragment', () => {
  it('names no loss, one water and one ammonia', () => {
    expect(lossType('y5')).toBe('noloss')
    expect(lossType('y5++')).toBe('noloss')
    expect(lossType('b3+')).toBe('noloss')
    expect(lossType('y5-H2O1+')).toBe('H2O')
    expect(lossType('b3-H3N1++')).toBe('NH3')
  })

  it('calls any other loss, and several, unknown', () => {
    expect(lossType('y4-C1H2N1O1+')).toBe('unknown')
    expect(lossType('y14-C1H4O1S1+++')).toBe('unknown')
    expect(lossType('y5-H2O1-H3N1+')).toBe('unknown')
    expect(lossType('b2-H3O4P1+')).toBe('unknown')
  })

  it('calls every nucleotide-shifted ion unknown, whatever its losses (4SU too)', () => {
    for (const shifted of ["y9+C'-NH3", "b2+U'", "y5+U'-H2O++", 'b5+C-NH3', 'y3+U', 'y3+G-NH3-H3PO4', 'b2+C-H3PO4', 'b4+tU-H2S', 'y6+tU', 'b3+S-H2S1+', 'y2+A++']) {
      expect(lossType(shifted), shifted).toBe('unknown')
    }
  })
})

describe('the fragments of an annotation', () => {
  const annotation =
    '416.2268,1.0,2,"[M+2H] C\'-NH3"|244.1633,0.0276,1,"y2"|423.2377,0.0095,1,"a3+C\'-NH3"|451.2260,0.0328,1,"b3+C\'-NH3"|' +
    '110.0718,0.2,1,"iH+"|136.0761,0.1,1,"MI:A\'+"|231.1,0.05,1,"AD-CO-H2O1+"|300.2,0.04,2,"y5-H2O1++"|503.3,0.3,1,"c4"|' +
    '831.4417,0.0276,1,"[M+H] C\'-NH3"'

  it('keeps the b and y ions, by m/z, at the annotated m/z and intensity, with the peak charge', () => {
    expect(libraryFragments(annotation)).toEqual([
      { type: 'y', ordinal: 2, charge: 1, mz: 244.1633, intensity: 0.0276, label: 'y2', loss: 'noloss' },
      { type: 'y', ordinal: 5, charge: 2, mz: 300.2, intensity: 0.04, label: 'y5-H2O1++', loss: 'H2O' },
      { type: 'b', ordinal: 3, charge: 1, mz: 451.226, intensity: 0.0328, label: "b3+C'-NH3", loss: 'unknown' },
    ])
  })

  it('has none of an empty annotation', () => {
    expect(libraryFragments('')).toEqual([])
    expect(libraryFragments('110.07,0.2,1,"iH+"')).toEqual([])
  })
})
