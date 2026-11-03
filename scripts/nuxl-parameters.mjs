// Generates the settings form's table of OpenNuXL's parameters from the OpenMS pin (native/OPENMS_COMMIT), at
// build time, not at run time:
//
//   node scripts/nuxl-parameters.mjs <OpenMS checkout of the pin>
//
// It reads OpenNuXL's option registration (`registerOptionsAndFlags_` of src/topp/OpenNuXL/OpenNuXL.cpp) and keeps
// the options that the shim lets through (`PARAMETERS` of src-tauri/src/args.rs, the same list as `ALLOWED` below),
// in the shape of `ParamEntry` (src/lib/settings/parameters.ts: full name, OpenNuXL's default, type, description,
// allowed values, `advanced`), in the order OpenNuXL registers them. Writes src/lib/settings/nuxl-parameters.json.
//
// What the C++ computes when the tool starts is filled in from the data it reads:
// - NuXL:presets: the presets of share/OpenMS/NUXL/nuxl_presets.json, in the file's order (the app's copy,
//   src/lib/settings/nuxl_presets.json, is checked against it);
// - peptide:enzyme: OpenMS' ProteaseDB, from share/OpenMS/CHEMISTRY/Enzymes.xml of the checkout, else the list
//   the table has already;
// - modifications:fixed / modifications:variable: ModificationsDB's search modifications, which the app keeps in
//   src/lib/settings/modifications.json (one list for both; nuxl.ts puts them in) and does not write here;
// - the constants of NuXLFDR.h in the descriptions (report:xl_fdr_groups).
// `filter` lists only the filters the shim allows (OpenNuXL's `optimize`, `RTpredict` and `pcrecalibration` are
// left out: docs/design.md §6).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const [openms] = process.argv.slice(2)
if (!openms) {
  console.error('usage: node scripts/nuxl-parameters.mjs <OpenMS checkout of the pin>')
  process.exit(2)
}
const read = (path) => readFileSync(join(openms, path), 'utf8')

/** The options the shim lets through (src-tauri/src/args.rs `PARAMETERS`). */
const ALLOWED = [
  'precursor:mass_tolerance',
  'precursor:mass_tolerance_unit',
  'precursor:min_charge',
  'precursor:max_charge',
  'precursor:isotopes',
  'fragment:mass_tolerance',
  'fragment:mass_tolerance_unit',
  'modifications:fixed',
  'modifications:variable',
  'modifications:variable_max_per_peptide',
  'peptide:min_size',
  'peptide:max_size',
  'peptide:missed_cleavages',
  'peptide:enzyme',
  'peptide:clip_nterm_methionine',
  'report:top_hits',
  'report:xl_fdr_groups',
  'NuXL:presets',
  'NuXL:length',
  'NuXL:sequence',
  'NuXL:target_nucleotides',
  'NuXL:nt_groups',
  'NuXL:mapping',
  'NuXL:can_cross_link',
  'NuXL:standalone',
  'NuXL:localization',
  'NuXL:fragment_adducts',
  'NuXL:modifications',
  'NuXL:scoring',
  'NuXL:rescoring',
  'NuXL:decoy_factor',
  'NuXL:CysteineAdduct',
  'NuXL:filter_fractional_mass',
  'NuXL:carbon_labeled_fragments',
  'NuXL:only_xl',
  'NuXL:filter_small_peptide_mass',
  'NuXL:marker_ions_tolerance',
  'filter',
  'window_size',
  'peak_count',
]
/** The filters of `filter` the shim allows. */
const FILTERS = ['filter_pc_mass_error', 'impute_decoy_medians', 'filter_bad_partial_loss_scores', 'autotune', 'idfilter', 'spectrumclusterfilter']

