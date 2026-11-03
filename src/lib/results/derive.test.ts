import { describe, expect, test } from 'vitest'
import { annotatePeaks } from '../psm/annotate'
import {
  countEnzymatic,
  generatedDecoy,
  isEnz,
  modificationMass,
  openmsString,
  pinEnzymeName,
  proformaString,
  reversePeptides,
  webIonName,
  type Modification,
} from './derive'

describe('the .pin features (PercolatorInfile)', () => {
  test('names the enzyme as ProSE does for Percolator', () => {
    expect(pinEnzymeName('Trypsin/P')).toBe('trypsinp')
    expect(pinEnzymeName('Trypsin')).toBe('trypsin')
    expect(pinEnzymeName('Lys-C')).toBe('lys-c')
    expect(pinEnzymeName('PepsinA')).toBe('pepsin')
    expect(pinEnzymeName('leukocyte elastase')).toBe('no_enzyme')
    expect(pinEnzymeName('')).toBe('no_enzyme')
  })

  test('cleaves as Percolator\'s rule table (isEnz_)', () => {
    expect(isEnz('K', 'A', 'trypsin')).toBe(true)
    expect(isEnz('K', 'P', 'trypsin')).toBe(false)
    expect(isEnz('K', 'P', 'trypsinp')).toBe(true)
    expect(isEnz('-', 'A', 'trypsin')).toBe(true)
    // the protein terminus as the evidence has it ('['), which is not '-': PercolatorInfile passes it as it is
    expect(isEnz('[', 'A', 'trypsin')).toBe(false)
    expect(isEnz('A', ']', 'trypsin')).toBe(false)
    expect(isEnz('A', 'K', 'lys-n')).toBe(true)
    expect(isEnz('A', 'D', 'asp-n')).toBe(true)
    expect(isEnz('E', 'P', 'glu-c')).toBe(false)
    expect(isEnz('A', 'B', 'no_enzyme')).toBe(true)
    expect(countEnzymatic('PEPKTIDERPK', 'trypsin')).toBe(1)
    expect(countEnzymatic('PEPKTIDERPK', 'trypsinp')).toBe(2)
  })
})

describe('peptide strings', () => {
  const oxidation: Modification = { position: 2, name: 'Oxidation', unimod: 35, mass: 15.994915 }
  const acetyl: Modification = { position: -1, name: 'Acetyl', unimod: 1, mass: 42.010565 }
  const amidated: Modification = { position: 4, name: 'Amidated', unimod: 2, mass: -0.984016 }

  test('as AASequence.toString() writes them', () => {
    expect(openmsString('AVMDK', [oxidation])).toBe('AVM(Oxidation)DK')
    expect(openmsString('AVMDK', [acetyl, oxidation])).toBe('.(Acetyl)AVM(Oxidation)DK')
    expect(openmsString('AVMD', [amidated])).toBe('AVMD.(Amidated)')
    expect(openmsString('AVMDK', [])).toBe('AVMDK')
  })

  test('as ProForma with Unimod names', () => {
    expect(proformaString('AVMDK', [acetyl, oxidation])).toBe('[Acetyl]-AVM[Oxidation]DK')
    expect(proformaString('AVMD', [amidated])).toBe('AVMD-[Amidated]')
    // a modification without a Unimod accession: its mass delta
    expect(proformaString('AVMDK', [{ position: 2, name: '+15.9949', unimod: -1, mass: 15.9949 }])).toBe('AVM[+15.9949]DK')
  })

  test('a mass-only modification is written with 4 decimals, so that it resolves to a named one', () => {
    // QPX gives the full double (15.994915…); OpenMS takes the tolerance from the digits written
    const unnamed: Modification = { position: 2, name: '', unimod: -1, mass: 15.99491461956 }
    const acetylMass: Modification = { position: -1, name: '', unimod: -1, mass: 42.0105646837 }
    const negative: Modification = { position: 5, name: '-0.98401558291', unimod: -1, mass: -0.98401558291 }
    expect(openmsString('AVMDK', [unnamed])).toBe('AVM[+15.9949]DK')
    expect(openmsString('AVMDK', [acetylMass])).toBe('.[+42.0106]AVMDK')
    expect(openmsString('AVMDA', [negative])).toBe('AVMDA.[-0.9840]')
    expect(proformaString('AVMDK', [unnamed])).toBe('AVM[+15.9949]DK')
    // the annotation reads it as the named modification (Oxidation, with its CH4OS loss)
    const named = annotatePeaks(new Float32Array(), new Float32Array(), 'AVM(Oxidation)DK', 2, { losses: true })
    const byMass = annotatePeaks(new Float32Array(), new Float32Array(), openmsString('AVMDK', [unnamed]), 2, { losses: true })
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

describe('generated decoys (ProSEAlgorithm, DecoyGenerator)', () => {
  test('reverse the peptides of the enzyme, keeping the cleavage sites', () => {
    // Trypsin/P: after every K and R
    expect(reversePeptides('ABCKDEFRGHI', 'Trypsin/P')).toBe('CBAKFEDRIHG')
    // Trypsin: not before P
    expect(reversePeptides('ABCKPEFRGHI', 'Trypsin')).toBe('FEPKCBARIHG')
    expect(reversePeptides('ABC', 'Trypsin')).toBe('CBA')
  })

  test('keep the initial M when ProSE clips it, reverse the whole protein when unspecific', () => {
    const decoys = (keepInitialMet: boolean, unspecific: boolean) => ({ enzyme: 'Trypsin/P', keepInitialMet, unspecific })
    expect(generatedDecoy('MABKCD', decoys(true, false))).toBe('MBAKDC')
    expect(generatedDecoy('MABKCD', decoys(false, false))).toBe('BAMKDC')
    expect(generatedDecoy('MABKCD', decoys(true, true))).toBe('MDCKBA')
  })
})

test('ion names as the web app writes them', () => {
  expect(webIonName('b3+')).toBe('b3')
  expect(webIonName('y5++')).toBe('y5++')
  expect(webIonName('y12+')).toBe('y12')
})
