/// <reference types="node" />
// The theoretical m/z of NuXL's annotated ions, against OpenNuXL's own outputs: every label of every hit of the
// OpenNuXL_1, _3 and _6 test outputs (searched with OpenNuXL's default fragment adducts, no preset, at a fragment
// tolerance of 20 ppm) is computed, within the tolerance of the observed m/z NuXL annotated it at.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { readIdXML, textColumn, numberColumn } from '../results/idxml'
import { classifyLabel, parseFragmentAnnotation } from './nuxl-annotation'
import { nuxlChemistry, nuxlPeptide, nuxlTheoreticalMz, searchChemistry, DEFAULT_FRAGMENT_ADDUCTS } from './nuxl-theoretical'

const PROTON = 1.007276466771

/** The kind of a label as the coverage counts it. */
function kindOf(label: string, charge: number): string {
  const ion = classifyLabel(label, charge)
  if (['a', 'b', 'c', 'x', 'y', 'z'].includes(ion.kind)) return ion.shift !== '' ? 'shifted' : ion.loss !== '' ? 'loss' : 'plain'
  if (ion.kind === 'precursor' || ion.kind === 'immonium') return ion.shift !== '' ? `shifted ${ion.kind}` : ion.kind
  return ion.kind
}

describe("OpenNuXL's annotated ions", () => {
  const chemistry = searchChemistry({})!

  test.each([1, 3, 6])('OpenNuXL_%i: every annotated ion has its theoretical m/z within the fragment tolerance', (n) => {
    const id = readIdXML(new Uint8Array(readFileSync(new URL(`../results/fixtures/nuxl/OpenNuXL_${n}_output.idXML`, import.meta.url))))
    const sp = id.searchParameters[0]
    expect([sp.fragmentTolerance, sp.fragmentToleranceUnit]).toEqual([20, 'ppm'])
    const { hits } = id
    const annotation = textColumn(hits.params, 'fragment_annotation', hits.count)
    const na = textColumn(hits.params, 'NuXL:NA', hits.count)
    const naMass = numberColumn(hits.params, 'NuXL:NA_MASS_z0', hits.count)
    const coverage = new Map<string, { labels: number; computed: number }>()
    const failures: string[] = []
    let worst = 0
    for (let h = 0; h < hits.count; h++) {
      const peptide = nuxlPeptide(hits.sequence[h], undefined, na[h] === 'none' ? '' : na[h], naMass[h])
      for (const p of parseFragmentAnnotation(annotation[h])) {
        const kind = kindOf(p.label, p.charge)
        const c = coverage.get(kind) ?? { labels: 0, computed: 0 }
        coverage.set(kind, c)
        c.labels++
        const t = nuxlTheoreticalMz(p.label, p.charge, peptide, chemistry, p.mz)
        if (t.mz === null) {
          failures.push(`${hits.sequence[h]} ${p.label}: ${t.reason}`)
          continue
        }
        const ppm = ((p.mz - t.mz) / t.mz) * 1e6
        worst = Math.max(worst, Math.abs(ppm))
        if (Math.abs(ppm) > 20) failures.push(`${hits.sequence[h]} ${p.label} at ${p.mz}: theoretical ${t.mz} (${ppm.toFixed(1)} ppm)`)
        else c.computed++
      }
    }
    console.log(`OpenNuXL_${n}: worst ${worst.toFixed(2)} ppm;`, Object.fromEntries([...coverage].map(([k, v]) => [k, `${v.computed}/${v.labels}`])))
    expect(failures, failures.slice(0, 20).join('\n')).toEqual([])
    for (const kind of ['shifted', 'marker', 'plain', 'loss', 'precursor', 'shifted precursor', 'immonium', 'shifted immonium', 'internal']) {
      expect(coverage.get(kind)?.labels, kind).toBeGreaterThan(0)
    }
  })
})

