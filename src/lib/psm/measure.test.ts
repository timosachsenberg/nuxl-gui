import { describe, expect, it } from 'vitest'
import {
  bracketAt,
  deltaCandidates,
  deltaText,
  layoutBrackets,
  matchDelta,
  matchText,
  measurementText,
  snapPeak,
  withLabel,
  type DeltaContext,
  type UserLabel,
} from './measure'
import { searchChemistry } from './nuxl-theoretical'
import { scale } from './plot'

describe('snapping a click to a peak', () => {
  // m/z 100 to 200 over 0 to 1000 px: 10 px per m/z; tops by intensity (y 0 at the top, 100 the axis)
  const x = scale([100, 200], [0, 1000])
  const mzAt = scale([0, 1000], [100, 200])
  const mz = [150, 150.5, 151, 160]
  const tops = [90, 10, 80, 50]
  const snap = (px: number, py: number) => snapPeak(mz, x, mzAt, (i) => tops[i], px, py)

  it('takes the peak whose top is nearest on screen among those within 10 px', () => {
    // between 150 and 151 (500 to 510 px): pointing high takes the tall one at 150.5
    expect(snap(503, 12)).toBe(1)
    // pointing low takes the short ones
    expect(snap(501, 90)).toBe(0)
    expect(snap(509, 80)).toBe(2)
    expect(snap(600, 60)).toBe(3)
  })

  it('takes none farther than 10 px, or of no peaks', () => {
    expect(snap(560, 50)).toBe(-1)
    expect(snap(611, 50)).toBe(-1)
    expect(snapPeak([], x, mzAt, () => 0, 10, 10)).toBe(-1)
  })
})

describe('the brackets', () => {
  it('stand above the higher peak, and go up where they would meet one placed before', () => {
    const [a, b, c] = layoutBrackets(
      [
        { xa: 100, ya: 200, xb: 200, yb: 150, width: 60 },
        { xa: 150, ya: 160, xb: 250, yb: 180, width: 60 },
        { xa: 400, ya: 120, xb: 500, yb: 100, width: 60 },
      ],
      { top: 30 },
    )
    expect(a.y).toBe(132)
    // (above a's box, 117 to 134)
    expect(b.y).toBe(114)
    expect(b.box.y1).toBeLessThan(a.box.y0)
    expect(c.y).toBe(82)
    // never above the top
    expect(layoutBrackets([{ xa: 0, ya: 20, xb: 10, yb: 25, width: 30 }], { top: 30 })[0].y).toBe(30)
  })

  it("go over the labels of the peaks, and their dotted lines start above the labels", () => {
    // the label of the higher peak (at x 200, its top 150) right above it, where the bar would be (132)
    const labels = [
      { x0: 185, x1: 215, y0: 131, y1: 146 },
      // the lower peak's (x 100, top 200)
      { x0: 85, x1: 115, y0: 181, y1: 196 },
    ]
    const [b] = layoutBrackets([{ xa: 100, ya: 200, xb: 200, yb: 150, width: 60 }], { top: 30, labels })
    expect(b.box.y1).toBeLessThanOrEqual(labels[0].y0)
    expect(b.y).toBe(128)
    expect(b.da).toBe(180)
    expect(b.db).toBe(130)
    // a label away from the bracket moves nothing
    expect(layoutBrackets([{ xa: 100, ya: 200, xb: 200, yb: 150, width: 60 }], { top: 30, labels: [{ x0: 400, x1: 450, y0: 120, y1: 135 }] })[0]).toMatchObject({ y: 132, da: 200, db: 150 })
    // no room above: at the top, over the label
    expect(layoutBrackets([{ xa: 100, ya: 60, xb: 200, yb: 50, width: 60 }], { top: 30, labels: [{ x0: 185, x1: 215, y0: 31, y1: 46 }] })[0].y).toBe(30)
  })

  it('are hit on their bar and on their label', () => {
    const brackets = layoutBrackets([{ xa: 100, ya: 200, xb: 200, yb: 150, width: 60 }], { top: 30 })
    expect(bracketAt(brackets, 150, 132)).toBe(0)
    expect(bracketAt(brackets, 150, 138)).toBe(0)
    expect(bracketAt(brackets, 150, 122)).toBe(0) // the label
    expect(bracketAt(brackets, 150, 145)).toBe(-1)
    expect(bracketAt(brackets, 260, 132)).toBe(-1)
  })
})

