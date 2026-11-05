// Makes the search folders of the results reader's fixtures (src/lib/results/fixtures/<case>/) from OpenNuXL's own
// test outputs (src/lib/results/fixtures/nuxl/, copies of OpenMS src/tests/topp/OpenNuXL_{1,3,6}_output.idXML) and the
// app's example (src-tauri/resources/example/OpenNuXL_1_input.{mzML,fasta}, the input of all three runs):
//
//   node scripts/results-fixtures.mjs
//
// A folder is what the shim leaves (docs/design.md §2): inputs.json, database.fasta (the FASTA with a cRAP
// contaminant, CON__), and in nuxl/ per input its `<stem>.outputs.json` and the files OpenNuXL derives from its -out:
// `<stem>_1.0000_XLs.idXML` and `<stem>_0.0000_peptides.idXML`, made here as NuXLFDR::calculatePeptideAndXLQValueAndFilter-
// AtPSMLevel makes them with `-report:peptideFDR 0 -report:xlFDR 1.0` (src/topp/OpenNuXL/source/NuXLFDR.cpp):
//
// - the top hit of each spectrum (IDFilter::keepNBestHits 1), the peptides (NuXL:isXL 0) and the cross-links apart;
// - the q-values of each group by target-decoy competition as FalseDiscoveryRate computes them (conservative: the
//   decoys over the targets at or above the score, the running minimum from the lowest score up; no decoy: 0), the hit
//   score set to the q-value (score type 'q-value', lower is better) and the former score kept as `NuXLScore_score`;
// - the cross-links' q-values with NuXLFDR's tie-break: + (1 − (score − min) / range) · 1e-5 by NuXL:score;
// - the decoy hits removed, the proteins no hit refers to removed (and the others numbered anew, as IdXMLFile does);
// - NuXL:fdr_group 'XL' on the cross-links (NuXLFDR labels the groups when the short cross-links have their own; here
//   it is set always, so that the reader's column is tested; the reader takes a cross-link without it as 'XL').
//
// - on every hit its peptide-level q-value 'peptide q-value' (Constants::UserParam::PEPTIDE_Q_VALUE), as
//   FalseDiscoveryRate::apply(ids, true) gives it in each group: the q-values of the best target and the best decoy
//   score of each unmodified sequence, the hit getting its sequence's of its own kind (before the tie-break).
//
// `all` of outputs.json names OpenNuXL's -out, which is not kept (the reader never reads it). `mz` names the run's QPX mz
// view (`nuxl/<stem>.mz.parquet`, OpenNuXL's -out_qpx, which the shim moves there): the MS2 spectra of the run's PSMs
// (one row per native ID, in the order of each one's first PSM), here the example's spectra under the run's native IDs,
// written with the columns, types and footer of QPXDatasetExport::mzView (a real one's schema; zstd, row groups of
// MZ_ROW_GROUP rows, small here so that the reader's row groups are tested), its peaks all kept (the example's spectra
// have fewer than 100 peaks per 100 Th).
//
// The cases:
//   example  one input (OpenNuXL_6: several hits per spectrum, a decoy among them), no Percolator (too few PSMs). The
//            test data are cross-linked standards: every spectrum's top hit is a cross-link, none a decoy. So that the
//            peptides' group and its target-decoy competition are tested, six spectra (LINEAR) take their best hit
//            without adduct as top hit, as a search without the cross-link adducts would have it (of spectrum 7 that
//            is the decoy FDKAGEHVASGR, which gives the peptides below it q-value 0.2);
//   runs     three inputs: OpenNuXL_6, OpenNuXL_1 (no decoys: every q-value 0) and one whose run did not finish
//            (no outputs.json);
//   empty    two inputs whose runs found nothing (filtered files without identifications);
//   screens  one input (OpenNuXL_3: precursor tolerance 10 ppm, decoys, the top 3 hits per spectrum, -NuXL:scoring
//            fast), taken as it is (no LINEAR): realistic precursor errors (OpenNuXL_6 searched with a tolerance of
//            1e9 ppm) for the screenshots of docs/screens (e2e/screens.shot.ts; the fake serves it with
//            FAKE_NUXL_RESULTS=screens). Every top hit is a cross-link, so its peptides file holds no PSM.
//   vendor   two inputs that are not mzML: a Bruker timsTOF folder run.d (OpenNuXL_6, its native IDs Bruker's
//            'frame=F scan=S precursor=P', where S is not unique) with its mz view, and a Thermo thermo.raw
//            (OpenNuXL_1, IDs 'controllerType=0 controllerNumber=1 scan=N') whose mz view OpenNuXL could not write
//            (`mz` null, the shim's note).
//   legacy   the vendor case as app versions before 0.9 saved it (no `mz`): run.d's spectra converted by FileConverter
//            (outputs.json `spectra`: nuxl/1__run.spectra.mzML, the example's spectra under those IDs as FileConverter
//            writes them: MS2 only, indexed, in another order than the native IDs), thermo.raw's conversion failed
//            (`spectra` null).
// And spectra/OpenNuXL_1_input.indexed.mzML: the example's mzML as an indexedmzML, its arrays zlib-compressed (the
// reader's spectrum load by the index; the plain file is read by scanning).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { deflateSync, zstdCompressSync } from 'node:zlib'
import { parquetWriteBuffer } from 'hyparquet-writer'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'src/lib/results/fixtures')
const example = join(root, 'src-tauri/resources/example')
const SOURCE = (n) => readFileSync(join(fixtures, 'nuxl', `OpenNuXL_${n}_output.idXML`), 'utf8')