describe('nuxlTheoreticalMz', () => {
  const chemistry = nuxlChemistry(DEFAULT_FRAGMENT_ADDUCTS, true)
  const peptide = nuxlPeptide('DY(NuXL:U-H3O4P1)HTVLGAR', undefined, 'U-H3O4P1', 226.05897)

  test('a shifted ion is the ion plus the fragment adduct per charge', () => {
    const y5 = nuxlTheoreticalMz('y5+', 1, peptide, chemistry).mz!
    const y5u = nuxlTheoreticalMz("y5+U'-H2O+", 1, peptide, chemistry).mz!
    // U'-H2O: C4H2N2O1
    expect(y5u - y5).toBeCloseTo(4 * 12 + 2 * 1.0078250319 + 2 * 14.003074 + 15.994915, 9)
    const y5uu = nuxlTheoreticalMz("y5+U'-H2O++", 2, peptide, chemistry).mz!
    expect(y5uu * 2 - PROTON).toBeCloseTo(y5u, 9)
  })

  test('a marker ion is the nucleotide fragment plus a proton', () => {
    // MI:U-H3PO4 C9H10N2O5 = 226.05897 + p; MI:A' (a default marker ion) C5H5N5 = 135.05450 + p (not
    // NuXLMarkerIonExtractor's 136.06231, which adds H)
    expect(nuxlTheoreticalMz('MI:U-H3PO4+', 1, peptide, chemistry).mz).toBeCloseTo(227.06625, 4)
    expect(nuxlTheoreticalMz("MI:A'+", 1, peptide, chemistry).mz).toBeCloseTo(136.06177, 4)
  })

  test('the precursor, with losses, shifted, with the whole nucleic acid', () => {
    const mh = nuxlTheoreticalMz('[M+H]+', 1, peptide, chemistry).mz!
    expect(mh).toBeCloseTo(peptide.fullMono + PROTON, 9)
    expect(nuxlTheoreticalMz('[M+2H-H2O]++', 2, peptide, chemistry).mz).toBeCloseTo((peptide.fullMono - 18.010565 + 2 * PROTON) / 2, 5)
    expect(nuxlTheoreticalMz('[M+2H+U-H3O4P1]++', 2, peptide, chemistry).mz).toBeCloseTo((peptide.fullMono + 226.05897 + 2 * PROTON) / 2, 9)
    expect(nuxlTheoreticalMz('[M+2H-H2O]+U-H3PO4++', 2, peptide, chemistry).mz).toBeCloseTo((peptide.fullMono - 18.010565 + 226.058973 + 2 * PROTON) / 2, 5)
  })

  test('says why it has no m/z', () => {
    expect(nuxlTheoreticalMz('y5+X-Y+', 1, peptide, chemistry)).toEqual({ mz: null, reason: "unknown fragment adduct 'X-Y'" })
    expect(nuxlTheoreticalMz('MI:Q+', 1, peptide, chemistry)).toEqual({ mz: null, reason: "unknown marker ion 'Q'" })
    expect(nuxlTheoreticalMz('y9+', 1, peptide, chemistry).reason).toBe('no ion y9 of DYHTVLGAR')
    expect(nuxlTheoreticalMz('iW+', 1, peptide, chemistry).reason).toBe('no W in DYHTVLGAR')
    expect(nuxlTheoreticalMz('[M+2H+UU]++', 2, peptide, chemistry).reason).toBe('the precursor adduct is U-H3O4P1, not UU')
    expect(nuxlTheoreticalMz('?', 1, peptide, chemistry).reason).toBe("unknown ion '?'")
    expect(nuxlTheoreticalMz('[M+2H]++', 2, nuxlPeptide('PEPTIDE'), chemistry).mz).not.toBeNull()
    expect(nuxlTheoreticalMz('[M+2H+U]++', 2, nuxlPeptide('PEPTIDE'), chemistry).reason).toBe('the precursor adduct mass is not known')
  })

  test("the search's fragment adducts: its preset's, else its NuXL:fragment_adducts, else OpenNuXL's", () => {
    // RNA-UV (UCGA) has G'; the defaults do not
    expect(searchChemistry({ 'NuXL:presets': 'RNA-UV (UCGA)' })!.adducts.has("G'")).toBe(true)
    expect(searchChemistry({}, 'RNA-UV (UCGA)')!.adducts.has("G'")).toBe(true)
    expect(searchChemistry({})!.adducts.has("G'")).toBe(false)
    expect(searchChemistry({ 'NuXL:fragment_adducts': ['U:C3O;C3O', 'U:C4H4N2O2'] })!.adducts.has('C4H4N2O2')).toBe(true)
    // the default marker ions of DNA: T'
    expect(searchChemistry({ 'NuXL:presets': 'DNA-UV' })!.markers.has("T'")).toBe(true)
    expect(searchChemistry({ 'NuXL:presets': 'unknown' })).toBeNull()
  })
})
