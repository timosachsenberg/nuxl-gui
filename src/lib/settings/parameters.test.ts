import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NUXL_PARAMETERS } from './nuxl'
import type { ParamEntry } from './parameters'
import {
  changedParameters,
  defaultsOf,
  dialogEntries,
  emptyTextDefault,
  parameterSections,
  requestParameters,
  sameValue,
  SEARCH_SETTING_NAMES,
  SEARCH_SETTINGS,
} from './parameters'

const entry = (name: string, value: ParamEntry['value'], more: Partial<ParamEntry> = {}): ParamEntry => ({
  name,
  value,
  type: typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'double' : Array.isArray(value) ? 'string[]' : 'string',
  description: '',
  tags: [],
  ...more,
})

const entries: ParamEntry[] = [
  entry('precursor:mass_tolerance', 6),
  entry('precursor:max_charge', 5, { type: 'int' }),
  entry('modifications:variable', ['Oxidation (M)']),
  entry('NuXL:presets', 'none', { validStrings: ['RNA-UV (U)', 'none'] }),
  entry('NuXL:only_xl', false),
  entry('filter', ['filter_pc_mass_error', 'autotune', 'idfilter']),
  entry('window_size', 75, { tags: ['advanced'] }),
]

/**
 * The options the shim lets through (docs/design.md §3, src-tauri/src/args.rs `PARAMETERS`), by their full name. The
 * shim's own options (-in, -out*, -threads, the FDR and Percolator options, NuXL:decoys, ...) are none of them.
 */
const ALLOWED = [
  'precursor:mass_tolerance', 'precursor:mass_tolerance_unit', 'precursor:min_charge', 'precursor:max_charge', 'precursor:isotopes',
  'fragment:mass_tolerance', 'fragment:mass_tolerance_unit', 'modifications:fixed', 'modifications:variable',
  'modifications:variable_max_per_peptide', 'peptide:min_size', 'peptide:max_size', 'peptide:missed_cleavages', 'peptide:enzyme',
  'peptide:clip_nterm_methionine', 'report:top_hits', 'report:xl_fdr_groups', 'NuXL:presets', 'NuXL:length', 'NuXL:sequence',
  'NuXL:target_nucleotides', 'NuXL:nt_groups', 'NuXL:mapping', 'NuXL:can_cross_link', 'NuXL:standalone', 'NuXL:localization',
  'NuXL:fragment_adducts', 'NuXL:modifications', 'NuXL:scoring', 'NuXL:rescoring', 'NuXL:decoy_factor', 'NuXL:CysteineAdduct',
  'NuXL:filter_fractional_mass', 'NuXL:carbon_labeled_fragments', 'NuXL:only_xl', 'NuXL:filter_small_peptide_mass',
  'NuXL:marker_ions_tolerance', 'filter', 'window_size', 'peak_count',
]

describe('parameters', () => {
  it('lists every parameter in the dialog', () => {
    expect(dialogEntries(entries)).toEqual(entries)
  })

  it('groups the dialog by section, in OpenNuXL\'s order', () => {
    const sections = parameterSections(entries)
    expect(sections.map((s) => s.name)).toEqual(['precursor', 'modifications', 'NuXL', 'general'])
    expect(sections[3].entries.map((e) => e.name)).toEqual(['filter', 'window_size'])
  })

  it('compares values, arrays by their items', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameValue(5, 5)).toBe(true)
    expect(sameValue('5', 5)).toBe(false)
  })

  it('sends the changed parameters of OpenNuXL, never the FDRs or a name OpenNuXL does not have', () => {
    const defaults = { ...defaultsOf(entries), ...SEARCH_SETTINGS }
    const values = {
      ...defaults,
      'precursor:mass_tolerance': 10,
      'NuXL:presets': 'RNA-UV (U)',
      'NuXL:only_xl': true,
      filter: ['autotune'],
      peptideFdr: 0.05,
      xlFdr: 0.1,
      'FDR:PSM': 0.01,
    }
    expect(requestParameters(values, entries)).toEqual({
      'precursor:mass_tolerance': 10,
      'NuXL:presets': 'RNA-UV (U)',
      'NuXL:only_xl': true,
      filter: ['autotune'],
    })
    // a preset saves the FDRs with the parameters
    expect(changedParameters(values, defaults)).toMatchObject({ peptideFdr: 0.05, xlFdr: 0.1 })
    // a list is a copy
    const sent = requestParameters(values, entries)
    ;(sent.filter as string[]).push('idfilter')
    expect(values.filter).toEqual(['autotune'])
  })

  it('sends no empty text, which runs with OpenNuXL\'s default (the shim passes nothing for it)', () => {
    const crossLink = entry('NuXL:can_cross_link', 'U')
    const sequence = entry('NuXL:sequence', '')
    expect(requestParameters({ 'NuXL:can_cross_link': '', 'NuXL:sequence': '' }, [crossLink, sequence])).toEqual({})
    expect(requestParameters({ 'NuXL:can_cross_link': 'UG' }, [crossLink])).toEqual({ 'NuXL:can_cross_link': 'UG' })
    expect(emptyTextDefault(crossLink)).toBe('U')
    expect(emptyTextDefault(sequence)).toBeNull()
    expect(emptyTextDefault(entry('precursor:mass_tolerance', 6))).toBeNull()
  })

  it('has the FDRs of 1 % as the search\'s own settings', () => {
    expect(SEARCH_SETTINGS).toEqual({ peptideFdr: 0.01, xlFdr: 0.01 })
    expect(SEARCH_SETTING_NAMES).toEqual(['peptideFdr', 'xlFdr'])
  })
})

