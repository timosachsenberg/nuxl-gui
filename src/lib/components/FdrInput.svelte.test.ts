// @vitest-environment happy-dom
// The FDR field: a field that can be off (the protein FDR) says "off" for 0 and has an Off chip; typing "off" or 0
// turns it off, a percentage on again. A field that cannot be off (the PSM FDR) rejects 0.
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import FdrInput from './FdrInput.svelte'

let shown: Record<string, unknown> | null = null
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
})

/** The field with `value` bound to the returned box (state, as a parent's bound value). */
function show(value: number, off: boolean) {
  const box = $state({ value })
  shown = mount(FdrInput, {
    target: document.body,
    props: {
      id: 'fdr',
      off,
      get value() {
        return box.value
      },
      set value(v: number) {
        box.value = v
      },
    },
  })
  flushSync()
  const input = document.getElementById('fdr') as HTMLInputElement
  const field = input.parentElement!
  const chips = () => [...document.querySelectorAll('button')].map((b) => ({ text: b.textContent, pressed: b.getAttribute('aria-pressed') }))
  const type = (text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
  }
  const blur = () => {
    input.dispatchEvent(new Event('blur'))
    flushSync()
  }
  return { box, input, field, chips, type, blur }
}

describe('an FDR field that can be off', () => {
  it('says "off" for 0, without a percent sign or q-value, with the Off chip pressed', () => {
    const { input, field, chips } = show(0, true)
    expect(input.value).toBe('off')
    expect(field.textContent).not.toContain('%')
    expect(field.textContent).not.toContain('q ≤')
    expect(chips()).toEqual([
      { text: 'Off', pressed: 'true' },
      { text: '0.1 %', pressed: 'false' },
      { text: '1 %', pressed: 'false' },
      { text: '5 %', pressed: 'false' },
    ])
    expect(input.getAttribute('aria-invalid')).toBe('false')
  })

  it('a chip or a typed percentage turns it on; "off" or 0 typed, or the Off chip, off again', () => {
    const { box, input, field, chips, type, blur } = show(0, true)
    ;(document.querySelectorAll('button')[2] as HTMLButtonElement).click()
    flushSync()
    expect(box.value).toBe(0.01)
    expect(input.value).toBe('1')
    expect(field.textContent).toContain('q ≤ 0.01')
    type('off')
    expect(box.value).toBe(0)
    type('5')
    expect(box.value).toBe(0.05)
    type('0')
    expect(box.value).toBe(0)
    // a typed 0 keeps the user's text, the word is beside it
    expect(field.textContent).toContain('off')
    blur()
    expect(input.value).toBe('off')
    type('2')
    blur()
    ;(document.querySelectorAll('button')[0] as HTMLButtonElement).click()
    flushSync()
    expect(box.value).toBe(0)
    expect(chips()[0]).toEqual({ text: 'Off', pressed: 'true' })
  })
})

describe('an FDR field that cannot be off', () => {
  it('has no Off chip and rejects 0', () => {
    const { box, input, chips, type } = show(0.01, false)
    expect(chips().map((c) => c.text)).toEqual(['0.1 %', '1 %', '5 %'])
    type('0')
    expect(box.value).toBe(0.01)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    type('off')
    expect(box.value).toBe(0.01)
  })
})

describe('an invalid entry', () => {
  it('never leaves the valid prefix typed on the way: "150" gives back the value before, not 15 %', () => {
    const { box, input, type, blur } = show(0.01, false)
    type('1')
    type('15')
    expect(box.value).toBe(0.15)
    type('150')
    expect(box.value).toBe(0.01)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    blur()
    expect(input.value).toBe('1')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    // the next entry starts from the value as it is then
    type('2')
    type('2x')
    expect(box.value).toBe(0.01)
    type('5')
    blur()
    expect(box.value).toBe(0.05)
  })

  it('also in a field that can be off, and above its maximum', () => {
    const { box, input, type, blur } = show(0, true)
    type('5')
    type('500')
    expect(box.value).toBe(0)
    blur()
    expect(input.value).toBe('off')
  })
})

describe('a value it does not take', () => {
  it('is marked invalid: a PSM FDR of 0 (ProSE\'s default, which "reset to default" sets) is not "0 % off"', () => {
    const { input, field } = show(0, false)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.textContent).not.toContain('off')
    expect(field.textContent).toContain('> 0 – 100 %')
  })
})


describe('a disabled FDR field (no FDR without decoys)', () => {
  it('says off, takes no input and its chips are disabled', () => {
    shown = mount(FdrInput, { target: document.body, props: { id: 'fdr', off: true, disabled: true, value: 0, 'aria-describedby': 'why' } })
    flushSync()
    const input = document.getElementById('fdr') as HTMLInputElement
    expect(input.disabled).toBe(true)
    expect(input.value).toBe('off')
    expect(input.getAttribute('aria-describedby')).toBe('why')
    expect(input.getAttribute('aria-invalid')).toBe('false')
    const chips = [...document.querySelectorAll('button')]
    expect(chips.length).toBeGreaterThan(1)
    expect(chips.every((b) => b.disabled)).toBe(true)
  })
})
