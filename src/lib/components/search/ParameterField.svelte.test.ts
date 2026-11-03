// @vitest-environment happy-dom
// A parameter of the "All parameters" dialog that does nothing with the other settings (an adduct field of NuXL with
// a protocol): it is disabled and says why; a switch is off then. A "true"/"false" choice is a switch of strings.
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import type { ParamEntry } from '$lib/settings/parameters'
import ParameterField from './ParameterField.svelte'

let shown: Record<string, unknown> | null = null
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
})

const flag: ParamEntry = { name: 'NuXL:only_xl', value: false, type: 'bool', description: '', tags: [] }

function show(blocked: string | null, entry: ParamEntry = flag, value: unknown = true) {
  const changes: unknown[] = []
  shown = mount(ParameterField, {
    target: document.body,
    props: { entry, id: 'p', labelId: 'p-label', value, blocked, onChange: (v: unknown) => changes.push(v) },
  })
  flushSync()
  return { changes, toggle: document.getElementById('p') as HTMLButtonElement }
}

describe('ParameterField', () => {
  it('a switch that is blocked is off, disabled and says why', () => {
    const { changes, toggle } = show('The protocol sets this.')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(true)
    toggle.click()
    flushSync()
    expect(changes).toEqual([])
    expect(document.body.textContent).toContain('The protocol sets this.')
    expect(toggle.getAttribute('aria-describedby')).toBe('p-blocked')
  })

  it('a switch that is not blocked shows and changes its value', () => {
    const { changes, toggle } = show(null)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(toggle.disabled).toBe(false)
    toggle.click()
    flushSync()
    expect(changes).toEqual([false])
  })

  it('a "true"/"false" choice is a switch that keeps the strings', () => {
    const entry: ParamEntry = {
      name: 'peptide:clip_nterm_methionine',
      value: 'true',
      type: 'string',
      description: '',
      tags: [],
      validStrings: ['true', 'false'],
    }
    const { changes, toggle } = show(null, entry, 'true')
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    toggle.click()
    flushSync()
    expect(changes).toEqual(['false'])
  })

  it('a list that is blocked is disabled and says why', () => {
    const entry: ParamEntry = { name: 'NuXL:modifications', value: ['U:'], type: 'string[]', description: '', tags: [] }
    show('The protocol sets this.', entry, ['U:', 'U:-H2O'])
    const area = document.getElementById('p') as HTMLTextAreaElement
    expect(area.disabled).toBe(true)
    expect(area.value).toBe('U:\nU:-H2O')
    expect(area.getAttribute('aria-describedby')).toBe('p-blocked')
  })
})
