// WebdriverIO through tauri-driver (which starts WebKitWebDriver) against the debug build of the app.
// Started by e2e/run.sh, inside native/scripts/in-env.sh and under xvfb-run. E2E_APPLICATION names another
// application script in place of e2e/app.sh (native/scripts/smoke-appimage.sh: the AppImage).
//
// tauri-driver belongs to the run (onPrepare .. onComplete) and lives in a process group of its own, so
// that it, its WebKitWebDriver and the app go together; a port that something else already listens on
// stops the run instead of talking to a stranger.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const application = process.env.E2E_APPLICATION ? resolve(process.env.E2E_APPLICATION) : resolve(root, 'e2e/app.sh')
const driverPort = 4444

let driver: ChildProcess | undefined
/** The folder of every spec's data folder, made per run and removed at its end. */
let dataRoot: string | undefined

/** Whether something accepts connections on the port. */
function listening(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.once('connect', () => (socket.destroy(), done(true)))
    socket.once('error', () => done(false))
  })
}

/** Waits (synchronously: this runs in exit handlers) for `ms`. */
const wait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * Ends tauri-driver with everything it started (the group: WebKitWebDriver, the app, a search): SIGTERM,
 * then SIGKILL for what is still there after a few seconds.
 */
function stopDriver() {
  const pid = driver?.pid
  driver = undefined
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return // the group is gone
  }
  for (const deadline = Date.now() + 3000; Date.now() < deadline; wait(50)) {
    try {
      process.kill(-pid, 0)
    } catch {
      return // every process of the group has ended
    }
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // gone meanwhile
  }
}

function cleanUp() {
  stopDriver()
  if (dataRoot) rmSync(dataRoot, { recursive: true, force: true })
  dataRoot = undefined
}

/** Starts tauri-driver for the run, once the port is free; throws if that is not possible. */
async function prepare() {
  if (!process.env.E2E_APPLICATION && !existsSync(resolve(root, 'src-tauri/target/debug/prose-desktop'))) {
    throw new Error('The debug build is missing: run `npm run tauri:build:debug` (e2e/run.sh does).')
  }
  if (await listening(driverPort)) {
    throw new Error(
      `Port ${driverPort} is taken by another process (a tauri-driver left over from an earlier run?). ` +
        'Stop it (`pkill tauri-driver`) and run again.',
    )
  }
  dataRoot = mkdtempSync(join(tmpdir(), 'prose-e2e-data-'))
  process.env.E2E_DATA_ROOT = dataRoot
  // a group of its own (detached), so that stopDriver reaches everything below it
  driver = spawn('tauri-driver', ['--port', String(driverPort)], {
    detached: true,
    stdio: ['ignore', process.stdout, process.stderr],
  })
  const gone = new Promise<never>((_, reject) => {
    driver!.once('error', (e) => reject(new Error(`tauri-driver failed to start: ${e.message}`)))
    driver!.once('exit', (code, signal) => reject(new Error(`tauri-driver ended at once (${signal ?? `exit code ${code}`})`)))
  })
  const ready = (async () => {
    const deadline = Date.now() + 30000
    while (!(await listening(driverPort))) {
      if (Date.now() > deadline) throw new Error(`tauri-driver did not listen on port ${driverPort} in 30 s`)
      await new Promise((r) => setTimeout(r, 100))
    }
  })()
  try {
    await Promise.race([ready, gone])
  } catch (e) {
    cleanUp()
    throw e
  }
  // (an exit after the start is the run's end or its failure; the sessions fail by themselves)
  driver.removeAllListeners('exit')
}

export const config: WebdriverIO.Config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: driverPort,
  specs: [resolve(root, 'e2e/*.spec.ts')],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      // tauri-driver turns this into the WebKitWebDriver options of the app; beforeSession adds the data folder
      'tauri:options': { application },
    } as WebdriverIO.Capabilities,
  ],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: { ui: 'bdd', timeout: 120000 },
  logLevel: 'warn',
  waitforTimeout: 10000,

  async onPrepare() {
    // (WebdriverIO logs the error of a hook and goes on with the run: a failed start has to end it)
    try {
      await prepare()
    } catch (e) {
      console.error(`\ne2e: ${(e as Error).message}\n`)
      cleanUp()
      process.exit(1)
    }
  },

  /** The app of a spec file gets a data folder of its own: <data-root>/<spec name>, as XDG_DATA_HOME. */
  beforeSession(_config, capabilities, specs) {
    const name = basename(specs[0] ?? 'spec').replace(/\.spec\.ts$/, '')
    const home = join(process.env.E2E_DATA_ROOT!, name)
    mkdirSync(home, { recursive: true })
    process.env.E2E_DATA_HOME = home
    ;(capabilities as any)['tauri:options'].args = [home]
  },

  onComplete: cleanUp,
}

process.on('exit', cleanUp)
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
  process.on(signal, () => {
    cleanUp()
    process.exit(code)
  })
}
