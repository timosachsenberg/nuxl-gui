// A large search through the screens: a real cross-linking run against a proteome-sized database with the
// preset's settings (RNA-UV (U)), by OpenNuXL with Percolator. On demand (it takes long and several GB):
//
//   NUXL_BIG=1 NUXL_TOOL=… NUXL_BIG_MZML=<run.mzML> NUXL_BIG_FASTA=<proteome.fasta> e2e/run.sh e2e/big.spec.ts
//
// Data: NUXL_BIG_MZML and NUXL_BIG_FASTA, default <NUXL_BIG_DIR>/big.mzML and <NUXL_BIG_DIR>/big.fasta
// (NUXL_BIG_DIR, default /scratch/sachsenb/nuxl-bench/data). Logs the search's time and the peak memory of the
// OpenNuXL process (VmHWM, polled once a second; the last reading before it ends).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appReady, clearSearches, dropFiles, freshForm, peakMemoryKb, toolProcesses, resultsId, textOf } from './lib.ts'

const data = process.env.NUXL_BIG_DIR ?? '/scratch/sachsenb/nuxl-bench/data'
const spectra = process.env.NUXL_BIG_MZML ?? join(data, 'big.mzML')
const database = process.env.NUXL_BIG_FASTA ?? join(data, 'big.fasta')
const enabled = Boolean(process.env.NUXL_BIG && process.env.NUXL_TOOL) && existsSync(spectra) && existsSync(database)

describe('a large search', () => {
  before(async function () {
    if (!enabled) {
      console.log('skipped: NUXL_BIG=1 (and NUXL_TOOL, and the data of NUXL_BIG_MZML and NUXL_BIG_FASTA) runs the large search')
      this.skip()
    }
    await appReady()
  })

  after(() => clearSearches())

  it('a large cross-linking search finishes', async function () {
    this.timeout(4 * 60 * 60 * 1000)
    await freshForm()
    await dropFiles([spectra, database])
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(expect.stringContaining('proteins'), { wait: 120000 })
    await expect($('[data-testid="search-plan"]')).toBeDisplayed()
    await $('button*=Start search').waitForEnabled({ timeout: 20000 }).catch(async (e) => {
      throw new Error(`Start search stays disabled: ${await textOf('#start-problem').catch(() => 'no reason shown')} (${e.message})`)
    })
    await $('button*=Start search').click()
    await $('[data-testid="search-progress"]').waitForDisplayed({ timeout: 30000 })

    // the search runs: its time, and the peak memory of OpenNuXL as the kernel counts it
    const started = Date.now()
    let peakKb = 0
    let progress = ''
    while ((await resultsId()) === null) {
      for (const p of toolProcesses()) peakKb = Math.max(peakKb, peakMemoryKb(p.pid) ?? 0)
      const failed = await $$('[data-testid="search-error"]')
      if (failed.length > 0) throw new Error(`the search failed: ${await failed[0].getProperty('textContent')}`)
      const now = (await textOf('[data-testid="search-progress"]').catch(() => progress)).trim()
      if (now !== progress) {
        progress = now
        console.log(`BIG ${Math.round((Date.now() - started) / 1000)} s: ${progress}`)
      }
      if (Date.now() - started > 235 * 60 * 1000) throw new Error('the search took longer than 235 minutes')
      await browser.pause(1000)
    }
    const seconds = (Date.now() - started) / 1000
    console.log(`BIG RESULT: ${seconds.toFixed(0)} s, OpenNuXL peak memory (VmHWM) ${(peakKb / 1024 / 1024).toFixed(2)} GB`)

    const count = $('[data-testid="psm-count"]')
    await count.waitForDisplayed({ timeout: 120000 })
    console.log(`BIG PSMs: ${await textOf('[data-testid="psm-count"]')}`)
    expect(await textOf('[data-testid="psm-count"]')).toMatch(/[1-9]/)
    expect(peakKb).toBeGreaterThan(0)
  })
})
