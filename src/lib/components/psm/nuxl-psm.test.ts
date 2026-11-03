import { describe, expect, it } from 'vitest'
import type { PsmOptionState } from '$lib/psm/psm'
import { classifyLabel, type NuxlPeak } from '$lib/psm/nuxl-annotation'
import {
  canonicalFormula,
  categoryOf,
  featureGroups,
  groupNuxl,
  legendOf,
  linearPeptide,
  lossToggle,
  massErrors,
  nuxlCharges,
  nuxlIonTable,
  nuxlLabel,
  nuxlLadder,
  placeAnnotation,
  resolveNuxlOptions,
  siteResidues,
  visibleNuxl,
  CATEGORY_COLORS,
  type LocalToggles,
} from './nuxl-psm'

const peak = (mz: number, label: string, intensity = 0.5, charge = 1): NuxlPeak => ({ mz, intensity, charge, label })
const user: PsmOptionState = { ions: ['b', 'y'], charges: null, losses: null, precursor: false }
const local: LocalToggles = { shifted: true, marker: true, immonium: true, internal: false }
const PPM20 = { value: 20, unit: 'ppm' as const }

describe('labels', () => {
  it('reads with subscripts and without counts of one, the ion number as it is', () => {
    expect(nuxlLabel('y1-H2O1+')).toBe('y1-H₂O+')
    expect(nuxlLabel('y12+')).toBe('y12+')
    expect(nuxlLabel('MI:U-H3PO4+')).toBe('MI:U-H₃PO₄+')
    expect(nuxlLabel("b3+U'-H2O+")).toBe("b3+U'-H₂O+")
    expect(nuxlLabel('[M+2H]+U-H3PO4++')).toBe('[M+2H]+U-H₃PO₄++')
  })

  it('has canonical formulas and loss toggles', () => {
    expect(canonicalFormula('H3N1')).toBe(canonicalFormula('NH3'))
    expect(canonicalFormula('H2O1')).toBe('H2O')
    expect(lossToggle('H2O1')).toBe('H2O')
    expect(lossToggle('H3N1')).toBe('NH3')
    expect(lossToggle('C1H2N2')).toBe('other')
    expect(lossToggle('')).toBe('')
  })

  it('colours by kind: prefix, suffix, shifted, marker, the others', () => {
    expect(categoryOf(classifyLabel('b3+'))).toBe('prefix')
    expect(categoryOf(classifyLabel('a2+'))).toBe('prefix')
    expect(categoryOf(classifyLabel('y5++'))).toBe('suffix')
    expect(categoryOf(classifyLabel("y3+U'+"))).toBe('shifted')
    expect(categoryOf(classifyLabel('MI:U-H3PO4+'))).toBe('marker')
    expect(categoryOf(classifyLabel('[M+H]+'))).toBe('precursor')
    expect(categoryOf(classifyLabel('iY+'))).toBe('immonium')
    expect(categoryOf(classifyLabel('HT'))).toBe('internal')
    expect(legendOf(['shifted', 'prefix', 'immonium']).map((l) => l.text)).toEqual(['a/b/c ions', 'shifted ions', 'other ions'])
  })
})

describe('the annotation on the peaks', () => {
  const annotation = [peak(175.119, 'y1+'), peak(416.161, 'b3+'), peak(415.201, "y3+U'+"), peak(227.066, 'MI:U-H3PO4+'), peak(900, 'y8+')]
  annotation.sort((a, b) => a.mz - b.mz)
  const observed = Float32Array.from([175.1192, 227.0661, 415.2012, 416.1608, 600])

  it('places each annotated peak on the nearest observed peak within the tolerance', () => {
    const { matches, unplaced } = placeAnnotation(annotation, observed, PPM20)
    expect(unplaced).toBe(1)
    expect(matches.map((m) => [m.label, m.peak])).toEqual([
      ['y1+', 0],
      ['MI:U-H3PO4+', 1],
      ["y3+U'+", 2],
      ['b3+', 3],
    ])
  })

  it('without observed peaks, puts each on its own', () => {
    const { matches, unplaced } = placeAnnotation(annotation, null, PPM20)
    expect(unplaced).toBe(0)
    expect(matches.map((m) => m.peak)).toEqual([0, 1, 2, 3, 4])
  })

  it('shows what the toggles show', () => {
    const { matches } = placeAnnotation(annotation, observed, PPM20)
    const o = resolveNuxlOptions(user, local, [1])
    expect(visibleNuxl(matches, o).map((m) => m.label)).toEqual(['y1+', 'MI:U-H3PO4+', "y3+U'+", 'b3+'])
    expect(visibleNuxl(matches, { ...o, shifted: false, marker: false }).map((m) => m.label)).toEqual(['y1+', 'b3+'])
    expect(visibleNuxl(matches, { ...o, ions: ['b'] }).map((m) => m.label)).toEqual(['MI:U-H3PO4+', 'b3+'])
  })

  it('groups the ions of a peak, unshifted ones first', () => {
    const { matches } = placeAnnotation([peak(500, "b4+U'+"), peak(500.001, 'y4+')], Float32Array.from([500]), PPM20)
    const [g] = groupNuxl(matches, Float32Array.from([500]), Float32Array.from([10]))
    expect(g.label).toBe("y4+ / b4+U'+")
    expect(g.color).toBe(CATEGORY_COLORS.suffix)
  })

  it('offers the charges NuXL annotated, at least 2+ for a precursor of 2+, at most the precursor', () => {
    const { matches } = placeAnnotation([peak(300, 'y5+++', 0.5, 3)], null, PPM20)
    expect(nuxlCharges(1, [])).toEqual([1])
    expect(nuxlCharges(3, [])).toEqual([1, 2])
    expect(nuxlCharges(4, matches)).toEqual([1, 2, 3])
    expect(nuxlCharges(2, matches)).toEqual([1, 2])
    expect(resolveNuxlOptions(user, local, [1, 2]).charges).toEqual([1, 2])
    expect(resolveNuxlOptions({ ...user, charges: [2] }, local, [1]).charges).toEqual([1])
    expect(resolveNuxlOptions({ ...user, losses: ['NH3'] }, local, [1]).losses).toEqual(['NH3'])
  })
})

