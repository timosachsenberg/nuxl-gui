// What kind of input a path is, by its name: the shim searches `.mzML` files, Thermo `.raw` files and Bruker timsTOF
// `.d` folders (OpenNuXL reads all three; src-tauri/src/args.rs) and reads the database from `.fasta`, `.fa` or
// `.faa`. The sizes and counts New search shows come from the shim (`inspect_files`), which reads the files where they
// are and also says what a name cannot tell: a `.d` that is not a timsTOF folder, a `.raw` that is a folder (Waters).

/**
 * The path without trailing separators: a folder from the dialog or a drop may end in `/` or `\` (`run.d/`). A path
 * of separators only keeps its first (as the shim's `input_path`).
 */
export function withoutTrailingSeparator(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed === '' ? path.slice(0, 1) : trimmed
}

/** The last part of a path (either separator), trailing separators ignored. */
function lastName(path: string): string {
  return withoutTrailingSeparator(path).split(/[\\/]/).pop() ?? path
}

export const isMzML = (name: string) => /\.mzml$/i.test(lastName(name))
/** A Thermo raw file (the shim refuses a `.raw` folder: that is Waters data). */
export const isRaw = (name: string) => /\.raw$/i.test(lastName(name))
/** A Bruker timsTOF folder by its name (`run.d`, `run.d/`); the shim checks that it holds analysis.tdf or analysis.tsf. */
export const isTimsD = (name: string) => /\.d$/i.test(lastName(name))
/** What the search takes as spectra: mzML, Thermo .raw, Bruker timsTOF .d. */
export const isSpectra = (name: string) => isMzML(name) || isRaw(name) || isTimsD(name)
export const isFasta = (name: string) => /\.(fasta|fa|faa)$/i.test(lastName(name))

const isCompressedMzML = (name: string) => /\.mzml\.(gz|bz2|zip)$/i.test(name)
const isZippedD = (name: string) => /\.d\.zip$/i.test(name)

/** The files in a timsTOF folder a file manager may drop instead of the folder itself. */
const TIMS_DATA = /^analysis\.(tdf|tdf_bin|tsf|tsf_bin)$/i

/**
 * The input a dropped or chosen path stands for: without trailing separators, and the `.d` folder for a file of it
 * (`run.d/analysis.tdf`: a file manager that opened the folder drops its files). Anything else unchanged.
 */
export function inputPath(path: string): string {
  const p = withoutTrailingSeparator(path)
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (cut > 0 && TIMS_DATA.test(p.slice(cut + 1)) && isTimsD(p.slice(0, cut))) return p.slice(0, cut)
  return p
}

/** The folder a path is in ('' for none), trailing separators ignored. */
function parentOf(path: string): string {
  const p = withoutTrailingSeparator(path)
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return cut > 0 ? p.slice(0, cut) : ''
}

/**
 * Whether `path` is one of the other files of a .d folder in `folders` (`run.d/SampleInfo.xml`, `run.d/chromatography-
 * data.sqlite`): a file manager that opened the folder drops them with analysis.tdf ("select all"). They are part of
 * the folder's input, not inputs of their own.
 */
export function isInTimsFolder(path: string, folders: ReadonlySet<string>): boolean {
  const parent = parentOf(path)
  return parent !== '' && isTimsD(parent) && folders.has(parent)
}

/**
 * What New search says of folders it cannot add as a timsTOF .d (`names`: chosen in the .d folder dialog, or given
 * with a trailing separator, and not named .d): typically the folder that holds the .d runs. [] for no names.
 */
export function notTimsFolderReason(names: string[]): string[] {
  if (names.length === 0) return []
  return [
    `${listed(names)} ${names.length === 1 ? 'is not a Bruker timsTOF .d folder' : 'are not Bruker timsTOF .d folders'}: ` +
      'choose the .d folders themselves (e.g. run.d), not the folder that holds them.',
  ]
}

/** "a", "a and b", "a, b and c" */
function listed(items: string[]): string {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * What New search says of files it cannot add (`names`: neither spectra nor FASTA), one sentence per kind: compressed
 * mzML, a zipped .d folder, anything else; each with what to do instead. [] for no names.
 */
export function unsearchableReason(names: string[]): string[] {
  const compressed = names.filter(isCompressedMzML)
  const zipped = names.filter(isZippedD)
  const other = names.filter((n) => !isCompressedMzML(n) && !isZippedD(n))
  const notices: string[] = []
  if (compressed.length > 0) {
    notices.push(
      `${listed(compressed)} ${compressed.length === 1 ? 'is' : 'are'} compressed. OpenNuXL reads plain mzML only: ` +
        `decompress ${compressed.length === 1 ? 'it' : 'them'} first (e.g. with gunzip), then add the .mzML.`,
    )
  }
  if (zipped.length > 0) {
    notices.push(
      `${listed(zipped)} ${zipped.length === 1 ? 'is a zipped Bruker .d folder' : 'are zipped Bruker .d folders'}: ` +
        `unzip ${zipped.length === 1 ? 'it' : 'them'} first, then add the .d ${zipped.length === 1 ? 'folder' : 'folders'}.`,
    )
  }
  if (other.length > 0) {
    notices.push(
      `Not a spectra file: ${other.join(', ')}. NuXL searches mzML, Thermo .raw or Bruker timsTOF .d; convert other ` +
        'vendor files to mzML first, e.g. with ProteoWizard msconvert.',
    )
  }
  return notices
}
