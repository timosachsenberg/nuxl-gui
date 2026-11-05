// The spectral library export (Export → "Spectral library (DIA-NN TSV)…", docs/design.md §5): a DIA-NN library of a
// search's target cross-links and peptides with NuXL's annotated b and y fragments, one entry per precursor.
//
// Ported from nuxl-app src/nuxl2dia.py (NuXL Team; NuXLDIA, github.com/timosachsenberg/NuXLDIA:
// `NuXLLibraryConverter.run_pipeline`), BSD-3, Copyright OpenMS Inc. -- Eberhard Karls University Tuebingen, ETH
// Zurich, and Freie Universitaet Berlin 2002-present. As nuxl2dia.py: decoys left out (a hit whose proteins are all
// decoys), cross-links only when localized (NuXL:best_localization_score > 0), one cross-link per peptide, adduct and
// charge (the best localization score, then the best NuXL:score), one peptide per modified peptide and charge (the best
// NuXL:score), the precursors in that order (cross-links first), its columns in its order. Differences (design.md):
// the PSMs are the search's within the export's two FDRs (nuxl-app: Percolator's 1 % files); the column
// FragmentLossType (nuxl2dia.py: FragmenLossType) with a value for every fragment; ProteinId without repeated
// accessions; integers without '.0'; a NuXL adduct modification in the sequence (OpenNuXL's of the pin) at its residue.

import { psmPasses, qLimits, type ResultModel } from '../model'
import { libraryFragments, type LibraryFragment } from './fragments'
import { ccsToInverseK0 } from './ion-mobility'
import { toIrt, type IrtFit } from './irt'
import { libraryAdductName, librarySequence } from './sequence'

/** A PSM as the library takes it (one row of nuxl2dia.py's TextExporter input). */
export type LibraryHit = {
  /** the peptide in OpenMS' notation ('KDIHPK', 'K(NuXL:C-H3N1)DIHPK', 'GQDM(Oxidation)ETEAHQNK') */
  sequence: string
  charge: number
  /** the precursor's m/z (observed) */
  mz: number
  /** seconds */
  rt: number
  /** the precursor's CCS (Å², the hit's 'IM'); NaN none */
  ccs: number
  /** a cross-link (from OpenNuXL's cross-link PSMs) */
  crossLink: boolean
  /** NuXL:NA ('' none) */
  adduct: string
  /** NuXL:NA_MASS_z0 (Da); NaN unknown */
  adductMass: number
  /** NuXL:best_localization_position (0-based residue); −1 none */
  site: number
  /** NuXL:best_localization_score; NaN none */
  siteScore: number
  /** NuXL:score; NaN none */
  nuxlScore: number
  /** the proteins' accessions, in the order of the hit's evidences */
  accessions: string[]
  /** every protein of the hit is a decoy */
  decoy: boolean
  /** NuXL's fragment_annotation */
  annotation: string
}

/** A precursor of the library, with its fragments. */
export type LibraryPrecursor = {
  /** ModifiedPeptideSequence */
  modified: string
  /** PeptideSequence */
  plain: string
  charge: number
  mz: number
  /** AverageExperimentalRetentionTime (seconds) */
  rt: number
  /** NormalizedRetentionTime; NaN without a reference */
  irt: number
  /** PrecursorIonMobility (1/K0); NaN none */
  ionMobility: number
  /** ProteinId: the accessions, ';'-separated */
  proteins: string
  crossLink: boolean
  /** the adduct in the sequence's brackets ('' none) and its mass (NaN unknown) */
  adduct: string
  adductMass: number
  fragments: LibraryFragment[]
}

/** A library, and what was left out on the way. */
export type Library = {
  precursors: LibraryPrecursor[]
  /** the precursors by kind */
  peptides: number
  crossLinks: number
  fragments: number
  /** the adducts of the cross-links, by their names in brackets, with their masses (NaN unknown) */
  adducts: Map<string, number>
  /** cross-link PSMs left out as not localized (best localization score 0 or none) */
  unlocalized: number
  /** decoy PSMs left out */
  decoys: number
  /** precursors left out for having no b or y fragment */
  withoutFragments: number
}

/** `a` before `b` when it scores higher (NaN lowest); 0 when equal. */
const higher = (a: number, b: number) => (Number.isNaN(a) ? (Number.isNaN(b) ? 0 : 1) : Number.isNaN(b) ? -1 : b - a)

/** The first hit per key of hits sorted (stably) by `order`. */
function bestPer(hits: LibraryHit[], key: (h: LibraryHit) => string, order: (a: LibraryHit, b: LibraryHit) => number): LibraryHit[] {
  const seen = new Set<string>()
  const out: LibraryHit[] = []
  for (const h of [...hits].sort(order)) {
    const k = key(h)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(h)
  }
  return out
}

/**
 * The library of `hits`: their target precursors (see the file's head), each with its b and y fragments (of a hit's
 * annotation by `fragmentsOf`, e.g. a cache of `libraryFragments`), the retention times also as iRT by `irt` (null: none).
 */
