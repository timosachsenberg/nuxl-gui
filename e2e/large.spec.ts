// The largest result that opens in the app, in WebKit: synthetic saved searches of one input with 500,000 to
// 4,000,000 PSMs (written by src/lib/results/read.test.ts, "large search folders", into PROSE_LARGE_DIR),
// copied into the spec's History one at a time and opened, each in a fresh app. Logs per size the outcome,
// the time, the files' size and the peak memory (VmHWM) of the app and of its web process. On demand:
//
//   PROSE_LARGE_DIR=/scratch/sachsenb/prose-large NODE_OPTIONS=--max-old-space-size=60000 \
//     npx vitest run src/lib/results/read.test.ts -t 'large search folders'
//   PROSE_LARGE_DIR=/scratch/sachsenb/prose-large native/scripts/in-env.sh e2e/run.sh e2e/large.spec.ts
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { appProcesses, appReady, goTo, peakMemoryKb, searchesDir, textOf } from './lib.ts'

const root = process.env.PROSE_LARGE_DIR ?? ''
const enabled = root !== '' && existsSync(root)
const sizes = enabled
  ? readdirSync(root)
      .filter((id) => /^9000-\d+$/.test(id) && existsSync(join(root, id, 'search.json')))
      .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]))
  : []

/** The bytes of a folder's files. */
function folderBytes(dir: string): number {
  let total = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const s = statSync(path)
    total += s.isDirectory() ? folderBytes(path) : s.size
  }
  return total
}

/** The processes whose parent is `pid` (a scan of /proc). */
function childrenOf(pid: number): number[] {
  const found: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      // (the parent is the fourth field after the command, which is in parentheses)
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8')
      if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === pid) found.push(Number(entry))
    } catch {
      // ended meanwhile
    }
  }
  return found
}

const gb = (kb: number) => (kb / 1024 / 1024).toFixed(2)

describe('large results in the app', () => {
  before(function () {
    if (!enabled || sizes.length === 0) {
      console.log('skipped: PROSE_LARGE_DIR (with the folders of read.test.ts "large search folders") runs it')
      this.skip()
    }
  })

  for (const id of sizes) {
    const n = Number(id.split('-')[1])
    it(`opens a result of ${n.toLocaleString('en')} PSMs, or says why not`, async function () {
      this.timeout(40 * 60 * 1000)
      // a fresh app for each size: its peak memory is this result's
      await browser.reloadSession().catch(() => {})
      await appReady()
      rmSync(searchesDir(), { recursive: true, force: true })
      cpSync(join(root, id), join(searchesDir(), id), { recursive: true })
      const bytes = folderBytes(join(searchesDir(), id))
      await goTo('History')
      const row = $(`[data-testid="history-row"][data-id="${id}"]`)
      await row.waitForDisplayed({ timeout: 60000 })
      await row.$('button=Open').click()

      const app = appProcesses()[0]?.pid ?? 0
      const started = Date.now()
      let appKb = 0
      let webKb = 0
      let outcome = ''
      while (outcome === '') {
        appKb = Math.max(appKb, peakMemoryKb(app) ?? 0)
        for (const child of childrenOf(app)) {
          if (readFileSync(`/proc/${child}/comm`, 'utf8').startsWith('WebKitWebProc')) webKb = Math.max(webKb, peakMemoryKb(child) ?? 0)
        }
        try {
          if ((await $$('[data-testid="psm-count"]')).length > 0) {
            outcome = `opened (${(await textOf('[data-testid="psm-count"]')).trim()})`
          } else if ((await $$('[data-testid="history-problem"]')).length > 0) {
            outcome = `refused: ${(await textOf('[data-testid="history-problem"]')).trim()}`
          }
        } catch (e) {
          outcome = `the page died: ${(e as Error).message.split('\n')[0]}`
        }
        if (outcome === '' && Date.now() - started > 35 * 60 * 1000) outcome = 'still opening after 35 minutes'
        if (outcome === '') await new Promise((r) => setTimeout(r, 500))
      }
      const seconds = (Date.now() - started) / 1000
      console.log(
        `LARGE ${n} PSMs, ${(bytes / 1024 ** 2).toFixed(0)} MB of files: ${outcome} after ${seconds.toFixed(1)} s; ` +
          `peak memory: app ${gb(appKb)} GB, web process ${gb(webKb)} GB`,
      )
      rmSync(searchesDir(), { recursive: true, force: true })
      expect(outcome).not.toBe('')
    })
  }
})
