import { describe, expect, it } from 'vitest'
import { clipMarks, mzDomain, niceTicks, placeLabels, placeLegend, scale, stickGroups, stickPath, stripFits, textWidth, wrapParts } from './plot'

describe('axes', () => {
  it('puts ticks on round numbers inside the range', () => {
    expect(niceTicks(0, 1000, 5)).toEqual([0, 200, 400, 600, 800, 1000])
    expect(niceTicks(112.3, 1387.9, 6)).toEqual([200, 400, 600, 800, 1000, 1200])
    expect(niceTicks(-24, 24, 4)).toEqual([-20, -10, 0, 10, 20])
    expect(niceTicks(0, 0.5, 5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5])
    expect(niceTicks(5, 5, 4)).toEqual([5])
  })

  it('spans the m/z of all the series, with some room', () => {
    expect(mzDomain([Float32Array.of(150, 900), [140, 1000]])).toEqual([105.6, 1034.4])
    // one value: at least 20 on either side
    expect(mzDomain([[500]])).toEqual([480, 520])
    expect(mzDomain([[]])).toEqual([0, 100])
  })

  it('maps linearly', () => {
    const x = scale([100, 200], [0, 50])
    expect(x(150)).toBe(25)
    expect(x(100)).toBe(0)
  })
})

describe('marks', () => {
  it('draws sticks as one path', () => {
    expect(stickPath([10, 20.04], [5, 8.26], 50)).toBe('M10 50V5M20 50V8.3')
    expect(stickPath([], [], 50)).toBe('')
  })

  it('groups sticks by colour on one m/z scale, and clips them at 100 %', () => {
    const x = scale([100, 1100], [0, 1000])
    const y = (r: number) => 100 - 100 * r
    const groups = stickGroups(
      [
        { mz: 500.0025, ratio: 0.5, color: 'blue' }, // an observed b ion, 5 ppm off
        { mz: 600, ratio: 1.8, color: 'grey' }, // a peak stronger than the reference
        { mz: 700, ratio: 1, color: 'blue' },
      ],
      x,
      y,
    )
    expect(groups.map((g) => g.color)).toEqual(['blue', 'grey'])
    expect(groups[0]).toMatchObject({ xs: [400.0025, 600], tops: [50, 0], clipped: [] })
    expect(groups[1]).toMatchObject({ xs: [500], tops: [0], clipped: [500] })
    // the same ion below (its theoretical m/z) is where the observed one is, to the pixel
    const below = stickGroups([{ mz: 500, ratio: 1, color: 'blue', faint: true }], x, (r) => 100 + 100 * r)
    expect(below[0]).toMatchObject({ faint: true, xs: [400], tops: [200] })
    expect(Math.abs(below[0].xs[0] - groups[0].xs[0])).toBeLessThan(0.01)
    expect(clipMarks([500], 0, true)).toBe('M497 0L500 -5L503 0Z')
  })
})

describe('labels', () => {
  it('estimates the width of a label', () => {
    expect(textWidth('b12', 11)).toBeGreaterThan(textWidth('b2', 11))
    expect(textWidth('', 11)).toBe(0)
  })

  it('puts labels above their peaks, higher when they would overlap, and leaves out what does not fit', () => {
    const at = placeLabels(
      [
        { x: 100, y: 80, width: 20 }, // the most important first
        { x: 105, y: 80, width: 20 }, // overlaps the first: one line up
        { x: 300, y: 80, width: 20 }, // free
        { x: 102, y: 80, width: 20 }, // overlaps both: two lines up
        { x: 101, y: 80, width: 20 }, // no room left within three lines: left out
      ],
      { lineHeight: 12, tries: 3, top: 40 },
    )
    expect(at).toEqual([80, 68, 80, 56, null])
    // never above the top
    expect(placeLabels([{ x: 0, y: 30, width: 10 }], { lineHeight: 12, tries: 3, top: 40 })).toEqual([40])
  })
})

