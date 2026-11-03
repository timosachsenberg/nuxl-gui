// A reader of OpenMS' idXML as OpenNuXL writes it (IdXMLFile::store, OpenMS src/openms/source/FORMAT/IdXMLFile.cpp),
// for files of hundreds of MB in the webview: no DOM, no object per tag, a small hand-written scanner over the decoded
// text, chunk by chunk. idXML has no text content worth keeping, only elements with attributes, so the scanner sees
// tags only: an open tag with its attributes, a close tag, or both (`<UserParam .../>`). The results are column-wise:
// typed arrays and string arrays per field, the UserParams of the hits and identifications as one column per name.
//
// What is read:
// - SearchParameters: the attributes, Fixed/VariableModification, the UserParams (extra_features, the custom
//   modifications of modification_definitions: OpenNuXL's precursor adducts `NuXL:U-H3O4P1`, ...);
// - IdentificationRun and its ProteinIdentification (score type, the run's UserParams such as spectra_data);
// - ProteinHit: id, accession, score, sequence, target_decoy and Description;
// - PeptideIdentification: score_type, higher_score_better, MZ, RT, spectrum_reference, its UserParams;
// - PeptideHit: score, sequence, charge, the peptide evidences (protein_refs with aa_before, aa_after, start, end:
//   space-separated lists in the order of the references) and every UserParam.
//
// Anything else (old idXML's PeptideEvidence elements, protein groups as UserParams) is passed over.

/** The UserParams of a level, one column per name: numbers (int, float; NaN where a row has none) or text ('' where
 * a row has none; also the lists, as written: '[a, b]'). A name of both kinds is text. */
export type ParamColumns = Map<string, Float64Array | string[]>

/** A custom modification of the search (the SearchParameters UserParam `modification_definitions`). */
export interface ModificationDefinition {
  /** the modification's id as AASequence writes it, e.g. 'NuXL:U-H3O4P1' */
  id: string
  /** its full id, e.g. 'NuXL:U-H3O4P1 (K)' */
  fullId: string
  /** the residue it is defined for ('X': any) */
  origin: string
  /** the term specificity ('none', 'N-term', ...) */
  termSpecificity: string
  /** the difference formula, e.g. 'C9H10N2O5' */
  formula: string
  /** monoisotopic and average mass deltas (Da); NaN if not given */
  monoMass: number
  averageMass: number
}

export interface IdXMLSearchParameters {
  /** 'SP_0', ... (an IdentificationRun refers to it by search_parameters_ref) */
  id: string
  db: string
  dbVersion: string
  taxonomy: string
  massType: string
  charges: string
  /** as written, lower-case ('trypsin/p') */
  enzyme: string
  missedCleavages: number
  precursorTolerance: number
  precursorToleranceUnit: 'ppm' | 'Da'
  fragmentTolerance: number
  fragmentToleranceUnit: 'ppm' | 'Da'
  fixedModifications: string[]
  variableModifications: string[]
  /** the UserParams by name, as text */
  params: Map<string, string>
  /** the custom modifications (parsed modification_definitions); [] if none */
  modificationDefinitions: ModificationDefinition[]
  /** the extra_features UserParam (the features OpenNuXL hands to Percolator), split; [] if none */
  extraFeatures: string[]
}

export interface IdXMLRun {
  searchEngine: string
  searchEngineVersion: string
  date: string
  /** search_parameters_ref */
  searchParameters: string
  proteinScoreType: string
  /** the UserParams of the ProteinIdentification (e.g. spectra_data), as text */
  params: Map<string, string>
}

