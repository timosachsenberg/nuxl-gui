/// <reference types="node" />
// The idXML reader on OpenNuXL's own outputs (fixtures/nuxl: OpenMS' OpenNuXL_6 and OpenNuXL_1 test outputs) and on
// hand-written files for the corners of the format.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { numberColumn, parseModificationDefinitions, readIdXML, textColumn, unescapeXml } from './idxml'

const source = (n: number) => readFileSync(join(__dirname, 'fixtures/nuxl', `OpenNuXL_${n}_output.idXML`))
const utf8 = new TextEncoder()
const idxml = (body: string) => utf8.encode(`<?xml version="1.0" encoding="UTF-8"?>\n<IdXML version="1.5">\n${body}\n</IdXML>\n`)

describe('readIdXML: OpenNuXL_6_output.idXML', () => {
  const x = readIdXML(new Uint8Array(source(6)))

  test('the search parameters, the custom adduct modifications, the extra features', () => {
    expect(x.searchParameters).toHaveLength(1)
    const sp = x.searchParameters[0]
    expect(sp).toMatchObject({
      id: 'SP_0',
      massType: 'monoisotopic',
      charges: '2:5',
      enzyme: 'trypsin/p',
      missedCleavages: 2,
      precursorTolerance: 1000000000,
      precursorToleranceUnit: 'ppm',
      fragmentTolerance: 20,
      fragmentToleranceUnit: 'ppm',
      fixedModifications: [],
      variableModifications: ['Oxidation (M)'],
    })
    expect(sp.params.get('PeptideIndexer:decoy_string')).toBe('DECOY_')
    expect(sp.modificationDefinitions).toHaveLength(21)
    expect(sp.modificationDefinitions[8]).toEqual({
      id: 'NuXL:U-H3O4P1',
      fullId: 'NuXL:U-H3O4P1 (A)',
      origin: 'A',
      termSpecificity: 'none',
      formula: 'C9H10N2O5',
      monoMass: 226.05897331900002,
      averageMass: 226.18654341716035,
    })
    expect(sp.extraFeatures).toHaveLength(43)
    expect(sp.extraFeatures).toContain('NuXL:score')
  })

  test('the run, its proteins with target_decoy and Description', () => {
    expect(x.runs).toEqual([
      {
        searchEngine: 'OpenNuXL',
        searchEngineVersion: '3.5.0-pre-feature-NuXL-2025-06-24',
        date: '2025-06-25T09:54:41',
        searchParameters: 'SP_0',
        proteinScoreType: '',
        params: new Map([['spectra_data', '[file://OpenNuXL_1_input.mzML]']]),
      },
    ])
    expect(x.proteins.accession).toEqual(['Cas7', 'Cse2', 'Cas6e', 'Cas5', 'DECOY_Cse1', 'Cse1'])
    expect(x.proteins.id).toEqual(['PH_0', 'PH_1', 'PH_2', 'PH_3', 'PH_4', 'PH_5'])
    expect(x.proteins.targetDecoy).toEqual(['target', 'target', 'target', 'target', 'decoy', 'target'])
    expect(x.proteins.description).toEqual(['', '', '', '', '', ''])
    expect(x.proteins.sequence[0].startsWith('MSNFINIHV')).toBe(true)
  })

  test('the identifications and their hits, column-wise; the evidences', () => {
    const { identifications: ids, hits } = x
    expect(ids.count).toBe(20)
    expect([ids.scoreType[0], ids.higherScoreBetter[0], ids.mz[0], ids.rt[0], ids.spectrumReference[0]]).toEqual(['NuXLScore', 1, 712.782836914062955, 17.7875061035156, 'spectrum=9'])
    expect(ids.hitOffsets.length).toBe(21)
    expect(hits.count).toBe(78)
    expect(ids.hitOffsets[20]).toBe(78)
    expect(hits.sequence.slice(0, 3)).toEqual(['AEADNLDDK(NuXL:U-H3O4P1)K', 'AEADNLDDK(NuXL:U-H2O1)K', 'AEADNLDDK'])
    expect([hits.score[0], hits.charge[0]]).toEqual([66.026290893554688, 2])
    // one evidence each: Cas7, 0-based 128 .. 137 (inclusive)
    expect([hits.evidenceOffsets[0], hits.evidenceOffsets[1], hits.protein[0], hits.start[0], hits.end[0], hits.aaBefore[0], hits.aaAfter[0]]).toEqual([0, 1, 0, 128, 137, 'K', 'L'])
    // the UserParams: numbers as numbers, text as text (the fragment annotation with its entities resolved)
    expect(numberColumn(hits.params, 'NuXL:score', hits.count)[0]).toBe(66.026290893554688)
    expect(numberColumn(hits.params, 'precursor_mz_error_ppm', hits.count)[0]).toBe(59428.57274219292)
    expect(textColumn(hits.params, 'NuXL:NA', hits.count).slice(0, 3)).toEqual(['U-H3O4P1', 'U-H2O1', 'none'])
    expect(textColumn(hits.params, 'fragment_annotation', hits.count)[0].startsWith('112.050621032714844,0.028104400262237,1,"MI:C\'+"')).toBe(true)
    // a name some hits lack: NaN there ('rank' is not on the first hits)
    const rank = numberColumn(hits.params, 'rank', hits.count)
    expect(rank[0]).toBeNaN()
    expect(rank[1]).toBe(1)
    // the identifications' own UserParams
    expect(numberColumn(ids.params, 'scan_index', ids.count)[0]).toBe(0)
  })

  test('hitsPerIdentification: the first hits only', () => {
    const top = readIdXML(new Uint8Array(source(6)), { hitsPerIdentification: 1 })
    expect(top.hits.count).toBe(20)
    expect(Array.from(top.identifications.hitOffsets.subarray(0, 4))).toEqual([0, 1, 2, 3])
    expect(top.hits.sequence[1]).toBe('LDSK(NuXL:U-H3O4P1)GNIK')
    expect(textColumn(top.hits.params, 'NuXL:NA', 20)[1]).toBe('U-H3O4P1')
  })

  test('OpenNuXL_1 (without decoys): the same layout', () => {
    const one = readIdXML(new Uint8Array(source(1)))
    expect([one.identifications.count, one.hits.count, one.proteins.count]).toEqual([20, 20, 5])
    expect(one.searchParameters[0].modificationDefinitions.map((d) => d.id)).toContain('NuXL:AU')
  })
})

