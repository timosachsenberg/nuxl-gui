// The exports of the Export menu: the current view as CSV, the design, the idXML of a searched file, the spectral
// library (with its DIA-NN declarations beside it); each saved where the user chooses (the system's save dialog).

import { writeDesignTsv } from '../design/design-tsv'
import { errorText, saveSearchFile, saveText, saveTextWithCompanion, searchFiles, type SavedWithCompanion } from '../desktop'
import { MODS_SUFFIX } from './library/mods'
import type { SearchFiles } from './read'
import { download } from '../download'
import type { OpenResult } from '../search/session.svelte'
import { resultName } from './display'
import type { ResultsView } from './view.svelte'

/** The name of a result's exports (see `resultName`). */
export function exportName(result: OpenResult): string {
  return resultName(result.design.rows.map((r) => r.fileName))
}

/** After the webview has painted (so that "Exporting…" shows before a long export). */
const painted = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))

/**
 * The current level's view as `<name>-<level>.csv` (`view.exporting` meanwhile); false on a tab
 * without a table or while an export runs.
 */
export async function exportCsv(view: ResultsView): Promise<boolean> {
  const level = view.level
  if (!level || view.exporting) return false
  view.exporting = true
  try {
    await painted()
    await download(`${exportName(view.result)}-${level.level}.csv`, level.csv(), 'text/csv;charset=utf-8')
    return true
  } finally {
    view.exporting = false
  }
}

/** The design of the searched files as `<name>_design.tsv` (OpenMS' one-table format). */
export async function exportDesign(result: OpenResult): Promise<void> {
  await download(`${exportName(result)}_design.tsv`, writeDesignTsv(result.design), 'text/tab-separated-values')
}

/** The idXML exports of a result: one per searched file (OpenNuXL runs once per input), by its position. */
export function idXMLFiles(result: OpenResult): { input: number; label: string }[] {
  const rows = result.design.rows
  return rows.map((r, k) => ({ input: k, label: rows.length > 1 ? `idXML: ${r.fileName}` : 'idXML' }))
}

/** The name of a file without its directories and its extension(s) (`.mzML`, `.mzML.gz`, `.raw`, a folder's `.d`). */
const stemOf = (name: string) => {
  const path = name.replace(/(.)[\\/]+$/, '$1')
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).replace(/\.(mzML(\.gz)?|raw|d)$/i, '')
}

/**
 * The idXML of input `input` (every PSM of its OpenNuXL run, targets and decoys, before the FDR filter:
 * `nuxl/<stem>.idXML`, docs/design.md §2), saved as `<file>.idXML`. The stem is the one of the folder's inputs.json
 * (`files` reads the folder; default: the desktop's).
 */
export async function exportIdXML(result: OpenResult, input = 0, files: SearchFiles = searchFiles(result.id)): Promise<void> {
  let records: unknown
  try {
    records = JSON.parse(new TextDecoder().decode(await files('inputs.json')))
  } catch (e) {
    throw new Error(`The search's inputs.json cannot be read (${errorText(e)}).`, { cause: e })
  }
  const record = Array.isArray(records)
    ? (records as { index?: number; stem?: unknown }[]).find((r, k) => (typeof r.index === 'number' ? r.index : k) === input)
    : undefined
  if (!record || typeof record.stem !== 'string' || record.stem === '') throw new Error(`The search has no input ${input + 1}.`)
  const name = result.design.rows[input]?.fileName ?? record.stem
  await saveSearchFile(result.id, `nuxl/${record.stem}.idXML`, `${stemOf(name)}.idXML`)
}

/**
 * The spectral library `tsv` saved as `name` where the user chooses, and DIA-NN's declarations of its adducts `mods`
 * beside it (`<chosen stem>_diann_mods.txt`; none when '': a library without cross-links). A declarations file that
 * exists is replaced only when `replace` (asked with its path) says so. Resolves with the paths (`companion` '' when
 * none was written), or null if the user cancelled.
 */
export async function saveLibrary(
  name: string,
  tsv: string,
  mods: string,
  replace: (path: string) => Promise<boolean>,
): Promise<SavedWithCompanion | null> {
  await painted()
  if (mods === '') {
    const path = await saveText(name, tsv)
    return path === null ? null : { path, companion: '' }
  }
  return saveTextWithCompanion(name, tsv, MODS_SUFFIX, mods, replace)
}
