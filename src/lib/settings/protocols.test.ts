import { describe, expect, it } from 'vitest'
import { NUXL_PARAMETERS } from './nuxl'
import { CUSTOM_PROTOCOL, DEFAULT_PROTOCOL, PROTOCOL_PARAMETERS, protocolParameters, PROTOCOLS, protocolSummary } from './protocols'

describe('the cross-linking protocols (NuXL:presets)', () => {
  it("are OpenNuXL's presets, with the default and the custom one among them", () => {
    const presets = NUXL_PARAMETERS.find((e) => e.name === 'NuXL:presets')!.validStrings!
    expect(Object.keys(PROTOCOLS)).toEqual(presets)
    expect(presets).toContain(DEFAULT_PROTOCOL)
    expect(presets).toContain(CUSTOM_PROTOCOL)
    for (const p of PROTOCOL_PARAMETERS) expect(NUXL_PARAMETERS.some((e) => e.name === p), p).toBe(true)
  })

  it('say in one line what they search, from the presets file', () => {
    expect(protocolSummary('RNA-UV (U)')).toBe('RNA, UV light · cross-links at U · 10 nucleotide adducts')
    expect(protocolSummary('RNA-UV Extended (UCGA)')).toBe('RNA, UV light · cross-links at U, C, G and A · 29 nucleotide adducts, with more losses')
    expect(protocolSummary('RNA-UV (4SU)')).toBe('RNA, UV light · cross-links at 4-thiouridine (S) · 6 nucleotide adducts')
    expect(protocolSummary('DNA-UV')).toBe('DNA, UV light · cross-links at T, C, G, A and deoxyribose phosphate (d) · 12 nucleotide adducts')
    expect(protocolSummary('RNA-DEB')).toBe('RNA, diepoxybutane · cross-links at U, C, G and A · 4 nucleotide adducts')
    expect(protocolSummary('RNA-SDA')).toBe(
      'RNA, SDA (NHS-diazirine) · cross-links at U, C, G, A and the cross-linker alone (s) · 15 nucleotide adducts · sites by NHS-ester chemistry',
    )
    expect(protocolSummary('none')).toMatch(/^Custom: the nucleotides and adducts of the NuXL parameters/)
    expect(protocolSummary('nonsense')).toBe('A protocol this OpenNuXL does not know.')
    // every protocol has a line of its own
    for (const name of Object.keys(PROTOCOLS)) expect(protocolSummary(name), name).not.toMatch(/undefined|^ ·/)
  })

  it('give the custom protocol their nucleotides and adducts to start from', () => {
    expect(protocolParameters('none')).toBeNull()
    expect(protocolParameters('nonsense')).toBeNull()
    const uv = protocolParameters('RNA-UV (U)')!
    expect(Object.keys(uv).sort()).toEqual([...PROTOCOL_PARAMETERS].sort())
    expect(uv['NuXL:can_cross_link']).toBe('U')
    expect(uv['NuXL:standalone']).toBe('')
    expect(uv['NuXL:localization']).toBe('fragments')
    expect(uv['NuXL:modifications']).toEqual(PROTOCOLS['RNA-UV (U)'].modifications)
    expect(protocolParameters('RNA-SDA')).toMatchObject({ 'NuXL:standalone': 's', 'NuXL:localization': 'NHS' })
    // copies: editing them leaves the protocol as it is
    ;(uv['NuXL:modifications'] as string[]).push('U:+H2O')
    expect(PROTOCOLS['RNA-UV (U)'].modifications).not.toContain('U:+H2O')
  })
})