describe("OpenNuXL's parameters (nuxl-parameters.json)", () => {
  const byName = new Map(NUXL_PARAMETERS.map((e) => [e.name, e]))

  it('are exactly the allowed ones, none of the shim\'s own, and none named like a search setting', () => {
    expect([...byName.keys()].sort()).toEqual([...ALLOWED].sort())
    for (const own of ['in', 'database', 'out', 'out_tsv', 'threads', 'report:peptideFDR', 'report:xlFDR', 'report:xl_peptidelevel_FDR',
      'percolator_backend', 'percolator_executable', 'NuXL:decoys', 'output_folder', 'NuXL:presets_file', 'ThermoRaw_executable', 'NET_executable']) {
      expect(byName.has(own), own).toBe(false)
    }
    for (const name of SEARCH_SETTING_NAMES) expect(byName.has(name), name).toBe(false)
  })

  it('agree with the shim\'s allowlist once it is OpenNuXL\'s', () => {
    const argsRs = readFileSync(new URL('../../../src-tauri/src/args.rs', import.meta.url), 'utf8')
    const list = /pub const PARAMETERS: &\[\(&str, Kind\)\] = &\[([\s\S]*?)\];/.exec(argsRs)?.[1] ?? ''
    const kinds = new Map([...list.matchAll(/\("([^"]+)",\s*(\w+)\)/g)].map((m) => [m[1], m[2]]))
    if (!kinds.has('NuXL:presets')) return // (the shim is still ProSE's)
    expect([...kinds.keys()].sort()).toEqual([...ALLOWED].sort())
    // each with the kind of its values that the form sends
    const kindOf = (e: ParamEntry) =>
      ({ int: 'Int', double: 'Float', bool: 'Flag', 'string[]': 'List', 'int[]': 'IntList' })[e.type as string] ??
      (e.validStrings ? 'Choice' : 'Text')
    for (const e of NUXL_PARAMETERS) expect(kindOf(e), e.name).toBe(kinds.get(e.name))
  })

  it('have OpenNuXL\'s defaults, types and choices', () => {
    const v = (name: string) => byName.get(name)!.value
    expect(v('precursor:mass_tolerance')).toBe(6)
    expect(v('precursor:mass_tolerance_unit')).toBe('ppm')
    expect(v('fragment:mass_tolerance')).toBe(20)
    expect(v('precursor:isotopes')).toEqual([0])
    expect(byName.get('precursor:isotopes')!.type).toBe('int[]')
    expect(v('modifications:variable')).toEqual(['Oxidation (M)'])
    expect(v('modifications:fixed')).toEqual([])
    expect(v('peptide:enzyme')).toBe('Trypsin/P')
    expect(v('peptide:max_size')).toBe(1000000)
    expect(v('NuXL:presets')).toBe('none')
    expect(v('NuXL:length')).toBe(2)
    expect(v('NuXL:scoring')).toBe('slow')
    expect(v('filter')).toEqual(['filter_pc_mass_error', 'autotune', 'idfilter'])
    for (const flag of ['NuXL:CysteineAdduct', 'NuXL:filter_fractional_mass', 'NuXL:carbon_labeled_fragments', 'NuXL:only_xl']) {
      expect(byName.get(flag)).toMatchObject({ type: 'bool', value: false, tags: ['advanced'] })
    }
    expect(byName.get('NuXL:presets')!.validStrings).toContain('RNA-UV (U)')
    expect(byName.get('NuXL:presets')!.validStrings).toContain('none')
    expect(byName.get('NuXL:scoring')!.validStrings).toEqual(['fast', 'slow'])
    expect(byName.get('peptide:clip_nterm_methionine')).toMatchObject({ type: 'string', value: 'true', validStrings: ['true', 'false'] })
    expect(byName.get('peptide:enzyme')!.validStrings).toContain('Lys-C')
    expect(byName.get('modifications:variable')!.validStrings).toContain('Phospho (S)')
    // only the filters the shim allows (not optimize, RTpredict, pcrecalibration)
    expect(byName.get('filter')!.validStrings).toEqual([
      'filter_pc_mass_error', 'impute_decoy_medians', 'filter_bad_partial_loss_scores', 'autotune', 'idfilter', 'spectrumclusterfilter',
    ])
    // the description with NuXLFDR's constants filled in
    expect(byName.get('report:xl_fdr_groups')!.description).toContain('at most 9 residues')
    expect(byName.get('report:xl_fdr_groups')!.description).toContain('at 10% FDR')
    // the bounds of the form
    expect(byName.get('NuXL:length')).toMatchObject({ min: 0, max: 4 })
    expect(byName.get('precursor:min_charge')).toMatchObject({ min: 1 })
  })
})