//------------------------------------------------------------------------------
// idXML, as blocks of text (IdXMLFile writes one element per line)

const param = (block, name) => {
  const m = new RegExp(`<UserParam type="[^"]*" name="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" value="([^"]*)"`).exec(block)
  return m ? m[1] : undefined
}
const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1]

function parse(text) {
  const proteinStart = text.indexOf('\t\t<ProteinIdentification')
  const headEnd = text.indexOf('\n', proteinStart) + 1
  const head = text.slice(0, headEnd)
  const proteinEnd = text.indexOf('\t\t</ProteinIdentification>')
  const proteinBlock = text.slice(headEnd, proteinEnd)
  const proteins = proteinBlock.match(/\t\t\t<ProteinHit [\s\S]*?<\/ProteinHit>\n/g) ?? []
  const runParams = proteinBlock.slice(proteinBlock.lastIndexOf('</ProteinHit>\n') + '</ProteinHit>\n'.length)
  const ids = (text.slice(proteinEnd).match(/\t\t<PeptideIdentification [\s\S]*?<\/PeptideIdentification>\n/g) ?? []).map((block) => {
    const open = block.slice(0, block.indexOf('\n') + 1)
    const hits = block.match(/\t\t\t<PeptideHit [\s\S]*?<\/PeptideHit>\n/g) ?? []
    const params = block.slice(block.lastIndexOf('</PeptideHit>\n') + '</PeptideHit>\n'.length, block.lastIndexOf('\t\t</PeptideIdentification>'))
    return { open, hits, params }
  })
  return { head, proteins, runParams, ids }
}

/** The q-values (conservative, higher score better) of the hits { score, decoy }: set as hit[key]. */
function qValues(hits, key = 'q') {
  const sorted = [...hits].sort((a, b) => b.score - a.score)
  const decoys = sorted.filter((h) => h.decoy).length
  let d = 0
  let t = 0
  const fdr = new Map()
  for (let i = 0; i < sorted.length; ) {
    let j = i
    while (j < sorted.length && sorted[j].score === sorted[i].score) {
      if (sorted[j].decoy) d++
      else t++
      j++
    }
    fdr.set(sorted[i].score, decoys === 0 ? 0 : t === 0 ? 1 : d / t)
    i = j
  }
  // the running minimum from the lowest score up
  let min = 1
  for (const score of [...fdr.keys()].sort((a, b) => a - b)) {
    min = Math.min(min, fdr.get(score))
    fdr.set(score, min)
  }
  for (const h of hits) h[key] = fdr.get(h.score)
}