export interface IdXML {
  searchParameters: IdXMLSearchParameters[]
  runs: IdXMLRun[]
  proteins: {
    count: number
    /** 'PH_0', ... */
    id: string[]
    accession: string[]
    sequence: string[]
    score: Float64Array
    /** the target_decoy UserParam ('target', 'decoy', 'target+decoy'); '' if none */
    targetDecoy: string[]
    /** the Description UserParam; '' if none */
    description: string[]
    /** its run (index of runs) */
    run: Uint16Array
  }
  identifications: {
    count: number
    run: Uint16Array
    scoreType: string[]
    /** 1: higher_score_better */
    higherScoreBetter: Uint8Array
    /** NaN: none */
    mz: Float64Array
    /** seconds; NaN: none */
    rt: Float64Array
    /** the native ID of the spectrum; '' if none */
    spectrumReference: string[]
    /** the hits of identification i: hitOffsets[i] .. hitOffsets[i + 1] (count + 1 entries), in the file's order
     * (IdXMLFile writes them sorted, the best first) */
    hitOffsets: Uint32Array
    params: ParamColumns
  }
  hits: {
    count: number
    score: Float64Array
    /** AASequence::toString(), e.g. 'AEADNLDDK(NuXL:U-H3O4P1)K' */
    sequence: string[]
    charge: Int8Array
    /** the peptide evidences of hit h: evidenceOffsets[h] .. evidenceOffsets[h + 1] of the evidence columns */
    evidenceOffsets: Uint32Array
    /** row of proteins; −1: a reference to no ProteinHit of the file */
    protein: Int32Array
    /** 0-based first and last residue in the protein (OpenMS PeptideEvidence); −1: unknown */
    start: Int32Array
    end: Int32Array
    /** the residues before and after ('[' and ']' for the protein termini, as OpenMS writes them); '' unknown */
    aaBefore: string[]
    aaAfter: string[]
    params: ParamColumns
  }
}

export interface IdXMLOptions {
  /** read at most this many hits of each identification (the first ones, the best); default all */
  hitsPerIdentification?: number
}

//------------------------------------------------------------------------------
// Text

const ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(quot|apos|amp|lt|gt));/g
const NAMED: Record<string, string> = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }

/** An attribute value with its entities resolved (OpenMS writeXMLEscape writes &quot; &apos; &amp; &lt; &gt;). */
export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(ENTITY, (_, hex: string | undefined, dec: string | undefined, name: string | undefined) =>
    hex !== undefined ? String.fromCodePoint(parseInt(hex, 16)) : dec !== undefined ? String.fromCodePoint(Number(dec)) : NAMED[name!],
  )
}

/** A number as OpenMS writes it ('5.94e04', 'nan', 'inf', '-inf'); NaN if it is none. */
function toNumber(s: string | undefined): number {
  if (s === undefined || s === '') return NaN
  const n = Number(s)
  if (n === n) return n
  const lower = s.trim().toLowerCase()
  if (lower === 'inf' || lower === '+inf' || lower === 'infinity') return Infinity
  if (lower === '-inf' || lower === '-infinity') return -Infinity
  return NaN
}

const isSpace = (c: number) => c === 32 || c === 10 || c === 9 || c === 13

//------------------------------------------------------------------------------
// Columns

/** A UserParam column being read: numbers until a text value comes, then text. */
class Column {
  text = false
  values: (number | string)[] = []

  set(row: number, value: string, numeric: boolean): void {
    const v: number | string = numeric && !this.text ? toNumber(value) : value
    if (!numeric && !this.text) {
      // (a name with numbers and text: the numbers as text, as OpenMS would print them)
      this.text = true
      for (let i = 0; i < this.values.length; i++) {
        const x = this.values[i]
        this.values[i] = typeof x === 'number' ? (x === x ? String(x) : '') : x
      }
    }
    const values = this.values
    while (values.length < row) values.push(this.text ? '' : NaN)
    if (values.length === row) values.push(v)
    else values[row] = v // the same name twice: the last
  }

  finish(rows: number): Float64Array | string[] {
    const values = this.values
    if (this.text) {
      const out = new Array<string>(rows)
      for (let i = 0; i < rows; i++) {
        const x = values[i]
        out[i] = x === undefined ? '' : typeof x === 'number' ? (x === x ? String(x) : '') : x
      }
      return out
    }
    const out = new Float64Array(rows).fill(NaN)
    for (let i = 0; i < values.length && i < rows; i++) out[i] = values[i] as number
    return out
  }
}

