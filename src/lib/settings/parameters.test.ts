import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ParamEntry } from './parameters'
import {
  CARD_PARAMETERS,
  changedParameters,
  defaultsOf,
  dialogEntries,
  parameterSections,
  requestParameters,
  sameValue,
  SWITCH_PARAMETERS,
} from './parameters'
import { PROSE_PARAMETERS } from './prose'

const entry = (name: string, value: ParamEntry['value'], more: Partial<ParamEntry> = {}): ParamEntry => ({
  name,
  value,
  type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'double' : Array.isArray(value) ? 'string[]' : 'string',
  description: '',
  tags: [],
  ...more,
})

const entries: ParamEntry[] = [
  entry('enzyme', 'Trypsin'),
  entry('rescore', true),
  entry('precursor:mass_tolerance_lower', 10),
  entry('precursor:max_charge', 5, { type: 'int' }),
  entry('modifications:fixed', ['Carbamidomethyl (C)']),
  entry('peptdeep:enable', false),
  entry('peptdeep:ms2_model', 'models/peptdeep_ms2_dynamic.onnx'),
  entry('peptdeep:rt_model', 'models/peptdeep_rt_dynamic.onnx'),
  entry('peptdeep:instrument', 'QE'),
  entry('peptdeep:nce', -1),
  entry('peptdeep:batch_size', 500, { type: 'int', tags: ['advanced'] }),
  entry('database:chunk_size', 0, { type: 'int' }),
]

describe('parameters', () => {
  it('leaves the parameters of the Rescoring card out of the dialog', () => {
    expect(dialogEntries(entries).map((e) => e.name)).toEqual([
      'enzyme',
      'precursor:mass_tolerance_lower',
      'precursor:max_charge',
      'modifications:fixed',
      'peptdeep:nce',
      'peptdeep:batch_size',
      'database:chunk_size',
    ])
  })

  it('groups the dialog by section, general first', () => {
    const sections = parameterSections(dialogEntries(entries))
    expect(sections.map((s) => s.name)).toEqual(['general', 'precursor', 'modifications', 'peptdeep', 'database'])
    expect(sections[3].entries.map((e) => e.name)).toEqual(['peptdeep:nce', 'peptdeep:batch_size'])
  })

  it('compares values, arrays by their items', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameValue(10, 10)).toBe(true)
    expect(sameValue(10, '10')).toBe(false)
    const defaults = defaultsOf(entries)
    expect(defaults['modifications:fixed']).toEqual(['Carbamidomethyl (C)'])
    expect(changedParameters({ ...defaults, 'modifications:fixed': ['Carbamidomethyl (C)'] }, defaults)).toEqual({})
  })

  it('sends the changed parameters, without those the switches set', () => {
    const defaults = defaultsOf(entries)
    const values = { ...defaults, enzyme: 'Lys-C', rescore: false, 'peptdeep:enable': true, 'peptdeep:instrument': 'timsTOF' }
    expect(requestParameters(values, defaults)).toEqual({ enzyme: 'Lys-C', 'peptdeep:instrument': 'timsTOF' })
  })
})

describe('the "All parameters" dialog and the shim', () => {
  // The shim's allowlist (src-tauri/src/args.rs `PARAMETERS`): every parameter a search may set, with its kind.
  const argsRs = readFileSync(new URL('../../../src-tauri/src/args.rs', import.meta.url), 'utf8')
  const list = /pub const PARAMETERS: &\[\(&str, Kind\)\] = &\[([\s\S]*?)\];/.exec(argsRs)?.[1] ?? ''
  const allowlist = new Map([...list.matchAll(/\("([^"]+)",\s*(\w+)\)/g)].map((m) => [m[1], m[2]]))

  /** The shim's kind (args.rs `Kind`) of a parameter as the dialog edits it (ParameterField). */
  const kindOf = (e: ParamEntry): string => {
    if (e.type === 'bool') return 'Flag'
    if (e.type === 'int') return 'Int'
    if (e.type === 'double') return 'Float'
    // the shim's List takes strings only; ParameterField sends numbers for int[] and double[], which no Kind takes
    if (e.type === 'string[]') return 'List'
    if (e.type.endsWith('[]')) return `${e.type} (a list of numbers: no shim Kind)`
    return e.validStrings && e.validStrings.length > 0 ? 'Choice' : 'Text'
  }

  it('sets only what the shim lets through, each with the shim\'s kind, and every allowed parameter has a control', () => {
    expect(allowlist.size).toBeGreaterThan(50)
    const dialog = dialogEntries(PROSE_PARAMETERS)
    for (const e of dialog) {
      expect(allowlist.has(e.name), `${e.name} is not in args.rs PARAMETERS`).toBe(true)
      expect(kindOf(e), `kind of ${e.name}`).toBe(allowlist.get(e.name))
    }
    // the reverse: each allowed parameter is in the dialog, or has its control on the page (the PeptDeep instrument)
    const controlled = new Set([...dialog.map((e) => e.name), ...CARD_PARAMETERS])
    for (const name of allowlist.keys()) expect(controlled.has(name), `${name} has no control in the app`).toBe(true)
    for (const name of CARD_PARAMETERS) {
      const e = PROSE_PARAMETERS.find((p) => p.name === name)!
      expect(kindOf(e), `kind of ${name}`).toBe(allowlist.get(name))
    }
    // the switches of the Rescoring card are the request's own fields, never parameters
    for (const name of SWITCH_PARAMETERS) expect(allowlist.has(name), name).toBe(false)
  })
})
