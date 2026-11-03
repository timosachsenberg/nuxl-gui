// The third-party notices of the app's packages, made when the packages are built (native/scripts/package-*.sh,
// in CI and here), into src-tauri/resources/notices/ (a bundled resource folder, git-ignored):
//
//   node scripts/third-party-notices.mjs
//
// - THIRD-PARTY-NOTICES.txt: the app's own licence, then the licences of
//   - the Rust crates linked into the app: the normal dependencies of prose-desktop for this platform
//     (`cargo metadata --filter-platform`), with the licence files each crate ships;
//   - the JavaScript packages bundled into the front end: those its code and CSS import (src/, not the
//     tests), and their dependencies, with the licence files each package ships;
//   - the fonts of the front end: Inter (an npm package, above), Inconsolata and Liberation Mono
//     (src/assets/fonts, their OFL texts);
//   - the OpenMS logo of the top bar (src/assets/logo, the OpenMS Assets licence);
//   identical licence texts are written once, after the list of what they cover.
// - copyright: the app's licence in Debian's machine-readable format, the .deb's /usr/share/doc/prose/copyright
//   (tauri.conf.json, bundle.linux.deb.files).
//
// The ProSE tool's own libraries and data come with their licences in resources/prose/share/OpenMS/LICENSES and
// the PeptDeep models' in resources/prose/share/OpenMS/models (native/scripts/bundle-prose.sh). No dependency:
// Node and cargo.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src-tauri', 'resources', 'notices')
/** The files of a crate or package that hold its licence. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-._].*)?$/i

const read = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trimEnd()

/** The licence files of a folder (not recursive), by name. */
function licenceFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => LICENCE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort()
    .map((name) => ({ name, text: read(join(dir, name)) }))
}

//------------------------------------------------------------------------------------------------
// Rust

function crates() {
  const host = /^host: (.+)$/m.exec(execFileSync('rustc', ['-vV']).toString())?.[1]
  if (!host) throw new Error('rustc -vV names no host')
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--format-version', '1', '--locked', '--manifest-path', join(ROOT, 'src-tauri', 'Cargo.toml'), '--filter-platform', host],
      { maxBuffer: 256 << 20 },
    ).toString(),
  )
  const byId = new Map(metadata.packages.map((p) => [p.id, p]))
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]))
  const root = metadata.resolve.root
  // the normal dependencies (linked into the app), not the build scripts' or the tests'
  const seen = new Set([root])
  const queue = [root]
  while (queue.length > 0) {
    for (const dep of nodes.get(queue.shift())?.deps ?? []) {
      if (!dep.dep_kinds.some((k) => k.kind === null) || seen.has(dep.pkg)) continue
      seen.add(dep.pkg)
      queue.push(dep.pkg)
    }
  }
  seen.delete(root)
  return [...seen]
    .map((id) => byId.get(id))
    .map((p) => {
      const dir = dirname(p.manifest_path)
      const files = licenceFiles(dir)
      if (p.license_file && !files.some((f) => join(dir, f.name) === resolve(dir, p.license_file))) {
        const path = resolve(dir, p.license_file)
        if (existsSync(path)) files.push({ name: relative(dir, path), text: read(path) })
      }
      return { name: p.name, version: p.version, license: p.license ?? 'see its licence file', source: p.repository ?? '', files }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

//------------------------------------------------------------------------------------------------
// JavaScript

/** Every file of the front end's code and CSS (src/, not the tests and their fixtures). */
function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== 'fixtures') out.push(...sources(path))
    } else if (/\.(ts|svelte|css|js)$/.test(name) && !/\.test\.ts$/.test(name) && !/fixtures?\.ts$/.test(name)) {
      out.push(path)
    }
  }
  return out
}

