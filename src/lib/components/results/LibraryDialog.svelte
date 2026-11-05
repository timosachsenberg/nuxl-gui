<script lang="ts">
  // Export → "Spectral library (DIA-NN TSV)…": a DIA-NN library of the search's target peptides and localized
  // cross-links (results/library/, docs/design.md §5). Its own two FDRs (1 %, or the search's tighter cutoff; never
  // looser than the search's), whatever the tables' filters; an optional iRT reference; live counts; DIA-NN's
  // declarations of the adducts to copy. Save writes the TSV where the user chooses and the declarations beside it
  // (`<name>_diann_mods.txt`); one that exists is replaced only when the user says so here.
  import FdrInput from '$lib/components/FdrInput.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { formatPercent } from '$lib/format/fdr'
  import { exportName, saveLibrary } from '$lib/results/exports'
  import { formatCount } from '$lib/results/display'
  import { defaultLibraryFdr, exportTexts, libraryExport, libraryFileName, validLibraryFdr } from '$lib/results/library/export'
  import { fitIrt, readIrtReference, referenceText, type IrtFit } from '$lib/results/library/irt'
  import type { ResultsView } from '$lib/results/view.svelte'

  let { view, open = $bindable(false) }: { view: ResultsView; open?: boolean } = $props()

  const m = $derived(view.model)
  let peptideFdr = $state(0.01)
  let xlFdr = $state(0.01)
  /** The iRT reference: its file's name and its fit; or what is wrong with it. */
  let reference = $state<{ name: string; fit: IrtFit } | null>(null)
  let referenceProblem = $state<string | null>(null)
  let referenceInput = $state<HTMLInputElement | null>(null)
  let saving = $state(false)
  let saved = $state<string | null>(null)
  let problem = $state<string | null>(null)
  let copied = $state<string | null>(null)
  /** The declarations file that exists, while the user decides whether to replace it. */
  let replacing = $state<{ name: string; answer: (replace: boolean) => void } | null>(null)

  // each opening starts from the defaults (the reference stays: the same LC setup)
  $effect(() => {
    if (!open) return
    const d = defaultLibraryFdr(view.model)
    peptideFdr = d.peptide
    xlFdr = d.xl
    saved = null
    problem = null
    copied = null
  })

  const fdr = $derived({ peptide: peptideFdr, xl: xlFdr })
  const valid = $derived(validLibraryFdr(m, fdr))
  const search = $derived({ parameters: view.result.settings.parameters, preset: view.result.outcome.nuxl?.preset })
  const built = $derived(open && valid ? libraryExport(m, fdr, reference?.fit ?? null, search) : null)
  const library = $derived(built?.library ?? null)
  const fileName = $derived(libraryFileName(exportName(view.result), fdr))
  const hasXl = $derived(m.xlPsms > 0)
  /** What the library leaves out, said. */
  const leftOut = $derived(
    library
      ? [
          library.unlocalized > 0 ? `${formatCount(library.unlocalized)} cross-link PSMs not localized` : '',
          library.withoutFragments > 0 ? `${formatCount(library.withoutFragments)} precursors without b or y ions` : '',
        ]
          .filter((s) => s !== '')
          .join('; ')
      : '',
  )

  const fieldTitle =
    "The library's own cutoffs: every target PSM within them, from every file, whatever the tables' filters. They can be tighter than the search's, not looser."

  async function chooseReference(input: HTMLInputElement) {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    referenceProblem = null
    try {
      const { rt, irt } = readIrtReference(await referenceText(new Uint8Array(await file.arrayBuffer())))
      reference = { name: file.name, fit: fitIrt(rt, irt) }
    } catch (e) {
      reference = null
      referenceProblem = `${file.name}: ${String((e as Error)?.message ?? e)}`
    }
  }

  async function copyMods() {
    const text = built?.mods.join('\n') ?? ''
    try {
      await navigator.clipboard.writeText(text)
      copied = 'Copied.'
    } catch {
      copied = 'The clipboard is not available: select the lines and copy them.'
    }
  }

  /** The user's answer about a declarations file that exists (the save dialog asked about the TSV only). */
  function askReplace(path: string): Promise<boolean> {
    const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
    return new Promise((resolve) => {
      replacing = {
        name,
        answer: (replace) => {
          replacing = null
          resolve(replace)
        },
      }
    })
  }

  async function save() {
    if (!built || !library || library.precursors.length === 0) return
    saving = true
    saved = null
    problem = null
    try {
      const { tsv, mods } = exportTexts(built)
      const written = await saveLibrary(fileName, tsv, mods, askReplace)
      if (written) saved = written.companion ? `Saved ${written.path}, and the declarations as ${written.companion}.` : `Saved ${written.path}.`
    } catch (e) {
      problem = String((e as Error)?.message ?? e)
    } finally {
      saving = false
      replacing?.answer(false)
    }
  }

  // closing the dialog while it asks: no
  $effect(() => {
    if (!open) replacing?.answer(false)
  })
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="gap-4 sm:max-w-lg" data-testid="library-dialog">
    <Dialog.Header>
      <Dialog.Title>Spectral library (DIA-NN TSV)</Dialog.Title>
      <Dialog.Description>
        A library for DIA-NN of the search's target peptides and localized cross-links, with the b and y ions NuXL
        annotated in their spectra: one entry per peptide, adduct and charge, the best-scoring one.
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid gap-3 sm:grid-cols-2" title={fieldTitle}>
      <div class="grid gap-2">
        <label for="library-peptide-fdr" class="text-xs font-medium">Peptide FDR</label>
        <FdrInput id="library-peptide-fdr" bind:value={peptideFdr} max={m.psmFdr} />
      </div>
      <div class="grid gap-2">
        <label for="library-xl-fdr" class="text-xs font-medium">Cross-link FDR</label>
        <FdrInput id="library-xl-fdr" bind:value={xlFdr} max={m.xlFdr} disabled={!hasXl} />
      </div>
    </div>
    <p class="-mt-1 text-xs text-muted-foreground">
      Libraries are usually built at 1 %: DIA-NN controls its own FDR on the DIA data, but cannot remove wrong spectra from
      the library. The search's cutoffs are {formatPercent(m.psmFdr)} for peptides and {formatPercent(m.xlFdr)} for cross-links;
      you can tighten them here. A looser cutoff needs a new search. The tables' filters do not apply.
    </p>

    <div class="grid gap-1.5 text-xs">
      <span class="font-medium">iRT reference (optional)</span>
      <div class="flex min-w-0 items-center gap-2">
        <Button variant="outline" size="xs" onclick={() => referenceInput?.click()} data-testid="library-irt-choose">Choose .tsv…</Button>
        {#if reference}
          <span class="min-w-0 truncate" title={reference.name}>{reference.name}</span>
          <Button variant="ghost" size="xs" onclick={() => (reference = null)} aria-label="Remove the iRT reference">Remove</Button>
        {/if}
        <input bind:this={referenceInput} type="file" accept=".tsv,.txt,.gz" hidden onchange={(e) => chooseReference(e.currentTarget)} />
      </div>
      {#if reference}
        <p class="text-muted-foreground" data-testid="library-irt-fit">
          NormalizedRetentionTime = {reference.fit.intercept.toFixed(3)} + {reference.fit.slope.toPrecision(6)} × RT (s), a straight line
          fitted to the reference's {formatCount(reference.fit.points)} rows.
        </p>
      {:else}
        <p class="text-muted-foreground">
          A library of the same LC setup (MSFragger / EasyPQP library.tsv, with RT and iRT columns): a straight line of its
          iRT over its retention time gives the NormalizedRetentionTime. Without one the column stays empty.
        </p>
      {/if}
      {#if referenceProblem}
        <p class="text-destructive" role="alert">{referenceProblem}</p>
      {/if}
    </div>

    {#if library}
      <div class="grid gap-1 text-xs" data-testid="library-counts">
        <p>
          <span class="font-medium tabular-nums">{formatCount(library.precursors.length)} precursors</span>:
          {formatCount(library.peptides)} peptides, {formatCount(library.crossLinks)} cross-links ·
          <span class="tabular-nums">{formatCount(library.fragments)} fragments</span> ·
          {formatCount(library.adducts.size)} adducts
        </p>
        {#if leftOut}
          <p class="text-muted-foreground">Left out: {leftOut}.</p>
        {/if}
      </div>
    {/if}

    {#if built && (built.mods.length > 0 || built.unknownMods.length > 0)}
      <div class="grid gap-1.5 text-xs">
        <div class="flex items-center gap-2">
          <span class="font-medium">DIA-NN declarations of the adducts</span>
          {#if built.mods.length > 0}
            <Button variant="outline" size="xs" class="ml-auto" onclick={copyMods} data-testid="library-mods-copy">Copy</Button>
          {/if}
        </div>
        {#if built.mods.length > 0}
          <pre class="max-h-28 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-snug select-text" data-testid="library-mods">{built.mods.join('\n')}</pre>
          <p class="text-muted-foreground">
            DIA-NN: paste into Additional options (or add to the command line) so that it knows the adduct masses. Saved
            beside the library as {fileName.replace(/\.tsv$/, '')}_diann_mods.txt.
          </p>
        {/if}
        {#if built.unknownMods.length > 0}
          <p class="text-destructive" data-testid="library-mods-unknown">The mass of {built.unknownMods.join(', ')} is not known: declare {built.unknownMods.length > 1 ? 'them' : 'it'} yourself.</p>
        {/if}
        {#if copied}<p class="text-muted-foreground" role="status">{copied}</p>{/if}
      </div>
    {/if}

    {#if replacing}
      <div class="grid gap-2 rounded-md border border-destructive/40 p-3 text-xs" role="alertdialog" aria-label="Replace {replacing.name}?">
        <p><span class="font-medium">Replace {replacing.name}?</span> A file of that name is beside the library already.</p>
        <div class="flex justify-end gap-2">
          <Button variant="outline" size="xs" onclick={() => replacing?.answer(false)}>Cancel</Button>
          <Button size="xs" onclick={() => replacing?.answer(true)} data-testid="library-replace">Replace</Button>
        </div>
      </div>
    {/if}
    {#if saved}<p class="text-xs break-all text-muted-foreground" role="status">{saved}</p>{/if}
    {#if problem}<p class="text-xs text-destructive" role="alert">{problem}</p>{/if}

    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (open = false)}>Close</Button>
      <span title={library && library.precursors.length === 0 ? 'No peptide or localized cross-link passes these cutoffs' : undefined}>
        <Button size="sm" disabled={saving || !library || library.precursors.length === 0} onclick={save} data-testid="library-save"
          >{saving ? 'Saving…' : 'Save library…'}</Button>
      </span>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
