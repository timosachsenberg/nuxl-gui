/// <reference types="node" />
// NuXL's fragment annotation: parsed from the fragment_annotation of OpenNuXL's own outputs, and its labels read.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { readIdXML, textColumn } from '../results/idxml'
import { classifyLabel, parseFragmentAnnotation } from './nuxl-annotation'

describe('parseFragmentAnnotation', () => {
  test('the peaks of a value, by ascending m/z; a label with commas and bars in quotes', () => {
    expect(parseFragmentAnnotation('')).toEqual([])
    expect(parseFragmentAnnotation('300.5,0.5,2,"y5++"|112.05,0.028,1,"MI:C\'+"|1,2,"broken"|200,1,1,"a,b|c"')).toEqual([
      { mz: 112.05, intensity: 0.028, charge: 1, label: "MI:C'+" },
      { mz: 200, intensity: 1, charge: 1, label: 'a,b|c' },
      { mz: 300.5, intensity: 0.5, charge: 2, label: 'y5++' },
    ])
  })

  test("every label of OpenNuXL's outputs is read", () => {
    const kinds = new Map<string, number>()
    for (const n of [1, 6]) {
      const x = readIdXML(new Uint8Array(readFileSync(new URL(`../results/fixtures/nuxl/OpenNuXL_${n}_output.idXML`, import.meta.url))))
      for (const value of textColumn(x.hits.params, 'fragment_annotation', x.hits.count)) {
        for (const p of parseFragmentAnnotation(value)) {
          const ion = classifyLabel(p.label, p.charge)
          expect(ion.kind, p.label).not.toBe('unknown')
          expect(ion.charge, p.label).toBe(p.charge)
          kinds.set(ion.kind, (kinds.get(ion.kind) ?? 0) + 1)
        }
      }
    }
    expect([...kinds.keys()].sort()).toEqual(['a', 'b', 'immonium', 'internal', 'marker', 'precursor', 'y'])
  })
})

describe('classifyLabel', () => {
  const ion = (kind: string, more: object = {}) => ({ kind, ordinal: 0, charge: 1, loss: '', shift: '', residues: '', ...more })
  test.each([
    ['y5+', 1, ion('y', { ordinal: 5 })],
    ['b3++', 2, ion('b', { ordinal: 3, charge: 2 })],
    ['y1-H2O1+', 1, ion('y', { ordinal: 1, loss: 'H2O1' })],
    ["y5+U'-H2O++", 2, ion('y', { ordinal: 5, charge: 2, shift: "U'-H2O" })],
    ["b2+U'+", 1, ion('b', { ordinal: 2, shift: "U'" })],
    ["MI:A'+", 1, ion('marker', { shift: "A'" })],
    ['MI:U-H3PO4+', 1, ion('marker', { shift: 'U-H3PO4' })],
    ['[M+H]+', 1, ion('precursor')],
    ['[M+H-H2O]+', 1, ion('precursor', { loss: 'H2O' })],
    ["[M+2H]+U'-H2O++", 2, ion('precursor', { charge: 2, shift: "U'-H2O" })],
    ['[M+2H-H2O]+U-H3PO4++', 2, ion('precursor', { charge: 2, loss: 'H2O', shift: 'U-H3PO4' })],
    ['[M+2H+U-H2O1]++', 2, ion('precursor', { charge: 2, shift: 'U-H2O1' })],
    ['[M+2H]-CH4S', 2, ion('precursor', { charge: 2, loss: 'CH4S' })],
    ["iK(C5H10N1)U'-H2O+", 1, ion('immonium', { residues: 'K', shift: "U'-H2O" })],
    ['iW+U+', 1, ion('immonium', { residues: 'W', shift: 'U' })],
    ['iF+', 1, ion('immonium', { residues: 'F' })],
    ['AD-CO-H2O1+', 1, ion('internal', { residues: 'AD', loss: 'CO-H2O1' })],
    ['QL', 1, ion('internal', { residues: 'QL' })],
    ['?', 3, ion('unknown', { charge: 3 })],
  ])('%s', (label, charge, expected) => {
    expect(classifyLabel(label, charge)).toEqual(expected)
  })
})
