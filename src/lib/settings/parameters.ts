// OpenNuXL's parameters as the New search page handles them: OpenNuXL's defaults (`NUXL_PARAMETERS`, generated
// from the OpenMS pin at build time), the search's own settings kept beside them (the FDRs), the values the page
// sends, and the sections of the parameters.

/** One of OpenNuXL's parameters (scripts/nuxl-parameters.mjs). */
export type ParamEntry = {
  name: string
  value: number | string | boolean | number[] | string[] | null
  type: 'string' | 'int' | 'double' | 'bool' | 'string[]' | 'int[]' | 'double[]' | 'empty'
  description: string
  tags: string[]
  validStrings?: string[]
  min?: number
  max?: number
}

/**
 * The search's own settings that the form keeps with OpenNuXL's parameters (presets save them, the example sets
 * them) but that the request sends apart (`settings.peptideFdr`, `settings.xlFdr`: fractions), never as parameters:
 * the shim gives OpenNuXL its FDR options itself (docs/design.md §3).
 */
export const SEARCH_SETTINGS = {
  /** The peptide PSMs' FDR (q-value cutoff). */
  peptideFdr: 0.01,
  /** The cross-link PSMs' FDR (q-value cutoff). */
  xlFdr: 0.01,
} as const

export type SearchSettingName = keyof typeof SEARCH_SETTINGS

export const SEARCH_SETTING_NAMES = Object.keys(SEARCH_SETTINGS) as SearchSettingName[]

/** The parameters the dialog lists: all of OpenNuXL's that the app may set. */
export function dialogEntries(entries: ParamEntry[]): ParamEntry[] {
  return entries
}

/** The section of a parameter: the part of its name before the last ":" ("general" without one). */
export function sectionOf(name: string): string {
  const colon = name.lastIndexOf(':')
  return colon < 0 ? 'general' : name.slice(0, colon)
}

/** The entries by section, in the order of their first parameter (OpenNuXL's order). */
export function parameterSections(entries: ParamEntry[]): { name: string; entries: ParamEntry[] }[] {
  const sections = new Map<string, ParamEntry[]>()
  for (const e of entries) {
    const section = sectionOf(e.name)
    const list = sections.get(section)
    if (list) list.push(e)
    else sections.set(section, [e])
  }
  return [...sections].map(([name, list]) => ({ name, entries: list }))
}

/** OpenNuXL's defaults by name. */
export function defaultsOf(entries: ParamEntry[]): Record<string, unknown> {
  return Object.fromEntries(entries.map((e) => [e.name, e.value]))
}

/** Whether two parameter values are the same (lists item by item, in order). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i])
  return a === b
}

/** The values that differ from the defaults (also those without a default). */
export function changedParameters(
  values: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const changed: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(values)) {
    if (!(name in defaults) || !sameValue(value, defaults[name])) changed[name] = copyValue(value)
  }
  return changed
}

/**
 * The parameters of a search request: the values of OpenNuXL's parameters (`entries`: the shim's allowlist) that
 * differ from OpenNuXL's defaults. Nothing else goes: not the search's own settings (`SEARCH_SETTINGS`), not a name
 * OpenNuXL's list does not have (a preset of another version), not an empty text (the shim passes no argument for
 * one, so OpenNuXL's default applies: the field says so, `emptyTextDefault`).
 */
export function requestParameters(values: Record<string, unknown>, entries: ParamEntry[]): Record<string, unknown> {
  const parameters: Record<string, unknown> = {}
  for (const e of entries) {
    if (!(e.name in values)) continue
    const value = values[e.name]
    if (value === undefined || sameValue(value, e.value)) continue
    if (e.type === 'string' && value === '') continue
    parameters[e.name] = copyValue(value)
  }
  return parameters
}

/**
 * OpenNuXL's default that runs when a text parameter is left empty (the shim passes no argument for an empty text):
 * its default when that is not empty, else null (empty and the default are the same).
 */
export function emptyTextDefault(entry: ParamEntry): string | null {
  return entry.type === 'string' && typeof entry.value === 'string' && entry.value !== '' ? entry.value : null
}

/** A value that can be edited without changing the original (lists are copied). */
export function copyValue<T>(value: T): T {
  return (Array.isArray(value) ? [...value] : value) as T
}

/** A copy of a set of values (its lists copied too). */
export function copyValues(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, copyValue(v)]))
}