describe('readIdXML: the format', () => {
  test('entities, attributes in any order and quotes, self-closing hits, several evidences, mixed UserParam types', () => {
    const x = readIdXML(
      idxml(`<SearchParameters id="SP_0" charges="+2, +3" db='a "b".fasta' precursor_peak_tolerance="0.5" precursor_peak_tolerance_ppm="false">
  <FixedModification name="Carbamidomethyl (C)" />
  <UserParam name="EnzymeTermSpecificity" type="string" value="full" />
</SearchParameters>
<IdentificationRun search_engine="X&amp;Y" search_parameters_ref="SP_0">
  <ProteinIdentification score_type="q-value">
    <ProteinHit id="PH_0" accession="P&lt;1&gt;" sequence="MPEPTIDEKPEPTIDEK"/>
    <ProteinHit id="PH_1" accession="P2" sequence="">
      <UserParam type="string" name="target_decoy" value="target"/>
    </ProteinHit>
  </ProteinIdentification>
  <PeptideIdentification score_type="q-value" higher_score_better="false" MZ="500.5" spectrum_reference="scan=1">
    <PeptideHit score="0.01" sequence="PEPTIDEK" charge="2" aa_before="M K" aa_after="P [" start="1 9" end="8 16" protein_refs="PH_0 PH_0" />
    <PeptideHit score="0.5" sequence=".(Acetyl)PEPTIDEK" charge="3" protein_refs="PH_9">
      <UserParam type="string" name="note" value="&quot;a&apos;b&quot; &#65;&#x42;"/>
      <UserParam type="int" name="x" value="7"/>
    </PeptideHit>
  </PeptideIdentification>
  <PeptideIdentification score_type="q-value" higher_score_better="false">
    <PeptideHit score="nan" sequence="K" charge="1">
      <UserParam type="string" name="x" value="seven"/>
      <UserParam type="intList" name="list" value="[1, 2]"/>
    </PeptideHit>
  </PeptideIdentification>
</IdentificationRun>`),
    )
    expect(x.searchParameters[0]).toMatchObject({ charges: '+2, +3', db: 'a "b".fasta', precursorToleranceUnit: 'Da', fixedModifications: ['Carbamidomethyl (C)'] })
    expect(x.searchParameters[0].params.get('EnzymeTermSpecificity')).toBe('full')
    expect(x.runs[0].searchEngine).toBe('X&Y')
    expect(x.proteins.accession).toEqual(['P<1>', 'P2'])
    expect(x.proteins.targetDecoy).toEqual(['', 'target'])
    const { identifications: ids, hits } = x
    expect(Array.from(ids.hitOffsets)).toEqual([0, 2, 3])
    expect(ids.rt[0]).toBeNaN()
    expect(ids.spectrumReference).toEqual(['scan=1', ''])
    expect(Array.from(hits.evidenceOffsets)).toEqual([0, 2, 3, 3])
    expect(Array.from(hits.protein)).toEqual([0, 0, -1])
    expect([...hits.start, ...hits.end, ...hits.aaBefore, ...hits.aaAfter]).toEqual([1, 9, -1, 8, 16, -1, 'M', 'K', '', 'P', '[', ''])
    expect(hits.score[2]).toBeNaN()
    expect(textColumn(hits.params, 'note', 3)).toEqual(['', '"a\'b" AB', ''])
    // a name with numbers and text: text
    expect(hits.params.get('x')).toEqual(['', '7', 'seven'])
    expect(textColumn(hits.params, 'list', 3)[2]).toBe('[1, 2]')
  })

  test('a truncated file, or none of idXML, throws', () => {
    const text = new TextDecoder().decode(source(6))
    expect(() => readIdXML(utf8.encode(text.slice(0, 100000)))).toThrow(/the file ends inside/)
    expect(() => readIdXML(utf8.encode(text.slice(0, text.lastIndexOf('</IdXML>'))))).toThrow('the file ends inside <IdXML> (is it complete?)')
    expect(() => readIdXML(utf8.encode('<mzML></mzML>'))).toThrow('it is not an idXML file')
    expect(() => readIdXML(utf8.encode('<IdXML><PeptideIdentification score_type=q-value></PeptideIdentification></IdXML>'))).toThrow(/without quotes/)
  })

  test('unescapeXml', () => {
    expect(unescapeXml('a &lt;b&gt; &amp;amp; &#233;&#x2013;')).toBe('a <b> &amp; é–')
    expect(unescapeXml('plain')).toBe('plain')
  })

  test('parseModificationDefinitions passes over what is no definition', () => {
    expect(parseModificationDefinitions('')).toEqual([])
    expect(parseModificationDefinitions('garbage;1|NuXL:U|NuXL:U (K)||K|none|C9H13N2O9P1|324.0359|324.18|')).toEqual([
      { id: 'NuXL:U', fullId: 'NuXL:U (K)', origin: 'K', termSpecificity: 'none', formula: 'C9H13N2O9P1', monoMass: 324.0359, averageMass: 324.18 },
    ])
  })
})

