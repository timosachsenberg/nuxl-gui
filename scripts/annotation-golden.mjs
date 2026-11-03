// Exports the golden fragment annotations (src/lib/psm/fixtures/annotations.json) that the TypeScript
// annotatePeaks (src/lib/psm/annotate.ts) is compared with: the web app's `annotatePeaks` of its
// 32-bit WebAssembly module in Node.js, called as the PSM view calls it (prose-pages
// app/src/lib/psm/psm.ts `annotationOptions`, `precursorOptions`) and with other option sets.
//
//   node scripts/annotation-golden.mjs <wasm32 package>
//
// The spectra: PSMs of the results reader's fixtures (src/lib/results/fixtures/web-<case>.json, the
// web app's stored peaks; the test reads the same PSMs with readSearch from fixtures/<case>/), and a few
// spectra made here from them (written into the file): peaks in another order, duplicate peaks and
// peaks next to the fragment ions, for the tie rules of the matching; peaks given as doubles
// (`float64`, passed as plain arrays) for its float precision. The peptides: the PSMs' own and
// variants with modifications (the example has none): Oxidation, Carbamidomethyl, N-terminal Acetyl,
// Phospho, TMT6plex, Deamidated, C-terminal Amidated, Gln->pyro-Glu.
//
// The results are written as tuples: a match [peak, ion, type, ordinal, charge, loss, theoreticalMz,
// errorPpm], a theoretical ion [ion, type, ordinal, charge, mz]; an annotation that throws as
// { error: message }.

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [pkg] = process.argv.slice(2)
if (!pkg) {
  console.error('usage: node scripts/annotation-golden.mjs <wasm32 package>')
  process.exit(2)
}
const out = process.env.OUT ?? new URL('../src/lib/psm/fixtures/annotations.json', import.meta.url).pathname
const fixtures = new URL('../src/lib/results/fixtures/', import.meta.url).pathname

const { default: createOpenMS } = await import(pathToFileURL(join(resolve(pkg), 'openms.mjs')).href)
const OpenMS = await createOpenMS({ numThreads: 1, print: () => {}, printErr: () => {} })
const version = JSON.parse(readFileSync(join(resolve(pkg), 'package.json'), 'utf8')).version

const web = (name) => JSON.parse(readFileSync(join(fixtures, `web-${name}.json`), 'utf8'))
// (the web app's example: the reader's fixture `suitability`; its cases keep the name "example")
const results = { suitability: web('suitability'), mods: web('mods') }

/** The stored peaks of PSM `row` of fixture `fixture` (as float32 values), its peptide and charge. */
function psm(fixture, row) {
  const { tables, spectra } = results[fixture]
  const s = spectra.psmSpectrum[row]
  if (!(s >= 0)) throw new Error(`${fixture} row ${row} has no spectrum`)
  const [from, to] = [spectra.offsets[s], spectra.offsets[s + 1]]
  return {
    mz: Array.from(new Float32Array(spectra.mz.slice(from, to))),
    intensity: Array.from(new Float32Array(spectra.intensity.slice(from, to))),
    peptide: tables.peptides.openms[tables.psms.peptide[row]],
    charge: tables.psms.charge[row],
  }
}

const f32 = (x) => Math.fround(x)

/** The annotation as tuples, or the error it throws. */
function annotate(mz, intensity, peptide, charge, options, float64 = false) {
  try {
    const r = float64
      ? OpenMS.annotatePeaks(mz, intensity, peptide, charge, options)
      : OpenMS.annotatePeaks(new Float32Array(mz), new Float32Array(intensity), peptide, charge, options)
    return {
      matches: r.matches.map((m) => [m.peak, m.ion, m.type, m.ordinal, m.charge, m.loss, m.theoreticalMz, m.errorPpm]),
      theoretical: r.theoretical.map((t) => [t.ion, t.type, t.ordinal, t.charge, t.mz]),
    }
  } catch (e) {
    const message = typeof e === 'object' && e !== null && 'message' in e ? String(e.message) : String(e)
    return { error: message }
  }
}

