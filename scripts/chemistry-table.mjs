// Generates the chemistry of the fragment annotation (src/lib/chemistry/chemistry.json) from the OpenMS
// pin (native/OPENMS_COMMIT), so that src/lib/psm/annotate.ts computes the masses as OpenMS does:
//
// - elements: OpenMS builds them in code (src/openms/source/CHEMISTRY/ElementDB.cpp, storeElements_):
//   symbol → [atomic number, monoisotopic mass], the monoisotopic mass being the mass of the most
//   abundant isotope (calculateMonoWeight_); and each isotope as an element of its own ('(13)C', of
//   its mass; storeIsotopes_), with the aliases 'D' ('(2)H') and 'T' ('(3)H').
// - residues: in code too (src/openms/source/CHEMISTRY/ResidueDB.cpp, buildResidues_): one-letter
//   code → [formula of the free amino acid, neutral loss formulas (addLossFormula)].
// - modifications: share/OpenMS/CHEMISTRY/unimod.xml, as UnimodXMLHandler reads it: name (title) →
//   [diff formula (<umod:delta> composition), specificities [site, position, neutral loss formulas]]
//   (site: the residue, 'X' for 'N-term'/'C-term'; position: A anywhere, N/C any N-/C-term, PN/PC
//   protein N-/C-term; the losses of <umod:NeutralLoss> with a composition). The mass deltas are in
//   unimod.json (scripts/unimod-table.mjs).
//
// A formula is an object symbol → count ('(13)C' for an isotope).
//
//   node scripts/chemistry-table.mjs <OpenMS checkout of the pin>

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [openms] = process.argv.slice(2)
if (!openms) {
  console.error('usage: node scripts/chemistry-table.mjs <OpenMS checkout of the pin>')
  process.exit(2)
}
const read = (path) => readFileSync(join(openms, path), 'utf8')

// --- elements (ElementDB.cpp)
const elementDB = read('src/openms/source/CHEMISTRY/ElementDB.cpp')
const maps = new Map()
for (const m of elementDB.matchAll(/map<unsigned int, double>\s+(\w+)\s*=\s*\{(.*?)\};/g)) {
  const entries = [...m[2].matchAll(/\{\s*(\d+)u\s*,\s*([-+0-9.eE]+)\s*\}/g)].map((e) => [Number(e[1]), Number(e[2])])
  maps.set(m[1], entries)
}
const elements = {}
for (const m of elementDB.matchAll(/buildElement_\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*(\d+)u\s*,\s*(\w+)\s*,\s*(\w+)\s*\)/g)) {
  const [, , symbol, an, abundanceName, massName] = m
  const abundance = maps.get(abundanceName)
  const mass = new Map(maps.get(massName))
  if (!abundance || !mass.size) throw new Error(`no isotopes of ${symbol}`)
  // the monoisotopic mass: the most abundant isotope's (the first of the highest abundance, by mass number)
  let best = -1
  let mono = 0
  for (const [number, a] of abundance) {
    if (a > best) {
      best = a
      mono = mass.get(number)
    }
  }
  if (symbol in elements) throw new Error(`element ${symbol} twice`)
  elements[symbol] = [Number(an), mono]
  for (const [number] of abundance) {
    const isotope = `(${Math.round(mass.get(number))})${symbol}`
    elements[isotope] = [Number(an), mass.get(Math.round(mass.get(number)))]
  }
}
if (!/symbols_\["D"\] = deuterium;/.test(elementDB) || !/symbols_\["T"\] = tritium;/.test(elementDB)) {
  throw new Error('ElementDB has no D and T aliases any more')
}
elements.D = elements['(2)H']
elements.T = elements['(3)H']

/** A formula as OpenMS writes it in code ('C3H7NO2', 'NHCNH', '(13)C2'): symbol → count. */
function parseFormula(text) {
  const formula = {}
  const token = /(\(\d+\)[A-Z][a-z]*|[A-Z][a-z]*)(-?\d+)?/gy
  let m
  while (token.lastIndex < text.length && (m = token.exec(text))) {
    if (!(m[1] in elements)) throw new Error(`unknown element ${m[1]} in ${text}`)
    formula[m[1]] = (formula[m[1]] ?? 0) + (m[2] === undefined ? 1 : Number(m[2]))
  }
  if (token.lastIndex !== text.length) throw new Error(`unreadable formula ${text}`)
  for (const [symbol, count] of Object.entries(formula)) if (count === 0) delete formula[symbol]
  return formula
}

