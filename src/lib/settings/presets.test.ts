import { describe, expect, it } from 'vitest'
import { changedParameters } from './parameters'
import {
  applyPreset,
  BUILTIN_PRESETS,
  DEFAULT_PRESET_ID,
  deletePreset,
  loadPresets,
  presetNamed,
  PRESETS_KEY,
  renamePreset,
  savePreset,
  type PresetStorage,
} from './presets'

/** localStorage in memory. */
function memoryStorage(initial: Record<string, string> = {}): PresetStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  }
}

// a few of OpenNuXL's defaults, and the search's FDRs
const defaults: Record<string, unknown> = {
  'peptide:enzyme': 'Trypsin/P',
  'peptide:missed_cleavages': 2,
  'precursor:mass_tolerance': 6,
  'precursor:mass_tolerance_unit': 'ppm',
  'fragment:mass_tolerance': 20,
  'modifications:fixed': [],
  'modifications:variable': ['Oxidation (M)'],
  'NuXL:presets': 'none',
  'NuXL:length': 2,
  peptideFdr: 0.01,
  xlFdr: 0.01,
}

describe('presets', () => {
  it('has one built-in preset: OpenNuXL\'s defaults with the protocol RNA-UV (U)', () => {
    expect(BUILTIN_PRESETS.map((p) => p.id)).toEqual(['nuxl-defaults'])
    expect(DEFAULT_PRESET_ID).toBe('nuxl-defaults')
    expect(BUILTIN_PRESETS[0]).toEqual({
      id: 'nuxl-defaults',
      name: 'OpenNuXL defaults · RNA-UV (U)',
      builtin: true,
      parameters: { 'NuXL:presets': 'RNA-UV (U)', peptideFdr: 0.01, xlFdr: 0.01 },
    })
  })

  it('a preset sets only its parameters, on top of the defaults (copied)', () => {
    const preset = BUILTIN_PRESETS[0]
    const values = applyPreset(preset, defaults)
    for (const [name, value] of Object.entries(values)) {
      expect(value).toEqual(name in preset.parameters ? preset.parameters[name] : defaults[name])
    }
    expect(values['NuXL:presets']).toBe('RNA-UV (U)')
    expect(values['precursor:mass_tolerance']).toBe(6)

    // a value is copied: editing the result leaves the defaults as they were
    ;(values['modifications:variable'] as string[]).push('Phospho (S)')
    expect(defaults['modifications:variable']).toEqual(['Oxidation (M)'])
  })

  it('saves only the parameters that differ from the defaults', () => {
    const storage = memoryStorage()
    const values = { ...defaults, 'peptide:enzyme': 'Lys-C', 'modifications:variable': ['Oxidation (M)'], xlFdr: 0.05 }
    const changed = changedParameters(values, defaults)
    expect(changed).toEqual({ 'peptide:enzyme': 'Lys-C', xlFdr: 0.05 })

    // the FDRs are preset settings like the parameters
    const saved = savePreset('Lys-C', changed, storage)
    expect(saved).toMatchObject({ name: 'Lys-C', parameters: { 'peptide:enzyme': 'Lys-C', xlFdr: 0.05 }, builtin: false })
    expect(loadPresets(storage).map((p) => p.name)).toEqual([...BUILTIN_PRESETS.map((p) => p.name), 'Lys-C'])
    expect(JSON.parse(storage.data.get(PRESETS_KEY)!)).toHaveLength(1)

    // the same name again replaces the preset (and keeps its id)
    const again = savePreset('Lys-C', { 'peptide:enzyme': 'Lys-C', 'peptide:missed_cleavages': 3 }, storage)
    expect(again.id).toBe(saved.id)
    const users = loadPresets(storage).filter((p) => !p.builtin)
    expect(users).toHaveLength(1)
    expect(users[0].parameters).toEqual({ 'peptide:enzyme': 'Lys-C', 'peptide:missed_cleavages': 3 })
  })

  it('ignores user presets it cannot read', () => {
    expect(loadPresets(memoryStorage({ [PRESETS_KEY]: 'not json' }))).toEqual(BUILTIN_PRESETS)
    expect(loadPresets(memoryStorage({ [PRESETS_KEY]: '[{"name": 3}]' }))).toEqual(BUILTIN_PRESETS)
    expect(loadPresets(null)).toEqual(BUILTIN_PRESETS)
  })

  it('keeps its presets apart from those of ProSE desktop', () => {
    expect(PRESETS_KEY).toBe('nuxl.presets')
  })

  it('renames and deletes user presets, never built-in ones', () => {
    const storage = memoryStorage()
    const lysc = savePreset('Lys-C', { 'peptide:enzyme': 'Lys-C' }, storage)
    const mine = savePreset('mine', { 'peptide:enzyme': 'Arg-C' }, storage)

    // renamed: the id and the parameters stay
    expect(renamePreset(lysc.id, '  Lys-C, 3 missed  ', storage)).toBe(true)
    expect(presetNamed(loadPresets(storage), 'Lys-C, 3 missed')).toMatchObject({ id: lysc.id, parameters: { 'peptide:enzyme': 'Lys-C' } })
    // its own name again is fine; another preset's name, an empty name or a built-in preset is refused
    expect(renamePreset(lysc.id, 'Lys-C, 3 missed', storage)).toBe(true)
    expect(renamePreset(lysc.id, 'mine', storage)).toBe(false)
    expect(renamePreset(lysc.id, BUILTIN_PRESETS[0].name, storage)).toBe(false)
    expect(renamePreset(lysc.id, ' ', storage)).toBe(false)
    expect(renamePreset(DEFAULT_PRESET_ID, 'Orbitrap', storage)).toBe(false)
    expect(loadPresets(storage).filter((p) => !p.builtin).map((p) => p.name)).toEqual(['Lys-C, 3 missed', 'mine'])

    expect(deletePreset(DEFAULT_PRESET_ID, storage)).toBe(false)
    expect(deletePreset(lysc.id, storage)).toBe(true)
    expect(deletePreset(lysc.id, storage)).toBe(false)
    expect(loadPresets(storage).filter((p) => !p.builtin).map((p) => p.id)).toEqual([mine.id])
    expect(loadPresets(storage).slice(0, BUILTIN_PRESETS.length)).toEqual(BUILTIN_PRESETS)
  })

  it('finds a preset by the name it would be saved under', () => {
    const storage = memoryStorage()
    savePreset('mine', {}, storage)
    expect(presetNamed(loadPresets(storage), ' mine ')?.name).toBe('mine')
    expect(presetNamed(loadPresets(storage), BUILTIN_PRESETS[0].name)?.builtin).toBe(true)
    expect(presetNamed(loadPresets(storage), 'other')).toBeNull()
  })
})