describe('readIdXML: large files', () => {
  // OpenNuXL_6's identifications repeated to about 100 MB: many chunks of the decoder, tags cut at their ends
  test('reads ~100 MB of identifications in a few seconds, the same as each copy', { timeout: 60_000 }, () => {
    const text = new TextDecoder().decode(source(6))
    const start = text.indexOf('\t\t<PeptideIdentification')
    const end = text.lastIndexOf('\t</IdentificationRun>')
    const block = text.slice(start, end)
    const copies = Math.ceil(100e6 / block.length)
    const big = utf8.encode(text.slice(0, start) + block.repeat(copies) + text.slice(end))
    const t0 = performance.now()
    const x = readIdXML(big)
    const seconds = (performance.now() - t0) / 1000
    expect(x.identifications.count).toBe(20 * copies)
    expect(x.hits.count).toBe(78 * copies)
    const score = numberColumn(x.hits.params, 'NuXL:score', x.hits.count)
    expect(score[78 * (copies - 1)]).toBe(66.026290893554688)
    expect(x.hits.sequence[78 * (copies - 1) + 4]).toBe('LDSK(NuXL:U-H3O4P1)GNIK')
    console.info(`readIdXML: ${(big.length / 1e6).toFixed(0)} MB in ${seconds.toFixed(2)} s`)
    expect(seconds).toBeLessThan(15)
  })
})
