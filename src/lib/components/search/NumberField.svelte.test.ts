// @vitest-environment happy-dom
// A number of the search settings: only valid numbers reach the setting, and an invalid entry gives back the value
// from before the typing (never a valid prefix of it: "1.5" missed cleavages is no 1).
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import NumberField from './NumberField.svelte'

let shown: Record<string, unknown> | null = null
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
})

/** The field with its value in the returned box, as a parent keeps it (`onChange` and `onClear` set it). */
function show(value: number | undefined, props: { kind?: 'int' | 'double'; min?: number; max?: number; clearable?: boolean } = {}) {
  const box = $state({ value, changes: [] as (number | undefined)[] })
  shown = mount(NumberField, {
    target: document.body,
    props: {
      id: 'n',
      kind: props.kind,
      min: props.min,
      max: props.max,
      get value() {
        return box.value
      },
      onChange: (v: number) => {
        box.value = v
        box.changes.push(v)
      },
      ...(props.clearable
        ? {
            onClear: () => {
              box.value = undefined
              box.changes.push(undefined)
            },
          }
        : {}),
    },
  })
  flushSync()
  const input = document.getElementById('n') as HTMLInputElement
  const type = (text: string) => {
    input.value = text
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
  }
  const blur = () => {
    input.dispatchEvent(new Event('blur'))
    flushSync()
  }
  return { box, input, type, blur }
}

describe('NumberField', () => {
  it('takes valid numbers as they are typed', () => {
    const { box, type, blur, input } = show(2, { kind: 'int', min: 0 })
    type('3')
    expect(box.value).toBe(3)
    type('31')
    blur()
    expect(box.value).toBe(31)
    expect(input.value).toBe('31')
  })

  it('gives back the value before the typing for an invalid entry, marked, and shows it again on leaving', () => {
    const { box, type, blur, input } = show(2, { kind: 'int', min: 0 })
    type('1')
    type('1.')
    type('1.5') // not a whole number: not 1
    expect(box.value).toBe(2)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.value).toBe('1.5')
    blur()
    expect(input.value).toBe('2')
    expect(input.getAttribute('aria-invalid')).toBe('false')
  })

  it('above its maximum: "150" with at most 100 is no 15', () => {
    const { box, type, blur, input } = show(20, { kind: 'double', min: 0, max: 100 })
    type('1')
    type('15')
    type('150')
    expect(box.value).toBe(20)
    blur()
    expect(input.value).toBe('20')
  })

  it('a field that can be empty is empty again when it was', () => {
    const { box, type, blur, input } = show(undefined, { kind: 'int', min: 1, max: 64, clearable: true })
    type('6')
    type('65')
    expect(box.value).toBeUndefined()
    blur()
    expect(input.value).toBe('')
  })
})
