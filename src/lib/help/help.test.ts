import { describe, expect, it } from 'vitest'
import { helpSectionFor, helpSections } from './help'

describe('the help', () => {
  it('has each section once, each with text', () => {
    const ids = helpSections.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of helpSections) expect(s.items.length, s.id).toBeGreaterThan(0)
  })

  it('opens at the section of what is on screen', () => {
    expect(helpSectionFor('search')).toBe('search')
    expect(helpSectionFor('history')).toBe('history')
    expect(helpSectionFor('results')).toBe('results')
    expect(helpSectionFor('results', { panel: true })).toBe('protein')
    expect(helpSectionFor('results', { psm: true, panel: true })).toBe('psm')
    for (const view of ['search', 'results', 'history'] as const) expect(helpSections.map((s) => s.id)).toContain(helpSectionFor(view))
  })
})
