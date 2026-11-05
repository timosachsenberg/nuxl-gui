// The spectral library's fragments of a precursor: the b and y ions of NuXL's annotation of its spectrum
// (`fragment_annotation`, psm/nuxl-annotation.ts), at the annotated (observed) m/z and NuXL's relative intensity.
//
// Ported from nuxl-app src/nuxl2dia.py (NuXL Team; NuXLDIA, github.com/timosachsenberg/NuXLDIA:
// `_parse_annotation_string`, `_parse_ion_annotation`, `filter_fragment_ions`), BSD-3, Copyright OpenMS Inc. --
// Eberhard Karls University Tuebingen, ETH Zurich, and Freie Universitaet Berlin 2002-present. Difference: the loss
// type (`FragmentLossType`, which nuxl2dia.py misspells FragmenLossType and leaves empty but for shifted ions) has a
// value for every ion (`lossType`).

import { classifyLabel, parseFragmentAnnotation } from '../../psm/nuxl-annotation'

/** DIA-NN's loss types: none, water, ammonia; 'unknown' for any other (and for every nucleotide-shifted ion). */
export type LossType = 'noloss' | 'H2O' | 'NH3' | 'unknown'

/** A fragment of the library. */
export type LibraryFragment = {
  /** FragmentType */
  type: 'b' | 'y'
  /** FragmentSeriesNumber (5 of y5) */
  ordinal: number
  /** FragmentCharge: the annotated peak's charge */
  charge: number
  /** ProductMz: the annotated peak's m/z */
  mz: number
  /** LibraryIntensity: NuXL's relative intensity (0–1) */
  intensity: number
  /** Annotation: NuXL's label ('y5', "y5+U'-H2O", 'b3-H2O1+') */
  label: string
  /** FragmentLossType */
  loss: LossType
}

/** The neutral losses DIA-NN names, by NuXL's formula (EmpiricalFormula's spelling, with or without its 1s). */
const NAMED_LOSSES: Record<string, LossType> = { H2O1: 'H2O', H2O: 'H2O', H3N1: 'NH3', H3N: 'NH3', NH3: 'NH3' }

/**
 * The loss type of a b or y ion's label: 'noloss' without a loss ('y5', 'y5++'), 'H2O' for one water ('y5-H2O1+'),
 * 'NH3' for one ammonia ('b3-H3N1+'), 'unknown' for any other loss or several ('y4-C1H2N1O1+', 'y5-H2O1-H3N1+') and
 * for every ion shifted by a nucleotide (fragment): an apostrophe ion ("y9+C'-NH3"), a whole one ('b5+C-NH3', 'y3+U'),
 * a 4SU one ('b4+tU-H2S'), whatever its losses.
 */
export function lossType(label: string): LossType {
  const ion = classifyLabel(label)
  if (ion.shift !== '' || label.includes("'")) return 'unknown'
  if (ion.loss === '') return 'noloss'
  return NAMED_LOSSES[ion.loss] ?? 'unknown'
}

/**
 * The library's fragments of NuXL's annotation `annotation` ('mz,intensity,charge,"label"|…'), by ascending m/z: its
 * b and y ions with their losses and shifts; a, c, x and z ions, the precursor ('[M+2H]…'), immonium ('iK…'), marker
 * ('MI:…') and internal ions are left out.
 */
export function libraryFragments(annotation: string): LibraryFragment[] {
  const out: LibraryFragment[] = []
  for (const peak of parseFragmentAnnotation(annotation)) {
    const ion = classifyLabel(peak.label, peak.charge)
    if (ion.kind !== 'b' && ion.kind !== 'y') continue
    out.push({
      type: ion.kind,
      ordinal: ion.ordinal,
      charge: peak.charge,
      mz: peak.mz,
      intensity: peak.intensity,
      label: peak.label,
      loss: lossType(peak.label),
    })
  }
  return out
}
