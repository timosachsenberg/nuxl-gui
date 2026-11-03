// What kind of input a path is, by its name: the shim searches `.mzML` and `.mzML.gz` and reads the
// database from `.fasta`, `.fa` or `.faa` (src-tauri/src/args.rs). The sizes and counts New search shows
// come from the shim (`inspect_files`), which reads the files where they are.

export const isMzML = (name: string) => /\.mzml(\.gz)?$/i.test(name)
export const isFasta = (name: string) => /\.(fasta|fa|faa)$/i.test(name)