// The option sets: the PSM view's (annotationOptions: the search's fragment tolerance, maxCharge 1 or 2,
// the ion toggles, losses on or off, no precursor; precursorOptions: no fragments, the precursor at its
// charge with its losses) and others (Da, all ion types, maxCharge 3, the defaults).
const view = (tolerance, unit, maxCharge, ions, losses) => ({ tolerance, unit, maxCharge, ions, losses, precursor: false })
const OPTION_SETS = [
  view(20, 'ppm', 1, ['b', 'y'], false),
  view(20, 'ppm', 2, ['b', 'y'], true),
  view(0.02, 'Da', 1, ['b', 'y'], false),
  view(0.05, 'Da', 2, ['a', 'b', 'y'], true),
  { tolerance: 10, unit: 'ppm', maxCharge: 3, ions: ['a', 'b', 'c', 'x', 'y', 'z'], losses: true, precursor: true },
  { tolerance: 0.5, unit: 'Da', maxCharge: 1, ions: ['c', 'z'], losses: false, precursor: false },
  { tolerance: 0.02, unit: 'Da', maxCharge: 3, ions: ['x', 'y', 'z'], losses: true, precursor: true },
  { tolerance: 50, unit: 'ppm', maxCharge: 2, ions: ['b', 'y'], losses: true, precursor: true },
  { tolerance: 0.1, unit: 'Da', maxCharge: 2, ions: ['b', 'y'], losses: true },
  null,
]
const precursorOptions = (tolerance, unit, charge) => ({ tolerance, unit, maxCharge: Math.max(1, charge), ions: [], losses: true, precursor: true })

const cases = []
let target = cases
const add = (name, spectrum, peaks, peptide, charge, options) =>
  target.push({ name, spectrum, peptide, charge, options, result: annotate(peaks.mz, peaks.intensity, peptide, charge, options, peaks.float64) })

// A: 50 PSMs of the example, evenly over its rows, each with two option sets (in turn) and, every
// fifth, the PSM view's precursor annotation
const example = results.suitability.tables.psms.count
const rows = Array.from({ length: 50 }, (_, i) => Math.floor((i * example) / 50))
rows.forEach((row, i) => {
  const p = psm('suitability', row)
  const ref = { fixture: 'suitability', row, peaks: p.mz.length }
  for (const k of [(2 * i) % OPTION_SETS.length, (2 * i + 1) % OPTION_SETS.length]) {
    add(`example ${row} options ${k}`, ref, p, p.peptide, p.charge, OPTION_SETS[k])
  }
  if (i % 5 === 0) add(`example ${row} precursor`, ref, p, p.peptide, p.charge, precursorOptions(20, 'ppm', p.charge))
})

// B: modified variants of the example's peptides (on the PSMs' peaks)
/** The peptide with `mod` (OpenMS spelling) after the first residue of `residues`, or null. */
function withResidueMod(peptide, residues, mod) {
  const at = [...peptide].findIndex((c) => residues.includes(c))
  return at < 0 ? null : `${peptide.slice(0, at + 1)}(${mod})${peptide.slice(at + 1)}`
}
const VARIANTS = [
  (s) => withResidueMod(s, 'M', 'Oxidation'),
  (s) => withResidueMod(s, 'ST', 'Phospho'),
  (s) => withResidueMod(s, 'Y', 'Phospho'),
  (s) => `.(Acetyl)${s}`,
  (s) => (s.includes('K') ? `.(TMT6plex)${s.replaceAll('K', 'K(TMT6plex)')}` : null),
  (s) => withResidueMod(s, 'NQ', 'Deamidated'),
  // the example has no cysteine: one in place of the second residue
  (s) => `${s[0]}C(Carbamidomethyl)${s.slice(2)}`,
  (s) => `${s}.(Amidated)`,
  (s) => (s[0] === 'Q' ? `.(Gln->pyro-Glu)${s}` : `.(Gln->pyro-Glu)Q${s.slice(1)}`),
  (s) => {
    const ox = withResidueMod(s, 'M', 'Oxidation') ?? s
    const ph = withResidueMod(ox, 'ST', 'Phospho')
    return ph === null ? null : `.(Acetyl)${ph}`
  },
]
const VARIANT_OPTIONS = [OPTION_SETS[1], OPTION_SETS[3], OPTION_SETS[4], OPTION_SETS[6], OPTION_SETS[7]]
let variants = 0
for (let v = 0; v < VARIANTS.length; v++) {
  let made = 0
  for (let i = 0; i < rows.length && made < 3; i++) {
    const row = rows[(i * 7 + v * 3) % rows.length]
    const p = psm('suitability', row)
    const peptide = VARIANTS[v](p.peptide)
    if (peptide === null) continue
    const options = VARIANT_OPTIONS[(v + made) % VARIANT_OPTIONS.length]
    add(`example ${row} variant ${v}`, { fixture: 'suitability', row, peaks: p.mz.length }, p, peptide, p.charge, options)
    made++
    variants++
  }
}

