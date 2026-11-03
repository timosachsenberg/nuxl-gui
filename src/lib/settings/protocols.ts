// The cross-linking protocols of OpenNuXL (`NuXL:presets`): OpenMS' share/OpenMS/NUXL/nuxl_presets.json, copied to
// nuxl_presets.json (scripts/nuxl-parameters.mjs checks the copy against the pin). A protocol sets the nucleotides,
// which of them cross-link, and the precursor and fragment adducts (NuXLPresets.cpp); OpenNuXL then ignores the
// NuXL fields of those (`PROTOCOL_PARAMETERS`). "none" is the custom protocol: OpenNuXL takes the adducts from those
// fields. The page says in one line what each protocol searches for (`protocolSummary`).

import presets from './nuxl_presets.json'

export type Protocol = {
  target_nucleotides: string[]
  mapping: string[]
  can_cross_link: string
  modifications: string[]
  fragment_adducts: string[]
  standalone?: string
  localization?: string
}

/** The protocols by name, in the file's order ("RNA-UV (U)", ..., "none"). */
export const PROTOCOLS: Readonly<Record<string, Protocol>> = presets as Record<string, Protocol>

/** The protocol of New search's default preset (OpenNuXL's own default is "none"). */
export const DEFAULT_PROTOCOL = 'RNA-UV (U)'

/** The custom protocol: the adducts of the NuXL fields. */
export const CUSTOM_PROTOCOL = 'none'

/**
 * The NuXL parameters a protocol sets in place of the user's (NuXLPresets::getPresets): they count only with the
 * custom protocol, so the request leaves them out otherwise.
 */
export const PROTOCOL_PARAMETERS = [
  'NuXL:target_nucleotides',
  'NuXL:mapping',
  'NuXL:can_cross_link',
  'NuXL:standalone',
  'NuXL:localization',
  'NuXL:modifications',
  'NuXL:fragment_adducts',
] as const

/**
 * The values of the protocol parameters that `name` sets, as the NuXL fields hold them (the custom protocol's
 * starting point); null for the custom protocol or an unknown name. A protocol without `standalone` or
 * `localization` has none (OpenNuXL: no standalone nucleotides, localization by the fragments).
 */
export function protocolParameters(name: string): Record<string, unknown> | null {
  const p = PROTOCOLS[name]
  if (!p || name === CUSTOM_PROTOCOL) return null
  return {
    'NuXL:target_nucleotides': [...p.target_nucleotides],
    'NuXL:mapping': [...p.mapping],
    'NuXL:can_cross_link': p.can_cross_link,
    'NuXL:standalone': p.standalone ?? '',
    'NuXL:localization': p.localization ?? 'fragments',
    'NuXL:modifications': [...p.modifications],
    'NuXL:fragment_adducts': [...p.fragment_adducts],
  }
}

/** The nucleotide letters of the presets that are not a base of its own, as people name them. */
const LETTERS: Readonly<Record<string, string>> = {
  S: '4-thiouridine (S)',
  X: '6-thioguanosine (X)',
  B: 'bromodeoxyuridine (B)',
  d: 'deoxyribose phosphate (d)',
  s: 'the cross-linker alone (s)',
}

/** The chemistry of a protocol, by the part of its name after RNA- or DNA-. */
const CHEMISTRY: [RegExp, string][] = [
  [/^UV\b/, 'UV light'],
  [/^DEB\b/, 'diepoxybutane'],
  [/^NM\b/, 'nitrogen mustard'],
  [/^FA\b/, 'formaldehyde'],
  [/^SDA\b/, 'SDA (NHS-diazirine)'],
]

/** "a", "a and b", "a, b and c" */
function listed(items: string[]): string {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * One line on what protocol `name` searches: the nucleic acid and the chemistry, which nucleotides cross-link, and
 * how many nucleotide adducts it knows ("RNA, UV light · cross-links at U · 10 nucleotide adducts"). The custom protocol says
 * where its adducts come from.
 */
export function protocolSummary(name: string): string {
  if (name === CUSTOM_PROTOCOL) return 'Custom: the nucleotides and adducts of the NuXL parameters (by default U with 4 adducts).'
  const p = PROTOCOLS[name]
  if (!p) return 'A protocol this OpenNuXL does not know.'
  const kind = /^(RNA|DNA)-(.*)$/.exec(name)
  const chemistry = kind ? CHEMISTRY.find(([pattern]) => pattern.test(kind[2]))?.[1] : undefined
  const what = [kind?.[1], chemistry].filter(Boolean).join(', ')
  const at = listed([...p.can_cross_link].map((c) => LETTERS[c] ?? c))
  const extended = /Extended/.test(name) ? ', with more losses' : ''
  const parts = [what, `cross-links at ${at}`, `${p.modifications.length} nucleotide adducts${extended}`]
  if (p.localization === 'NHS') parts.push('sites by NHS-ester chemistry')
  return parts.filter(Boolean).join(' · ')
}