// the shim's list, once it is OpenNuXL's: the same names
const argsPath = join(root, 'src-tauri/src/args.rs')
if (existsSync(argsPath)) {
  const list = /pub const PARAMETERS: &\[\(&str, Kind\)\] = &\[([\s\S]*?)\];/.exec(readFileSync(argsPath, 'utf8'))?.[1]
  const names = list ? [...list.matchAll(/\("([^"]+)",\s*\w+\)/g)].map((m) => m[1]) : []
  if (names.includes('NuXL:presets')) {
    const differ = [...names.filter((n) => !ALLOWED.includes(n)), ...ALLOWED.filter((n) => !names.includes(n))]
    if (differ.length > 0) throw new Error(`the allowlist differs from src-tauri/src/args.rs: ${differ.join(', ')}`)
  } else {
    console.warn('src-tauri/src/args.rs has no OpenNuXL allowlist yet: using the list of this script')
  }
}

const source = read('src/topp/OpenNuXL/OpenNuXL.cpp')
const start = source.indexOf('void registerOptionsAndFlags_()')
if (start < 0) throw new Error('registerOptionsAndFlags_ not found')
const body = blockAt(source, source.indexOf('{', start))

// NuXLFDR's constants (report:xl_fdr_groups' description)
const constants = {}
for (const m of read('src/topp/OpenNuXL/include/NuXLFDR.h').matchAll(/static constexpr \w+ (\w+) = ([\d.]+);/g)) {
  constants[`NuXLFDR::${m[1]}`] = Number(m[2])
}

/** The text of the block that opens at `open` (`{` or `(`), without its brackets; strings and comments are skipped. */
function blockAt(text, open) {
  const close = { '{': '}', '(': ')' }[text[open]]
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      i = stringEnd(text, i)
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i)
      continue
    }
    if (c === text[open]) depth++
    else if (c === close && --depth === 0) return text.slice(open + 1, i)
  }
  throw new Error(`unbalanced ${text[open]} at ${open}`)
}

/** The index of the closing quote of the string literal that opens at `i`. */
function stringEnd(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++
    else if (text[j] === '"') return j
  }
  throw new Error('unterminated string')
}

/** The arguments of a call, split at the commas outside brackets and strings. */
function splitArgs(text) {
  const args = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') i = stringEnd(text, i)
    else if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i)
    else if ('({<['.includes(c) && !(c === '<' && /\s/.test(text[i + 1] ?? ''))) depth++
    else if (')}>]'.includes(c) && !(c === '>' && /[\s=]/.test(text[i - 1] ?? ''))) depth--
    else if (c === ',' && depth === 0) {
      args.push(text.slice(from, i).trim())
      from = i + 1
    }
  }
  args.push(text.slice(from).trim())
  return args.filter((a) => a !== '')
}

const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
const withoutComments = (s) => s.replace(/\/\/[^\n]*/g, '').trim()

/** The lists the body defines before it registers them (`StringList modifications; modifications.emplace_back("U:")`). */
const variables = {}
for (const m of body.matchAll(/\b(?:StringList|IntList|DoubleList|std::vector<\w+>|vector<\w+>)\s+(\w+)\s*(=\s*\{([\s\S]*?)\})?\s*;/g)) {
  variables[m[1]] = m[3] !== undefined ? splitArgs(m[3]).map(evaluate) : []
}
for (const m of body.matchAll(/\b(\w+)\.(?:emplace_back|push_back)\(("(?:[^"\\]|\\.)*")\);/g)) {
  if (m[1] in variables) variables[m[1]].push(evaluate(m[2]))
}

/**
 * The value of a C++ expression of the registration: a number, a string (literals joined by `+`, with
 * `std::to_string` of NuXLFDR's constants), `true`/`false`, a braced list, `ListUtils::create<...>("a,b")`, or one of
 * the lists above. Anything else is refused (the script is then out of date with OpenNuXL).
 */
function evaluate(expression) {
  const e = withoutComments(expression)
  if (/^-?\d+(\.\d+)?(e\d+)?$/i.test(e)) return Number(e)
  if (e === 'true' || e === 'false') return e === 'true'
  if (e.startsWith('{')) return splitArgs(blockAt(e, 0)).map(evaluate)
  const create = /^ListUtils::create<[\w:]+>\(("(?:[^"\\]|\\.)*")\)$/.exec(e)
  if (create) {
    const text = evaluate(create[1])
    return text === '' ? [] : text.split(',')
  }
  if (/^\w+$/.test(e) && e in variables) return [...variables[e]]
  // strings: literals (adjacent or joined by +), std::to_string(<constant>), static_cast<int>(<constant> * <number>)
  const parts = []
  let rest = e
  while (rest !== '') {
    let m
    if ((m = /^"((?:[^"\\]|\\.)*)"\s*/.exec(rest))) parts.push(unescape(m[1]))
    else if ((m = /^std::to_string\(\s*([\w:]+)\s*\)\s*/.exec(rest))) parts.push(String(constant(m[1])))
    else if ((m = /^std::to_string\(\s*static_cast<int>\(\s*([\w:]+)\s*\*\s*(\d+)\s*\)\s*\)\s*/.exec(rest)))
      parts.push(String(Math.trunc(constant(m[1]) * Number(m[2]))))
    else if ((m = /^\+\s*/.exec(rest))) {
      // (joins the parts)
    } else throw new Error(`cannot evaluate: ${e}`)
    rest = rest.slice(m[0].length)
  }
  return parts.join('')
}

function constant(name) {
  if (!(name in constants)) throw new Error(`unknown constant ${name}`)
  return constants[name]
}