// C: the PSMs of the mods fixture (measured spectra, charge 3, M(Oxidation)), with several option sets
const modsCount = results.mods.tables.psms.count
for (let row = 0; row < modsCount; row++) {
  const p = psm('mods', row)
  const ref = { fixture: 'mods', row, peaks: p.mz.length }
  for (const k of [0, 1, 3, 4, 5, 6, 8, 9]) add(`mods ${row} options ${k}`, ref, p, p.peptide, p.charge, OPTION_SETS[k])
  add(`mods ${row} precursor`, ref, p, p.peptide, p.charge, precursorOptions(0.1, 'Da', p.charge))
}

// D: spectra made for the tie rules, written into the file (as float32 values)
/** Peaks next to and on the ions of `peptide` (the spectrum `p` with them added), in shuffled order. */
function crowded(p, peptide, charge, seed) {
  const ions = OpenMS.annotatePeaks(new Float32Array(0), new Float32Array(0), peptide, charge, OPTION_SETS[4]).theoretical
  const mz = [...p.mz]
  const intensity = [...p.intensity]
  let state = seed
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648)
  ions.forEach((ion, k) => {
    if (k % 3 === 0) {
      // the same peak twice (equal m/z), and a peak on each side at equal distance
      const at = f32(ion.mz + 0.003)
      mz.push(at, at, f32(ion.mz - 0.004), f32(ion.mz + 0.004))
      intensity.push(10, 20, 5, 5)
    } else if (k % 3 === 1) {
      // peaks within 0.02 Da and 20 ppm, one closer than the other
      mz.push(f32(ion.mz + ion.mz * 6e-6), f32(ion.mz - ion.mz * 9e-6), f32(ion.mz + 0.015))
      intensity.push(7, 8, 9)
    }
  })
  // shuffled: the peaks as passed are not sorted
  const order = mz.map((_, i) => i)
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return { mz: order.map((i) => f32(mz[i])), intensity: order.map((i) => f32(intensity[i])) }
}
const embedded = []
const embed = (peaks) => {
  embedded.push(peaks)
  return { embedded: embedded.length - 1, peaks: peaks.mz.length }
}
for (const [fixture, row, peptide, seed] of [
  ['suitability', rows[3], null, 1],
  ['suitability', rows[17], null, 2],
  ['mods', 0, null, 3],
  ['mods', 1, null, 4],
]) {
  const p = psm(fixture, row)
  const pep = peptide ?? p.peptide
  const peaks = crowded(p, pep, p.charge, seed)
  const ref = embed(peaks)
  for (const k of [0, 1, 2, 3, 4, 5, 6, 7, 8]) add(`crowded ${fixture} ${row} options ${k}`, ref, peaks, pep, p.charge, OPTION_SETS[k])
}
// equal m/z in the arrays as passed: three copies of each peak, the arrays in reverse order
{
  const p = psm('suitability', rows[9])
  const mz = [...p.mz, ...p.mz, ...p.mz].reverse()
  const intensity = [...p.intensity, ...p.intensity.map((x) => x * 2), ...p.intensity.map((x) => x * 3)].reverse()
  const ref = embed({ mz, intensity })
  for (const k of [0, 1, 2, 3, 7]) add(`triplicate example ${rows[9]} options ${k}`, ref, { mz, intensity }, p.peptide, p.charge, OPTION_SETS[k])
}