export function buildLibrary(
  hits: readonly LibraryHit[],
  irt: IrtFit | null = null,
  fragmentsOf: (annotation: string) => LibraryFragment[] = libraryFragments,
): Library {
  let decoys = 0
  let unlocalized = 0
  const xls: LibraryHit[] = []
  const peptides: LibraryHit[] = []
  for (const h of hits) {
    if (h.decoy) decoys++
    else if (!h.crossLink) peptides.push(h)
    else if (h.siteScore > 0) xls.push(h)
    else unlocalized++
  }
  const sequenceOf = new Map<LibraryHit, ReturnType<typeof librarySequence>>()
  const seq = (h: LibraryHit) => {
    let s = sequenceOf.get(h)
    if (!s) sequenceOf.set(h, (s = librarySequence(h.sequence, h.crossLink ? h.adduct : '', h.crossLink ? h.site : -1, h.adductMass)))
    return s
  }
  const chosen = [
    ...bestPer(
      xls,
      (h) => `${seq(h).key}\u0000${h.adduct}\u0000${h.charge}`,
      (a, b) => higher(a.siteScore, b.siteScore) || higher(a.nuxlScore, b.nuxlScore),
    ),
    ...bestPer(peptides, (h) => `${h.sequence}\u0000${h.charge}`, (a, b) => higher(a.nuxlScore, b.nuxlScore)),
  ]

  const library: Library = {
    precursors: [],
    peptides: 0,
    crossLinks: 0,
    fragments: 0,
    adducts: new Map(),
    unlocalized,
    decoys,
    withoutFragments: 0,
  }
  for (const h of chosen) {
    const fragments = fragmentsOf(h.annotation)
    if (fragments.length === 0) {
      library.withoutFragments++
      continue
    }
    const s = seq(h)
    const precursor: LibraryPrecursor = {
      modified: s.modified,
      plain: s.plain,
      charge: h.charge,
      mz: h.mz,
      rt: h.rt,
      irt: toIrt(irt, h.rt),
      ionMobility: ccsToInverseK0(h.ccs, h.charge, h.mz),
      proteins: [...new Set(h.accessions)].join(';'),
      crossLink: h.crossLink,
      adduct: s.adduct,
      // (NuXL:NA_MASS_z0 is the mass of NuXL:NA's adduct, not of another one in the brackets)
      adductMass: s.adduct !== '' && s.adduct === libraryAdductName(h.adduct) ? h.adductMass : NaN,
      fragments,
    }
    library.precursors.push(precursor)
    if (h.crossLink) library.crossLinks++
    else library.peptides++
    library.fragments += fragments.length
    if (precursor.adduct !== '') {
      const known = library.adducts.get(precursor.adduct)
      if (known === undefined || (Number.isNaN(known) && !Number.isNaN(precursor.adductMass))) library.adducts.set(precursor.adduct, precursor.adductMass)
    }
  }
  return library
}

/** The library's columns, in nuxl2dia.py's order (FragmentLossType spelled right). */
export const LIBRARY_COLUMNS = [
  'ModifiedPeptideSequence',
  'PrecursorCharge',
  'AverageExperimentalRetentionTime',
  'PrecursorIonMobility',
  'PeptideSequence',
  'PrecursorMz',
  'ProteinId',
  'Annotation',
  'FragmentSeriesNumber',
  'ProductMz',
  'LibraryIntensity',
  'FragmentCharge',
  'FragmentType',
  'NormalizedRetentionTime',
  'FragmentLossType',
] as const

/** A number as the TSV has it: in full (the shortest text that reads back as the same double); NaN empty. */
const num = (x: number) => (Number.isFinite(x) ? String(x) : '')
/** A text field: no tab or line break in it. */
const text = (s: string) => s.replace(/[\t\r\n]/g, ' ')

/** The library as DIA-NN's TSV: a header, then one row per fragment ('\n' line ends, UTF-8 without BOM). */
export function libraryTsv(library: Library): string {
  const lines = [LIBRARY_COLUMNS.join('\t')]
  for (const p of library.precursors) {
    const head = [text(p.modified), String(p.charge), num(p.rt), num(p.ionMobility), p.plain, num(p.mz), text(p.proteins)]
    for (const f of p.fragments) {
      lines.push(
        [...head, text(f.label), String(f.ordinal), num(f.mz), num(f.intensity), String(f.charge), f.type, num(p.irt), f.loss].join('\t'),
      )
    }
  }
  return lines.join('\n') + '\n'
}

/** The export's FDRs: the peptide PSMs' and the cross-link PSMs' (q-values, at most the search's). */
export type LibraryFdr = { peptide: number; xl: number }

/**
 * The search's PSMs within `fdr` (the PSMs' q-values; a peptide PSM also by its peptide-level q-value, model.ts
 * `psmPasses`), as library hits: of every file, whatever the tables' filters.
 */
export function libraryHits(m: ResultModel, fdr: LibraryFdr): LibraryHit[] {
  const { psms, peptides, proteins } = m.tables
  const limits = qLimits(m, fdr.peptide, fdr.xl)
  const out: LibraryHit[] = []
  for (let i = 0; i < psms.count; i++) {
    if (!psmPasses(m, i, limits)) continue
    const k = psms.peptide[i]
    const accessions: string[] = []
    let allDecoys = psms.decoy[i] === 1
    let anyProtein = false
    let targets = false
    for (let r = peptides.proteinOffsets[k]; r < peptides.proteinOffsets[k + 1]; r++) {
      const p = peptides.protein[r]
      accessions.push(proteins.accession[p])
      anyProtein = true
      if (!proteins.decoy[p]) targets = true
    }
    if (anyProtein && !targets) allDecoys = true
    const xl = psms.xl
    out.push({
      sequence: peptides.openms[k],
      charge: psms.charge[i],
      mz: psms.mz[i],
      rt: psms.rt[i],
      ccs: xl.ccs[i],
      crossLink: xl.isXL[i] === 1,
      adduct: xl.adduct[i],
      adductMass: xl.adductMass[i] > 0 ? xl.adductMass[i] : NaN,
      site: xl.site[i],
      siteScore: xl.siteScore[i],
      nuxlScore: xl.nuxlScore[i],
      accessions,
      decoy: allDecoys,
      annotation: xl.annotation[i],
    })
  }
  return out
}