class Columns {
  readonly byName = new Map<string, Column>()
  set(name: string, row: number, value: string, numeric: boolean): void {
    let c = this.byName.get(name)
    if (!c) this.byName.set(name, (c = new Column()))
    c.set(row, value, numeric)
  }
  finish(rows: number): ParamColumns {
    const out: ParamColumns = new Map()
    for (const [name, c] of this.byName) out.set(name, c.finish(rows))
    return out
  }
}

/** The numbers of the UserParam `name` (NaN where a row has none, or where it is text that is no number). */
export function numberColumn(params: ParamColumns, name: string, rows: number): Float64Array {
  const c = params.get(name)
  if (!c) return new Float64Array(rows).fill(NaN)
  if (c instanceof Float64Array) return c
  return Float64Array.from(c, (s) => toNumber(s))
}

/** The text of the UserParam `name` ('' where a row has none). */
export function textColumn(params: ParamColumns, name: string, rows: number): string[] {
  const c = params.get(name)
  if (!c) return new Array<string>(rows).fill('')
  if (Array.isArray(c)) return c
  return Array.from(c, (x) => (x === x ? String(x) : ''))
}

//------------------------------------------------------------------------------
// Search parameters

/**
 * The custom modifications of `modification_definitions`: entries separated by ';', each of the fields
 * '<user-defined>|<id>|<full id>|<unimod>|<origin>|<term specificity>|<diff formula>|<mono mass>|<average mass>|'.
 */
export function parseModificationDefinitions(value: string): ModificationDefinition[] {
  const out: ModificationDefinition[] = []
  for (const entry of value.split(';')) {
    if (entry.trim() === '') continue
    const f = entry.split('|')
    if (f.length < 8 || f[1] === '') continue
    out.push({
      id: f[1],
      fullId: f[2] ?? f[1],
      origin: f[4] ?? '',
      termSpecificity: f[5] ?? '',
      formula: f[6] ?? '',
      monoMass: toNumber(f[7]),
      averageMass: toNumber(f[8]),
    })
  }
  return out
}

const unit = (ppm: string | undefined): 'ppm' | 'Da' => (ppm === 'true' ? 'ppm' : 'Da')

//------------------------------------------------------------------------------
// The scanner

/** Where the scanner is: what a UserParam belongs to. SkippedHit: a PeptideHit beyond hitsPerIdentification, whose
 * UserParams are passed over. */
const At = { Nothing: 0, SearchParameters: 1, ProteinIdentification: 2, ProteinHit: 3, PeptideIdentification: 4, PeptideHit: 5, SkippedHit: 6 } as const
type At = (typeof At)[keyof typeof At]

/** Bytes decoded per step: the text of one step is at most this long (plus a tag cut at its end). */
const CHUNK = 8 << 20

/**
 * Reads an idXML file. Throws if it is not idXML (no IdXML element) or ends inside an element (a truncated file);
 * the message does not name the file (the caller's does).
 */