// F: the float precision of the ppm matching (MatchedIterator compares the distances and the tolerance
// as float): two peaks on either side of an ion whose distances differ as doubles but not as floats
// (peaks given as doubles: the module takes any numbers), and tolerances at which the float comparison
// decides otherwise than a double one would
{
  const nextFloat = (x, k) => {
    const b = new Float32Array([x])
    const i = new Int32Array(b.buffer)
    i[0] += k
    return b[0]
  }
  const p = psm('suitability', rows[5])
  const ions = OpenMS.annotatePeaks(new Float32Array(0), new Float32Array(0), p.peptide, p.charge, OPTION_SETS[0]).theoretical
  const mz = []
  for (const ion of ions) {
    const m = ion.mz
    const d = 0.002
    const [low, high] = [m - d - 1e-13, m + d]
    // as floats a tie (the first, lower peak is taken), as doubles the higher one is closer
    if (f32(m - low) === f32(high - m) && m - low > high - m) mz.push(low, high)
  }
  if (mz.length < 6) throw new Error('too few float ties')
  const peaks = { mz, intensity: mz.map(() => 1), float64: true }
  const ref = embed(peaks)
  add(`float ties example ${rows[5]}`, ref, peaks, p.peptide, p.charge, OPTION_SETS[0])
  add(`float ties example ${rows[5]}, 10 ppm`, ref, peaks, p.peptide, p.charge, { ...OPTION_SETS[0], tolerance: 10 })

  // the tolerance at which an ion's peak is in as float but not as double, and the reverse
  const q = psm('mods', 0)
  const matched = OpenMS.annotatePeaks(new Float32Array(q.mz), new Float32Array(q.intensity), q.peptide, q.charge, OPTION_SETS[1]).matches
  const found = { in: 0, out: 0 }
  for (const match of matched) {
    const [m, observed] = [match.theoreticalMz, q.mz[match.peak]]
    const d = Math.abs(observed - m)
    const t0 = f32((d / m) * 1e6)
    for (let k = -40; k <= 40; k++) {
      const t = nextFloat(t0, k)
      const asFloat = f32(d) <= f32(f32(f32(t) / 1e6) * f32(m))
      const asDouble = d <= (t / 1e6) * m
      const kind = asFloat && !asDouble ? 'in' : !asFloat && asDouble ? 'out' : null
      if (kind && found[kind] < 2) {
        found[kind]++
        add(`tolerance boundary (${kind} as float) mods 0 ${match.ion}`, { fixture: 'mods', row: 0, peaks: q.mz.length }, q, q.peptide, q.charge, {
          ...OPTION_SETS[1],
          tolerance: t,
        })
      }
    }
  }
  if (found.in + found.out === 0) throw new Error('no tolerance boundary found')
}

// G: the band of the Da alignment (SpectrumAlignment narrows it from the left as it goes): a spectrum
// where narrowing it otherwise changes the alignment (found by a random search)
{
  const mz = [
    350.7199401855469, 529.218505859375, 209.65538024902344, 407.0260925292969, 209.66639709472656, 110.6314468383789,
    718.5663452148438, 405.8816833496094, 406.7156982421875, 631.12548828125, 269.0335998535156, 111.44466400146484,
    243.2423095703125, 932.4300537109375, 604.0435791015625, 243.5496063232422, 640.66552734375, 208.73538208007812,
    129.31629943847656, 424.2188415527344,
  ]
  const peaks = { mz, intensity: mz.map(() => 1) }
  const options = { tolerance: 0.3, unit: 'Da', maxCharge: 1, ions: ['a', 'b', 'c', 'x', 'y', 'z'], losses: true }
  add('band of the Da alignment', embed(peaks), peaks, 'QPVVYLK', 2, options)
}

// E: edge cases
{
  const p = psm('suitability', rows[0])
  const ref = { fixture: 'suitability', row: rows[0], peaks: p.mz.length }
  const none = embed({ mz: [], intensity: [] })
  add('no peaks', none, { mz: [], intensity: [] }, p.peptide, p.charge, OPTION_SETS[1])
  add('no peaks, defaults', none, { mz: [], intensity: [] }, p.peptide, 3, null)
  add('one residue', ref, p, 'K', 1, OPTION_SETS[4])
  add('one residue, b and y', ref, p, 'R', 2, { tolerance: 20, unit: 'ppm', maxCharge: 1, ions: ['b', 'y'], losses: true, precursor: true })
  add('two residues', ref, p, 'GK', 2, OPTION_SETS[4])
  add('maxCharge 0', ref, p, p.peptide, p.charge, { tolerance: 20, unit: 'ppm', maxCharge: 0 })
  add('precursor charge 4, defaults', ref, p, p.peptide, 4, null)
  add('precursor charge 1, defaults', ref, p, p.peptide, 1, null)
  add('options empty', ref, p, p.peptide, p.charge, {})
  add('no ions', ref, p, p.peptide, p.charge, { tolerance: 20, unit: 'ppm', ions: [] })
  add('arginine losses', ref, p, 'RRKDEST', 2, OPTION_SETS[4])
  add('selenocysteine and pyrrolysine', ref, p, 'GUOK', 2, OPTION_SETS[1])
  // a terminal modification written on the first residue (no residue has it): OpenMS takes it as N-terminal
  add('pyro-Glu on the first residue', ref, p, 'Q(Gln->pyro-Glu)QEAEIK', 2, OPTION_SETS[4])
  add('C-terminal and N-terminal modification', ref, p, '.(Acetyl)PEPTIDEK.(Amidated)', 2, OPTION_SETS[6])
  add('several modifications on one residue type', ref, p, 'M(Oxidation)AM(Oxidation)S(Phospho)T(Phospho)Y(Phospho)K', 3, OPTION_SETS[4])
  // errors
  add('charge 0', ref, p, p.peptide, 0, null)
  add('empty peptide', ref, p, '', 2, null)
  add('unknown ion type', ref, p, p.peptide, 2, { ions: ['b', 'q'] })
  add('unknown unit', ref, p, p.peptide, 2, { unit: 'Th' })
  add('unknown modification', ref, p, 'PEPT(Foo)IDE', 2, null)
  add('modification on a residue it does not apply to', ref, p, 'PEPTIDEM(Phospho)K', 2, null)
}

