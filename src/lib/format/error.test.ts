import { describe, expect, it } from 'vitest'
import { errorText } from './error'

describe('errorText', () => {
  it('gives the message of an Error, a command rejection and a string', () => {
    expect(errorText(new Error('disk full'))).toBe('disk full')
    expect(errorText({ message: 'x.parquet does not exist.', notFound: true })).toBe('x.parquet does not exist.')
    expect(errorText('refused')).toBe('refused')
    expect(errorText(42)).toBe('42')
  })

  it('never gives "[object Object]"', () => {
    expect(errorText({ code: 5 })).toBe('{"code":5}')
    expect(errorText({})).toBe('unknown error (Object)')
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(errorText(cycle)).toBe('unknown error (Object)')
  })
})
