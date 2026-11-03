import { describe, expect, it } from 'vitest'
import {
  fileSafe,
  fileSafeMaxBytes,
  formatCount,
  formatQCompact,
  formatQValue,
  formatScore,
  naturalKey,
  parseAccession,
  parseDescription,
  resultName,
  sampleHeader,
  scanNumber,
  spectrumLabel,
} from './display'
import type { ResultSample } from './model'

describe('parseAccession', () => {
  it('shows the identifier of a UniProt accession, with its entry name apart', () => {
    expect(parseAccession('sp|P02768|ALBU_HUMAN')).toEqual({ id: 'P02768', entry: 'ALBU_HUMAN', contaminant: false })
    expect(parseAccession('tr|A0A024R161|A0A024R161_HUMAN').id).toBe('A0A024R161')
  })

  it('marks cRAP contaminants and drops their prefix from the identifier', () => {
    expect(parseAccession('CON__P00761')).toEqual({ id: 'P00761', entry: null, contaminant: true })
    expect(parseAccession('CON__sp|P00761|TRYP_PIG')).toEqual({ id: 'P00761', entry: 'TRYP_PIG', contaminant: true })
  })

  it('keeps any other accession as it is', () => {
    expect(parseAccession('ENSP00000354587')).toEqual({ id: 'ENSP00000354587', entry: null, contaminant: false })
    expect(parseAccession('a|b')).toEqual({ id: 'a|b', entry: null, contaminant: false })
  })
})

describe('parseDescription', () => {
  it('reads the protein name, gene and organism of a UniProt header', () => {
    expect(parseDescription('Serum albumin OS=Homo sapiens OX=9606 GN=ALB PE=1 SV=2')).toEqual({
      name: 'Serum albumin',
      gene: 'ALB',
      organism: 'Homo sapiens',
    })
  })

  it('keeps other descriptions whole', () => {
    expect(parseDescription('Synthetic protein 12, family 12')).toEqual({ name: 'Synthetic protein 12, family 12', gene: null, organism: null })
    expect(parseDescription('')).toEqual({ name: '', gene: null, organism: null })
    expect(parseDescription('Trypsin OS=Sus scrofa')).toEqual({ name: 'Trypsin', gene: null, organism: 'Sus scrofa' })
  })
})

describe('sampleHeader', () => {
  const sample = (label: string, condition: string | null): ResultSample =>
    ({ index: 0, condition, replicate: 1, label, designSample: 0, techReplicate: null }) as ResultSample

  it('drops the condition, which the group header shows', () => {
    expect(sampleHeader(sample('EGF 1', 'EGF'))).toBe('1')
    expect(sampleHeader(sample('EGF 1 · TR2', 'EGF'))).toBe('1 · TR2')
    expect(sampleHeader(sample('run_a', null))).toBe('run_a')
  })
})

describe('cell formats', () => {
  it('formats counts with thousands separators', () => {
    expect(formatCount(1284)).toBe('1,284')
    expect(formatCount(0)).toBe('0')
  })

  it('formats q-values: two significant digits, tiny ones in scientific notation, missing as a dash', () => {
    expect(formatQValue(0.0123)).toBe('0.012')
    expect(formatQValue(0.001)).toBe('0.001')
    expect(formatQValue(0.00002)).toBe('2.0e-5')
    expect(formatQValue(0)).toBe('0')
    expect(formatQValue(NaN)).toBe('–')
  })

  it('formats q-values for the narrow list beside the PSM view in six characters at most', () => {
    expect(formatQCompact(0.0031)).toBe('3.1e-3')
    expect(formatQCompact(0.00002)).toBe('2.0e-5')
    expect(formatQCompact(0.0123)).toBe('0.012')
    expect(formatQCompact(0.5)).toBe('0.5')
    expect(formatQCompact(0)).toBe('0')
    expect(formatQCompact(NaN)).toBe('–')
    expect(formatQCompact(1e-12)).toBe('<1e-9')
    for (const q of [1e-12, 0.0099, 0.01, 0.0999, 0.999]) expect(formatQCompact(q).length).toBeLessThanOrEqual(6)
  })

  it('shows the scores Percolator could not give (-100 at q = 1) as a dash', () => {
    expect(formatScore(3.14159, 0.001)).toBe('3.142')
    expect(formatScore(-1.5, 0.2)).toBe('−1.500') // a real minus (U+2212)
    expect(formatScore(-0.0004, 0.01)).toBe('0.000') // rounded first: no "-0.000"
    expect(formatScore(-100, 1)).toBe('–')
    expect(formatScore(NaN, 0.01)).toBe('–')
  })
})