/** AASequence::toUnmodifiedString of an idXML sequence ('.(Acetyl)DAHK(Oxidation)R' -> 'DAHKR'). */
const unmodified = (sequence) => sequence.replace(/\([^()]*(\([^()]*\)[^()]*)*\)|\[[^\]]*\]|\./g, '')

/**
 * FalseDiscoveryRate's peptide-level q-values of the hits { hit, score, decoy } (apply with annotate_peptide_fdr): the
 * best score per unmodified sequence among the targets and among the decoys, their q-values together; set as hit.pq.
 */
function peptideQValues(hits) {
  const best = new Map()
  for (const h of hits) {
    const key = `${h.decoy ? 'd' : 't'}\u0000${unmodified(attribute(h.hit, 'sequence') ?? '')}`
    const b = best.get(key)
    if (!b || h.score > b.score) best.set(key, { score: h.score, decoy: h.decoy, key })
  }
  const peptides = [...best.values()]
  qValues(peptides)
  const q = new Map(peptides.map((p) => [p.key, p.q]))
  for (const h of hits) h.pq = q.get(`${h.decoy ? 'd' : 't'}\u0000${unmodified(attribute(h.hit, 'sequence') ?? '')}`)
}

const number = (x) => (Number.isInteger(x) ? `${x}.0` : String(x))

/**
 * The filtered files of an OpenNuXL -out (see above): { peptides, xls } as idXML text. `linear`: the identifications
 * (0-based, in the file's order) whose top hit is taken to be their best hit without adduct (NuXL:isXL 0).
 */
function filtered(text, linear = new Set()) {
  const f = parse(text)
  const top = f.ids
    .filter((pi) => pi.hits.length > 0)
    .map((pi, k) => {
      const hit = linear.has(k) ? pi.hits.find((h) => Number(param(h, 'NuXL:isXL') ?? 0) === 0) : pi.hits[0]
      return {
        pi,
        hit,
        score: Number(param(hit, 'NuXL:score')),
        decoy: param(hit, 'target_decoy') === 'decoy',
        xl: Number(param(hit, 'NuXL:isXL') ?? 0) !== 0,
      }
    })
  const peptides = top.filter((h) => !h.xl)
  const xls = top.filter((h) => h.xl)
  qValues(peptides)
  qValues(xls)
  peptideQValues(peptides)
  peptideQValues(xls)
  if (xls.length > 0) {
    const scores = xls.map((h) => h.score)
    const [min, max] = [Math.min(...scores), Math.max(...scores)]
    for (const h of xls) h.q += (1 - (h.score - min) / (max - min)) * 1e-5
  }
  const write = (group, isXL) => {
    const kept = group.filter((h) => !h.decoy)
    // the proteins the kept hits refer to, numbered anew in the file's order
    const used = new Set(kept.flatMap((h) => (attribute(h.hit, 'protein_refs') ?? '').split(' ').filter(Boolean)))
    const renumber = new Map()
    const proteins = f.proteins.filter((p) => used.has(attribute(p, 'id')))
    proteins.forEach((p, k) => renumber.set(attribute(p, 'id'), `PH_${k}`))
    const proteinText = proteins.map((p) => p.replace(/ id="PH_\d+"/, ` id="${renumber.get(attribute(p, 'id'))}"`)).join('')
    const idText = kept
      .map(({ pi, hit, score, q, pq }) => {
        const open = pi.open.replace(/score_type="[^"]*" higher_score_better="[^"]*"/, 'score_type="q-value" higher_score_better="false"')
        let h = hit
          .replace(/<PeptideHit score="[^"]*"/, `<PeptideHit score="${number(q)}"`)
          .replace(/ protein_refs="([^"]*)"/, (_, refs) => ` protein_refs="${refs.split(' ').map((r) => renumber.get(r)).join(' ')}"`)
        const extra = [
          `\t\t\t\t<UserParam type="float" name="peptide q-value" value="${number(pq)}"/>\n`,
          `\t\t\t\t<UserParam type="float" name="NuXLScore_score" value="${number(score)}"/>\n`,
        ]
        if (isXL) extra.push(`\t\t\t\t<UserParam type="string" name="NuXL:fdr_group" value="XL"/>\n`)
        h = h.replace('\t\t\t</PeptideHit>\n', `${extra.join('')}\t\t\t</PeptideHit>\n`)
        return `${open}${h}${pi.params}\t\t</PeptideIdentification>\n`
      })
      .join('')
    return `${f.head}${proteinText}${f.runParams}\t\t</ProteinIdentification>\n${idText}\t</IdentificationRun>\n</IdXML>\n`
  }
  return { peptides: write(peptides, false), xls: write(xls, true), counts: { peptides: peptides.filter((h) => !h.decoy).length, xls: xls.filter((h) => !h.decoy).length, decoys: top.filter((h) => h.decoy).length } }
}