const json = {
  generator: 'scripts/annotation-golden.mjs',
  module: `@openms/openms-wasm-mt ${version} (wasm32)`,
  spectra: embedded,
  cases,
}
writeFileSync(out, JSON.stringify(json) + '\n')
const errors = cases.filter((c) => c.result.error !== undefined).length
console.log(`${cases.length} cases (${variants} modified variants, ${errors} errors), ${embedded.length} spectra written: ${out}`)

// M: modifications given by mass (src/lib/psm/fixtures/annotations-mass.json), as the reader writes those
// without a name ('M[+15.9949]', '.[+42.0106]PEPTIDE'; derive.ts openmsString) and other spellings
// AASequence reads: the module resolves them to the Unimod modification of that mass, else to a mass
// delta. No precursor peaks where the delta stays unresolved: their water and ammonia losses leave such
// a delta out in OpenMS (it is in no formula), and annotate.ts deliberately does not (see there).
const massCases = []
target = massCases
{
  const m = psm('mods', 1) // IALSRPNVEVVALNDPFITNDYAAYM(Oxidation)FK, charge 3
  const mRef = { fixture: 'mods', row: 1, peaks: m.mz.length }
  const mass = (peptide) => peptide.replace('M(Oxidation)', 'M[+15.9949]')
  for (const k of [1, 3, 4, 6]) add(`mods 1 mass-spelled Oxidation options ${k}`, mRef, m, mass(m.peptide), m.charge, OPTION_SETS[k])
  add('mods 1 Oxidation as residue mass', mRef, m, m.peptide.replace('M(Oxidation)', 'M[147.0354]'), m.charge, OPTION_SETS[4])
  add('mods 1 Oxidation as integer mass', mRef, m, m.peptide.replace('M(Oxidation)', 'M[+16]'), m.charge, OPTION_SETS[4])
  const p = psm('suitability', rows[2])
  const ref = { fixture: 'suitability', row: rows[2], peaks: p.mz.length }
  const seq = p.peptide
  const spelled = [
    ['N-terminal Acetyl by mass, dot notation', `.[+42.0106]${seq}`, true],
    ['N-terminal Acetyl by mass', `[+42.0106]${seq}`, true],
    ['N-terminal mass on the first residue', `${seq[0]}[+42.0106]${seq.slice(1)}`, true],
    ['C-terminal Amidated by mass', `${seq}.[-0.9840]`, true],
    ['Phospho by mass', withResidueMod(seq, 'ST', 'Phospho')?.replace('(Phospho)', '[+79.9663]'), true],
    ['Carbamidomethyl by mass', `${seq[0]}C[+57.0215]${seq.slice(2)}`, true],
    ['TMT6plex by mass', `.[+229.1629]${seq.replaceAll('K', 'K[+229.1629]')}`, true],
    // two Unimod entries of this mass for K, Trimethyl (with the loss C3H9N) before Propyl (without): the first
    ['isobaric Trimethyl and Propyl by mass', `${seq.slice(0, 3)}K[+42.0470]${seq.slice(3)}`, true],
    ['unknown mass on a residue', `${seq.slice(0, 3)}[+123.4567]${seq.slice(3)}`, false],
    ['unknown mass on the last residue', `${seq}[+123.4567]`, false],
    ['unknown N-terminal mass', `.[+100.1234]${seq}`, false],
    ['unknown C-terminal mass', `${seq}.[+100.1234]`, false],
    ['negative unknown mass', `${seq.slice(0, 2)}[-3.21]${seq.slice(2)}`, false],
  ]
  for (const [name, peptide, resolved] of spelled) {
    if (!peptide) continue
    for (const k of resolved ? [1, 4, 6] : [1, 3, 8]) add(`${name} options ${k}`, ref, p, peptide, p.charge, OPTION_SETS[k])
  }
}
const massOut = process.env.OUT_MASS ?? new URL('../src/lib/psm/fixtures/annotations-mass.json', import.meta.url).pathname
writeFileSync(massOut, JSON.stringify({ generator: json.generator, module: json.module, spectra: [], cases: massCases }) + '\n')
console.log(`${massCases.length} cases of modifications given by mass written: ${massOut}`)
