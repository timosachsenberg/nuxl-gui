// The in-app help (HelpDialog.svelte): what each view does and how to use it, the terms of the results, the keys.
// Plain data, so that the dialog renders it and the tests check that every view has its section.

import type { View } from '$lib/route'

/** One entry of a section: a term (bold, optional) and what it is. */
export type HelpItem = { term?: string; text: string }

export type HelpSection = {
  id: HelpSectionId
  title: string
  /** A paragraph before the entries. */
  intro?: string
  items: HelpItem[]
}

export type HelpSectionId = 'start' | 'search' | 'results' | 'protein' | 'psm' | 'history' | 'terms' | 'keys'

export const helpSections: HelpSection[] = [
  {
    id: 'start',
    title: 'Getting started',
    intro:
      'NuXL finds peptides cross-linked to RNA or DNA in MS/MS spectra with OpenNuXL of OpenMS. Everything runs on this computer: the spectra and the database are never uploaded.',
    items: [
      { term: '1. New search', text: 'Add the spectra, choose a FASTA database and the protocol of the experiment, then Start search. "Try the example" fills in a small test run.' },
      { term: '2. Results', text: 'When the search is done its results open: key figures, an overview, tables of proteins, peptides and PSMs, and each PSM\'s annotated spectrum.' },
      { term: '3. History', text: 'Every finished search is kept with its results, so that you can open it again later or save it as a project file.' },
      { text: 'Most labels, column headers and buttons explain themselves when you hover over them.' },
    ],
  },
  {
    id: 'search',
    title: 'New search',
    items: [
      { term: 'Spectra', text: 'mzML files, Thermo .raw files and Bruker timsTOF .d folders: drop them on the window or use Add files. OpenNuXL searches each file on its own, one after the other.' },
      { term: 'Design', text: 'With more than one file, the table under Spectra gives each file its condition, replicate and fraction. The Samples tab and the per-sample columns of the results follow it.' },
      { term: 'Protein database', text: 'A FASTA file (a FASTA dropped on the window becomes the database). OpenNuXL adds the decoys itself; Contaminants adds the cRAP proteins (common contaminants), which the result tables hide by default.' },
      { term: 'Protocol', text: 'The nucleic acid and the cross-linking chemistry (e.g. RNA-UV (U), DNA-UV, RNA-DEB): it sets which nucleotides and adducts OpenNuXL looks for. Longest adduct limits their length; 0 searches linear peptides only.' },
      { term: 'Scoring', text: '"Slow: all losses" scores the adducts with all their neutral losses; "Fast: total loss only" scores fewer and runs quicker.' },
      { term: 'Tolerances, enzyme, modifications', text: 'As in any database search: precursor and fragment mass tolerance, the protease and its missed cleavages, fixed and variable modifications, charges and peptide length.' },
      { term: 'Peptide FDR, cross-link FDR', text: 'Peptide PSMs and cross-link PSMs are each held to their own false discovery rate, file by file.' },
      { term: 'Advanced, All parameters', text: 'Advanced shows a few more settings (threads, isotopes, …); All parameters lists every parameter of OpenNuXL, with a search box.' },
      { term: 'Presets', text: 'Save as preset keeps the current settings under a name; the Preset menu brings them back.' },
      { term: 'Rescoring', text: 'With 1,000 PSMs or more per file, Percolator rescores them; below that OpenNuXL keeps its own scores and the results say so.' },
    ],
  },
  {
    id: 'results',
    title: 'Results',
    items: [
      { term: 'Key figures', text: 'Proteins, peptides and PSMs the search found at its cutoffs (peptide FDR and cross-link FDR), the samples and the median precursor mass error.' },
      { term: 'Overview', text: 'The search\'s settings, each file\'s outcome (PSMs, whether Percolator ran) and charts of the adducts and the cross-linked amino acids.' },
      { term: 'Proteins, Peptides, PSMs', text: 'Tables at three levels. Click a column header to sort; the search box and the filters above narrow the rows; Columns shows or hides columns; Export CSV saves the rows as shown.' },
      { term: 'Protein row', text: 'Opens the protein panel beside the table (see Protein panel).' },
      { term: 'Peptide or PSM row', text: 'Opens the PSM view with the annotated spectrum (see PSM view).' },
      { term: 'Samples', text: 'Per sample of the design: its PSMs, cross-link PSMs, peptides and proteins.' },
      { term: 'QC', text: 'Score distributions of peptide and cross-link PSMs, the precursor mass errors and the PSMs per file.' },
      { term: 'Export menu', text: 'The current table as CSV, the design (design.tsv), the open spectrum as SVG, the whole search as a project file (.nuxl), each file\'s idXML (every PSM before the FDR filter) and the search\'s folder.' },
    ],
  },
  {
    id: 'protein',
    title: 'Protein panel',
    items: [
      { term: 'Coverage', text: 'The strip and the sequence map show which residues peptides with PSMs cover, the modified residues and, in violet, the cross-linked residues.' },
      { term: 'Cross-linked sites', text: 'Under the map: each cross-linked residue with its adducts and their PSMs.' },
      { term: 'On a 3D structure', text: 'ChimeraX script and PyMOL script save the sites as a script for these viewers. For a UniProt accession the script opens the AlphaFold DB model (the viewer downloads it from EBI, not this app); for any other protein, open a structure first, then run the script.' },
      { term: 'Peptides, PSMs', text: 'The protein\'s peptides (each opens to its PSMs) and its PSMs; Open in PSM table filters the PSMs tab by the protein.' },
    ],
  },
  {
    id: 'psm',
    title: 'PSM view',
    items: [
      { term: 'Header', text: 'The peptide with its fragment ladder, whether it is a cross-link, its adduct and cross-linked residue, and its q-value.' },
      { term: 'Spectrum', text: 'The observed peaks with OpenNuXL\'s annotation on top, mirrored against the theoretical b/y ions of the linear peptide below. The toggles choose the ion types, charges, shifted ions and the other annotations.' },
      { term: 'Mass errors', text: 'The fragment mass error of each annotated ion; the strip can be collapsed.' },
      { term: 'Measure, Label', text: 'Measure: click two peaks for their m/z difference (and what it may be). Label: click a peak to give it a text of your own. Both are part of Export spectrum (SVG).' },
      { term: 'Prev, Next', text: 'Step through the PSMs of the table below, which stays in sight.' },
      { term: 'Peaks', text: 'The peaks are read from your mzML file where it is. If it was moved (or for an imported project) the view shows only the peaks NuXL annotated, and says so.' },
    ],
  },
  {
    id: 'history',
    title: 'History and projects',
    items: [
      { term: 'History', text: 'Finished searches with their results, kept on this computer: Open, Rename or Delete them.' },
      { term: 'Projects', text: 'Export › Project saves a search as one .nuxl file; Open project in History opens it on another computer. Projects leave out the spectra, so there the PSM view shows the annotated peaks only.' },
    ],
  },
  {
    id: 'terms',
    title: 'Terms',
    items: [
      { term: 'PSM', text: 'Peptide–spectrum match: a spectrum with the peptide that explains it best.' },
      { term: 'Cross-link (XL)', text: 'A peptide that carries a piece of nucleic acid, covalently bound to one of its residues.' },
      { term: 'Adduct', text: 'The nucleic acid on a cross-linked peptide, written as its nucleotides and the losses of their formula: U-H₂O is one U that lost water.' },
      { term: 'Cross-linked residue (site)', text: 'The amino acid the adduct is on, as OpenNuXL localizes it; the localization score (0–1) says how sure it is. A cross-link that is not localized names its candidate residues instead.' },
      { term: 'Shifted ions', text: 'Fragment ions that carry the adduct, or part of it, and are shifted by its mass.' },
      { term: 'Marker ions', text: 'Ions of the nucleic acid itself (e.g. its bases), a sign of a cross-link.' },
      { term: 'FDR, q-value', text: 'The false discovery rate is estimated with decoys (sequences that cannot be in the sample). A PSM\'s q-value is the lowest FDR at which it is accepted.' },
      { term: 'PEP', text: 'Posterior error probability: the chance that this one PSM is wrong (Percolator).' },
      { term: 'Percolator', text: 'Rescores the PSMs with machine learning when a file has enough of them (1,000 PSMs).' },
      { term: 'Contaminants', text: 'Common contaminant proteins (cRAP) added to the database; marked, and hidden in the tables by default.' },
      { term: 'Found in', text: 'In how many of the samples a protein or peptide was found.' },
      { term: 'ProForma', text: 'The standard notation of a peptide with its modifications, used in the CSV files and when copying.' },
    ],
  },
  {
    id: 'keys',
    title: 'Keys',
    items: [
      { term: 'F1', text: 'This help.' },
      { term: 'Ctrl+Enter (⌘+Enter)', text: 'New search: Start search.' },
      { term: '↑ ↓, Page Up/Down, Home, End', text: 'In a table: move through the rows. Enter or Space opens the row.' },
      { term: 'Escape', text: 'Closes the protein panel or the PSM view (in the PSM view, first the Measure or Label tool).' },
      { term: '← →', text: 'PSM view: the previous or next PSM.' },
      { term: 'M, L', text: 'PSM view: the Measure or Label tool. Delete removes the selected measurement or label.' },
    ],
  },
]

/**
 * The section that fits what is on screen: the view, and on Results whether a PSM is open (the PSM view) or the
 * protein panel beside the Proteins table.
 */
export function helpSectionFor(view: View, open: { psm?: boolean; panel?: boolean } = {}): HelpSectionId {
  if (view === 'search') return 'search'
  if (view === 'history') return 'history'
  return open.psm ? 'psm' : open.panel ? 'protein' : 'results'
}