const TYPES = {
  registerIntOption_: 'int',
  registerDoubleOption_: 'double',
  registerStringOption_: 'string',
  registerIntList_: 'int[]',
  registerDoubleList_: 'double[]',
  registerStringList_: 'string[]',
  registerFlag_: 'bool',
}

/** The allowed values OpenNuXL computes when it starts (see the top). */
const COMPUTED = ['NuXL:presets', 'peptide:enzyme', 'modifications:fixed', 'modifications:variable']

const entries = []
const valid = {}
for (const call of body.matchAll(/\b(register\w+_|setValidStrings_|setMinInt_|setMaxInt_|setMinFloat_|setMaxFloat_)\s*\(/g)) {
  const args = splitArgs(blockAt(body, call.index + call[0].length - 1))
  const fn = call[1]
  // a name that is computed (the presets' subsections) is none of the allowed ones
  if (!/^"[^"]*"$/.test(args[0])) continue
  const name = evaluate(args[0])
  if (!ALLOWED.includes(name)) continue
  if (fn === 'setValidStrings_') {
    // (the lists computed at the tool's start are filled in below)
    if (!COMPUTED.includes(name)) valid[name] = evaluate(args[1])
    continue
  }
  if (fn.startsWith('setMin') || fn.startsWith('setMax')) {
    const entry = entries.find((x) => x.name === name)
    if (entry) entry[fn.startsWith('setMin') ? 'min' : 'max'] = evaluate(args[1])
    continue
  }
  const type = TYPES[fn]
  if (!type) throw new Error(`${name}: unknown registration ${fn}`)
  if (type === 'bool') {
    // registerFlag_(name, description, advanced = false)
    entries.push({ name, value: false, type, description: evaluate(args[1]), tags: args[2] && evaluate(args[2]) ? ['advanced'] : [] })
    continue
  }
  // register<Type>Option_ / register<Type>List_(name, argument, default, description, required = true, advanced = false)
  const value = evaluate(args[2])
  entries.push({
    name,
    value: type === 'int' && typeof value === 'number' ? Math.round(value) : value,
    type,
    description: evaluate(args[3]),
    tags: args[5] && evaluate(args[5]) ? ['advanced'] : [],
  })
}

// the allowed values that OpenNuXL computes at its start
const presetsJson = JSON.parse(read('share/OpenMS/NUXL/nuxl_presets.json'))
const appPresets = JSON.parse(readFileSync(join(root, 'src/lib/settings/nuxl_presets.json'), 'utf8'))
if (JSON.stringify(presetsJson) !== JSON.stringify(appPresets)) {
  throw new Error('src/lib/settings/nuxl_presets.json differs from share/OpenMS/NUXL/nuxl_presets.json of the pin: copy it again')
}
valid['NuXL:presets'] = Object.keys(presetsJson)
valid['peptide:enzyme'] = enzymes()
valid['filter'] = (valid['filter'] ?? []).filter((f) => FILTERS.includes(f))

for (const entry of entries) {
  if (entry.name === 'modifications:fixed' || entry.name === 'modifications:variable') continue
  if (valid[entry.name]) entry.validStrings = valid[entry.name]
}

const missing = ALLOWED.filter((n) => !entries.some((e) => e.name === n))
if (missing.length > 0) throw new Error(`not among OpenNuXL's options: ${missing.join(', ')}`)
for (const e of entries) {
  if (e.validStrings && typeof e.value === 'string' && !e.validStrings.includes(e.value)) throw new Error(`${e.name}: default ${e.value} not allowed`)
}

/** ProteaseDB's names: Enzymes.xml of the checkout, else the table's list as it is. */
function enzymes() {
  const xml = join(openms, 'share/OpenMS/CHEMISTRY/Enzymes.xml')
  if (existsSync(xml)) {
    const names = [...readFileSync(xml, 'utf8').matchAll(/<ITEM name="Name" value="([^"]+)"/g)].map((m) => m[1])
    if (names.length > 0) return names
  }
  for (const file of ['nuxl-parameters.json']) {
    const path = join(root, 'src/lib/settings', file)
    if (!existsSync(path)) continue
    const list = JSON.parse(readFileSync(path, 'utf8')).find((e) => e.name === 'peptide:enzyme' || e.name === 'enzyme')?.validStrings
    if (list) {
      console.warn(`no Enzymes.xml in the checkout: the enzymes of src/lib/settings/${file}`)
      return list
    }
  }
  throw new Error('no enzyme list: share/OpenMS/CHEMISTRY/Enzymes.xml is missing')
}

writeFileSync(join(root, 'src/lib/settings/nuxl-parameters.json'), JSON.stringify(entries, null, 1) + '\n')
console.log(`${entries.length} parameters`)
