#!/usr/bin/env node
// Sets the app's version everywhere it is written: `node scripts/bump-version.mjs 0.2.0`.
//
// The version of a release is src-tauri/tauri.conf.json's (the packages' names and the tag desktop-native-v<version>
// follow it; desktop.yml's release job and tag-release.yml check it); Cargo.toml, Cargo.lock (the nuxl-desktop
// entry), package.json and package-lock.json (its own two entries) carry the same, so that nothing reads an old one.
// Each file is changed in place, only at that one spot, and the script checks that it found it.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = process.argv[2]
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/bump-version.mjs <major.minor.patch>, e.g. 0.2.0')
  process.exit(2)
}

/** Replaces the one match of `pattern` in `file` (its first group is kept, the version after it replaced). */
function setIn(file, pattern) {
  const path = join(root, file)
  const text = readFileSync(path, 'utf8')
  const matches = text.match(new RegExp(pattern.source, 'g' + pattern.flags)) ?? []
  if (matches.length !== 1) throw new Error(`${file}: expected one version to change, found ${matches.length}`)
  let before = ''
  const changed = text.replace(pattern, (whole, keep, old) => {
    before = old
    return `${keep}${version}`
  })
  writeFileSync(path, changed)
  console.log(`${file}: ${before} -> ${version}`)
}

/** Sets the version of package.json-like JSON at the given paths, keeping the file's formatting. */
function setJson(file, paths) {
  const path = join(root, file)
  const json = JSON.parse(readFileSync(path, 'utf8'))
  for (const keys of paths) {
    let at = json
    for (const k of keys) at = at?.[k]
    if (!at || typeof at.version !== 'string') throw new Error(`${file}: no version at ${keys.join('.') || '(top)'}`)
    console.log(`${file} ${keys.join('.') || '(top)'}: ${at.version} -> ${version}`)
    at.version = version
  }
  const text = readFileSync(path, 'utf8')
  const indent = text.match(/^\{\n( +)/)?.[1] ?? '  '
  writeFileSync(path, JSON.stringify(json, null, indent) + (text.endsWith('\n') ? '\n' : ''))
}

setIn('src-tauri/tauri.conf.json', /("version":\s*")(\d+\.\d+\.\d+)(?=")/)
setIn('src-tauri/Cargo.toml', /(\[package\][^[]*?\nversion = ")(\d+\.\d+\.\d+)(?=")/s)
setIn('src-tauri/Cargo.lock', /(\[\[package\]\]\nname = "nuxl-desktop"\nversion = ")(\d+\.\d+\.\d+)(?=")/)
setJson('package.json', [[]])
setJson('package-lock.json', [[], ['packages', '']])
