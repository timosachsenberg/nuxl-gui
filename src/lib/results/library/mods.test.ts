/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adductFormulaMass, diannModLines, MODS_SUFFIX, targetNucleotides } from './mods'

describe("the adducts' masses", () => {
  const rna = targetNucleotides({ 'NuXL:presets': 'RNA-UV (UCGA)' })

  it("are those of NuXLDIA's DIA-NN declarations (3 decimals) for all of its adducts", () => {
    const lines = readFileSync(join(__dirname, 'fixtures', 'declare_mod_UV_UCGA_ext.txt'), 'utf8').split('\n').filter((l) => l.trim() !== '')
    expect(lines.length).toBe(99)
    for (const line of lines) {
      const [, name, mass] = /^--mod ([^,]+),([\d.]+)$/.exec(line.trim())!
      expect(adductFormulaMass(name, rna).toFixed(3), name).toBe(Number(mass).toFixed(3))
    }
  })

  it("agree with OpenNuXL's NuXL:NA_MASS_z0 (the fixtures' idXMLs)", () => {
    const given: [string, number][] = [
      ['U', 324.035869904700007],
      ['U-H2O1', 306.025304840900048],
      ['C-H3N1', 306.025304840899992],
      ['U-H3O4P1', 226.058973319000017],
      ['U-H1O3P1', 244.069538382800005],
      ['AU', 653.088391777500078],
      ['UU-H3O4P1', 532.084278159900009],
      ['CU-H2O1', 611.066593713700058],
      ['GU-H3O4P1', 571.106410191800023],
    ]
    for (const [name, mass] of given) expect(adductFormulaMass(name, rna), name).toBeCloseTo(mass, 9)
  })

  it("take the protocol's nucleotides (4SU, DNA) and formulas added", () => {
    const s4u = targetNucleotides({}, 'RNA-UV (4SU)')
    // S = C9H13N2O8PS; S-H2S1 = C9H11N2O8P
    expect(adductFormulaMass('S-H2S1', s4u)).toBeCloseTo(adductFormulaMass('U-H2O1', s4u), 9)
    expect(Number.isNaN(adductFormulaMass('S', rna))).toBe(true)
    const dna = targetNucleotides({ 'NuXL:presets': 'DNA-UV' })
    expect(adductFormulaMass('T', dna)).toBeCloseTo(322.056605, 5)
    const deb = targetNucleotides({ 'NuXL:presets': 'RNA-DEB' })
    expect(adductFormulaMass('U+C4H6O2-H2O1', deb)).toBeCloseTo(324.03587 + 86.036779 - 18.010565, 5)
    expect(Number.isNaN(adductFormulaMass('U-Xx2', rna))).toBe(true)
  })

  it("take the custom protocol's nucleotides, else OpenNuXL's defaults", () => {
    expect([...targetNucleotides({}).keys()]).toEqual(['A', 'C', 'G', 'U'])
    expect([...targetNucleotides({ 'NuXL:target_nucleotides': ['T=C10H15N2O8P'] }).keys()]).toEqual(['T'])
  })
})

describe("DIA-NN's declarations", () => {
  it('are one --mod line per adduct, by name, with 6 decimals; none for one of unknown mass', () => {
    const { lines, unknown } = diannModLines(
      new Map([
        ['U-H2O1', 306.02530209],
        ['AU', 653.0882],
        ['S', NaN],
      ]),
    )
    expect(lines).toEqual(['--mod AU,653.088200', '--mod U-H2O1,306.025302'])
    expect(unknown).toEqual(['S'])
    expect(MODS_SUFFIX).toBe('_diann_mods.txt')
  })
})
