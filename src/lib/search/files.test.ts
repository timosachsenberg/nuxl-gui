import { describe, expect, it } from 'vitest'
import { inputPath, isFasta, isMzML, isRaw, isSpectra, isTimsD, unsearchableReason, withoutTrailingSeparator } from './files'

// (the spectrum and protein counts moved to the shim: src-tauri/tests/files.rs)
describe('files', () => {
  it('recognises the file types by extension, as the shim accepts them: mzML, Thermo .raw, Bruker .d', () => {
    expect(isMzML('run.mzML')).toBe(true)
    expect(isMzML('RUN.MZML')).toBe(true)
    expect(isMzML('run.mzML.gz')).toBe(false)
    expect(isMzML('run.raw')).toBe(false)
    expect(isMzML('run.gz')).toBe(false)
    expect(isRaw('run.raw')).toBe(true)
    expect(isRaw('/data/RUN.RAW')).toBe(true)
    expect(isRaw('run.raw.mzML')).toBe(false)
    expect(isTimsD('run.d')).toBe(true)
    expect(isTimsD('/data/run.D/')).toBe(true)
    expect(isTimsD('C:\\data\\run.d\\')).toBe(true)
    expect(isTimsD('run.dat')).toBe(false)
    expect(isTimsD('run.d.zip')).toBe(false)
    expect(isTimsD('/data/run.d/analysis.tdf')).toBe(false)
    for (const name of ['a.mzML', 'a.raw', 'a.d', 'a.d/']) expect(isSpectra(name)).toBe(true)
    for (const name of ['a.mzML.gz', 'a.d.zip', 'a.wiff', 'a', 'db.fasta']) expect(isSpectra(name)).toBe(false)
    expect(isFasta('db.fasta')).toBe(true)
    expect(isFasta('db.fa')).toBe(true)
    expect(isFasta('db.faa')).toBe(true)
    expect(isFasta('db.fas')).toBe(false)
    expect(isFasta('db.txt')).toBe(false)
  })

  it('takes a path without trailing separators, and a file of a .d folder as the folder', () => {
    expect(withoutTrailingSeparator('/data/run.d/')).toBe('/data/run.d')
    expect(withoutTrailingSeparator('C:\\data\\run.d\\\\')).toBe('C:\\data\\run.d')
    expect(withoutTrailingSeparator('/')).toBe('/')
    expect(withoutTrailingSeparator('//')).toBe('/')
    expect(inputPath('/data/run.d//')).toBe('/data/run.d')
    expect(inputPath('/data/run.d/analysis.tdf')).toBe('/data/run.d')
    expect(inputPath('/data/run.d/analysis.tdf_bin')).toBe('/data/run.d')
    expect(inputPath('C:\\data\\run.d\\ANALYSIS.TSF')).toBe('C:\\data\\run.d')
    // not of a .d folder, or another file of it: as it is
    expect(inputPath('/data/plain/analysis.tdf')).toBe('/data/plain/analysis.tdf')
    expect(inputPath('/data/run.d/chromatography-data.sqlite')).toBe('/data/run.d/chromatography-data.sqlite')
    expect(inputPath('/data/run.mzML')).toBe('/data/run.mzML')
  })

  it('says what to do with compressed mzML, zipped .d folders and anything else', () => {
    expect(unsearchableReason([])).toEqual([])
    expect(unsearchableReason(['a.mzML.gz'])).toEqual([
      'a.mzML.gz is compressed. OpenNuXL reads plain mzML only: decompress it first (e.g. with gunzip), then add the .mzML.',
    ])
    expect(unsearchableReason(['a.mzML.gz', 'b.mzML.gz', 'x.d.zip', 'y.D.ZIP', 'notes.txt'])).toEqual([
      'a.mzML.gz and b.mzML.gz are compressed. OpenNuXL reads plain mzML only: decompress them first (e.g. with gunzip), then add the .mzML.',
      'x.d.zip and y.D.ZIP are zipped Bruker .d folders: unzip them first, then add the .d folders.',
      'Not a spectra file: notes.txt. NuXL searches mzML, Thermo .raw or Bruker timsTOF .d; convert other vendor files to mzML first, e.g. with ProteoWizard msconvert.',
    ])
    expect(unsearchableReason(['x.d.zip'])).toEqual(['x.d.zip is a zipped Bruker .d folder: unzip it first, then add the .d folder.'])
  })
})
