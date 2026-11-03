// What kind of input a path is, by its name: the shim searches `.mzML` (OpenNuXL reads plain mzML only) and reads
// the database from `.fasta`, `.fa` or `.faa` (src-tauri/src/args.rs). The sizes and counts New search shows
// come from the shim (`inspect_files`), which reads the files where they are.

export const isMzML = (name: string) => /\.mzml$/i.test(name)
export const isFasta = (name: string) => /\.(fasta|fa|faa)$/i.test(name)

const isCompressedMzML = (name: string) => /\.mzml\.(gz|bz2|zip)$/i.test(name)
const isRaw = (name: string) => /\.raw$/i.test(name)

/** "a", "a and b", "a, b and c" */
function listed(items: string[]): string {
  return items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

/**
 * What New search says of files it cannot add (`names`: neither mzML nor FASTA), one sentence per kind: compressed
 * mzML, Thermo .raw, anything else; each with what to do instead. [] for no names.
 */
export function unsearchableReason(names: string[]): string[] {
  const compressed = names.filter(isCompressedMzML)
  const raw = names.filter(isRaw)
  const other = names.filter((n) => !isCompressedMzML(n) && !isRaw(n))
  const notices: string[] = []
  if (compressed.length > 0) {
    notices.push(
      `${listed(compressed)} ${compressed.length === 1 ? 'is' : 'are'} compressed. OpenNuXL reads plain mzML only: ` +
        `decompress ${compressed.length === 1 ? 'it' : 'them'} first (e.g. with gunzip), then add the .mzML.`,
    )
  }
  if (raw.length > 0) {
    notices.push(
      `${listed(raw)}: Thermo raw files cannot be searched directly. Convert ${raw.length === 1 ? 'it' : 'them'} to mzML ` +
        'first, e.g. with ThermoRawFileParser or ProteoWizard msconvert.',
    )
  }
  if (other.length > 0) {
    notices.push(`Not an mzML file: ${other.join(', ')}. Convert vendor files to mzML first, e.g. with ProteoWizard msconvert.`)
  }
  return notices
}
