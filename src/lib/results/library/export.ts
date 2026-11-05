// The spectral library export of a result (Export → "Spectral library (DIA-NN TSV)…"): its FDRs, its file name, the
// library and DIA-NN's declarations of its adducts. The dialog (LibraryDialog.svelte) shows what this gives; exports.ts
// saves it.

import { percentNumber } from '../../format/fdr'
import type { ResultModel } from '../model'
import { buildLibrary, libraryHits, libraryTsv, type Library, type LibraryFdr } from './library'
import { libraryFragments, type LibraryFragment } from './fragments'
import type { IrtFit } from './irt'
import { adductFormulaMass, diannModLines, targetNucleotides } from './mods'

/** The FDR a library is usually built at (DDA libraries for DIA: 1 %), and so the export's default. */
export const LIBRARY_FDR = 0.01

/** The export's FDRs at first: 1 %, or the search's cutoff where it is tighter. */
export function defaultLibraryFdr(m: Pick<ResultModel, 'psmFdr' | 'xlFdr'>): LibraryFdr {
  return { peptide: Math.min(m.psmFdr, LIBRARY_FDR), xl: Math.min(m.xlFdr, LIBRARY_FDR) }
}

/** Whether `fdr` can be exported: each above 0 and at most the search's cutoff (a looser one needs a new search). */
export function validLibraryFdr(m: Pick<ResultModel, 'psmFdr' | 'xlFdr'>, fdr: LibraryFdr): boolean {
  const ok = (q: number, cutoff: number) => q > 0 && q <= cutoff * (1 + 1e-9)
  return ok(fdr.peptide, m.psmFdr) && ok(fdr.xl, m.xlFdr)
}

/** The library's file name: `<name>_library_pep1%_xl1%.tsv` (the TSV has no place for its FDRs). */
export function libraryFileName(name: string, fdr: LibraryFdr): string {
  return `${name}_library_pep${percentNumber(fdr.peptide)}%_xl${percentNumber(fdr.xl)}%.tsv`
}

/** What the export writes: the library, its TSV and the declarations of its adducts. */
export type LibraryExport = {
  library: Library
  /** DIA-NN's `--mod` lines of the library's adducts, by name */
  mods: string[]
  /** adducts whose mass is not known (no line) */
  unknownMods: string[]
}

/**
 * The b and y fragments of each annotation of a model, parsed once (the dialog builds its library at each change of
 * its FDRs; the annotations are the model's, and a parse of them most of the work).
 */
const fragmentCache = new WeakMap<ResultModel, Map<string, LibraryFragment[]>>()

function cachedFragments(m: ResultModel): (annotation: string) => LibraryFragment[] {
  let cache = fragmentCache.get(m)
  if (!cache) fragmentCache.set(m, (cache = new Map()))
  const known = cache
  return (annotation) => {
    let f = known.get(annotation)
    if (!f) known.set(annotation, (f = libraryFragments(annotation)))
    return f
  }
}

/**
 * The library of model `m` at `fdr`, its retention times also as iRT by `irt` (null: none). The adducts' masses are
 * OpenNuXL's (NuXL:NA_MASS_z0), else of their formulas with the nucleotides of the search (`parameters`, `preset`).
 */
export function libraryExport(
  m: ResultModel,
  fdr: LibraryFdr,
  irt: IrtFit | null,
  search: { parameters: Record<string, unknown>; preset?: string },
): LibraryExport {
  const library = buildLibrary(libraryHits(m, fdr), irt, cachedFragments(m))
  const masses = new Map(library.adducts)
  let nucleotides: ReturnType<typeof targetNucleotides> | null = null
  for (const [name, mass] of masses) {
    if (!Number.isNaN(mass)) continue
    nucleotides ??= targetNucleotides(search.parameters, search.preset)
    masses.set(name, adductFormulaMass(name, nucleotides))
  }
  const { lines, unknown } = diannModLines(masses)
  return { library, mods: lines, unknownMods: unknown }
}

/** The TSV of an export (`libraryTsv`) and the text of its declarations file (one line each; '' none). */
export function exportTexts(e: LibraryExport): { tsv: string; mods: string } {
  return { tsv: libraryTsv(e.library), mods: e.mods.length > 0 ? e.mods.join('\n') + '\n' : '' }
}
