// Generates the app's modification table (src/lib/chemistry/unimod.json) from the Unimod file of the
// OpenMS pin (`share/OpenMS/CHEMISTRY/unimod.xml` of native/OPENMS_COMMIT), which OpenMS' ModificationsDB
// reads: every Unimod modification by its record id, with its name (the title, OpenMS' modification id)
// and its monoisotopic mass delta (`<umod:delta mono_mass>`).
//
//   node scripts/unimod-table.mjs <OpenMS checkout of the pin>
//
// No output of ProSE has the masses of the modifications (docs/parity.md, peptides.modMass).

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [openms] = process.argv.slice(2)
if (!openms) {
  console.error('usage: node scripts/unimod-table.mjs <OpenMS checkout of the pin>')
  process.exit(2)
}
const xml = readFileSync(join(openms, 'share/OpenMS/CHEMISTRY/unimod.xml'), 'utf8')
const unescape = (s) =>
  s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** record id → [name, monoisotopic mass delta] */
const table = {}
for (const mod of xml.matchAll(/<umod:mod\s([^>]*)>([\s\S]*?)<\/umod:mod>/g)) {
  const title = /\btitle="([^"]*)"/.exec(mod[1])?.[1]
  const id = /\brecord_id="(\d+)"/.exec(mod[1])?.[1]
  const mass = /<umod:delta\b[^>]*\bmono_mass="([^"]+)"/.exec(mod[2])?.[1]
  if (title === undefined || id === undefined || mass === undefined) throw new Error(`unreadable entry: ${mod[1].slice(0, 120)}`)
  table[id] = [unescape(title), Number(mass)]
}
const out = new URL('../src/lib/chemistry/unimod.json', import.meta.url).pathname
writeFileSync(out, JSON.stringify(table) + '\n')
console.log(`${Object.keys(table).length} modifications: ${out}`)
