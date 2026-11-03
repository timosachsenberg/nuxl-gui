<script lang="ts">
  // Closing the window while a search runs: the app keeps the window and asks here first. Closing ends
  // ProSE, and the search leaves nothing behind; "Keep searching" leaves the window open. (Closing the
  // window again before an answer closes it: the app's rule, src-tauri/src/lib.rs `close_requested`.)
  // Should the search end while the question is open, the app is answered "keep" at once (so that a later
  // close with a search running asks again), and the question says what is left (search/close-guard.ts).
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { answerClose, onCloseRequested } from '$lib/desktop'
  import { GUARD_TEXT, guardState } from '$lib/search/close-guard'
  import { searchRun } from '$lib/search/session.svelte'
  import { onMount } from 'svelte'

  let open = $state(false)
  /** The question has been answered with a button (the dialog's own close is "keep"). */
  let answered = false
  /** The app has been answered "keep" because the search ended while the question was open. */
  let released = false

  const phase = $derived(guardState(searchRun))
  const text = $derived(GUARD_TEXT[phase])

  onMount(() => {
    let stop: (() => void) | null = null
    let gone = false
    void onCloseRequested(() => {
      answered = false
      released = false
      open = true
    }).then((unlisten) => {
      if (gone) unlisten()
      else stop = unlisten
    })
    return () => {
      gone = true
      stop?.()
    }
  })

  $effect(() => {
    if (open && phase !== 'running' && !answered && !released) {
      released = true
      void answerClose(false)
    }
  })

  function answer(close: boolean) {
    answered = true
    open = false
    void answerClose(close)
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(next) => {
    if (!next && !answered) void answerClose(false)
  }}>
  <Dialog.Content class="gap-4 sm:max-w-sm" data-testid="close-guard" data-search={phase}>
    <Dialog.Header>
      <Dialog.Title>{text.title}</Dialog.Title>
      <Dialog.Description>{text.description}</Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => answer(false)}>{text.keep}</Button>
      <Button variant={phase === 'running' ? 'destructive' : 'default'} size="sm" onclick={() => answer(true)}>{text.close}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
