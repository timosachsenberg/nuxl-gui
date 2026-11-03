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
// `all` of outputs.json names OpenNuXL's -out, which is not kept (the reader never reads it).
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
// And spectra/OpenNuXL_1_input.indexed.mzML: the example's mzML as an indexedmzML, its arrays zlib-compressed (the
// reader's spectrum load by the index; the plain file is read by scanning).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

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
  return { id: `f${index}`, index, link, stem: link.replace(/\.mzML$/i, ''), name, path: `/data/${name}` }
}

function outputs(stem, index, { percolator = false, notes = [], seconds = 1.5 } = {}) {
  return {
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
  }
  console.log(`${name}: ${records.length} input(s)`)
}

/** The identifications of OpenNuXL_6 whose top hit the example takes to be their best one without adduct. */
const LINEAR = new Set([2, 6, 10, 11, 13, 17])
const six = filtered(SOURCE(6), LINEAR)
const one = filtered(SOURCE(1))
console.log('OpenNuXL_6:', six.counts, 'OpenNuXL_1:', one.counts)

writeFolder('example', [input(0, 'OpenNuXL_1_input.mzML')], [{ ...six, outputs: { notes: [TOO_FEW] } }])
writeFolder(
  'runs',
  [input(0, 'OpenNuXL_1_input.mzML'), input(1, 'no_decoys.mzML'), input(2, 'unfinished.mzML')],
  [{ ...six, outputs: { notes: [TOO_FEW] } }, { ...one, outputs: { notes: [TOO_FEW], seconds: 2.5 } }, null],
)
const three = filtered(SOURCE(3))
console.log('OpenNuXL_3:', three.counts)
writeFolder('screens', [input(0, 'OpenNuXL_1_input.mzML')], [{ ...three, outputs: { notes: [TOO_FEW] } }])
const nothing = withoutIds(SOURCE(6))
writeFolder('empty', [input(0, 'a.mzML'), input(1, 'b.mzML')], [
  { xls: nothing, peptides: nothing, outputs: { notes: [TOO_FEW] } },
  { xls: nothing, peptides: nothing, outputs: { notes: [TOO_FEW] } },
])

//------------------------------------------------------------------------------
// The indexed mzML

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