describe('what a Δm/z may be', () => {
  const tolerance = { value: 20, unit: 'ppm' as const }
  const defaults = { tolerance, candidates: deltaCandidates([], ['Oxidation (M)'], searchChemistry({})) }
  /** The match of a Δ `delta` below a peak at `at`. */
  const text = (delta: number, at: number, context: DeltaContext = defaults) => matchText(matchDelta(at - delta, at, context))

  it('is a residue, I and L as one, oxidized M among them', () => {
    expect(text(163.0633, 700)).toBe('≈ Y')
    expect(text(113.08406, 700)).toBe('≈ I/L')
    expect(text(147.0354, 700)).toBe('≈ M(Oxidation)')
    expect(text(131.0405, 700)).toBe('≈ M')
    // off by more than 20 ppm at both peaks (0.014 + 0.0107 Da)
    expect(matchDelta(700 - 163.09, 700, defaults)).toEqual([])
  })

  it('allows the tolerance of each peak: a Δ carries the errors of both', () => {
    // each peak within 20 ppm, one 15 ppm low, the other 15 ppm high: the Δ is 0.0205 off Y
    const [a, b] = [600 * (1 - 15e-6), (600 + 163.06333) * (1 + 15e-6)]
    expect(matchText(matchDelta(a, b, defaults))).toBe('≈ Y')
    // in Da: the sum of the two
    const da = { tolerance: { value: 0.02, unit: 'Da' as const }, candidates: defaults.candidates }
    expect(matchText(matchDelta(600, 600 + 163.06333 + 0.035, da))).toBe('≈ Y')
    expect(matchDelta(600, 600 + 163.06333 + 0.045, da)).toEqual([])
  })

  it('is a nucleotide or a fragment adduct of the search, named so that it is not read as a residue', () => {
    expect(text(226.059, 900)).toBe('≈ U-H₃PO₄ (nt)')
    expect(text(324.0359, 900)).toBe('≈ U (nt)')
    expect(text(94.0167, 900)).toBe("≈ U'-H₂O (nt)")
  })

  it('tells the nucleotides C, G, A and T from the residues of the same letters', () => {
    const rna = { tolerance, candidates: deltaCandidates([], [], searchChemistry({}, 'RNA-UV (U)')) }
    expect(text(323.05185, 900, rna)).toBe('≈ C (nt)')
    expect(text(103.00919, 900, rna)).toBe('≈ C')
    expect(text(363.058, 900, rna)).toBe('≈ G (nt)')
    expect(text(57.02146, 900, rna)).toBe('≈ G')
    expect(text(347.0631, 900, rna)).toBe('≈ A (nt)')
    const dna = { tolerance, candidates: deltaCandidates([], [], searchChemistry({}, 'DNA-UV')) }
    expect(text(322.0566, 900, dna)).toBe('≈ T (nt)')
    expect(text(101.04768, 900, dna)).toBe('≈ T')
    // the same name of a residue and a nucleotide, both in the window: both kept
    const both = { tolerance: { value: 0.5, unit: 'Da' as const }, candidates: [
      { name: 'X', mass: 100, kind: 'residue' as const },
      { name: 'X', mass: 100.1, kind: 'adduct' as const },
    ] }
    expect(matchDelta(500, 600, both).map((m) => m.kind)).toEqual(['residue', 'adduct'])
  })

  it('is, for a cross-link, a residue it may be on with a fragment adduct', () => {
    const chemistry = searchChemistry({}, 'RNA-UV (U)')
    const xl = { tolerance, candidates: deltaCandidates(['Carbamidomethyl (C)'], [], chemistry, ['C']) }
    // C(Carbamidomethyl) 160.03065 + U 324.03587
    expect(text(160.03065 + 324.03587, 1200, xl)).toBe('≈ C(Carbamidomethyl)+U')
    expect(text(160.03065 + 112.02728, 1200, xl)).toBe("≈ C(Carbamidomethyl)+U'")
    // not for a peptide
    const linear = { tolerance, candidates: deltaCandidates(['Carbamidomethyl (C)'], [], chemistry) }
    expect(text(160.03065 + 324.03587, 1200, linear)).toBe('')
  })

  it('is at 2+ too where the view shows 2+ fragments', () => {
    const two = { ...defaults, charges: [1, 2] }
    expect(text(163.06333 / 2, 700, two)).toBe('≈ Y (2+)')
    expect(text(163.06333, 700, two)).toBe('≈ Y')
    expect(text(163.06333 / 2, 700)).toBe('')
  })

  it('says when it cannot tell them apart: the closest first', () => {
    const da = { tolerance: { value: 0.025, unit: 'Da' as const }, candidates: defaults.candidates }
    expect(text(128.07, 500, da)).toBe('≈ Q / K?')
    expect(text(128.09, 500, da)).toBe('≈ K / Q?')
    // at 20 ppm K and Q are apart
    expect(text(128.09496, 500)).toBe('≈ K')
    // of one name with several masses, the closest
    const twice = { tolerance: { value: 0.5, unit: 'Da' as const }, candidates: [
      { name: 'X', mass: 100.2, kind: 'residue' as const },
      { name: 'X', mass: 100, kind: 'residue' as const },
    ] }
    expect(matchDelta(500, 600, twice)).toEqual([{ name: 'X', mass: 100, kind: 'residue', charge: 1, error: 0 }])
  })

  it('has the fixed modifications in place of the unmodified residue', () => {
    const fixed = { tolerance, candidates: deltaCandidates(['Carbamidomethyl (C)'], [], null) }
    expect(text(160.03065, 500, fixed)).toBe('≈ C(Carbamidomethyl)')
    expect(matchDelta(500 - 103.00919, 500, fixed)).toEqual([])
    expect(matchDelta(500 - 103.00919, 500, { tolerance, candidates: deltaCandidates([], [], null) }).map((m) => m.name)).toEqual(['C'])
  })

  it('keeps the unmodified residue for a fixed modification it cannot read', () => {
    const unknown = { tolerance, candidates: deltaCandidates(['NoSuchModification (K)'], [], null) }
    expect(text(128.09496, 500, unknown)).toBe('≈ K')
    // (one with parentheses in its name is read)
    const label = { tolerance, candidates: deltaCandidates(['Label:13C(6) (K)'], [], null) }
    expect(text(134.11509, 500, label)).toBe('≈ K(Label:13C(6))')
    expect(text(128.09496, 500, label)).toBe('')
  })

  it('is written after the Δ, with three decimals (the peaks are Float32)', () => {
    const m = { a: { mz: 663.2633, intensity: 5 }, b: { mz: 500.2, intensity: 9 } }
    expect(deltaText(163.06333)).toBe('Δ163.063')
    expect(measurementText(m, defaults)).toBe('Δ163.063 ≈ Y')
    expect(measurementText({ a: m.a, b: { mz: 600, intensity: 1 } }, defaults)).toBe('Δ63.263')
    expect(measurementText(m, null)).toBe('Δ163.063')
  })
})

describe('the labels', () => {
  const peak = { mz: 500.25, intensity: 10 }
  it('are added, changed and, with no text, removed', () => {
    let labels: UserLabel[] = []
    labels = withLabel(labels, peak, ' y4 ')
    expect(labels).toEqual([{ mz: 500.25, intensity: 10, text: 'y4' }])
    labels = withLabel(labels, { mz: 500.2504, intensity: 10 }, 'y4*')
    expect(labels).toEqual([{ mz: 500.25, intensity: 10, text: 'y4*' }])
    labels = withLabel(labels, { mz: 600, intensity: 1 }, 'b')
    expect(labels.map((l) => l.text)).toEqual(['y4*', 'b'])
    labels = withLabel(labels, peak, '')
    expect(labels.map((l) => l.text)).toEqual(['b'])
    expect(withLabel(labels, peak, '')).toBe(labels)
  })
})