/** An idXML of `text`'s search without identifications (a run that found nothing). */
function withoutIds(text) {
  const f = parse(text)
  return `${f.head}${f.runParams}\t\t</ProteinIdentification>\n\t</IdentificationRun>\n</IdXML>\n`
}

//------------------------------------------------------------------------------
// The folders

const FASTA_DESCRIPTIONS = {
  Cse1: 'CRISPR system Cascade subunit CasA OS=Escherichia coli (strain K12) GN=casA',
  Cse2: 'CRISPR system Cascade subunit CasB OS=Escherichia coli (strain K12) GN=casB',
  Cas7: 'CRISPR system Cascade subunit CasC OS=Escherichia coli (strain K12) GN=casC',
  Cas5: 'CRISPR system Cascade subunit CasD OS=Escherichia coli (strain K12) GN=casD',
  Cas6e: 'CRISPR-associated endoribonuclease Cas6e OS=Escherichia coli (strain K12) GN=casE',
}

/** The example FASTA with descriptions and the first cRAP entry as a contaminant (the shim's CON__ prefix). */
function databaseFasta() {
  const fasta = readFileSync(join(example, 'OpenNuXL_1_input.fasta'), 'utf8').replace(/^>(\S+)\s*$/gm, (_, id) => `>${id} ${FASTA_DESCRIPTIONS[id] ?? ''}`.trimEnd())
  const crap = readFileSync(join(root, 'src-tauri/resources/fasta/crap.fasta'), 'utf8')
  const first = crap.slice(0, crap.indexOf('\n>', 1) + 1)
  return fasta.trimEnd() + '\n' + first.replace(/^>/, '>CON__')
}

function input(index, name) {
  const link = `${index + 1}__${name}`
  // (the shim's input_stem: the link without .mzML, .raw or .d)
  return { id: `f${index}`, index, link, stem: link.replace(/\.(mzML|raw|d)$/i, ''), name, path: `/data/${name}` }
}

function outputs(stem, index, { percolator = false, notes = [], seconds = 1.5, spectra, mz } = {}) {
  return {
    // (app versions before 0.9, a .raw or .d input: the shim's mzML of its spectra, or null when it could not be written)
    ...(spectra !== undefined ? { spectra } : {}),
    // (the run's QPX mz view, or null when OpenNuXL could not write it)
    ...(mz !== undefined ? { mz } : {}),
    input: index,
    all: `nuxl/${stem}.idXML`,
    xls: `nuxl/${stem}_1.0000_XLs.idXML`,
    peptides: `nuxl/${stem}_0.0000_peptides.idXML`,
    proteins: null,
    report: null,
    percolator,
    notes,
    seconds,
    fdr: { peptide: 0.01, xl: 0.01 },
  }
}

const TOO_FEW = 'Too few PSMs for score recalibration. Skipped.'

function writeFolder(name, records, runs) {
  const dir = join(fixtures, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'nuxl'), { recursive: true })
  writeFileSync(join(dir, 'inputs.json'), JSON.stringify(records, null, 2) + '\n')
  writeFileSync(join(dir, 'database.fasta'), databaseFasta())
  for (const [k, run] of runs.entries()) {
    if (!run) continue
    const stem = records[k].stem
    const out = outputs(stem, k, run.outputs)
    writeFileSync(join(dir, 'nuxl', `${stem}.outputs.json`), JSON.stringify(out, null, 2) + '\n')
    writeFileSync(join(dir, out.xls), run.xls)
    writeFileSync(join(dir, out.peptides), run.peptides)
    if (run.spectra) writeFileSync(join(dir, out.spectra), run.spectra)
    if (run.mzView) writeFileSync(join(dir, out.mz), run.mzView)
  }
  console.log(`${name}: ${records.length} input(s)`)
}