describe('resultName', () => {
  it('names a result after what its files share, for file names', () => {
    expect(resultName(['sample.mzML'])).toBe('sample')
    expect(resultName(['EGF_time_1.mzML', 'EGF_time_2.mzML'])).toBe('EGF_time')
    expect(resultName(['DatabaseSuitability_1.mzML', 'DatabaseSuitability_2.mzML'])).toBe('DatabaseSuitability')
    expect(resultName(['/input/0/a b (1).mzML'])).toBe('a_b_1')
    expect(resultName(['control_1.mzML', 'EGF_1.mzML'])).toBe('prose-results')
    expect(resultName([])).toBe('prose-results')
  })

  it('keeps the letters of any script', () => {
    expect(resultName(['Probe Größe ä ö ü.mzML'])).toBe('Probe_Größe_ä_ö_ü')
    expect(resultName(['Müller_1.mzML', 'Müller_2.mzML'])).toBe('Müller')
    expect(resultName(['蛋白质组_1.mzML'])).toBe('蛋白质组_1')
    expect(resultName(['Ångström Łódź.mzML'])).toBe('Ångström_Łódź')
    // a decomposed "ü" (u and a combining diaeresis) is the same name as the composed one
    expect(resultName(['Gru\u0308n_1.mzML', 'Gru\u0308n_2.mzML'])).toBe('Grün')
  })

  it('still replaces what a file name cannot hold', () => {
    expect(fileSafe('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
    expect(fileSafe('tab\there\u0000nul')).toBe('tab_here_nul')
    expect(fileSafe('../ü')).toBe('ü')
  })

  it('never makes a name Windows reserves for a device', () => {
    for (const name of ['CON', 'con', 'Prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt5', 'COM¹', 'LPT³']) {
      expect(fileSafe(name)).toBe(`_${name}`)
    }
    // with an extension too ("NUL.txt" is the device as well)
    expect(fileSafe('NUL.txt')).toBe('_NUL.txt')
    expect(fileSafe('con.tar.gz')).toBe('_con.tar.gz')
    expect(fileSafe('Aux. data')).toBe('_Aux._data')
    // made reserved by the replacements: "CON " and "(nul)" become CON and nul
    expect(fileSafe('CON ')).toBe('_CON')
    expect(fileSafe('(nul)')).toBe('_nul')
    // names that only start like one are names
    for (const name of ['CONSOLE', 'nullable', 'COM10', 'LPT0x', 'auxiliary', 'CON_1', 'PRN-2', 'com']) {
      expect(fileSafe(name)).toBe(name)
    }
    // a result named after such a file gets the prefix too
    expect(resultName(['AUX.mzML'])).toBe('_AUX')
    expect(resultName(['nul_1.mzML', 'nul_2.mzML'])).toBe('_nul')
  })

  it('caps a name at 200 UTF-8 bytes, cut between characters', () => {
    const bytes = (s: string) => new TextEncoder().encode(s).length
    expect(fileSafeMaxBytes).toBe(200)
    expect(fileSafe('a'.repeat(250))).toBe('a'.repeat(200))
    // three bytes a character: 66 of them (198 bytes; a 67th would make 201)
    const cjk = fileSafe('蛋'.repeat(150))
    expect(cjk).toBe('蛋'.repeat(66))
    expect(bytes(cjk)).toBe(198)
    // outside the BMP: four bytes (two UTF-16 units) a character, never split in half
    expect(fileSafe('𝔸'.repeat(120))).toBe('𝔸'.repeat(50))
    const mixed = fileSafe(`a${'𠀀'.repeat(60)}`)
    expect(mixed).toBe(`a${'𠀀'.repeat(49)}`)
    expect(bytes(mixed)).toBe(197)
    expect(/\p{Cs}/u.test(mixed)).toBe(false) // no lone surrogate
    // two bytes: "ü" 100 times fits exactly
    expect(fileSafe('ü'.repeat(130))).toBe('ü'.repeat(100))
    // no separator is left at the cut
    expect(fileSafe(`${'b'.repeat(199)}_c`)).toBe('b'.repeat(199))
    // the "_" of a reserved name is inside the limit
    const reserved = fileSafe(`CON.${'x'.repeat(300)}`)
    expect(reserved.startsWith('_CON.x')).toBe(true)
    expect(bytes(reserved)).toBe(200)
    expect(resultName([`${'x'.repeat(300)}.mzML`])).toBe('x'.repeat(200))
  })
})

describe('spectrumLabel', () => {
  it('shows the scan, spectrum or index number of a native ID', () => {
    expect(spectrumLabel('controllerType=0 controllerNumber=1 scan=4711')).toBe('4711')
    expect(spectrumLabel('spectrum=2')).toBe('2')
    expect(spectrumLabel('index=17')).toBe('17')
    expect(spectrumLabel('frame=5 scan=12')).toBe('12')
    expect(spectrumLabel('merged=3 frame=5')).toBe('merged=3 frame=5')
    expect(spectrumLabel('scan=12a')).toBe('scan=12a')
  })
})

describe('scanNumber', () => {
  it('is the number of a scan=, spectrum= or index= term, else null', () => {
    expect(scanNumber('controllerType=0 controllerNumber=1 scan=4711')).toBe(4711)
    expect(scanNumber('spectrum=0')).toBe(0)
    expect(scanNumber('index=17')).toBe(17)
    expect(scanNumber('merged=3 frame=5')).toBeNull()
    expect(scanNumber('scan=12a')).toBeNull()
    expect(scanNumber('')).toBeNull()
  })
})

describe('naturalKey', () => {
  it('orders digits as numbers and ignores case, so that plain string comparison gives the natural order', () => {
    const ids = ['frame=12', 'Frame=5', 'frame=100', 'frame=5a', 'frame=0']
    const sorted = [...ids].sort((a, b) => (naturalKey(a) < naturalKey(b) ? -1 : naturalKey(a) > naturalKey(b) ? 1 : 0))
    expect(sorted).toEqual(['frame=0', 'Frame=5', 'frame=5a', 'frame=12', 'frame=100'])
  })
})
