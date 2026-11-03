// What the close guard (CloseGuard.svelte) says when the window is closed during a search: while OpenNuXL runs,
// that closing stops it and keeps nothing; once OpenNuXL has ended (the search may end while the question is
// open), that the search is saved in History, or that nothing runs any more.

import type { RunStatus } from './session.svelte'

export type GuardState = 'running' | 'saved' | 'ended'

/**
 * Where the search is, for the guard: OpenNuXL runs; it has ended and the search is saved (its results may still
 * be read: the record was written first); or it failed, was cancelled, or there is none.
 */
export function guardState(run: { status: RunStatus; toolEnded: boolean }): GuardState {
  if (run.status === 'running' && !run.toolEnded) return 'running'
  if (run.toolEnded || run.status === 'done') return 'saved'
  return 'ended'
}

export const GUARD_TEXT: Record<GuardState, { title: string; description: string; keep: string; close: string }> = {
  running: {
    title: 'A search is running',
    description: 'If you close NuXL now, the search stops and nothing from it is kept.',
    keep: 'Keep searching',
    close: 'Close NuXL',
  },
  saved: {
    title: 'The search has finished',
    description: 'It is saved in History. You can close NuXL now.',
    keep: 'Keep NuXL open',
    close: 'Close NuXL',
  },
  ended: {
    title: 'The search has ended',
    description: 'No search is running any more. You can close NuXL now.',
    keep: 'Keep NuXL open',
    close: 'Close NuXL',
  },
}
