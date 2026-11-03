import { describe, expect, it } from 'vitest'
import { describeFailure } from './failure'

const files = ['good.mzML', 'broken.mzML']
const stalled = 10_000
const parseError =
  'Parse Error: - due to that error of type Parse Error in: /src/openms/source/FORMAT/HANDLERS/XMLHandler.cpp@68-' +
  'void OpenMS::Internal::XMLHandler::fatalError(ActionMode, const std::string &, UInt, UInt) const'

describe('describeFailure', () => {
  it('leads with how OpenNuXL ended, and keeps its last lines and log as the detail', () => {
    const stage = { label: 'Searching broken.mzML (2 of 2)...', file: 1, files, silentMs: 0 }
    const crashed = describeFailure(stage, 'Reading /data/broken.mzML ...', {
      ended: 'OpenNuXL crashed (signal 11, SIGSEGV)',
      detail: 'Loading /data/broken.mzML\nReading /data/broken.mzML ...',
      log: '/home/me/.local/share/org.openms.nuxl.desktop/logs/last-failure.log',
    })
    expect(crashed).toEqual({
      context: 'While searching file 2 of 2 (broken.mzML)',
      summary: 'OpenNuXL crashed (signal 11, SIGSEGV): Reading /data/broken.mzML ...',
      detail: 'Loading /data/broken.mzML\nReading /data/broken.mzML ...',
      log: '/home/me/.local/share/org.openms.nuxl.desktop/logs/last-failure.log',
    })
    // an exit code, with an OpenMS exception shortened (its "Error:" left out after the lead)
    const exited = describeFailure(stage, `Error: ${parseError}`, { ended: 'OpenNuXL ended with exit code 3', detail: `x\nError: ${parseError}` })
    expect(exited.summary).toBe('OpenNuXL ended with exit code 3: Parse Error. The file may be incomplete or not valid mzML.')
    expect(exited.detail).toBe(`x\nError: ${parseError}`)
    // nothing said: the lead alone
    expect(describeFailure(stage, '', { ended: 'OpenNuXL crashed (signal 9, SIGKILL)' }).summary).toBe('OpenNuXL crashed (signal 9, SIGKILL).')
    // without how it ended (the shim's own failures), as before
    expect(describeFailure(stage, 'The search folder cannot be finished (busy).')).toEqual({
      context: 'While searching file 2 of 2 (broken.mzML)',
      summary: 'The search folder cannot be finished (busy).',
      detail: null,
    })
  })

  it('names the file and stage of the last progress report and keeps the raw text as detail', () => {
    const f = describeFailure({ label: 'Filtering spectra...', file: 1, files, silentMs: 10 }, parseError)
    expect(f.context).toBe('While searching file 2 of 2 (broken.mzML)')
    expect(f.summary).toBe('Parse Error. The file may be incomplete or not valid mzML.')
    expect(f.detail).toBe(parseError)
  })

  it('says only the file for a one-file search', () => {
    const f = describeFailure({ label: 'Post-processing PSMs...', file: 0, files: ['run.mzML'], silentMs: 0 }, 'x')
    expect(f.context).toBe('While searching run.mzML')
  })

  it('names the steps outside the files', () => {
    const stage = (label: string) => describeFailure({ label, file: -1, files, silentMs: 0 }, 'x').context
    expect(stage('Reading the files...')).toBe('While reading the files')
    expect(stage('Starting OpenMS...')).toBe('While starting OpenMS')
    // the shim's steps (src-tauri/src/progress.rs)
    expect(stage('Starting OpenNuXL...')).toBe('While starting OpenNuXL')
    expect(stage('Preparing the database…')).toBe('While preparing the database')
    expect(stage('Reading the results...')).toBe('While reading the results')
    expect(stage('Writing the results...')).toBe('During “Writing the results”')
    expect(stage('')).toBe('During the search')
  })

  it('keeps the app\'s own messages whole', () => {
    const own = 'The search folder cannot be finished (Access is denied. (os error 5)).'
    const f = describeFailure({ label: 'Scoring run.mzML (1 of 2)… 45 %', file: 0, files, silentMs: 0 }, own)
    expect(f.summary).toBe(own)
    expect(f.detail).toBeNull()
  })

  it('names the database whose count failed after Start', () => {
    const f = describeFailure({ label: 'Counting proteins...', file: -1, files, silentMs: 0 }, 'large.fasta cannot be read (NotReadableError).')
    expect(f.context).toBe('While counting the proteins of large.fasta')
    expect(f.summary).toBe('large.fasta cannot be read (NotReadableError).')
    expect(describeFailure({ label: 'Counting proteins...', file: -1, files, silentMs: 0 }, 'x').context).toBe('While counting the proteins')
  })

  it('shortens OpenMS exceptions to their message', () => {
    const invalid =
      'InvalidValue: the value of NuXL:length is out of range - due to that error of type InvalidValue in: /a.cpp@1-f()'
    const f = describeFailure({ label: 'Reading the files...', file: -1, files, silentMs: 0 }, invalid)
    expect(f.summary).toBe('InvalidValue: the value of NuXL:length is out of range.')
    expect(f.detail).toBe(invalid)
  })

  it("names Percolator's step of a file", () => {
    const stage = { label: 'Percolator: good.mzML (2 of 2)…', file: 1, files: ['small.mzML', 'good.mzML'], silentMs: stalled }
    expect(describeFailure(stage, 'x').context).toBe('While rescoring file 2 of 2 (good.mzML) with Percolator')
    expect(describeFailure({ ...stage, files: ['good.mzML'], file: 0 }, 'x').context).toBe('While rescoring good.mzML with Percolator')
  })

  it('names the file whose step ended last: its end report comes before its own error', () => {
    // reproduced: good.mzML then broken.mzML; OpenNuXL ends the step of broken.mzML (0.95), then throws
    const f = describeFailure({ label: 'Searching broken.mzML (2 of 2)...', file: 1, files, silentMs: 0 }, parseError)
    expect(f.context).toBe('While searching file 2 of 2 (broken.mzML)')
  })

  it('does not name a stage for a step without progress reports (Percolator), only its file', () => {
    const f = describeFailure({ label: 'Post-processing PSMs...', file: 1, files, silentMs: stalled }, 'x')
    expect(f.context).toBe('While searching file 2 of 2 (broken.mzML), in a step without progress reports (e.g. Percolator)')
  })

  it('cleans up OpenMS exceptions without a location', () => {
    const fasta = 'Parse Error: Error while parsing FASTA file! The first entry could not be read! Please check the file! in: '
    const f = describeFailure({ label: 'Generate decoys...', file: 0, files, silentMs: 0 }, fasta)
    expect(f.summary).toBe('Parse Error: Error while parsing FASTA file! The first entry could not be read! Please check the file!')
    expect(f.summary).not.toMatch(/in:/)
    expect(f.detail).toBe(fasta)
    // an ordinary "in:" inside a message stays
    expect(describeFailure({ label: '', file: -1, files, silentMs: 0 }, 'No PSMs in: the run').summary).toBe('No PSMs in: the run')
  })
})