//------------------------------------------------------------------------------
// The QPX mz view

/** The rows per row group of the fixtures' mz views (OpenNuXL writes 256; fewer here, so that a view has several). */
const MZ_ROW_GROUP = 8

/** The MS2 spectra of the example's mzML by native ID: their peaks, RT (s), precursor m/z and charge. */
function exampleSpectra() {
  const text = readFileSync(join(example, 'OpenNuXL_1_input.mzML'), 'latin1')
  const out = new Map()
  for (const block of text.match(/<spectrum [\s\S]*?<\/spectrum>/g)) {
    const id = /<spectrum [^>]*\bid="([^"]*)"/.exec(block)[1]
    const value = (accession) => {
      const at = block.indexOf(`accession="${accession}"`)
      if (at < 0) return null
      const tag = block.slice(block.lastIndexOf('<', at), block.indexOf('>', at))
      return /value="([^"]*)"/.exec(tag)?.[1] ?? null
    }
    if (value('MS:1000511') !== '2') continue
    const arrays = [...block.matchAll(/<binaryDataArray [\s\S]*?<\/binaryDataArray>/g)].map(([a]) => {
      const bytes = Buffer.from(/<binary>([^<]*)<\/binary>/.exec(a)[1], 'base64')
      const wide = a.includes('MS:1000523')
      const values = wide ? new Float64Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) : new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      return { mz: a.includes('MS:1000514'), values: Array.from(values) }
    })
    const rt = Number(value('MS:1000016'))
    const minutes = /MS:1000016[^>]*unitName="minute"/.test(block)
    out.set(id, {
      mz: arrays.find((a) => a.mz).values,
      intensity: arrays.find((a) => !a.mz).values,
      rt: minutes ? rt * 60 : rt,
      precursorMz: Number(value('MS:1000744')),
      charge: value('MS:1000041') === null ? null : Number(value('MS:1000041')),
    })
  }
  return out
}

/** The schema of QPXDatasetExport::mzView's table, as Arrow writes it (from an mz view of the pinned OpenMS). */
const MZ_SCHEMA = [
  { repetition_type: 'REQUIRED', name: 'schema', num_children: 13 },
  { type: 'BYTE_ARRAY', repetition_type: 'REQUIRED', name: 'id', converted_type: 'UTF8', logical_type: { type: 'STRING' } },
  { type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL', name: 'run_file_name', converted_type: 'UTF8', logical_type: { type: 'STRING' } },
  { repetition_type: 'OPTIONAL', name: 'scan', num_children: 1, converted_type: 'LIST', logical_type: { type: 'LIST' } },
  { repetition_type: 'REPEATED', name: 'list', num_children: 1 },
  { type: 'INT32', repetition_type: 'OPTIONAL', name: 'element' },
  { type: 'INT32', repetition_type: 'REQUIRED', name: 'ms_level' },
  { type: 'BOOLEAN', repetition_type: 'REQUIRED', name: 'centroid' },
  { type: 'FLOAT', repetition_type: 'REQUIRED', name: 'scan_start_time' },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'inverse_ion_mobility' },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'ion_injection_time' },
  { type: 'FLOAT', repetition_type: 'REQUIRED', name: 'total_ion_current' },
  { repetition_type: 'OPTIONAL', name: 'precursors', num_children: 1, converted_type: 'LIST', logical_type: { type: 'LIST' } },
  { repetition_type: 'REPEATED', name: 'list', num_children: 1 },
  { repetition_type: 'OPTIONAL', name: 'element', num_children: 7 },
  { type: 'FLOAT', repetition_type: 'REQUIRED', name: 'selected_ion_mz' },
  { type: 'INT32', repetition_type: 'OPTIONAL', name: 'selected_ion_charge' },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'selected_ion_intensity' },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'isolation_window_target' },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'isolation_window_lower' },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'isolation_window_upper' },
  { type: 'BYTE_ARRAY', repetition_type: 'OPTIONAL', name: 'spectrum_ref', converted_type: 'UTF8', logical_type: { type: 'STRING' } },
  { repetition_type: 'REQUIRED', name: 'mz', num_children: 1, converted_type: 'LIST', logical_type: { type: 'LIST' } },
  { repetition_type: 'REPEATED', name: 'list', num_children: 1 },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'element' },
  { repetition_type: 'REQUIRED', name: 'intensity', num_children: 1, converted_type: 'LIST', logical_type: { type: 'LIST' } },
  { repetition_type: 'REPEATED', name: 'list', num_children: 1 },
  { type: 'FLOAT', repetition_type: 'OPTIONAL', name: 'element' },
  { repetition_type: 'OPTIONAL', name: 'cv_params', num_children: 1, converted_type: 'LIST', logical_type: { type: 'LIST' } },
  { repetition_type: 'REPEATED', name: 'list', num_children: 1 },
  { repetition_type: 'OPTIONAL', name: 'element', num_children: 2 },
  { type: 'BYTE_ARRAY', repetition_type: 'REQUIRED', name: 'cv_name', converted_type: 'UTF8', logical_type: { type: 'STRING' } },
  { type: 'BYTE_ARRAY', repetition_type: 'REQUIRED', name: 'cv_value', converted_type: 'UTF8', logical_type: { type: 'STRING' } },
]