/** The package a module specifier names (`bits-ui/x` -> `bits-ui`, `@a/b/c` -> `@a/b`), or null for a path. */
function packageOf(specifier) {
  if (/^[./$]|^[a-z]+:/i.test(specifier)) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function packages() {
  // imported by code (with what they import) and by CSS (a style sheet of the package: nothing more)
  const code = new Set()
  const styles = new Set()
  const patterns = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(?\s*['"]([^'"]+)['"]/g]
  for (const file of sources(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8')
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const name = packageOf(match[1])
        if (name) (file.endsWith('.css') ? styles : code).add(name)
      }
    }
    for (const match of text.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]/g)) {
      const name = packageOf(match[1])
      if (name) styles.add(name)
    }
  }
  // the bundle has what the code's packages import too (their dependencies; peer dependencies are imported
  // themselves). (svelte's list has its compiler's too: more than the bundle has, never less.)
  const dirOf = (name) => join(ROOT, 'node_modules', name)
  const found = new Map()
  const queue = [...code].map((name) => [name, true]).concat([...styles].map((name) => [name, false]))
  while (queue.length > 0) {
    const [name, follow] = queue.shift()
    if (found.has(name) && (!follow || found.get(name).followed)) continue
    const json = join(dirOf(name), 'package.json')
    if (!existsSync(json)) throw new Error(`${name} is imported by the front end but not installed (npm ci)`)
    const pkg = JSON.parse(readFileSync(json, 'utf8'))
    found.set(name, { ...pkg, followed: follow })
    if (follow) queue.push(...Object.keys(pkg.dependencies ?? {}).map((dep) => [dep, true]))
  }
  return [...found]
    .map(([name, pkg]) => ({
      name,
      version: pkg.version,
      license: typeof pkg.license === 'string' ? pkg.license : (pkg.licenses ?? []).map((l) => l.type ?? l).join(' OR ') || 'see its licence file',
      source: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? ''),
      files: licenceFiles(dirOf(name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

//------------------------------------------------------------------------------------------------
// Fonts

function fonts() {
  const dir = join(ROOT, 'src', 'assets', 'fonts')
  return [
    { name: 'Inconsolata', file: 'Inconsolata-LICENSE.txt' },
    { name: 'Liberation Mono', file: 'LiberationMono-LICENSE.txt' },
  ].map(({ name, file }) => ({ name, version: '', license: 'OFL-1.1', source: `src/assets/fonts (${file})`, files: [{ name: file, text: read(join(dir, file)) }] }))
}

//------------------------------------------------------------------------------------------------
// The OpenMS logo

function logo() {
  const file = 'OpenMS-Assets-LICENSE.md'
  return [
    {
      name: 'OpenMS logo (OpenMS logo © OpenMS Inc., used with permission)',
      version: '',
      license: 'OpenMS Assets License',
      source: 'https://github.com/OpenMS/Assets logos/180x180_trans.png',
      files: [{ name: file, text: read(join(ROOT, 'src', 'assets', 'logo', file)) }],
    },
  ]
}

//------------------------------------------------------------------------------------------------

const RULE = '-'.repeat(100)

/** A section: the list of what it covers, then each distinct licence text once, with what it covers. */
function section(title, items) {
  const lines = [RULE, title, RULE, '']
  for (const i of items) lines.push(`${i.name}${i.version ? ` ${i.version}` : ''}  (${i.license})${i.source ? `  ${i.source}` : ''}`)
  lines.push('')
  const texts = new Map()
  for (const i of items) {
    if (i.files.length === 0) {
      const key = `none:${i.license}`
      if (!texts.has(key)) texts.set(key, { text: `(no licence file in the package; its licence is ${i.license})`, who: [] })
      texts.get(key).who.push(`${i.name} ${i.version}`.trim())
      continue
    }
    for (const f of i.files) {
      const key = createHash('sha256').update(f.text).digest('hex')
      if (!texts.has(key)) texts.set(key, { text: f.text, who: [] })
      texts.get(key).who.push(`${i.name}${i.version ? ` ${i.version}` : ''} (${f.name})`)
    }
  }
  for (const { text, who } of texts.values()) {
    lines.push(`=== ${who.join(', ')}`, '', text, '')
  }
  return lines.join('\n')
}

const licence = read(join(ROOT, 'LICENSE'))
const rust = crates()
const js = packages()
const fontList = fonts()
const logoList = logo()

// what the bundles must have: a broken lookup must not write a short file that looks complete
for (const name of ['tauri', 'tauri-plugin-dialog', 'serde', 'serde_json']) {
  if (!rust.some((c) => c.name === name)) throw new Error(`the crate ${name} is not among the app's dependencies`)
}
for (const name of ['svelte', 'bits-ui', '@tauri-apps/api', 'hyparquet', 'fflate', 'zstddec', 'fzstd', 'tailwindcss', '@fontsource-variable/inter']) {
  if (!js.some((p) => p.name === name)) throw new Error(`the package ${name} is not among the front end's`)
}
if (rust.length < 100) throw new Error(`only ${rust.length} crates: cargo metadata gave too little`)
const unlicensed = [...rust, ...js].filter((i) => i.files.length === 0 && !/MIT|Apache|BSD|ISC|Zlib|Unicode|MPL|0BSD|Unlicense|CC0|OFL|BSL/i.test(i.license))
if (unlicensed.length > 0) throw new Error(`no licence known for ${unlicensed.map((i) => i.name).join(', ')}`)

const notices = [
  'ProSE desktop: third-party notices',
  '',
  'ProSE desktop is released under the licence below. It bundles the software listed after it, under their licences.',
  'The ProSE tool and its libraries (resources/prose) come with their licences in resources/prose/share/OpenMS/LICENSES,',
  "the PeptDeep models with AlphaPeptDeep's in resources/prose/share/OpenMS/models.",
  'The example (resources/example) is OpenMS example data under the licence of ProSE desktop below: the run',
  'Ecoli_MS2_small.mzML of share/OpenMS/examples/ID, and the E. coli K-12 proteins (TaxID 83333) of',
  'share/OpenMS/examples/TOPPAS/data/Identification/target_decoy_Ecoli_K12_TaxID_83333.proteomes.fasta without its decoys.',
  'OpenMS logo © OpenMS Inc., used with permission (the OpenMS Assets License, at the end).',
  '',
  RULE,
  'ProSE desktop',
  RULE,
  '',
  licence,
  '',
  section(`Rust crates linked into the app (${rust.length})`, rust),
  section(`JavaScript packages bundled into the app's pages (${js.length})`, js),
  section('Fonts (Inter is the npm package @fontsource-variable/inter, above)', fontList),
  section('The OpenMS logo', logoList),
].join('\n')

const debian = [
  'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/',
  'Upstream-Name: ProSE',
  'Source: https://github.com/timosachsenberg/prose-gui',
  'Comment: The software bundled with ProSE and its licences: /usr/lib/ProSE/resources/notices/THIRD-PARTY-NOTICES.txt',
  ' (the Rust crates, JavaScript packages, fonts and OpenMS logo of the app), /usr/lib/ProSE/resources/prose/share/OpenMS/LICENSES',
  ' (the ProSE tool and its libraries) and /usr/lib/ProSE/resources/prose/share/OpenMS/models (the PeptDeep models).',
  '',
  'Files: *',
  'Copyright: OpenMS Inc. -- Eberhard Karls University Tuebingen, ETH Zurich, and Freie Universitaet Berlin 2002-present',
  'License: BSD-3-Clause',
  ...licence.split('\n').map((line) => (line.trim() === '' ? ' .' : ` ${line}`)),
  '',
].join('\n')

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'THIRD-PARTY-NOTICES.txt'), `${notices}\n`)
writeFileSync(join(OUT, 'copyright'), debian)
console.log(
  `third-party notices: ${rust.length} crates, ${js.length} npm packages, ${fontList.length + 1} fonts, the OpenMS logo -> ${relative(ROOT, join(OUT, 'THIRD-PARTY-NOTICES.txt'))} ` +
    `(${Math.round(statSync(join(OUT, 'THIRD-PARTY-NOTICES.txt')).size / 1024)} KB), ${relative(ROOT, join(OUT, 'copyright'))}`,
)
