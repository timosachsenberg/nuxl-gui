// The AppImage smoke test (native/scripts/smoke-appimage.sh runs it; not one of the *.spec.ts of e2e/run.sh).
// The AppImage runs from an empty environment (e2e/appimage-app.sh) and searches the example with PeptDeep
// with the ProSE it bundles. Besides the result, the test reads which files the processes have mapped
// (/proc/<pid>/maps): the app and WebKit's processes, and ProSE while it searches, load their libraries from
// the AppImage or from the system, never from SMOKE_FORBIDDEN (the build machine's sysroot and OpenMS build,
// colon-separated), and ProSE loads its own closure with one OpenMP runtime.
import { existsSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { appReady, clearSearches, dataHome, invoke, openFirstPsm, runExample } from './lib.ts'

const forbidden = (process.env.SMOKE_FORBIDDEN ?? '').split(':').filter(Boolean)

/** The machine's glibc loader and Debian multiarch triple (the AppImages for x64 and arm64). */
const { loader, multiarch } =
  process.arch === 'arm64'
    ? { loader: 'ld-linux-aarch64.so.1', multiarch: 'aarch64-linux-gnu' }
    : { loader: 'ld-linux-x86-64.so.2', multiarch: 'x86_64-linux-gnu' }
const loaderStem = loader.replace(/\.so\.\d+$/, '')
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The files a process has mapped (libraries, the executable), or [] once it has ended. */
function mappedFiles(pid: number): string[] {
  try {
    const lines = readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n')
    return [...new Set(lines.map((l) => l.split(/\s+/).slice(5).join(' ')).filter((p) => p.startsWith('/')))]
  } catch {
    return []
  }
}

/** The processes whose executable lies below `dir`: pid and executable. */
function processesBelow(dir: string): { pid: number; exe: string }[] {
  const found: { pid: number; exe: string }[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const exe = readlinkSync(`/proc/${entry}/exe`)
      if (exe.startsWith(dir + '/')) found.push({ pid: Number(entry), exe })
    } catch {
      // ended, or not ours
    }
  }
  return found
}

/**
 * The GUI stack the AppImage brings itself: a library of it mapped from outside the AppImage means the app runs
 * on the host's WebKitGTK/GTK/GLib (as it would on the CI runner, where WebKitGTK is installed), not its own.
 */
const bundledStack = /(webkit|javascriptcore|soup|gtk-3|gdk-3|glib|gio|gobject)/i

/**
 * What the app and WebKit may take from the host: glibc and the GCC runtime, the GL driver stack (as on
 * linuxdeploy's exclude list: it has to match the host's drivers) with what the Mesa drivers load, the X11,
 * xcb and Wayland client libraries, and the font and text libraries linuxdeploy leaves to the host. By soname
 * stem (the name without `.so` and the version).
 */
const hostAllowed = [
  // glibc, the GCC runtime
  new RegExp(`^(${escape(loaderStem)}|libc|libm|libmvec|libdl|libpthread|librt|libresolv|libutil|libstdc\\+\\+|libgcc_s)$`),
  // GL: glvnd, Mesa (its drivers, LLVM and what they link), libdrm
  /^(libGL|libGLX|libGLX_mesa|libEGL|libEGL_mesa|libGLESv2|libGLdispatch|libOpenGL|libglapi|libgbm|libgallium-.*|.*_dri|libdrm(_[a-z]+)?|libLLVM.*|libpciaccess|libsensors|libedit|libtinfo|libelf|libxshmfence|libXxf86vm|libvulkan)$/,
  // the X11, xcb and Wayland client libraries
  /^(libX11|libX11-xcb|libxcb(-[a-z0-9]+)?|libwayland-(client|server|egl|cursor))$/,
  // fonts and text, and what they link
  /^(libfontconfig|libfreetype|libharfbuzz|libfribidi|libexpat|libz|libuuid|libcom_err|libgpg-error)$/,
]
const stem = (file: string) => file.split('/').pop()!.replace(/\.so(\.[\d.]+)?$/, '').replace(/\.so$/, '')

const offending = (files: string[]) => files.filter((f) => forbidden.some((p) => f === p || f.startsWith(p + '/')))
const sharedLibraries = (files: string[]) => files.filter((f) => /\.so(\.\d+)*$/.test(f))

