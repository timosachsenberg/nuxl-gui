// Show search folder: what opens (the system's file manager, by its name) and when a folder can be shown. The shim
// finds the folder by the search's id (src-tauri/src/history.rs `show_folder`); the page never names a path.

/** The system's file manager: Finder (macOS), Explorer (Windows), else the file manager. */
export function fileManager(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'Finder'
  if (/Windows/.test(userAgent)) return 'Explorer'
  return 'the file manager'
}

/** The tooltip of Show search folder: what opens, and what the folder holds. */
export function showFolderTitle(userAgent?: string): string {
  return (
    `Opens the search's folder in ${fileManager(userAgent)}: OpenNuXL's outputs (nuxl/: idXML, TSV), its log ` +
    `(nuxl.log) and the search's record`
  )
}

/** A search id as the shim makes them (src-tauri/src/files.rs `valid_id`): a folder of History that it can show. */
export function canShowFolder(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id)
}
