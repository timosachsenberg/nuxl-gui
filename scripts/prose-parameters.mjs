// Generates the settings form's table of ProSE's parameters from the pinned ProSE tool
// (native/OPENMS_COMMIT), at build time, not at run time:
//
//   node scripts/prose-parameters.mjs [<ProSE binary>]      (default: $PROSE_BIN)
//
// It runs `ProSE -write_ini` into a temporary folder and keeps the `Search:` parameters that the shim
// lets through (`PARAMETERS` of src-tauri/src/args.rs), in the shape of the web app's
// `ParamEntry` (name without `Search:`, value = ProSE's default, type, description, allowed values,
// limits). Writes:
//
// - src/lib/settings/prose-parameters.json: the entries, without the modification names;
// - src/lib/settings/modifications.json: the allowed values of `modifications:fixed` and
//   `modifications:variable` (one list: ProSE gives both the same), e.g. "Oxidation (M)".
//
// The web app read the same from the WebAssembly module at run time (`getDefaults().getEntries()`).

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tool = process.argv[2] ?? process.env.PROSE_BIN
if (!tool) {
  console.error('usage: node scripts/prose-parameters.mjs <ProSE binary>   (or set PROSE_BIN)')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'prose-ini-'))
let ini
try {
  execFileSync(tool, ['-write_ini', join(dir, 'prose.ini')], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] })
  ini = readFileSync(join(dir, 'prose.ini'), 'utf8')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// the shim's allowlist
const argsRs = readFileSync(join(root, 'src-tauri/src/args.rs'), 'utf8')
const list = /pub const PARAMETERS: &\[\(&str, Kind\)\] = &\[([\s\S]*?)\];/.exec(argsRs)?.[1]
if (!list) throw new Error('PARAMETERS not found in src-tauri/src/args.rs')
const allowed = new Set([...list.matchAll(/\("([^"]+)",\s*\w+\)/g)].map((m) => m[1]))

const unescape = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
const attr = (tag, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? unescape(m[1]) : undefined
}

/** The value of an ITEM (by its type) or the LISTITEMs of an ITEMLIST. */
function valueOf(type, raw, items) {
  if (items) {
    if (type === 'int' || type === 'double') return items.map(Number)
    return items
  }
  if (type === 'int' || type === 'double') return Number(raw)
  if (type === 'bool') return raw === 'true'
  return raw ?? ''
}

const entries = []
let modifications = null
const path = []
// NODE open/close, ITEM, ITEMLIST (with its LISTITEMs) in document order
const token = /<NODE\b([^>]*)>|<\/NODE>|<ITEM\b([^>]*?)\/>|<ITEMLIST\b([^>]*)>([\s\S]*?)<\/ITEMLIST>/g
for (const m of ini.matchAll(token)) {
  if (m[1] !== undefined) {
    path.push(attr(m[1], 'name'))
    continue
  }
  if (m[0] === '</NODE>') {
    path.pop()
    continue
  }
  const tag = m[2] ?? m[3]
  const name = attr(tag, 'name')
  // ProSE:1:Search:<...>:<name> (not the tool's own options, e.g. threads: the form has its own field)
  const inner = path.slice(2)
  if (inner[0] !== 'Search') continue
  const key = [...inner.slice(1), name].join(':')
  const isList = m[3] !== undefined
  const type = (attr(tag, 'type') ?? 'string') + (isList ? '[]' : '')
  const restrictions = attr(tag, 'restrictions')
  const items = isList ? [...m[4].matchAll(/<LISTITEM\s+value="([^"]*)"/g)].map((x) => unescape(x[1])) : undefined
  if (key === 'modifications:fixed' || key === 'modifications:variable') {
    const valid = restrictions?.split(',') ?? []
    if (modifications && JSON.stringify(modifications) !== JSON.stringify(valid)) {
      throw new Error('the fixed and variable modifications have different allowed values')
    }
    modifications = valid
  }
  if (!allowed.has(key)) continue
  const entry = {
    name: key,
    value: valueOf(attr(tag, 'type'), attr(tag, 'value'), items),
    type,
    description: attr(tag, 'description') ?? '',
    tags: attr(tag, 'advanced') === 'true' ? ['advanced'] : [],
  }
  if (restrictions !== undefined && key !== 'modifications:fixed' && key !== 'modifications:variable') {
    if (type === 'int' || type === 'double') {
      const [min, max] = restrictions.split(':')
      if (min !== '') entry.min = Number(min)
      if (max !== undefined && max !== '') entry.max = Number(max)
    } else {
      entry.validStrings = restrictions.split(',')
    }
  }
  entries.push(entry)
}

const missing = [...allowed].filter((n) => !entries.some((e) => e.name === n))
if (missing.length > 0) throw new Error(`not in ProSE's parameters: ${missing.join(', ')}`)
if (!modifications || modifications.length === 0) throw new Error('no modification names')

writeFileSync(join(root, 'src/lib/settings/prose-parameters.json'), JSON.stringify(entries, null, 1) + '\n')
writeFileSync(join(root, 'src/lib/settings/modifications.json'), JSON.stringify(modifications) + '\n')
console.log(`${entries.length} parameters, ${modifications.length} modification names`)
