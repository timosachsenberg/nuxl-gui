import { describe, expect, it } from 'vitest'
import { libraryAdductName, librarySequence } from './sequence'

describe('the library sequence of a peptide', () => {
  it("writes OpenNuXL's adduct modification as a bracket after its residue, once", () => {
    expect(librarySequence('K(NuXL:C-H3N1)DIHPK', 'C-H3N1', 0)).toEqual({ modified: 'K[C-H3N1]DIHPK', plain: 'KDIHPK', key: 'KDIHPK', adduct: 'C-H3N1' })
    expect(librarySequence('AEADNLDDK(NuXL:U-H3O4P1)K', 'U-H3O4P1', 8).modified).toBe('AEADNLDDK[U-H3O4P1]K')
    // the modification's residue counts, not a site that disagrees
    expect(librarySequence('AEADNLDDK(NuXL:U-H3O4P1)K', 'U-H3O4P1', 2).modified).toBe('AEADNLDDK[U-H3O4P1]K')
  })

  it('puts the adduct of a sequence without it at the site, as nuxl2dia.py (TextExporter files)', () => {
    expect(librarySequence('KDIHPK', 'C-H3N1', 1)).toEqual({ modified: 'KD[C-H3N1]IHPK', plain: 'KDIHPK', key: 'KDIHPK', adduct: 'C-H3N1' })
    expect(librarySequence('WLSLR', 'U', 0).modified).toBe('W[U]LSLR')
    expect(librarySequence('WLSLR', 'U', 4).modified).toBe('WLSLR[U]')
  })

  it('writes no bracket without a site, or with a site outside the peptide', () => {
    expect(librarySequence('WLSLR', 'U', -1)).toEqual({ modified: 'WLSLR', plain: 'WLSLR', key: 'WLSLR', adduct: '' })
    expect(librarySequence('WLSLR', 'U', 9)).toMatchObject({ modified: 'WLSLR', adduct: '' })
    expect(librarySequence('WLSLR', '', 2).modified).toBe('WLSLR')
  })

  it('puts the adduct before a residue that carries another modification, as nuxl2dia.py', () => {
    expect(librarySequence('ATLGEVGNAEHM(Oxidation)LR', 'U', 11).modified).toBe('ATLGEVGNAEH[U]M(UniMod:35)LR')
    expect(librarySequence('QHVPVFVTDEM(Oxidation)VGHK', 'CU-H3N1', 9).modified).toBe('QHVPVFVTDE[CU-H3N1]M(UniMod:35)VGHK')
  })

  it('writes Oxidation and Carbamidomethyl as Unimod accessions, other modifications as OpenMS does', () => {
    expect(librarySequence('GQDM(Oxidation)ETEAHQNK', '', -1)).toEqual({
      modified: 'GQDM(UniMod:35)ETEAHQNK',
      plain: 'GQDMETEAHQNK',
      key: 'GQDM(Oxidation)ETEAHQNK',
      adduct: '',
    })
    expect(librarySequence('AC(Carbamidomethyl)M(Oxidation)K', '', -1).modified).toBe('AC(UniMod:4)M(UniMod:35)K')
    expect(librarySequence('.(Acetyl)AS(Phospho)K', '', -1)).toMatchObject({ modified: '.(Acetyl)AS(Phospho)K', plain: 'ASK' })
    // nested parentheses stay one modification
    expect(librarySequence('PEK(Label:13C(6)15N(2))R', 'U', 0)).toMatchObject({ modified: 'P[U]EK(Label:13C(6)15N(2))R', plain: 'PEKR' })
  })

  it('keeps the oxidised and the plain peptide apart (the key has the modifications, not the adduct)', () => {
    const plain = librarySequence('M(NuXL:U)ATSGMMTELGK', 'U', 0)
    const oxidised = librarySequence('M(NuXL:U)ATSGM(Oxidation)MTELGK', 'U', 0)
    expect(plain.key).toBe('MATSGMMTELGK')
    expect(oxidised.key).toBe('MATSGM(Oxidation)MTELGK')
    // two localizations of one adduct: one key
    expect(librarySequence('KD(NuXL:U)IHPK', 'U', 1).key).toBe(librarySequence('K(NuXL:U)DIHPK', 'U', 0).key)
  })

  it("splits OpenNuXL's merged modification: the adduct in brackets, the residue's own one kept (OpenMS' unit test)", () => {
    expect(librarySequence('PEPM(NuXL:U-H2O1~Oxidation)TIDE', 'U-H2O1', 3)).toEqual({
      modified: 'PEP[U-H2O1]M(UniMod:35)TIDE',
      plain: 'PEPMTIDE',
      key: 'PEPM(Oxidation)TIDE',
      adduct: 'U-H2O1',
    })
    expect(librarySequence('PEPC(NuXL:U~Carbamidomethyl)K', 'U', 3)).toMatchObject({ modified: 'PEP[U]C(UniMod:4)K', key: 'PEPC(Carbamidomethyl)K' })
    // the oxidised and the plain cross-link: two keys
    expect(librarySequence('PEPM(NuXL:U-H2O1)K', 'U-H2O1', 3).key).toBe('PEPMK')
  })

  it("takes OpenNuXL's mass delta of the adduct at the site as the adduct, never a second one", () => {
    // (OpenNuXL's fallback, and its older idXMLs: 'AEADNLDDK[+306.025304840900048]K')
    expect(librarySequence('AEADNLDDK[+306.025304840900048]K', 'U-H2O1', 8, 306.025305)).toEqual({
      modified: 'AEADNLDDK[U-H2O1]K',
      plain: 'AEADNLDDKK',
      key: 'AEADNLDDKK',
      adduct: 'U-H2O1',
    })
    expect(librarySequence('PEPM(Oxidation)K[+306.0253]', 'U-H2O1', 4, 306.025305).modified).toBe('PEPM(UniMod:35)K[U-H2O1]')
    // the adduct's mass and the residue's own: the rest stays the residue's
    expect(librarySequence('AEADNLDDK[+322.0202]K', 'U-H2O1', 8, 306.025305)).toMatchObject({ modified: 'AEADNLDD[U-H2O1]K[+15.9949]K', key: 'AEADNLDDK[+15.9949]K' })
    // another mass delta is not the adduct
    expect(librarySequence('AEADNLDDK[+42.0106]K', 'U-H2O1', 8, 306.025305).modified).toBe('AEADNLDD[U-H2O1]K[+42.0106]K')
  })

  it('takes the site for a terminal adduct modification', () => {
    expect(librarySequence('.(NuXL:U)WLSLR', 'U', 1).modified).toBe('WL[U]SLR')
    expect(librarySequence('.(NuXL:U)WLSLR', 'U', -1)).toMatchObject({ modified: 'WLSLR', key: 'WLSLR', adduct: '' })
  })

  it('orders dinucleotides alphabetically, as DIA-NN declarations of NuXLDIA have them', () => {
    expect(libraryAdductName('UC-H3N1')).toBe('CU-H3N1')
    expect(libraryAdductName('UA')).toBe('AU')
    expect(libraryAdductName('GA-H2O1')).toBe('AG-H2O1')
    expect(libraryAdductName('CG')).toBe('CG')
    expect(libraryAdductName('U-H2O1')).toBe('U-H2O1')
    // (only the first two letters, as nuxl2dia.py)
    expect(libraryAdductName('UUC')).toBe('UUC')
    expect(librarySequence('KD(NuXL:UC-H3N1)IHPK', 'UC-H3N1', 1)).toMatchObject({ modified: 'KD[CU-H3N1]IHPK', adduct: 'CU-H3N1' })
  })
})