export function readIdXML(bytes: Uint8Array, options: IdXMLOptions = {}): IdXML {
  const maxHits = options.hitsPerIdentification ?? Infinity

  const searchParameters: IdXMLSearchParameters[] = []
  const runs: IdXMLRun[] = []
  const pr = {
    id: [] as string[],
    accession: [] as string[],
    sequence: [] as string[],
    score: [] as number[],
    targetDecoy: [] as string[],
    description: [] as string[],
    run: [] as number[],
  }
  const pi = {
    run: [] as number[],
    scoreType: [] as string[],
    higher: [] as number[],
    mz: [] as number[],
    rt: [] as number[],
    reference: [] as string[],
    hitOffsets: [0] as number[],
    params: new Columns(),
  }
  const ph = {
    score: [] as number[],
    sequence: [] as string[],
    charge: [] as number[],
    evidenceOffsets: [0] as number[],
    proteinRef: [] as string[],
    start: [] as number[],
    end: [] as number[],
    aaBefore: [] as string[],
    aaAfter: [] as string[],
    params: new Columns(),
  }

  // the attributes of the current tag: names[k], values[k] for k < nAttrs (reused; the values are unescaped)
  const names: string[] = []
  const values: string[] = []
  let nAttrs = 0
  const attr = (name: string): string | undefined => {
    for (let k = 0; k < nAttrs; k++) if (names[k] === name) return values[k]
    return undefined
  }

  let at: At = At.Nothing
  let sp: IdXMLSearchParameters | null = null
  let run: IdXMLRun | null = null
  let sawRoot = false
  let hitsHere = 0
  /** the element the file must not end in, for the error of a truncated file */
  const open: string[] = []

  const list = (name: string) => {
    const v = attr(name)
    return v === undefined || v === '' ? [] : v.split(' ')
  }

  const onOpen = (tag: string, selfClosing: boolean) => {
    switch (tag) {
      case 'UserParam': {
        const name = attr('name')
        if (name === undefined) return
        const value = attr('value') ?? ''
        const type = attr('type') ?? 'string'
        const numeric = type === 'int' || type === 'float' || type === 'double'
        switch (at) {
          case At.PeptideHit:
            ph.params.set(name, ph.score.length - 1, value, numeric)
            break
          case At.PeptideIdentification:
            pi.params.set(name, pi.scoreType.length - 1, value, numeric)
            break
          case At.ProteinHit:
            if (name === 'target_decoy') pr.targetDecoy[pr.targetDecoy.length - 1] = value
            else if (name === 'Description') pr.description[pr.description.length - 1] = value
            break
          case At.ProteinIdentification:
            run?.params.set(name, value)
            break
          case At.SearchParameters:
            sp?.params.set(name, value)
            break
        }
        return
      }
      case 'PeptideHit': {
        if (at !== At.PeptideIdentification) return
        if (hitsHere >= maxHits) {
          if (!selfClosing) at = At.SkippedHit
          return
        }
        hitsHere++
        ph.score.push(toNumber(attr('score')))
        ph.sequence.push(attr('sequence') ?? '')
        ph.charge.push(Math.max(-128, Math.min(127, Math.round(toNumber(attr('charge')) || 0))))
        const refs = list('protein_refs')
        const before = list('aa_before')
        const after = list('aa_after')
        const starts = list('start')
        const ends = list('end')
        for (let e = 0; e < refs.length; e++) {
          ph.proteinRef.push(refs[e])
          ph.aaBefore.push(before[e] ?? '')
          ph.aaAfter.push(after[e] ?? '')
          const s = toNumber(starts[e])
          const t = toNumber(ends[e])
          ph.start.push(s === s ? s : -1)
          ph.end.push(t === t ? t : -1)
        }
        ph.evidenceOffsets.push(ph.proteinRef.length)
        if (!selfClosing) at = At.PeptideHit
        return
      }
      case 'PeptideIdentification': {
        pi.run.push(Math.max(0, runs.length - 1))
        pi.scoreType.push(attr('score_type') ?? '')
        pi.higher.push(attr('higher_score_better') === 'false' ? 0 : 1)
        pi.mz.push(toNumber(attr('MZ')))
        pi.rt.push(toNumber(attr('RT')))
        pi.reference.push(attr('spectrum_reference') ?? '')
        hitsHere = 0
        if (selfClosing) pi.hitOffsets.push(ph.score.length)
        else {
          at = At.PeptideIdentification
          open.push(tag)
        }
        return
      }
      case 'ProteinHit': {
        pr.id.push(attr('id') ?? '')
        pr.accession.push(attr('accession') ?? '')
        pr.sequence.push(attr('sequence') ?? '')
        pr.score.push(toNumber(attr('score')))
        pr.targetDecoy.push('')
        pr.description.push('')
        pr.run.push(Math.max(0, runs.length - 1))
        if (!selfClosing) at = At.ProteinHit
        return
      }
      case 'ProteinIdentification':
        if (run) run.proteinScoreType = attr('score_type') ?? ''
        if (!selfClosing) at = At.ProteinIdentification
        return
      case 'IdentificationRun':
        run = {
          searchEngine: attr('search_engine') ?? '',
          searchEngineVersion: attr('search_engine_version') ?? '',
          date: attr('date') ?? '',
          searchParameters: attr('search_parameters_ref') ?? '',
          proteinScoreType: '',
          params: new Map(),
        }
        runs.push(run)
        return
      case 'SearchParameters':
        sp = {
          id: attr('id') ?? '',
          db: attr('db') ?? '',
          dbVersion: attr('db_version') ?? '',
          taxonomy: attr('taxonomy') ?? '',
          massType: attr('mass_type') ?? '',
          charges: attr('charges') ?? '',
          enzyme: attr('enzyme') ?? '',
          missedCleavages: toNumber(attr('missed_cleavages')),
          precursorTolerance: toNumber(attr('precursor_peak_tolerance')),
          precursorToleranceUnit: unit(attr('precursor_peak_tolerance_ppm')),
          fragmentTolerance: toNumber(attr('peak_mass_tolerance')),
          fragmentToleranceUnit: unit(attr('peak_mass_tolerance_ppm')),
          fixedModifications: [],
          variableModifications: [],
          params: new Map(),
          modificationDefinitions: [],
          extraFeatures: [],
        }
        searchParameters.push(sp)
        if (!selfClosing) at = At.SearchParameters
        return
      case 'FixedModification':
        if (at === At.SearchParameters) sp?.fixedModifications.push(attr('name') ?? '')
        return
      case 'VariableModification':
        if (at === At.SearchParameters) sp?.variableModifications.push(attr('name') ?? '')
        return
      case 'IdXML':
        sawRoot = true
        if (!selfClosing) open.push(tag)
        return
    }
  }

  const onClose = (tag: string) => {
    switch (tag) {
      case 'PeptideHit':
        if (at === At.PeptideHit || at === At.SkippedHit) at = At.PeptideIdentification
        return
      case 'PeptideIdentification':
        pi.hitOffsets.push(ph.score.length)
        at = At.Nothing
        open.pop()
        return
      case 'ProteinHit':
        at = At.ProteinIdentification
        return
      case 'ProteinIdentification':
      case 'SearchParameters':
        at = At.Nothing
        return
      case 'IdXML':
        open.pop()
        return
    }
  }

  /** Scans the tags of `text`; returns where the tag starts that the text ends in (the rest, for the next step), or
   * text.length. */
  const scan = (text: string): number => {
    let i = 0
    const n = text.length
    while (true) {
      const lt = text.indexOf('<', i)
      if (lt < 0) return n
      let p = lt + 1
      if (p >= n) return lt
      const c = text.charCodeAt(p)
      if (c === 33 /* ! */) {
        // a comment, CDATA or DOCTYPE: to its end
        const end = text.startsWith('<!--', lt) ? text.indexOf('-->', p) : text.indexOf('>', p)
        if (end < 0) return lt
        i = end + (text.startsWith('<!--', lt) ? 3 : 1)
        continue
      }
      if (c === 63 /* ? */) {
        const end = text.indexOf('?>', p)
        if (end < 0) return lt
        i = end + 2
        continue
      }
      const closing = c === 47 /* / */
      if (closing) p++
      // the tag name
      const nameStart = p
      while (p < n) {
        const d = text.charCodeAt(p)
        if (isSpace(d) || d === 62 /* > */ || d === 47 /* / */) break
        p++
      }
      if (p >= n) return lt
      const tag = text.slice(nameStart, p)
      if (closing) {
        const end = text.indexOf('>', p)
        if (end < 0) return lt
        onClose(tag)
        i = end + 1
        continue
      }
      // the attributes: name = "value" (or 'value'); a '>' in a value is no end
      nAttrs = 0
      let selfClosing = false
      let complete = false
      while (p < n) {
        let d = text.charCodeAt(p)
        if (isSpace(d)) {
          p++
          continue
        }
        if (d === 62 /* > */) {
          complete = true
          p++
          break
        }
        if (d === 47 /* / */) {
          if (p + 1 >= n) break
          selfClosing = true
          p++
          continue
        }
        const attrStart = p
        while (p < n) {
          d = text.charCodeAt(p)
          if (d === 61 /* = */ || isSpace(d) || d === 62) break
          p++
        }
        const name = text.slice(attrStart, p)
        while (p < n && isSpace(text.charCodeAt(p))) p++
        if (p >= n) break
        if (text.charCodeAt(p) !== 61) {
          // an attribute without value (not XML): passed over
          continue
        }
        p++
        while (p < n && isSpace(text.charCodeAt(p))) p++
        if (p >= n) break
        const quote = text[p]
        if (quote !== '"' && quote !== "'") throw new Error(`an attribute of <${tag}> without quotes at character ${p}`)
        const close = text.indexOf(quote, p + 1)
        if (close < 0) break
        names[nAttrs] = name
        values[nAttrs] = unescapeXml(text.slice(p + 1, close))
        nAttrs++
        p = close + 1
      }
      if (!complete) return lt
      onOpen(tag, selfClosing)
      i = p
    }
  }

  const decoder = new TextDecoder('utf-8')
  let carry = ''
  for (let from = 0; from < bytes.length; from += CHUNK) {
    const text = carry + decoder.decode(bytes.subarray(from, Math.min(bytes.length, from + CHUNK)), { stream: true })
    const rest = scan(text)
    carry = text.slice(rest)
  }
  const last = carry + decoder.decode()
  if (last !== '') {
    const rest = scan(last)
    if (last.slice(rest).trim() !== '') throw new Error('the file ends inside a tag (is it complete?)')
  }
  if (!sawRoot) throw new Error('it is not an idXML file (no IdXML element)')
  if (open.length > 0) throw new Error(`the file ends inside <${open[open.length - 1]}> (is it complete?)`)

  for (const s of searchParameters) {
    s.modificationDefinitions = parseModificationDefinitions(s.params.get('modification_definitions') ?? '')
    s.extraFeatures = (s.params.get('extra_features') ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter((f) => f !== '')
  }

  // the protein references: 'PH_<n>' are the ids of the file's ProteinHits (numbered over all runs)
  const proteinIndex = new Map<string, number>()
  pr.id.forEach((id, k) => {
    if (!proteinIndex.has(id)) proteinIndex.set(id, k)
  })
  const nIds = pi.scoreType.length
  const nHits = ph.score.length
  return {
    searchParameters,
    runs,
    proteins: {
      count: pr.id.length,
      id: pr.id,
      accession: pr.accession,
      sequence: pr.sequence,
      score: Float64Array.from(pr.score),
      targetDecoy: pr.targetDecoy,
      description: pr.description,
      run: Uint16Array.from(pr.run),
    },
    identifications: {
      count: nIds,
      run: Uint16Array.from(pi.run),
      scoreType: pi.scoreType,
      higherScoreBetter: Uint8Array.from(pi.higher),
      mz: Float64Array.from(pi.mz),
      rt: Float64Array.from(pi.rt),
      spectrumReference: pi.reference,
      hitOffsets: Uint32Array.from(pi.hitOffsets),
      params: pi.params.finish(nIds),
    },
    hits: {
      count: nHits,
      score: Float64Array.from(ph.score),
      sequence: ph.sequence,
      charge: Int8Array.from(ph.charge),
      evidenceOffsets: Uint32Array.from(ph.evidenceOffsets),
      protein: Int32Array.from(ph.proteinRef, (id) => proteinIndex.get(id) ?? -1),
      start: Int32Array.from(ph.start),
      end: Int32Array.from(ph.end),
      aaBefore: ph.aaBefore,
      aaAfter: ph.aaAfter,
      params: ph.params.finish(nHits),
    },
  }
}