describe('the AppImage', () => {
  /** The folder the AppImage was extracted to (…/appimage_extracted_<digest>). */
  let appRoot = ''

  let toolInfo: { result?: any; failure?: string } = {}
  const marker = '/usr/lib/ProSE/resources/prose/bin/ProSE'

  before(async () => {
    await appReady()
    toolInfo = await invoke('tool_info')
    const path: string = toolInfo.result?.path ?? ''
    if (path.endsWith(marker)) appRoot = path.slice(0, -marker.length)
  })

  afterEach(() => clearSearches())

  it('runs from an environment without the development toolchain', () => {
    const env = readFileSync(join(dataHome(), 'appimage-env.txt'), 'utf8')
    console.log(env.trim())
    // (LD_LIBRARY_PATH is never kept from the driver's environment; appimage-app.sh sets it only to the
    // folder of the host's missing libGLESv2.so.2, see smoke-appimage.sh)
    expect(env).not.toMatch(/^kept: .*\b(LD_LIBRARY_PATH|PROSE_BIN|PKG_CONFIG_PATH|XDG_DATA_DIRS|GIO_EXTRA_MODULES)\b/m)
  })

  it('finds its bundled ProSE, with ONNX (the build manifest and the PeptDeep models)', async () => {
    const { result, failure } = toolInfo
    expect(failure).toBeUndefined()
    console.log('tool_info', JSON.stringify(result))
    expect(result.path.endsWith(marker)).toBe(true)
    expect(appRoot).toMatch(/appimage_extracted_[0-9a-f]+$/)
    expect(result.onnx).toBe(true)
    expect(result.version).not.toBe('')
  })

  it('searches the example with PeptDeep: 154 PSMs, the PeptDeep mirror, ProSE with its own libraries', async () => {
    expect(appRoot).toMatch(/appimage_extracted_/)
    // ProSE's mapped files, read while it runs
    const proseMaps = new Set<string>()
    const proseExes = new Set<string>()
    const poll = setInterval(() => {
      for (const p of processesBelow(appRoot)) {
        if (!p.exe.endsWith('/bin/ProSE')) continue
        proseExes.add(p.exe)
        for (const f of mappedFiles(p.pid)) proseMaps.add(f)
      }
    }, 100)
    try {
      await runExample({ peptdeep: true })
    } finally {
      clearInterval(poll)
    }
    await expect($('[data-testid="psm-count"]')).toHaveText(expect.stringContaining('154'))
    await openFirstPsm()
    await expect($('[data-testid="bottom-label"]')).toHaveText(expect.stringContaining('PeptDeep'))
    expect((await $$('[data-testid="bottom-peaks"]')).length).toBeGreaterThan(0)
    expect(await $$('[data-testid="bottom-status"]')).toHaveLength(0)

    const bundleLib = `${appRoot}/usr/lib/ProSE/resources/prose/lib/`
    const libs = sharedLibraries([...proseMaps])
    console.log(`ProSE ${[...proseExes].join(', ')} mapped ${libs.length} libraries:`)
    console.log('  from the bundle: ' + libs.filter((f) => f.startsWith(bundleLib)).map((f) => f.slice(bundleLib.length)).join(' '))
    console.log('  from elsewhere: ' + libs.filter((f) => !f.startsWith(bundleLib)).join(' '))
    expect(proseExes.size).toBeGreaterThan(0)
    for (const lib of ['libOpenMS.so', 'libonnxruntime.so.1', 'libarrow.so.2400', 'libgomp.so.1', 'libstdc++.so.6', 'libgcc_s.so.1']) {
      expect(libs).toContain(bundleLib + lib)
    }
    // one OpenMP runtime, the bundle's
    expect(libs.filter((f) => /\/lib(gomp|omp|iomp5)\.so/.test(f))).toEqual([bundleLib + 'libgomp.so.1'])
    // every library outside the bundle is glibc's (bundle-prose.sh's exclude list), or one of its gconv
    // charset modules
    for (const f of libs.filter((f) => !f.startsWith(bundleLib) && !/\/gconv\/[^/]+\.so$/.test(f))) {
      expect(f.split('/').pop()).toMatch(new RegExp(`^(${escape(loader)}|lib(c|m|mvec|dl|pthread|rt|resolv)\\.so\\.\\d+)$`))
    }
    expect(offending([...proseMaps])).toEqual([])
  })

  it('the app and WebKit run on the AppImage’s libraries: its own GUI stack, from the host only what an AppImage leaves to it, nothing of the build machine', () => {
    expect(appRoot).toMatch(/appimage_extracted_/)
    const processes = processesBelow(appRoot)
    const names = processes.map((p) => p.exe.slice(appRoot.length))
    console.log('processes of the AppImage: ' + names.join(', '))
    expect(names).toContain('/usr/bin/prose-desktop')
    expect(names.some((n) => n.endsWith('/WebKitWebProcess'))).toBe(true)
    expect(names.some((n) => n.endsWith('/WebKitNetworkProcess'))).toBe(true)
    for (const p of processes) {
      const files = mappedFiles(p.pid)
      expect(offending(files)).toEqual([])
      if (p.exe.endsWith('/usr/bin/prose-desktop') || p.exe.endsWith('/WebKitWebProcess')) {
        expect(files).toContain(`${appRoot}/usr/lib/libwebkit2gtk-4.1.so.0`)
      }
    }
    // what the app and WebKit's processes take from the host: none of the GUI stack the AppImage brings, and
    // nothing beyond the host libraries an AppImage leaves to the system
    for (const p of processes) {
      const outside = sharedLibraries(mappedFiles(p.pid)).filter((f) => !f.startsWith(appRoot + '/'))
      const name = p.exe.slice(appRoot.length)
      console.log(`${name} maps ${outside.length} libraries of the host: ${outside.map((f) => f.split('/').pop()).join(' ')}`)
      expect({ process: name, hostGuiStack: outside.filter((f) => bundledStack.test(f.split('/').pop()!)) }).toEqual({
        process: name,
        hostGuiStack: [],
      })
      expect({ process: name, notAllowed: outside.filter((f) => !hostAllowed.some((r) => r.test(stem(f)))) }).toEqual({
        process: name,
        notAllowed: [],
      })
    }
    expect(existsSync(`${appRoot}/usr/lib/${multiarch}/webkit2gtk-4.1/WebKitWebProcess`)).toBe(true)
  })
})
