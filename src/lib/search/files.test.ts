import { describe, expect, it } from 'vitest'
import { isFasta, isMzML, unsearchableReason } from './files'

// (the spectrum and protein counts moved to the shim: src-tauri/tests/files.rs)
describe('files', () => {
  it('recognises the file types by extension, as the shim accepts them: plain mzML only', () => {
    expect(isMzML('run.mzML')).toBe(true)
    expect(isMzML('RUN.MZML')).toBe(true)
    expect(isMzML('run.mzML.gz')).toBe(false)
    expect(isMzML('run.raw')).toBe(false)
    expect(isMzML('run.gz')).toBe(false)
    expect(isFasta('db.fasta')).toBe(true)
    expect(isFasta('db.fa')).toBe(true)
    expect(isFasta('db.faa')).toBe(true)
    expect(isFasta('db.fas')).toBe(false)
    expect(isFasta('db.txt')).toBe(false)
  })

  it('says what to do with compressed mzML, raw files and anything else', () => {
    expect(unsearchableReason([])).toEqual([])
    expect(unsearchableReason(['a.mzML.gz'])).toEqual([
      'a.mzML.gz is compressed. OpenNuXL reads plain mzML only: decompress it first (e.g. with gunzip), then add the .mzML.',
    ])
    expect(unsearchableReason(['a.mzML.gz', 'b.mzML.gz', 'x.RAW', 'notes.txt'])).toEqual([
      'a.mzML.gz and b.mzML.gz are compressed. OpenNuXL reads plain mzML only: decompress them first (e.g. with gunzip), then add the .mzML.',
      'x.RAW: Thermo raw files cannot be searched directly. Convert it to mzML first, e.g. with ThermoRawFileParser or ProteoWizard msconvert.',
      'Not an mzML file: notes.txt. Convert vendor files to mzML first, e.g. with ProteoWizard msconvert.',
    ])
  })
})
