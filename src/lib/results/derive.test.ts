import { describe, expect, test } from 'vitest'
import { annotatePeaks } from '../psm/annotate'
import { modificationMass, parseOpenmsSequence, proformaString, tableModifications, unimodAccession, type Modification } from './derive'

describe('peptide strings', () => {
  const oxidation: Modification = { position: 2, name: 'Oxidation', unimod: 35, mass: 15.994915 }
  const acetyl: Modification = { position: -1, name: 'Acetyl', unimod: 1, mass: 42.010565 }
  const amidated: Modification = { position: 4, name: 'Amidated', unimod: 2, mass: -0.984016 }

  test('as ProForma with Unimod names', () => {
    expect(proformaString('AVMDK', [acetyl, oxidation])).toBe('[Acetyl]-AVM[Oxidation]DK')
    expect(proformaString('AVMD', [amidated])).toBe('AVMD-[Amidated]')
    // a modification without a Unimod accession: its mass delta
    expect(proformaString('AVMDK', [{ position: 2, name: '+15.9949', unimod: -1, mass: 15.9949 }])).toBe('AVM[+15.9949]DK')
  })

  test('a mass-only modification is written with 4 decimals, so that it resolves to a named one', () => {
    // the full double (15.994915…); OpenMS takes the tolerance from the digits written
    const unnamed: Modification = { position: 2, name: '', unimod: -1, mass: 15.99491461956 }
    const negative: Modification = { position: 5, name: '-0.98401558291', unimod: -1, mass: -0.98401558291 }
    expect(proformaString('AVMDK', [unnamed])).toBe('AVM[+15.9949]DK')
    expect(proformaString('AVMDA', [negative])).toBe('AVMDA-[-0.9840]')
    // the annotation reads the 4 decimals as the named modification (Oxidation, with its CH4OS loss)
    const named = annotatePeaks(new Float32Array(), new Float32Array(), 'AVM(Oxidation)DK', 2, { losses: true })
    const byMass = annotatePeaks(new Float32Array(), new Float32Array(), 'AVM[+15.9949]DK', 2, { losses: true })
    expect(byMass.theoretical).toEqual(named.theoretical)
  })

  test('the mass of a modification: the pin\'s Unimod table, or the mass of a mass-only name', () => {
    expect(modificationMass('Oxidation', 35)).toBeCloseTo(15.994915, 9)
    expect(modificationMass('Carbamidomethyl', -1)).toBeCloseTo(57.021464, 9)
    expect(modificationMass('[+15.9949]', -1)).toBeCloseTo(15.9949, 9)
    expect(modificationMass('-17.0265', -1)).toBeCloseTo(-17.0265, 9)
    expect(Number.isNaN(modificationMass('NoSuchModification', -1))).toBe(true)
  })
})

describe('parseOpenmsSequence and tableModifications', () => {
  const noAdduct = () => NaN
  test("OpenNuXL's sequences: adducts in parentheses, Unimod names, terminal and mass-only modifications", () => {
    expect(parseOpenmsSequence('AEADNLDDK(NuXL:U-H3O4P1)K')).toEqual({
      sequence: 'AEADNLDDKK',
      mods: [{ position: 8, name: 'NuXL:U-H3O4P1', mass: NaN, absolute: false }],
    })
    expect(parseOpenmsSequence('.(Acetyl)M(Oxidation)PEPTIDER.(Amidated)').mods.map((m) => [m.position, m.name])).toEqual([
      [-1, 'Acetyl'],
      [0, 'Oxidation'],
      [9, 'Amidated'],
    ])
    expect(parseOpenmsSequence('PEPK(Label:13C(6)15N(2))').mods[0].name).toBe('Label:13C(6)15N(2)')
    expect(parseOpenmsSequence('M[+15.9949]K[147.0354]').mods).toEqual([
      { position: 0, name: '', mass: 15.9949, absolute: false },
      { position: 1, name: '', mass: 147.0354, absolute: true },
    ])
    expect(() => parseOpenmsSequence('PEPK(Oxidation')).toThrow(/no '\)'/)
    expect(() => parseOpenmsSequence('PEP K')).toThrow(/unexpected/)
    expect(() => parseOpenmsSequence('M[abc]')).toThrow(/no mass/)
  })

  test('the table modifications: Unimod by name and accession, adducts without their prefix, masses as deltas', () => {
    const { sequence, mods } = parseOpenmsSequence('.(Acetyl)M(UniMod:35)C(Carbamidomethyl)K(NuXL:U-H3O4P1)M[147.0354]S[+79.9663]')
    const adduct = (id: string) => (id === 'NuXL:U-H3O4P1' ? 226.058973 : NaN)
    expect(tableModifications(sequence, mods, adduct)).toEqual([
      { position: -1, name: 'Acetyl', unimod: 1, mass: 42.010565 },
      { position: 0, name: 'Oxidation', unimod: 35, mass: 15.994915 },
      { position: 1, name: 'Carbamidomethyl', unimod: 4, mass: 57.021464 },
      { position: 2, name: 'U-H3O4P1', unimod: -1, mass: 226.058973 },
      { position: 3, name: '+15.9949', unimod: -1, mass: 147.0354 - 131.040485 },
      { position: 4, name: '+79.9663', unimod: -1, mass: 79.9663 },
    ])
    expect(tableModifications('K', [{ position: 0, name: 'NoSuchMod', mass: NaN, absolute: false }], noAdduct)).toEqual([
      { position: 0, name: 'NoSuchMod', unimod: -1, mass: NaN },
    ])
    expect(unimodAccession('Phospho')).toBe(21)
    expect(unimodAccession('NoSuchMod')).toBe(-1)
  })
})
