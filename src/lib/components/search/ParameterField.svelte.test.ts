// @vitest-environment happy-dom
// A parameter of the "All parameters" dialog that cannot be used with the other settings (co-isolated precursors
// with database chunks): its switch is off and disabled, and says why, as on the page.
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

const entry: ParamEntry = { name: 'chimeric:enabled', value: false, type: 'bool', description: '', tags: [] }

function show(blocked: string | null) {
  const changes: unknown[] = []
  shown = mount(ParameterField, {
    target: document.body,
    props: { entry, id: 'p', labelId: 'p-label', value: true, blocked, onChange: (v: unknown) => changes.push(v) },
  })
  flushSync()
  return { changes, toggle: document.getElementById('p') as HTMLButtonElement }
}

describe('ParameterField', () => {
  it('a switch that is blocked is off, disabled and says why', () => {
    const { changes, toggle } = show('Set database:chunk_size to 0 to use it.')
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(toggle.disabled).toBe(true)
    toggle.click()
    flushSync()
    expect(changes).toEqual([])
    expect(document.body.textContent).toContain('Set database:chunk_size to 0 to use it.')
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
})
