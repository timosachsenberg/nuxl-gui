# The spectral library's parity fixtures

`library.parity.test.ts` checks the TypeScript port against nuxl2dia.py on these files.

- `EXP1_slice_XLs.unknown`, `EXP1_slice_peptides.unknown`: 45 cross-link and 30 peptide rows of NuXLDIA's
  `003-TextExporter-out/timstof/SMosh_MR_070126_ECO_UV_EXP1_…_perc_0.0100_{XLs,peptides}.unknown` (OpenNuXL's 1 %
  outputs through TextExporter; github.com/timosachsenberg/NuXLDIA, commit fea98d7), only the columns nuxl2dia.py
  reads. The rows chosen: every row with a modification, a decoy accession or a dinucleotide to reorder ('UC…'), five
  that are not localized, and groups of rows of one peptide, adduct and charge (cross-links) or one peptide and charge
  (peptides), so that the deduplication decides.
- `EXP1_slice_nuxl2dia.tsv`: what nuxl2dia.py (NuXLDIA fea98d7, sha256 9209ca59…a98670; Python 3, pandas 3.0.5,
  numpy 2.5.3, no scipy) writes of them:
  `python3 nuxl2dia.py -i EXP1_slice_XLs.unknown EXP1_slice_peptides.unknown -o EXP1_slice_nuxl2dia.tsv`.
  nuxl-app's src/nuxl2dia.py differs from it by a refactoring only.

nuxl2dia.py and nuxl-app are BSD-3 licensed, Copyright OpenMS Inc. -- Eberhard Karls University Tuebingen, ETH
Zurich, and Freie Universitaet Berlin 2002-present (the licence of this app). The example data is NuXLDIA's, whose
repository names no licence; it is used here as test data only.

`declare_mod_UV_UCGA_ext.txt`: NuXLDIA's DIA-NN declarations of the adducts of RNA-UV (UCGA) (its `DIA-NN/` folder,
fea98d7; 3 decimals), which `mods.test.ts` checks the adduct masses against.
