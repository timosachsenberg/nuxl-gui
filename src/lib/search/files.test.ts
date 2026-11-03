import { describe, expect, it } from 'vitest'
import { isFasta, isMzML } from './files'

// (the spectrum and protein counts moved to the shim: src-tauri/tests/files.rs)
describe('files', () => {
  it('recognises the file types by extension, as the shim accepts them', () => {
    expect(isMzML('run.mzML')).toBe(true)
    expect(isMzML('RUN.MZML')).toBe(true)
    expect(isMzML('run.mzML.gz')).toBe(true)
    expect(isMzML('run.raw')).toBe(false)
    expect(isMzML('run.gz')).toBe(false)
    expect(isFasta('db.fasta')).toBe(true)
    expect(isFasta('db.fa')).toBe(true)
    expect(isFasta('db.faa')).toBe(true)
    expect(isFasta('db.fas')).toBe(false)
    expect(isFasta('db.txt')).toBe(false)
  })
})