/** The native IDs of the PSMs of the filtered files of `run`, in the order of their first PSM. */
function psmIds(run) {
  const ids = []
  for (const text of [run.xls, run.peptides]) {
    for (const m of text.matchAll(/spectrum_reference="([^"]*)"/g)) if (!ids.includes(m[1])) ids.push(m[1])
  }
  return ids
}

/**
 * The QPX mz view of the run `run` (`runFile`: its run_file_name): a row per native ID of its PSMs, the example's
 * spectrum `spectrum=N` of each (`back(id)` gives N's id `spectrum=N`), as OpenNuXL's -out_qpx writes it.
 */
function mzView(run, runFile, back = (id) => id) {
  const spectra = exampleSpectra()
  const rows = []
  for (const id of psmIds(run)) {
    const s = spectra.get(back(id))
    if (!s) continue
    const scan = /(?:scan|spectrum)=(\d+)/.exec(id)
    rows.push({
      id,
      run_file_name: runFile,
      scan: scan ? [Number(scan[1])] : null,
      ms_level: 2,
      centroid: true,
      scan_start_time: s.rt / 60,
      inverse_ion_mobility: null,
      ion_injection_time: null,
      total_ion_current: s.intensity.reduce((a, b) => a + b, 0),
      precursors: [
        {
          selected_ion_mz: s.precursorMz,
          selected_ion_charge: s.charge,
          selected_ion_intensity: null,
          isolation_window_target: null,
          isolation_window_lower: null,
          isolation_window_upper: null,
          spectrum_ref: null,
        },
      ],
      mz: s.mz,
      intensity: s.intensity,
      cv_params: null,
    })
  }
  const names = ['id', 'run_file_name', 'scan', 'ms_level', 'centroid', 'scan_start_time', 'inverse_ion_mobility', 'ion_injection_time', 'total_ion_current', 'precursors', 'mz', 'intensity', 'cv_params']
  const kv = {
    qpx_version: '1.1',
    file_type: 'mz_file',
    creator: 'OpenMS',
    software_provider: 'OpenMS (results-fixtures.mjs)',
    compression_format: 'zstd',
    nuxl_peak_annotated: 'kept',
    nuxl_peak_top: '100',
    nuxl_peak_window: '100',
    scan_format: 'scan',
  }
  return new Uint8Array(
    parquetWriteBuffer({
      columnData: names.map((name) => ({ name, data: rows.map((r) => r[name]) })),
      schema: MZ_SCHEMA,
      rowGroupSize: MZ_ROW_GROUP,
      codec: 'ZSTD',
      compressors: { ZSTD: (input) => new Uint8Array(zstdCompressSync(input)) },
      kvMetadata: Object.entries(kv).map(([key, value]) => ({ key, value })),
    }),
  )
}

