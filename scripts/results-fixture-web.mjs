// Exports the web app's result of a search of scripts/results-example.mjs
// (src/lib/results/fixtures/web-<case>.json), the golden result the reader is compared with: the
// web app's 32-bit WebAssembly module in Node.js, called as the web app's engine calls it (prose-pages
// app/src/lib/engine/core.ts `runSearch`, `searchSettings`, `predict`): the files one by one
// (`provideFile`) under their names, the database with the contaminants (`withContaminants`), the
// parameters of the case, Percolator and PeptDeep as the case says, `keepSpectra`, decoys kept, and
// PeptDeep's prediction of every PSM row (`predictMS2` of the row's peptide and charge at its file's NCE,
// as the PSM view asks for it).
//
//   node scripts/results-fixture-web.mjs <case> <wasm32 package>
//
// Typed arrays become arrays (float32 values with the 9 significant digits that keep them exactly) and
// NaN becomes null. OUT=<file> writes it elsewhere.

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CRAP, getCase } from './results-example.mjs'

const [caseName, pkg] = process.argv.slice(2)
if (!caseName || !pkg) {
  console.error('usage: node scripts/results-fixture-web.mjs <case> <wasm32 package>')
  process.exit(2)
}
const search = getCase(caseName)
const out = process.env.OUT ?? new URL(`../src/lib/results/fixtures/web-${caseName}.json`, import.meta.url).pathname
const peptdeep = search.peptdeep && process.env.PEPTDEEP !== '0'
const MS2_MODEL = '/models/peptdeep_ms2_dynamic.onnx'

const { default: createOpenMS } = await import(pathToFileURL(join(resolve(pkg), 'openms.mjs')).href)
const OpenMS = await createOpenMS({ numThreads: 4, print: () => {}, printErr: () => {} })
OpenMS.setLogEnabled('info', false)
OpenMS.mountHostDirectory('/models', join(resolve(pkg), 'models'))

// core.ts withContaminants
let fasta = readFileSync(search.fasta, 'utf8')
if (search.contaminants) {
  if (!fasta.endsWith('\n')) fasta += '\n'
  fasta += readFileSync(CRAP, 'utf8').replace(/^>(?!CON__)/gm, '>CON__')
}
const databasePath = `/input/db/${basename(search.fasta)}`
OpenMS.FS.mkdirTree('/input/db', 0o777)
OpenMS.FS.writeFile(databasePath, fasta)
const mzML = readFileSync(search.mzML)

// core.ts searchSettings
const prose = new OpenMS.ProSEAlgorithm()
const parameters = { ...search.parameters, 'peptdeep:enable': peptdeep }
if (peptdeep) {
  parameters['peptdeep:ms2_model'] = MS2_MODEL
  parameters['peptdeep:rt_model'] = '/models/peptdeep_rt_dynamic.onnx'
}
prose.setParameterValues(parameters)
const paths = search.names.map((name, i) => `/input/${i}/${name}`)
const results = prose.searchFiles(paths, databasePath, {
  rescore: search.rescore,
  keepSpectra: true,
  provideFile: (_i, path) => {
    OpenMS.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')), 0o777)
    OpenMS.allocateFile(path, mzML.length, mzML.length)
    OpenMS.writeFileChunk(path, mzML, 0)
  },
  releaseFile: (_i, path) => OpenMS.FS.unlink(path),
})
const summary = results.summary()
const tables = results.tables()
const spectra = results.spectra()

// the PSM view's prediction of every PSM row (PsmView.svelte: peptides.openms, the PSM's charge, the
// file's peptdeepNce), as PredictedSpectra (columns over all PSMs; the ion name has the type, the
// ordinal and the charge of PredictedIon). Without PeptDeep the files have no NCE (the PSM view would
// take the spectrum's): none.
const predicted = { psmOffsets: [0], ion: [], mz: [], intensity: [] }
for (let i = 0; i < tables.psms.count; i++) {
  const nce = summary.files[tables.psms.file[i]].peptdeepNce
  const peptide = tables.peptides.openms[tables.psms.peptide[i]]
  const instrument = search.parameters['peptdeep:instrument']
  if (nce !== null) {
    for (const p of OpenMS.predictMS2(peptide, tables.psms.charge[i], nce, instrument, MS2_MODEL)) {
      predicted.ion.push(p.ion)
      predicted.mz.push(p.mz)
      predicted.intensity.push(p.intensity)
    }
  }
  predicted.psmOffsets.push(predicted.ion.length)
}

const float32 = (v) => (Number.isNaN(v) ? null : Number(v.toPrecision(9)))
const plain = (_key, value) => {
  if (value instanceof Float32Array) return Array.from(value, float32)
  if (ArrayBuffer.isView(value)) return Array.from(value, (v) => (typeof v === 'number' && Number.isNaN(v) ? null : v))
  if (typeof value === 'number' && Number.isNaN(value)) return null
  return value
}
const meta = { version: OpenMS.getVersion(), names: search.names, parameters, rescore: search.rescore }
writeFileSync(out, JSON.stringify({ ...meta, summary, tables, spectra, predicted }, plain) + '\n')
console.log(`${tables.psms.count} PSMs, ${tables.peptides.count} peptides, ${tables.proteins.count} proteins: ${out}`)
results.delete()
prose.delete()
process.exit(0)
