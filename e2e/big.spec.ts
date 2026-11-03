// A large search through the screens: the TMT run of Erwinia against the human reference proteome with the
// Erwinia proteins added, semi-tryptic and without database chunks (the bench's `erwinia_semi_human`, whose
// database has the Erwinia proteins so that the run has identifications: against the human proteome alone
// no PSM passes the FDR, and ProSE reports an empty result). On demand (it takes minutes and several GB):
//
//   PROSE_BIG=1 PROSE_BIN=… native/scripts/in-env.sh e2e/run.sh e2e/big.spec.ts
//
// Data: PROSE_BIG_DIR, default /scratch/sachsenb/prose-bench/data. Logs the search's time and the peak
// memory of the ProSE process (VmHWM, polled once a second; the last reading before it ends).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appReady, clearSearches, dropFiles, freshForm, peakMemoryKb, proseProcesses, resultsId, textOf } from './lib.ts'

const data = process.env.PROSE_BIG_DIR ?? '/scratch/sachsenb/prose-bench/data'
const spectra = join(data, 'erwinia_tmt.mzML')
const human = join(data, 'human_ref.fasta')
const erwinia = join(data, 'erwinia.fasta')
const enabled = Boolean(process.env.PROSE_BIG && process.env.PROSE_BIN) && existsSync(spectra) && existsSync(human) && existsSync(erwinia)

const PRESET = {
  id: 'e2e-tmt-semi',
  name: 'TMT · semi-tryptic',
  parameters: {
    'modifications:fixed': ['Carbamidomethyl (C)', 'TMT6plex (K)', 'TMT6plex (N-term)'],
    'modifications:variable': ['Oxidation (M)'],
    'peptide:enzyme_specificity': 'semi',
    'precursor:mass_tolerance_lower': 10,
    'precursor:mass_tolerance_upper': 10,
    'precursor:mass_tolerance_unit': 'ppm',
    'fragment:mass_tolerance': 0.02,
    'fragment:mass_tolerance_unit': 'Da',
    'FDR:PSM': 0.01,
    'FDR:protein': 0.01,
    'database:chunk_size': 0,
  },
}

describe('a large search', () => {
  let work: string | undefined
  let database = ''

  before(async function () {
    if (!enabled) {
      console.log('skipped: PROSE_BIG=1 (and PROSE_BIN, and the data of PROSE_BIG_DIR) runs the large search')
      this.skip()
    }
    work = mkdtempSync(join(tmpdir(), 'prose-e2e-big-'))
    database = join(work, 'human_ref+erwinia.fasta')
    writeFileSync(database, Buffer.concat([readFileSync(human), Buffer.from('\n'), readFileSync(erwinia)]))
    await appReady()
  })

  after(() => {
    if (work) rmSync(work, { recursive: true, force: true })
    clearSearches()
  })

  it('a human semi-tryptic search without chunks finishes', async function () {
    this.timeout(60 * 60 * 1000)
    await browser.execute((preset) => localStorage.setItem('prose.presets', JSON.stringify([preset])), PRESET)
    await freshForm()
    await dropFiles([spectra, database])
    await expect($('[data-testid="fasta-proteins"]')).toHaveText(expect.stringContaining('proteins'), { wait: 120000 })
    await $('#preset').click()
    await $(`[role="option"]=${PRESET.name}`).click()
    await browser.waitUntil(async () => (await textOf('#preset')).trim() === PRESET.name, { timeoutMsg: 'the preset was not chosen' })
    await expect($('[data-testid="search-plan"]')).toBeDisplayed()
    await $('button*=Start search').waitForEnabled({ timeout: 20000 }).catch(async (e) => {
      throw new Error(`Start search stays disabled: ${await textOf('#start-problem').catch(() => 'no reason shown')} (${e.message})`)
    })
    await $('button*=Start search').click()
    await $('[data-testid="search-progress"]').waitForDisplayed({ timeout: 30000 })

    // the search runs: its time, and the peak memory of ProSE as the kernel counts it
    const started = Date.now()
    let peakKb = 0
    let progress = ''
    while ((await resultsId()) === null) {
      for (const p of proseProcesses()) peakKb = Math.max(peakKb, peakMemoryKb(p.pid) ?? 0)
      const failed = await $$('[data-testid="search-error"]')
      if (failed.length > 0) throw new Error(`the search failed: ${await failed[0].getProperty('textContent')}`)
      const now = (await textOf('[data-testid="search-progress"]').catch(() => progress)).trim()
      if (now !== progress) {
        progress = now
        console.log(`BIG ${Math.round((Date.now() - started) / 1000)} s: ${progress}`)
      }
      if (Date.now() - started > 55 * 60 * 1000) throw new Error('the search took longer than 55 minutes')
      await browser.pause(1000)
    }
    const seconds = (Date.now() - started) / 1000
    console.log(`BIG RESULT: ${seconds.toFixed(0)} s, ProSE peak memory (VmHWM) ${(peakKb / 1024 / 1024).toFixed(2)} GB`)

    const count = $('[data-testid="psm-count"]')
    await count.waitForDisplayed({ timeout: 120000 })
    console.log(`BIG PSMs: ${await textOf('[data-testid="psm-count"]')}`)
    expect(await textOf('[data-testid="psm-count"]')).toMatch(/[1-9]/)
    expect(peakKb).toBeGreaterThan(0)
  })
})
