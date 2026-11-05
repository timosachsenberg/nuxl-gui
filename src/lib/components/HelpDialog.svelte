<script lang="ts">
  // The help (lib/help/help.ts): the sections in a list at the left, their text at the right, opened at the section
  // that fits the view (helpState.section); a click in the list scrolls to its section.
  import * as Dialog from '$lib/components/ui/dialog'
  import { helpSections, type HelpSectionId } from '$lib/help/help'
  import { helpState } from '$lib/help/help.svelte'
  import { cn } from '$lib/utils'
  import { tick } from 'svelte'

  let body = $state<HTMLElement | null>(null)
  /** The section in sight (marked in the list). */
  let current = $state<HelpSectionId>('start')

  function show(id: HelpSectionId, smooth = false) {
    current = id
    body?.querySelector(`#help-${id}`)?.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' })
  }

  // opened: at its section
  $effect(() => {
    if (!helpState.open) return
    const id = helpState.section
    void tick().then(() => show(id))
  })

  /** The section whose heading is at (or last above) the top of the text: the list marks it while scrolling. */
  function onscroll() {
    if (!body) return
    const top = body.getBoundingClientRect().top + 24
    let id = helpSections[0].id
    for (const s of helpSections) {
      const heading = body.querySelector(`#help-${s.id}`)
      if (heading && heading.getBoundingClientRect().top <= top) id = s.id
    }
    current = id
  }
</script>

<Dialog.Root bind:open={helpState.open}>
  <!-- the focus goes to the text (scrolled to the section, scrollable by keys), not to the first entry of the list -->
  <Dialog.Content
    class="flex h-[min(80vh,760px)] flex-col gap-0 p-0 sm:max-w-3xl"
    data-testid="help-dialog"
    onOpenAutoFocus={(e) => {
      e.preventDefault()
      body?.focus({ preventScroll: true })
    }}>
    <Dialog.Header class="border-b px-5 py-3.5">
      <Dialog.Title>Help</Dialog.Title>
      <Dialog.Description class="text-xs">How NuXL works, its views and terms. Hover over a label or a column header for more.</Dialog.Description>
    </Dialog.Header>
    <div class="flex min-h-0 flex-1">
      <nav aria-label="Help sections" class="w-44 flex-none overflow-auto border-r p-2">
        {#each helpSections as s (s.id)}
          <button
            type="button"
            class={cn(
              'block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-muted',
              current === s.id ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground',
            )}
            aria-current={current === s.id ? 'true' : undefined}
            onclick={() => show(s.id, true)}>{s.title}</button
          >
        {/each}
      </nav>
      <div bind:this={body} {onscroll} tabindex="-1" class="min-w-0 outline-none flex-1 overflow-auto px-5 pt-3 pb-[40vh] text-[13px] leading-relaxed" data-testid="help-body">
        {#each helpSections as s (s.id)}
          <section aria-labelledby="help-{s.id}" class="mb-5">
            <h3 id="help-{s.id}" class="mb-1.5 scroll-mt-3 text-sm font-semibold">{s.title}</h3>
            {#if s.intro}<p class="mb-2">{s.intro}</p>{/if}
            <dl class="grid gap-1.5">
              {#each s.items as item, i (i)}
                <div>
                  {#if item.term}<dt class="inline font-medium">{item.term}:</dt>{' '}{/if}<dd class="inline text-muted-foreground">{item.text}</dd>
                </div>
              {/each}
            </dl>
          </section>
        {/each}
      </div>
    </div>
  </Dialog.Content>
</Dialog.Root>
