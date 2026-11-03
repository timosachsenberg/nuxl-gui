// What History says of a search beside its name, to tell searches of the same name apart (a search repeated
// with other settings is named after the same files): its database, and of its settings those that differ
// between the searches of that name ("co-isolated precursors", "fragment 0.5 Da", "protein FDR 5 %"). The
// record's settings hold the parameters that differ from ProSE's defaults; the rest is ProSE's defaults.

import { formatPercent } from '../format/fdr'
import { defaultsOf } from '../settings/parameters'
import { PROSE_PARAMETERS } from '../settings/prose'
import type { HistoryEntry } from './history'

/** One thing about a search: what it is (to compare searches by) and how it reads. */
export type Fact = { key: string; text: string }

const defaults = defaultsOf(PROSE_PARAMETERS)

/** The parameters the facts below cover (the rest each make a fact of their own). */
const COVERED = new Set([
  'enzyme',
  'precursor:mass_tolerance_lower',
  'precursor:mass_tolerance_upper',
  'precursor:mass_tolerance_unit',
  'fragment:mass_tolerance',
  'fragment:mass_tolerance_unit',
  'FDR:PSM',
  'FDR:protein',
])

const number = (v: unknown) => (typeof v === 'number' ? String(Number(v.toPrecision(6))) : String(v))

/** A parameter that is not covered, as people read it: "co-isolated precursors", "database chunks of 2000". */
function parameterText(name: string, value: unknown): string {
  if (name === 'chimeric:enabled') return value === true ? 'co-isolated precursors' : 'no co-isolated precursors'
  if (name === 'database:chunk_size') return Number(value) > 0 ? `database chunks of ${number(value)}` : 'no database chunks'
  if (name === 'peptide:missed_cleavages') return `${number(value)} missed ${Number(value) === 1 ? 'cleavage' : 'cleavages'}`
  if (name === 'modifications:variable' || name === 'modifications:fixed') {
    const kind = name === 'modifications:fixed' ? 'fixed' : 'variable'
    const list = Array.isArray(value) ? value : []
    return list.length > 0 ? `${kind}: ${list.join(', ')}` : `no ${kind} modifications`
  }
  const shown = Array.isArray(value) ? value.join(', ') || 'none' : typeof value === 'boolean' ? (value ? 'on' : 'off') : number(value)
  return `${name} ${shown}`
}

/**
 * What a search is, in the order History shows it: database, preset, enzyme, tolerances, FDRs, rescoring,
 * contaminants, then the other parameters the search changed. `presetName` names a preset by its id (null:
 * unknown, e.g. one deleted since). An entry without a record has none.
 */
export function entryFacts(entry: HistoryEntry, presetName: (id: string) => string | null = () => null): Fact[] {
  if (entry.error !== null) return []
  const settings = entry.settings ?? {}
  const parameters = settings.parameters ?? {}
  const value = (name: string) => (name in parameters ? parameters[name] : defaults[name])
  const facts: Fact[] = []
  if (entry.database) facts.push({ key: 'database', text: entry.database })
  if (settings.presetId !== undefined) facts.push({ key: 'preset', text: presetName(settings.presetId) ?? `preset ${settings.presetId}` })
  facts.push({ key: 'enzyme', text: String(value('enzyme')) })
  const [lower, upper, unit] = ['lower', 'upper', 'unit'].map((p) => value(`precursor:mass_tolerance_${p}`))
  const window = lower === upper ? `±${number(lower)}` : `−${number(lower)}/+${number(upper)}`
  facts.push({ key: 'precursor', text: `precursor ${window} ${unit}` })
  facts.push({ key: 'fragment', text: `fragment ${number(value('fragment:mass_tolerance'))} ${value('fragment:mass_tolerance_unit')}` })
  // (a search without decoys has none: its cutoff is 1, as the protein FDR's when off)
  if (entry.psmFdr !== null) facts.push({ key: 'psmFdr', text: entry.psmFdr >= 1 ? 'no PSM FDR' : `PSM FDR ${formatPercent(entry.psmFdr)}` })
  if (entry.proteinFdr !== null) {
    facts.push({ key: 'proteinFdr', text: entry.proteinFdr >= 1 ? 'no protein FDR' : `protein FDR ${formatPercent(entry.proteinFdr)}` })
  }
  if (settings.rescore !== undefined) {
    facts.push({ key: 'rescore', text: !settings.rescore ? 'no rescoring' : settings.peptdeep ? 'Percolator with PeptDeep' : 'Percolator' })
  }
  if (settings.contaminants !== undefined) facts.push({ key: 'contaminants', text: settings.contaminants ? 'with cRAP' : 'without cRAP' })
  for (const [name, v] of Object.entries(parameters)) {
    if (!COVERED.has(name)) facts.push({ key: `parameter:${name}`, text: parameterText(name, v) })
  }
  return facts
}

/**
 * The line beside each search's name (by id): its database, then the facts that differ between it and the
 * other searches of the same name (a fact that one has and another has not differs too: a parameter at
 * ProSE's default is not in the record). A search whose name is its own, or that has no record, gets its
 * database only (or nothing).
 */
export function distinguishing(entries: HistoryEntry[], presetName?: (id: string) => string | null): Map<string, Fact[]> {
  const facts = new Map(entries.map((e) => [e.id, entryFacts(e, presetName)]))
  const groups = new Map<string, HistoryEntry[]>()
  for (const e of entries) {
    if (e.error !== null) continue
    const name = e.name ?? e.id
    groups.set(name, [...(groups.get(name) ?? []), e])
  }
  const out = new Map<string, Fact[]>()
  for (const e of entries) {
    const own = facts.get(e.id)!
    const database = own.filter((f) => f.key === 'database')
    const group = e.error === null ? groups.get(e.name ?? e.id)! : [e]
    if (group.length < 2) {
      out.set(e.id, database)
      continue
    }
    const texts = group.map((g) => new Map(facts.get(g.id)!.map((f) => [f.key, f.text])))
    const differs = (f: Fact) => texts.some((t) => t.get(f.key) !== f.text)
    out.set(e.id, [...database, ...own.filter((f) => f.key !== 'database' && differs(f))])
  }
  return out
}