describe('the strip under the mirror spectrum', () => {
  const label = 'PeptDeep · NCE 36 (calibrated) · QE · 100 % = strongest predicted b/y'
  const similarity = 'cosine 0.437 · spectral angle 0.288 (search)'

  it('keeps the label and the similarity on one line when both fit', () => {
    expect(stripFits(label, similarity, 820)).toBe(true)
    expect(stripFits('Theoretical', similarity, 400)).toBe(true)
  })

  it('puts the similarity on a line of its own when they would meet', () => {
    // about 660 px of plot at a window of 1050 px: the label alone is some 400 px wide
    expect(stripFits(label, similarity, 660)).toBe(false)
    expect(stripFits(label, similarity, textWidth(label, 11) + 16 + textWidth(similarity, 11) - 1)).toBe(false)
    expect(stripFits(label, similarity, textWidth(label, 11) + 16 + textWidth(similarity, 11))).toBe(true)
  })

  it('needs no room for a similarity that is not there', () => {
    expect(stripFits(label, null, 100)).toBe(true)
  })
})

describe('the legend above the mirror spectrum', () => {
  // four items of 50 px, 7 px of which the room after an item; the label 200 px from 46 px on
  const widths = [50, 50, 50, 50]

  it('sits beside the label, flush right, when both fit', () => {
    const { items, lines } = placeLegend(200, widths, 46, 800)
    expect(lines).toBe(0)
    expect(items.map((i) => i.line)).toEqual([0, 0, 0, 0])
    // the last item's text ends at the right edge
    expect(items.map((i) => i.x)).toEqual([607, 657, 707, 757])
    // just enough room: 46 + 200 + 16 + 193
    expect(placeLegend(200, widths, 46, 455).lines).toBe(0)
  })

  it('takes a line of its own under the label when they would meet (a narrow window)', () => {
    const { items, lines } = placeLegend(200, widths, 46, 454)
    expect(lines).toBe(1)
    expect(items).toEqual([
      { x: 46, line: 1 },
      { x: 96, line: 1 },
      { x: 146, line: 1 },
      { x: 196, line: 1 },
    ])
    // never over the label: every item is right of it on its line, or on a line below it
    for (const right of [300, 400, 500, 600]) {
      for (const item of placeLegend(200, widths, 46, right).items) expect(item.line > 0 || item.x >= 46 + 200 + 16).toBe(true)
    }
  })

  it('wraps onto more lines when one is not enough', () => {
    const { items, lines } = placeLegend(200, widths, 46, 46 + 110)
    expect(lines).toBe(2)
    expect(items.map((i) => [i.x, i.line])).toEqual([
      [46, 1],
      [96, 1],
      [46, 2],
      [96, 2],
    ])
    // an item wider than the line still gets one
    expect(placeLegend(200, [300], 46, 100).items).toEqual([{ x: 46, line: 1 }])
  })
})

describe('texts of parts on narrow views', () => {
  const parts = ['Fragment mass error', 'mean +0.175 Da', 'SD 0.191 Da', 'dot size = intensity', 'tolerance ±0.5 Da']

  it('keeps one line when it fits', () => {
    expect(wrapParts(parts, 1000)).toEqual([parts.join(' · ')])
    expect(wrapParts(['Theoretical'], 10)).toEqual(['Theoretical'])
    expect(wrapParts([], 100)).toEqual([''])
  })

  it('breaks between parts, each line within the width, ending in a dot that says it goes on', () => {
    const available = 250
    const lines = wrapParts(parts, available)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ')).toBe(parts.join(' · '))
    for (const line of lines.slice(0, -1)) expect(line.endsWith(' ·')).toBe(true)
    for (const line of lines) expect(textWidth(line, 11)).toBeLessThanOrEqual(available)
  })

  it('gives a part wider than a line a line of its own', () => {
    expect(wrapParts(['a', 'a very long part of the text', 'b'], 40)).toEqual(['a ·', 'a very long part of the text ·', 'b'])
  })
})
