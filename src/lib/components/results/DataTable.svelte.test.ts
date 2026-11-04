// @vitest-environment happy-dom
// The table's keyboard: Enter selects the active row; with followFocus (the PSM table under the PSM view) the arrow
// keys, Page Up/Down, Home and End select each row they move to, with the focus staying in the grid. Without it,
// they only move the active row.
import { flushSync, mount, unmount } from 'svelte'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import DataTable, { type Column } from './DataTable.svelte'

const columns: Column[] = [{ id: 'n', header: 'Row', width: 'auto', align: 'left', cell: (i: number) => `row ${i}` }]

// happy-dom lays nothing out: every element would be 0 px high, so the grid would take each row as scrolled out of
// view. A 400 px grid, as in a window.
const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
beforeAll(() => Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 }))
afterAll(() => {
  if (clientHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', clientHeight)
})

describe('DataTable keys', () => {
  let shown: Record<string, unknown> | null = null
  afterEach(() => {
    if (shown) unmount(shown)
    shown = null
    document.body.innerHTML = ''
  })

  function table(followFocus: boolean) {
    const clicked: number[] = []
    const target = document.createElement('div')
    document.body.append(target)
    shown = mount(DataTable, {
      target,
      props: {
        rows: Uint32Array.from([10, 11, 12, 13]),
        columns,
        sort: { key: 'n', dir: 'asc' as const },
        onSort: () => {},
        onRowClick: (row: number) => clicked.push(row),
        label: 'Test',
        followFocus,
      },
    })
    flushSync()
    const grid = target.querySelector<HTMLElement>('[role="grid"]')!
    const press = (key: string) => {
      grid.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      flushSync()
    }
    return { clicked, grid, press }
  }

  it('selects each row the keys reach with followFocus', () => {
    const { clicked, press } = table(true)
    press('ArrowDown')
    press('ArrowDown')
    press('ArrowUp')
    press('End')
    press('Home')
    expect(clicked).toEqual([11, 12, 11, 13, 10])
  })

  it('only moves the active row without it; Enter selects', () => {
    const { clicked, press } = table(false)
    press('ArrowDown')
    press('ArrowDown')
    expect(clicked).toEqual([])
    press('Enter')
    expect(clicked).toEqual([12])
  })

  it('does not select rows when the grid is scrolled with the mouse', () => {
    const { clicked, grid } = table(true)
    grid.scrollTop = 50
    grid.dispatchEvent(new Event('scroll'))
    flushSync()
    expect(clicked).toEqual([])
  })
})