describe('the linear peptide', () => {
  it('leaves out the adduct', () => {
    expect(linearPeptide('DY(NuXL:U-H3O4P1)HTVLGAR')).toBe('DYHTVLGAR')
    expect(linearPeptide('M(Oxidation)VFC(NuXL:UU-H3O4P1)K')).toBe('M(Oxidation)VFCK')
    expect(linearPeptide('.(NuXL:U)PEPTIDE')).toBe('PEPTIDE')
    expect(linearPeptide('PEPTIDE.(NuXL:U)')).toBe('PEPTIDE')
    expect(linearPeptide('PEPTIDE.(Amidated)')).toBe('PEPTIDE.(Amidated)')
  })

  const theoretical = [
    { ion: 'b2', type: 'b', ordinal: 2, charge: 1, mz: 279.0975 },
    { ion: 'b3', type: 'b', ordinal: 3, charge: 1, mz: 416.1564 },
    { ion: 'y1', type: 'y', ordinal: 1, charge: 1, mz: 175.119 },
    { ion: 'y1-NH3', type: 'y', ordinal: 1, charge: 1, mz: 158.0924 },
    { ion: 'y2', type: 'y', ordinal: 2, charge: 1, mz: 246.1561 },
  ]

  it('gives the mass errors of the unshifted ions against their theoretical m/z', () => {
    const mz = Float32Array.from([158.0925, 175.119, 416.1608, 500])
    const { matches } = placeAnnotation([peak(158.0925, 'y1-H3N1+'), peak(175.119, 'y1+'), peak(416.1608, 'b3+'), peak(500, "b3+U'+")], mz, PPM20)
    const errors = massErrors(matches, theoretical, mz)
    expect(errors.map((e) => e.ion)).toEqual(['y1-H₃N+', 'y1+', 'b3+'])
    expect(errors[2].errorPpm).toBeCloseTo(((mz[2] - 416.1564) / 416.1564) * 1e6, 6)
  })

  it('makes the ladder and the ion table, unshifted and shifted', () => {
    const { matches } = placeAnnotation([peak(175.119, 'y1+'), peak(416.16, 'b3+'), peak(500, "b2+U'+")], null, PPM20)
    const ladder = nuxlLadder(matches, 4)
    expect(ladder.n).toEqual([null, { type: null, shifted: true }, { type: 'b', shifted: false }])
    expect(ladder.c).toEqual([null, null, { type: 'y', shifted: false }])
    const o = resolveNuxlOptions(user, local, [1])
    const table = nuxlIonTable(theoretical, matches, 4, o)
    expect(table.n.map((c) => c.header)).toEqual(['b⁺', 'b⁺ shifted'])
    expect(table.c.map((c) => c.header)).toEqual(['y⁺'])
    expect(table.rows[1].n).toEqual([{ ion: 'b2', mz: 279.0975, matched: false }, { ion: "b2+U'+", mz: 500, matched: true, title: "b2+U'+ m/z 500.0000", shift: "+U'", more: 0 }])
    expect(table.rows[2].n[0]).toEqual({ ion: 'b3', mz: 416.1564, matched: true })
    expect(table.rows[3].c[0]).toEqual({ ion: 'y1', mz: 175.119, matched: true })
  })
})

describe('the header and the features', () => {
  it('marks the candidate residues and the site', () => {
    expect(siteResidues('DyHTVLGAR', 1).slice(0, 3)).toEqual([
      { residue: 'D', candidate: false, site: false },
      { residue: 'Y', candidate: true, site: true },
      { residue: 'H', candidate: false, site: false },
    ])
  })

  it('groups the features, the main scores first', () => {
    const groups = featureGroups(['missed_cleavages', 'NuXL:MIC', 'NuXL:pl_MIC', 'NuXL:marker_ions_score', 'NuXL:score', 'NuXL:NA_MASS_z0', 'isotope_error'])
    expect(groups.map((g) => g.title)).toEqual(['Scores', 'Ion matches', 'Shifted ions (partial loss)', 'Precursor and adduct', 'Other'])
    expect(groups[0].features.map((f) => f.label)).toEqual(['score', 'marker_ions_score'])
    expect(groups[4].features.map((f) => f.name)).toEqual(['missed_cleavages'])
  })
})
