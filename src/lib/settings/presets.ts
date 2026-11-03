// Presets of the search settings: the built-in one and those the user saved ("Save as preset", kept in
// localStorage). A preset holds only the settings it sets (OpenNuXL's parameters by name, and the search's own
// FDRs: parameters.ts `SEARCH_SETTINGS`); everything else is OpenNuXL's default. Not to be confused with OpenNuXL's
// own presets, the cross-linking protocols (`NuXL:presets`, protocols.ts), which a preset sets like any parameter.

import { copyValues, SEARCH_SETTINGS } from './parameters'
import { DEFAULT_PROTOCOL } from './protocols'

export type Preset = { id: string; name: string; parameters: Record<string, unknown>; builtin: boolean }

/** Where the user presets are kept. */
export const PRESETS_KEY = 'nuxl.presets'

/** What the presets need of localStorage (an in-memory one in the tests). */
export type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>

/**
 * The built-in preset: OpenNuXL's defaults (precursor 6 ppm, fragments 20 ppm, Trypsin/P, Oxidation (M), ...) with
 * the protocol of UV cross-linked RNA at U (OpenNuXL's own default is no protocol), and FDRs of 1 %.
 */
export const BUILTIN_PRESETS: Preset[] = [
  {
    id: 'nuxl-defaults',
    name: `OpenNuXL defaults · ${DEFAULT_PROTOCOL}`,
    builtin: true,
    parameters: { 'NuXL:presets': DEFAULT_PROTOCOL, ...SEARCH_SETTINGS },
  },
]

export const DEFAULT_PRESET_ID = 'nuxl-defaults'

/** The webview's localStorage: kept by the app on this computer (its data folder), across restarts. */
function appStorage(): PresetStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // blocked storage
  }
}

function isUserPreset(value: unknown): value is Preset {
  const p = value as Preset
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.parameters === 'object' &&
    p.parameters !== null &&
    !Array.isArray(p.parameters)
  )
}

function readUserPresets(storage: PresetStorage | null): Preset[] {
  if (!storage) return []
  try {
    const list: unknown = JSON.parse(storage.getItem(PRESETS_KEY) ?? '[]')
    if (!Array.isArray(list) || !list.every(isUserPreset)) return []
    return list.map((p) => ({ ...p, builtin: false }))
  } catch {
    return []
  }
}

/** The built-in presets, then the user's. */
export function loadPresets(storage: PresetStorage | null = appStorage()): Preset[] {
  return [...BUILTIN_PRESETS, ...readUserPresets(storage)]
}

/**
 * Saves `parameters` (the values that differ from OpenNuXL's defaults, and the FDRs) as a user preset. A user
 * preset of the same name is replaced.
 */
export function savePreset(
  name: string,
  parameters: Record<string, unknown>,
  storage: PresetStorage | null = appStorage(),
): Preset {
  const values = copyValues(parameters)
  const users = readUserPresets(storage)
  const existing = users.find((p) => p.name === name.trim())
  const preset: Preset = {
    id: existing?.id ?? `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
    parameters: values,
    builtin: false,
  }
  const next = existing ? users.map((p) => (p.id === preset.id ? preset : p)) : [...users, preset]
  writeUserPresets(next, storage)
  return preset
}

function writeUserPresets(presets: Preset[], storage: PresetStorage | null) {
  storage?.setItem(PRESETS_KEY, JSON.stringify(presets.map(({ builtin: _b, ...p }) => p)))
}

/**
 * The preset named `name` (as saved: trimmed), if any. "Save as preset" asks before it replaces a user preset of
 * that name; a built-in one cannot be replaced.
 */
export function presetNamed(presets: Preset[], name: string): Preset | null {
  return presets.find((p) => p.name === name.trim()) ?? null
}

/** Renames the user preset `id` (a built-in one, or a name another preset has, is refused: false). */
export function renamePreset(id: string, name: string, storage: PresetStorage | null = appStorage()): boolean {
  const users = readUserPresets(storage)
  const trimmed = name.trim()
  const other = presetNamed(loadPresets(storage), trimmed)
  if (trimmed === '' || !users.some((p) => p.id === id) || (other !== null && other.id !== id)) return false
  writeUserPresets(users.map((p) => (p.id === id ? { ...p, name: trimmed } : p)), storage)
  return true
}

/** Deletes the user preset `id` (a built-in one stays: false). */
export function deletePreset(id: string, storage: PresetStorage | null = appStorage()): boolean {
  const users = readUserPresets(storage)
  if (!users.some((p) => p.id === id)) return false
  writeUserPresets(users.filter((p) => p.id !== id), storage)
  return true
}

/** The values of a preset: the defaults (OpenNuXL's, and the search's own) with the preset's parameters on top (copies). */
export function applyPreset(preset: Preset, defaults: Record<string, unknown>): Record<string, unknown> {
  return copyValues({ ...defaults, ...preset.parameters })
}