/** The run `run` of input `stem` with its mz view (`back`: as for mzView). */
const withView = (run, stem, back) => ({ ...run, mzView: mzView(run, stem, back), outputs: { ...run.outputs, mz: `nuxl/${stem}.mz.parquet` } })

/** The identifications of OpenNuXL_6 whose top hit the example takes to be their best one without adduct. */
const LINEAR = new Set([2, 6, 10, 11, 13, 17])
const six = filtered(SOURCE(6), LINEAR)
const one = filtered(SOURCE(1))
console.log('OpenNuXL_6:', six.counts, 'OpenNuXL_1:', one.counts)

writeFolder('example', [input(0, 'OpenNuXL_1_input.mzML')], [withView({ ...six, outputs: { notes: [TOO_FEW] } }, '1__OpenNuXL_1_input')])
writeFolder(
  'runs',
  [input(0, 'OpenNuXL_1_input.mzML'), input(1, 'no_decoys.mzML'), input(2, 'unfinished.mzML')],
  [withView({ ...six, outputs: { notes: [TOO_FEW] } }, '1__OpenNuXL_1_input'), withView({ ...one, outputs: { notes: [TOO_FEW], seconds: 2.5 } }, '2__no_decoys'), null],
)
const three = filtered(SOURCE(3))
console.log('OpenNuXL_3:', three.counts)
writeFolder('screens', [input(0, 'OpenNuXL_1_input.mzML')], [withView({ ...three, outputs: { notes: [TOO_FEW] } }, '1__OpenNuXL_1_input')])
const nothing = withoutIds(SOURCE(6))
writeFolder('empty', [input(0, 'a.mzML'), input(1, 'b.mzML')], [
  { xls: nothing, peptides: nothing, outputs: { notes: [TOO_FEW] } },
  { xls: nothing, peptides: nothing, outputs: { notes: [TOO_FEW] } },
])

//------------------------------------------------------------------------------
// The indexed mzML

/** The filtered files `run` with their native IDs `spectrum=N` as `id(N)` gives them. */
function renamed(run, id) {
  const rename = (text) => text.replace(/spectrum_reference="spectrum=(\d+)"/g, (_, n) => `spectrum_reference="${id(Number(n))}"`)
  return { ...run, xls: rename(run.xls), peptides: rename(run.peptides) }
}

/** The mzML `text` with its binary arrays zlib-compressed, wrapped as indexedmzML with the spectrum offsets. */
function indexedMzml(text) {
  // the arrays, zlib-compressed (MS:1000574) instead of none (MS:1000576)
  let body = text.replace(/<binaryDataArray encodedLength="\d+">([\s\S]*?)<binary>([^<]*)<\/binary>/g, (_, params, base64) => {
    const packed = deflateSync(Buffer.from(base64, 'base64')).toString('base64')
    const compressed = params.replace('accession="MS:1000576" name="no compression"', 'accession="MS:1000574" name="zlib compression"')
    return `<binaryDataArray encodedLength="${packed.length}">${compressed}<binary>${packed}</binary>`
  })
  const declaration = body.slice(0, body.indexOf('?>') + 2)
  body = body.slice(declaration.length).replace(/^\s*/, '\n').replace(/\s*$/, '\n')
  const headText = `${declaration}\n<indexedmzML xmlns="http://psi.hupo.org/ms/mzml" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://psi.hupo.org/ms/mzml http://psidev.info/files/ms/mzML/xsd/mzML1.1.2_idx.xsd">`
  const head = Buffer.from(headText + body, 'latin1')
  // the byte offsets of the spectrum elements (the file is ISO-8859-1: one byte per character)
  const offsets = []
  const tag = /<spectrum\s[^>]*\bid="([^"]*)"/g
  const all = headText + body
  for (let m; (m = tag.exec(all)); ) offsets.push([m[1], m.index])
  let index = `\t<indexList count="1">\n\t\t<index name="spectrum">\n`
  for (const [id, offset] of offsets) index += `\t\t\t<offset idRef="${id}">${offset}</offset>\n`
  index += `\t\t</index>\n\t</indexList>\n`
  // (the offset of the <indexList> element itself, after its indentation)
  const indexOffset = head.length + 1
  const rest = `${index}\t<indexListOffset>${indexOffset}</indexListOffset>\n\t<fileChecksum>`
  const withoutSum = Buffer.concat([head, Buffer.from(rest, 'latin1')])
  const sum = createHash('sha1').update(withoutSum).digest('hex')
  return Buffer.concat([withoutSum, Buffer.from(`${sum}</fileChecksum>\n</indexedmzML>\n`, 'latin1')])
}

