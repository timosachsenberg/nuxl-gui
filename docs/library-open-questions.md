# Spectral library (DIA-NN TSV): open questions

The export (Export › "Spectral library (DIA-NN TSV)…", `docs/design.md` §5) is a port of nuxl-app's nuxl2dia.py
(NuXLDIA). These questions are for someone who knows NuXL and DIA-NN. None of these libraries has been run through
DIA-NN yet: no DIA-NN run, log or report exists in NuXLDIA either. The answers decide whether a rule stays as it is.

## FDR

1. **Which FDR should a library be built at?** The dialog has its own peptide FDR and cross-link FDR, each 1 % at first
   (or the search's cutoff, where that is tighter). Both can be tightened, but never set looser than the search's. The
   tables' filters do not apply. nuxl-app always uses Percolator's 1 % files (`*_perc_0.0100_*`). Is 1 %/1 % right for
   cross-links, or should cross-links be stricter? Is the PSM-level cross-link FDR enough, or should a peptide-level
   one apply (OpenNuXL's `xl_peptidelevel_FDR`)?
2. **Should rescored or RDDF identifications be offered?** At the moment they are not.

## Fragments and FragmentLossType

3. **Which FragmentLossType values?** The column is spelled `FragmentLossType`. nuxl2dia.py writes it as
   `FragmenLossType`, which DIA-NN does not recognise, so DIA-NN treats every fragment as `noloss`. The export writes
   one of four values for every fragment:
   - `noloss`;
   - `H2O` for one water;
   - `NH3` for one ammonia;
   - `unknown` for anything else.

   In DIA-NN 1.7.12 an empty value or `unknown` becomes "other loss". How does DIA-NN 2.x read these values? Would the
   old effect (every fragment `noloss`) be safer? One way to check: convert a library to `.parquet` in DIA-NN 2.x and
   look at it.
4. **Neutral-loss labels.** Is it right to send only exactly `-H2O1` and `-H3N1` to H2O and NH3? Should other losses get
   a value of their own? DIA-NN 1.7.12 also knows `CO`. Examples of other losses: `-C1H2N1O1`, `-C1H4O1S1` (oxidised
   M), and `-H2O1-H3N1`.
5. **Shifted ions as `unknown`.** Every ion shifted by a nucleotide (fragment) is labelled `unknown`. Examples:
   `y9+C'-NH3`, `b5+C-NH3`, `y3+U`, and the 4SU form `b4+tU-H2S`. The fragment keeps its b/y type, number and charge,
   and DIA-NN extracts it at the annotated m/z. Is that right? Some DIA-NN paths regenerate ions from the sequence:
   `--reverse-decoys`, empirical libraries / MBR, and `--tune-lib`. On those paths, a y ion that contains the
   cross-linked residue carries the whole adduct, which is wrong for a partial shift such as `U'`. Should shifted ions be
   left out, or should `--no-fragmentation` be recommended?
6. **Only b and y ions are kept.** nuxl2dia.py does the same. a ions are dropped, even though DIA-NN accepts a as "b"
   with a note. Precursor, immonium, marker and internal ions are dropped too. Should a ions be kept?

## Modifications and their declarations

7. **Notation of other modifications.** Only Oxidation and Carbamidomethyl become UniMod accessions (`(UniMod:35)`,
   `(UniMod:4)`), as in nuxl2dia.py. Every other modification is written as OpenMS writes it, for example
   `S(Phospho)`, `.(Acetyl)PEPTIDE` and `[+15.9949]`. Is that what DIA-NN expects? Should every Unimod modification be
   written as `(UniMod:n)`, and terminal ones in DIA-NN's spelling?
8. **Adduct names with `+` or `'`.** Do names such as `[AS+H1O3P1-H2S1]` (4SU), `[U+C4H6O2]` (DEB) or a name with `'`
   parse in DIA-NN's sequences and in `--mod`?
9. **`--mod` lines without sites.** The export writes `--mod U-H2O1,306.025305`: a name and a mass with 6 decimals, but
   no residue and no label. Is that enough for DIA-NN 2.x? In particular for `--tune-lib`, which exits on undeclared
   modifications. Note that DIA-NN renames a declared mod to UniMod when the masses agree within 1e-5 Da; is
   `--original-mods` advisable?
10. **The adduct before a modified residue.** When the cross-linked residue carries another modification, nuxl2dia.py
    puts the bracket before that residue. Example: `PE[U]M(UniMod:35)K`, which DIA-NN would read as an adduct on E. The
    port does the same, but only for sequences without OpenNuXL's adduct modification (TextExporter input). OpenNuXL
    now writes the adduct on its residue (`M(NuXL:U)`), and that residue cannot carry a second modification. Was that
    placement intended?

## DIA-NN settings and columns

11. **Recommended settings.** Should the app recommend `--no-fragmentation` (only the library's fragments) and/or
    `--no-lib-filter` (use the library as is)? DIA-NN's default `--min-fr-aas` drops fragments with fewer than 3
    residues.
12. **Ion mobility column.** The export writes `PrecursorIonMobility`, as nuxl2dia.py does; DIA-NN 2.x documents
    `IonMobility`. Does 2.x read `PrecursorIonMobility`? The value is OpenNuXL's CCS converted to 1/K0
    (Mason–Schamp, N2, 305 K, nuxl2dia.py's constants).
13. **iRT reference.** The iRT reference is an MSFragger/EasyPQP `library.tsv` of the same LC setup. A straight line of
    its iRT over its retention time, in seconds as NuXL's, gives NormalizedRetentionTime. Without a reference the column
    is empty and DIA-NN takes AverageExperimentalRetentionTime. Are the reference's retention times always in seconds
    (some libraries use minutes)? Is a linear fit enough, or is a piecewise one needed (nuxl-app's other mode)?

## Which precursors

14. **Unlocalized cross-links.** Cross-links with a best localization score of 0 or none are left out, as in nuxl-app;
    the dialog counts them. Should they go in with the adduct on the most likely residue, or without a site?
15. **Peptides without cross-link.** Peptides without a cross-link are always included (for retention time and
    calibration), as in nuxl-app. Should that be optional?

## Other tools

16. **OpenSWATH.** OpenMS' TargetedFileConverter cannot read these sequences: AASequence takes the text in brackets as a
    mass, and `[U-H2O1]` throws. That is why the export is named "DIA-NN TSV". Is an OpenSWATH variant wanted, with the
    adducts as mass deltas (`[+306.0253]`)? It would need to be tested.

## The data

17. **The parity test's data.** The parity test uses a slice of NuXLDIA's example TextExporter output
    (`src/lib/results/library/fixtures/`), and NuXLDIA's repository names no licence. Can that slice be kept in this
    repository (BSD-3)?
