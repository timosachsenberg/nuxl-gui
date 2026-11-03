// What a search of this session does when it finishes: on New search, where its progress shows, its results
// open. Anywhere else (History with a name being edited, another result, a PSM) the user stays where they are,
// the result that is open stays open, and a notification links to the new results (App.svelte's Toaster).

import { toast } from 'svelte-sonner'
import type { Route } from '../route'
import { navigate, router } from '../route.svelte'
import { searchRun } from './session.svelte'

/** Whether a search that finishes now opens its results: only while New search (with its progress) is shown. */
export function opensWhenFinished(route: Route): boolean {
  return route.view === 'search'
}

/** `runSearch`'s `keepOpen`: the open result stays open unless the finished search opens. */
export function keepsOpenResult(): boolean {
  return !opensWhenFinished(router.route)
}

/** "a.mzML", "a.mzML and b.mzML", "a.mzML and 4 more". */
export function filesText(files: string[]): string {
  if (files.length <= 2) return files.join(' and ')
  return `${files[0]} and ${files.length - 1} more`
}

/** How long the notification stays (ms): long enough to be seen on coming back to the window. */
export const FINISHED_NOTICE_MS = 30_000

/** Shows search `id`, which has just finished: its results, or a notification with a link to them. */
export function showFinished(id: string): void {
  const open = () => navigate({ view: 'results', id })
  if (opensWhenFinished(router.route)) {
    open()
    return
  }
  toast.success('Search finished', {
    id: `finished-${id}`,
    description: `${filesText(searchRun.files)}. The results are saved in History.`,
    duration: FINISHED_NOTICE_MS,
    action: { label: 'Open results', onClick: open },
  })
}