mkdirSync(join(fixtures, 'spectra'), { recursive: true })
writeFileSync(join(fixtures, 'spectra', 'OpenNuXL_1_input.indexed.mzML'), indexedMzml(readFileSync(join(example, 'OpenNuXL_1_input.mzML'), 'latin1')))
console.log('spectra/OpenNuXL_1_input.indexed.mzML')

//------------------------------------------------------------------------------
// The inputs that are not mzML

/** A Bruker timsTOF native ID of the example's spectrum n: frames of several precursors, mobility scans that repeat. */
const brukerId = (n) => `frame=${100 + Math.floor(n / 4)} scan=${200 + (n % 2)} precursor=${1001 + n}`
const thermoId = (n) => `controllerType=0 controllerNumber=1 scan=${n + 1}`

/**
 * The example's mzML as FileConverter writes a timsTOF folder's MS2 spectra: the native IDs `id(n)`, the spectra in
 * reverse order (their `index` another than in the input), indexedmzML with zlib-compressed arrays.
 */
function convertedMzml(id) {
  const text = readFileSync(join(example, 'OpenNuXL_1_input.mzML'), 'latin1')
  const start = text.indexOf('<spectrum ')
  const end = text.lastIndexOf('</spectrum>') + '</spectrum>'.length
  const spectra = text.slice(start, end).match(/<spectrum [\s\S]*?<\/spectrum>/g)
  const reversed = spectra
    .reverse()
    .map((s, k) => s.replace(/<spectrum id="spectrum=(\d+)" index="\d+"/, (_, n) => `<spectrum id="${id(Number(n))}" index="${k}"`))
    .join('\n\t\t\t')
  return indexedMzml(text.slice(0, start) + reversed + text.slice(end))
}

/** The example's id `spectrum=N` of a native ID `id(n)` (the inverse of brukerId, thermoId). */
const exampleIdOf = (id) => {
  const n = /precursor=(\d+)/.exec(id)?.[1]
  if (n !== undefined) return `spectrum=${Number(n) - 1001}`
  return `spectrum=${Number(/scan=(\d+)$/.exec(id)[1]) - 1}`
}
const bruker = renamed(six, brukerId)
writeFolder(
  'vendor',
  [input(0, 'run.d'), input(1, 'thermo.raw')],
  [
    withView({ ...bruker, outputs: { notes: [TOO_FEW] } }, '1__run', exampleIdOf),
    {
      ...renamed(one, thermoId),
      outputs: {
        notes: [TOO_FEW, 'The PSM view shows the annotated peaks only: the spectra of thermo.raw could not be kept (the spectra of 2__thermo.raw cannot be read (no such file)).'],
        mz: null,
      },
    },
  ],
)
writeFolder(
  'legacy',
  [input(0, 'run.d'), input(1, 'thermo.raw')],
  [
    { ...renamed(six, brukerId), spectra: convertedMzml(brukerId), outputs: { notes: [TOO_FEW], spectra: 'nuxl/1__run.spectra.mzML' } },
    {
      ...renamed(one, thermoId),
      outputs: {
        notes: [TOO_FEW, 'The PSM view shows the annotated peaks only: the spectra of thermo.raw could not be converted (FileConverter ended with exit code 1).'],
        spectra: null,
      },
    },
  ],
)