// --- residues (ResidueDB.cpp)
const residueDB = read('src/openms/source/CHEMISTRY/ResidueDB.cpp')
const variables = new Map()
const residues = {}
for (const m of residueDB.matchAll(/Residue\*\s+(\w+)\s*=\s*new\s+Residue\s*\(\s*"[^"]*"\s*,\s*"[^"]*"\s*,\s*"([A-Z])"\s*,\s*EmpiricalFormula\(\s*"([^"]*)"\s*\)/g)) {
  const [, variable, code, formula] = m
  residues[code] = [parseFormula(formula), []]
  variables.set(variable, code)
}
for (const m of residueDB.matchAll(/(\w+)->addLossFormula\(\s*EmpiricalFormula\(\s*"([^"]*)"\s*\)\s*\)/g)) {
  const code = variables.get(m[1])
  if (!code) throw new Error(`loss of unknown residue ${m[1]}`)
  residues[code][1].push(parseFormula(m[2]))
}
if (Object.keys(residues).length < 20) throw new Error('too few residues read')

// --- modifications (unimod.xml, as UnimodXMLHandler reads it)
const xml = read('share/OpenMS/CHEMISTRY/unimod.xml')
const unescape = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
/** The formula of the <umod:element> tags of `body` ('13C' becomes '(13)C', as the handler writes it). */
function composition(body) {
  const formula = {}
  for (const e of body.matchAll(/<umod:element\s+symbol="([^"]+)"\s+number="([^"]+)"\s*\/>/g)) {
    const isotope = e[1].replace(/[^0-9]/g, '')
    const symbol = isotope ? `(${isotope})${e[1].replace(/[0-9]/g, '')}` : e[1]
    if (!(symbol in elements)) throw new Error(`unknown element ${e[1]}`)
    formula[symbol] = (formula[symbol] ?? 0) + Number(e[2])
  }
  for (const [symbol, count] of Object.entries(formula)) if (count === 0) delete formula[symbol]
  return formula
}
const POSITIONS = { Anywhere: 'A', 'Any N-term': 'N', 'Any C-term': 'C', 'Protein N-term': 'PN', 'Protein C-term': 'PC' }
const modifications = {}
for (const mod of xml.matchAll(/<umod:mod\s([^>]*)>([\s\S]*?)<\/umod:mod>/g)) {
  const title = unescape(/\btitle="([^"]*)"/.exec(mod[1])?.[1] ?? '')
  if (!title) throw new Error(`no title: ${mod[1].slice(0, 120)}`)
  const delta = /<umod:delta\b[^>]*>([\s\S]*?)<\/umod:delta>|<umod:delta\b[^>]*\/>/.exec(mod[2])
  if (!delta) throw new Error(`${title}: no delta`)
  const specificities = []
  for (const spec of mod[2].matchAll(/<umod:specificity\s([^>]*?)(?:\/>|>([\s\S]*?)<\/umod:specificity>)/g)) {
    const site = /\bsite="([^"]*)"/.exec(spec[1])[1]
    const position = POSITIONS[/\bposition="([^"]*)"/.exec(spec[1])[1]] ?? 'A' // unknown: anywhere (as the handler)
    const losses = []
    for (const loss of (spec[2] ?? '').matchAll(/<umod:NeutralLoss\b[^>]*?(?:\/>|>([\s\S]*?)<\/umod:NeutralLoss>)/g)) {
      const formula = composition(loss[1] ?? '')
      if (Object.keys(formula).length > 0) losses.push(formula) // the handler skips the losses without elements
    }
    specificities.push([site.length > 1 ? 'X' : site, position, losses])
  }
  if (title in modifications) throw new Error(`modification ${title} twice`)
  modifications[title] = [composition(delta[1] ?? ''), specificities]
}

const out = new URL('../src/lib/chemistry/chemistry.json', import.meta.url).pathname
writeFileSync(out, JSON.stringify({ elements, residues, modifications }) + '\n')
console.log(`${Object.keys(elements).length} elements, ${Object.keys(residues).length} residues, ${Object.keys(modifications).length} modifications: ${out}`)
