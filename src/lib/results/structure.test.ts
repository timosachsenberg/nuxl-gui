import { describe, expect, it } from 'vitest'
import type { CrossLinkedSite } from './protein'
import { structureFileStem, structureScript, uniprotAccession, type StructureInput } from './structure'

const site = (position: number, residue: string, adducts: [string, number][], score = NaN): CrossLinkedSite => ({
  position,
  residue,
  psms: adducts.reduce((n, [, k]) => n + k, 0),
  adducts: adducts.map(([adduct, psms]) => ({ adduct, psms })),
  score,
})

const albumin = (over: Partial<StructureInput> = {}): StructureInput => ({
  accession: 'sp|P02768|ALBU_HUMAN',
  description: 'Albumin OS=Homo sapiens OX=9606 GN=ALB PE=1 SV=2',
  length: 609,
  sites: [site(122, 'K', [['U-H3O4P1', 3], ['UU-H2O1', 1]], 0.98), site(244, 'Y', [['U', 1]])],
  xlFdr: 0.01,
  result: 'run',
  ...over,
})

describe('UniProt accessions', () => {
  it('takes the accession of a UniProt header, a bare one and a contaminant', () => {
    expect(uniprotAccession('sp|P02768|ALBU_HUMAN')).toEqual({ id: 'P02768', isoform: false })
    expect(uniprotAccession('tr|A0A024R161|A0A024R161_HUMAN')).toEqual({ id: 'A0A024R161', isoform: false })
    expect(uniprotAccession('P02768')).toEqual({ id: 'P02768', isoform: false })
    expect(uniprotAccession('CON__P02768')).toEqual({ id: 'P02768', isoform: false })
    expect(uniprotAccession('sp|P02768-2|ALBU_HUMAN')).toEqual({ id: 'P02768-2', isoform: true })
  })

  it('knows no accession in other databases\' identifiers', () => {
    for (const other of ['Cas7', 'NP_000468.1', 'ENSP00000295897', 'DECOY_sp|P02768|ALBU_HUMAN', 'p02768', ''])
      expect(uniprotAccession(other)).toBeNull()
  })
})

describe('the file name', () => {
  it('is the result, the accession and xl-sites, safe for a file name', () => {
    expect(structureFileStem(albumin())).toBe('run_P02768_xl-sites')
    expect(structureFileStem(albumin({ accession: 'my protein/1' }))).toBe('run_my_protein_1_xl-sites')
  })
})

describe('ChimeraX', () => {
  it('fetches the AlphaFold model and colours and labels each site', () => {
    const script = structureScript('chimerax', albumin())
    const commands = script.split('\n').filter((l) => l && !l.startsWith('#'))
    expect(commands).toEqual([
      'alphafold fetch P02768',
      'cartoon',
      'color lightgray',
      'show :123,245 atoms',
      'style :123,245 ball',
      'color :123 #4c1d95',
      'color :245 #c4b5fd',
      'label :123 text "{0.name} {0.number}: U-H3PO4 x3 / UU-H2O x1"',
      'label :245 text "{0.name} {0.number}: U x1"',
      'view :123,245',
    ])
    // the header: the protein, the cutoff, the table of sites, the colours and the source
    expect(script).toContain('# NuXL: the cross-linked residues of sp|P02768|ALBU_HUMAN Albumin OS=Homo sapiens')
    expect(script).toContain("cross-link FDR (1 %)")
    expect(script).toContain('(609 residues)')
    expect(script).toContain('# K123      4     0.98                     U-H3PO4 x3 / UU-H2O x1')
    expect(script).toContain('# Y245      1     -                        U x1')
    expect(script).toContain('light violet (1) to dark violet (4)')
    expect(script).toContain('AlphaFold DB model of P02768')
    expect(script).toContain('sends the accession to EBI')
    expect(script.endsWith('view :123,245\n')).toBe(true)
  })

  it('fetches nothing without a UniProt accession or for an isoform, and says to open a structure first', () => {
    for (const accession of ['Cas7', 'sp|P02768-2|ALBU_HUMAN']) {
      const script = structureScript('chimerax', albumin({ accession }))
      expect(script).not.toContain('alphafold fetch')
      expect(script).toContain('Open a structure of the protein first')
    }
    expect(structureScript('chimerax', albumin({ accession: 'Cas7' }))).toContain('Cas7 is not a UniProt accession')
    expect(structureScript('chimerax', albumin({ accession: 'P02768-2' }))).toContain('P02768-2 is an isoform')
  })

  it('colours a protein whose sites all have one PSM in one colour', () => {
    const script = structureScript('chimerax', albumin({ sites: [site(9, 'K', [['U', 1]]), site(19, 'C', [['U', 1]])] }))
    expect(script).toContain('color :10 #7c3aed\ncolor :20 #7c3aed')
    expect(script).toContain('# Colour: violet.')
  })

  it('keeps a description on one comment line and escapes braces and quotes of labels', () => {
    const script = structureScript('chimerax', albumin({ description: 'one\ntwo', sites: [site(0, 'M', [['{x}"', 1]])] }))
    expect(script).toContain('ALBU_HUMAN one two, for ChimeraX')
    expect(script).toContain('label :1 text "{0.name} {0.number}: {{x}}\' x1"')
  })
})

describe('PyMOL', () => {
  it('loads the AlphaFold model, colours and labels each site, and checks the residues', () => {
    const script = structureScript('pymol', albumin())
    expect(script).toContain('_nuxl_fetch("P02768", "AF-P02768")')
    expect(script).toContain('https://alphafold.ebi.ac.uk/api/prediction/')
    expect(script).toContain('select nuxl_xl_sites, polymer.protein and resi 123+245')
    expect(script).toContain('set_color nuxl_xl_4, [0.298, 0.114, 0.584]')
    expect(script).toContain('color nuxl_xl_4, polymer.protein and resi 123\ncolor nuxl_xl_1, polymer.protein and resi 245')
    expect(script).toContain('label polymer.protein and resi 123 and name CA, resn + " " + resi + ": U-H3PO4 x3 / UU-H2O x1"')
    expect(script).toContain('_nuxl_check([(123, "K"), (245, "Y")])')
    expect(script).toContain('# K123      4     0.98')
    // python blocks open and close
    expect(script.match(/^python$/gm)).toHaveLength(2)
    expect(script.match(/^python end$/gm)).toHaveLength(2)
    expect(script.endsWith('zoom nuxl_xl_sites, 8\n')).toBe(true)
  })

  it('loads nothing without a UniProt accession, and still checks the residues', () => {
    const script = structureScript('pymol', albumin({ accession: 'Cas7' }))
    expect(script).not.toContain('_nuxl_fetch')
    expect(script).toContain('_nuxl_check(')
    expect(script.match(/^python$/gm)).toHaveLength(1)
  })

  it('writes no comma or semicolon into a label, which PyMOL would split the command at', () => {
    const script = structureScript('pymol', albumin({ sites: [site(0, 'M', [['U,1;2', 1]])] }))
    const label = script.split('\n').find((l) => l.startsWith('label '))!
    expect(label.split(',')).toHaveLength(2)
    expect(label).not.toContain(';')
  })
})
