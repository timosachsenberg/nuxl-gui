// @vitest-environment happy-dom
// The error strip's header and description say how many annotated ions shown have no theoretical m/z.
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import SpectrumMirror from './SpectrumMirror.svelte'
import type { ColoredMatch } from './nuxl-psm'

const dot: ColoredMatch = { peak: 0, ion: 'y1+', type: 'y', ordinal: 1, charge: 1, loss: '', theoreticalMz: 175.119, errorPpm: 1.5, color: 'var(--ion-y)' }

describe('the error strip', () => {
  let shown: Record<string, unknown> | null = null
  afterEach(() => {
    if (shown) unmount(shown)
    shown = null
    document.body.innerHTML = ''
  })

  function strip(matches: ColoredMatch[], omitted: number) {
    const target = document.createElement('div')
    document.body.append(target)
    shown = mount(SpectrumMirror, {
      target,
      props: {
        mz: Float32Array.from([175.119, 500]),
        intensity: Float32Array.from([100, 50]),
        groups: [],
        reference: { intensity: 100, text: 'base peak' },
        legend: [],
        bottom: { kind: 'status', label: 'Theoretical', message: '' },
        title: 'Spectrum',
        description: 'A spectrum.',
        errors: { matches, tolerance: { value: 20, unit: 'ppm' }, omitted },
      },
    })
    flushSync()
    return {
      header: target.querySelector('[data-testid="error-stats"]')?.textContent?.replace(/\s+/g, ' ').replace(/ ?· ?/g, ' · ').trim() ?? '',
      desc: target.querySelector('desc')?.textContent ?? '',
    }
  }

  it('no ion shown', () => {
    const { header, desc } = strip([], 0)
    expect(header).toBe('Fragment mass error · no annotated ion shown · tolerance ±20 ppm')
    expect(desc).toContain('no annotated ion is shown, so no mass error is shown')
  })

  it('ions shown, none with a theoretical m/z', () => {
    const { header, desc } = strip([], 3)
    expect(header).toBe('Fragment mass error · none of the 3 annotated ions shown has a theoretical m/z · tolerance ±20 ppm')
    expect(desc).toContain('no mass error is shown: none of the 3 annotated ions shown has a theoretical m/z.')
  })

  it('some without a theoretical m/z', () => {
    const { header, desc } = strip([dot], 2)
    expect(header).toMatch(/· 2 of 3 without a theoretical m\/z/)
    expect(desc).toContain('the mass error in ppm of 1 of the 3 annotated ions shown (2 have no theoretical m/z) is drawn')
    unmount(shown!)
    shown = null
    expect(strip([dot], 0).desc).toContain('the mass error in ppm of the annotated ion shown is drawn')
  })
})

describe('the precursor', () => {
  let shown: Record<string, unknown> | null = null
  afterEach(() => {
    if (shown) unmount(shown)
    shown = null
    document.body.innerHTML = ''
  })

  function spectrum(precursor: { mz: number; charge: number } | null) {
    const target = document.createElement('div')
    document.body.append(target)
    shown = mount(SpectrumMirror, {
      target,
      props: {
        mz: Float32Array.from([175.119, 500]),
        intensity: Float32Array.from([100, 50]),
        groups: [],
        reference: { intensity: 100, text: 'base peak' },
        legend: [],
        bottom: { kind: 'status', label: 'Theoretical', message: '' },
        title: 'Spectrum',
        description: 'A spectrum.',
        precursor,
      },
    })
    flushSync()
    return target
  }

  it('is marked at its m/z with its charge, also beyond the peaks', () => {
    const target = spectrum({ mz: 912.4567, charge: 2 })
    const mark = target.querySelector('[data-testid="precursor-mark"]')
    expect(mark?.getAttribute('data-mz')).toBe('912.4567')
    expect(target.querySelector('[data-testid="precursor-label"]')?.textContent).toBe('precursor 2+')
    // (the m/z axis reaches it)
    const [, hi] = target.querySelector('[data-testid="spectrum"]')!.getAttribute('data-mz-domain')!.split(' ').map(Number)
    expect(hi).toBeGreaterThan(912.4567)
    expect(target.querySelector('desc')?.textContent).toContain('A dashed line marks the precursor at m/z 912.4567 (2+).')
  })

  it('is not marked without a known m/z', () => {
    expect(spectrum(null).querySelector('[data-testid="precursor-mark"]')).toBeNull()
    unmount(shown!)
    shown = null
    expect(spectrum({ mz: NaN, charge: 2 }).querySelector('[data-testid="precursor-mark"]')).toBeNull()
  })
})
