// Whether the help is open, and at which section (HelpDialog.svelte; the top bar's button and F1 open it).
import type { HelpSectionId } from './help'

export const helpState = $state({ open: false, section: 'start' as HelpSectionId })

/** Opens the help at `section`. */
export function openHelp(section: HelpSectionId): void {
  helpState.section = section
  helpState.open = true
}
