// The system's file dialogs, one at a time. Each is a window of its own that the page cannot see: a second
// click on "Add files" (or an export) while one is open would open another, and the two would answer in turn.
// While a dialog is open, another asked for is not shown and counts as cancelled.

let open = false

/** A dialog is open. */
export function dialogOpen(): boolean {
  return open
}

/** Shows the dialog of `show`, unless one is open: then resolves with `cancelled` at once. */
export async function oneDialog<T>(cancelled: T, show: () => Promise<T>): Promise<T> {
  if (open) return cancelled
  open = true
  try {
    return await show()
  } finally {
    open = false
  }
}
