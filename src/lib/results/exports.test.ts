import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenResult } from '../search/session.svelte'

const saved: [string, string, string][] = []
vi.mock('../desktop', () => ({
  errorText: (e: unknown) => String((e as Error)?.message ?? e),
  saveSearchFile: async (id: string, name: string, suggested: string) => {
    saved.push([id, name, suggested])
    return `/saved/${suggested}`
  },
  searchFiles: () => () => Promise.reject(new Error('no folder')),
}))

const { exportIdXML, idXMLFiles } = await import('./exports')

const result = (files: string[]) =>
  ({ id: 's1', design: { rows: files.map((fileName) => ({ fileName })) } }) as unknown as OpenResult
const inputs = (stems: string[]) => async (name: string) => {
  expect(name).toBe('inputs.json')
  return new TextEncoder().encode(JSON.stringify(stems.map((stem, index) => ({ id: String(index), index, stem }))))
}

describe('the idXML exports', () => {
  beforeEach(() => void (saved.length = 0))

  it('offer one idXML per searched file', () => {
    expect(idXMLFiles(result(['a.mzML']))).toEqual([{ input: 0, label: 'idXML' }])
    expect(idXMLFiles(result(['a.mzML', 'b.mzML'])).map((f) => f.label)).toEqual(['idXML: a.mzML', 'idXML: b.mzML'])
  })

  it("save OpenNuXL's idXML of the input, by its stem in inputs.json", async () => {
    await exportIdXML(result(['a.mzML', 'b.mzML']), 1, inputs(['1__a', '2__b']))
    expect(saved).toEqual([['s1', 'nuxl/2__b.idXML', 'b.idXML']])
    await expect(exportIdXML(result(['a.mzML']), 3, inputs(['1__a']))).rejects.toThrow('The search has no input 4.')
    await expect(exportIdXML(result(['a.mzML']), 0)).rejects.toThrow("The search's inputs.json cannot be read (no folder).")
  })

  it('name the idXML of a Thermo .raw or a Bruker .d input without its extension', async () => {
    await exportIdXML(result(['run.raw', 'tims.d']), 0, inputs(['1__run', '2__tims']))
    await exportIdXML(result(['run.raw', 'tims.d']), 1, inputs(['1__run', '2__tims']))
    expect(saved).toEqual([
      ['s1', 'nuxl/1__run.idXML', 'run.idXML'],
      ['s1', 'nuxl/2__tims.idXML', 'tims.idXML'],
    ])
  })
})
