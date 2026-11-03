<script lang="ts">
  // The one filter row of a level: text; the kind (all, cross-links, peptides; on proteins: cross-linked ones);
  // on peptides and PSMs the q-value cutoffs of the peptide PSMs and of the cross-links (tightening the search's
  // only), the adduct and the nucleotide; on proteins the minimum peptides and "found in" (OpenNuXL has no protein
  // FDR: the proteins count the PSMs at the search's cutoffs); contaminants as a chip; "n of total".
  import FdrInput from '$lib/components/FdrInput.svelte'
  import ChoiceSelect from '$lib/components/search/ChoiceSelect.svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Popover from '$lib/components/ui/popover'
  import { formatPercent, formatQ } from '$lib/format/fdr'
  import { adductLabel } from '$lib/format/peptide'
  import { formatCount, parseAccession } from '$lib/results/display'
  import { crossLinkChoices, type Kind } from '$lib/results/filters'
  import type { LevelState, ResultsView } from '$lib/results/view.svelte'
  import { cn } from '$lib/utils'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import { untrack } from 'svelte'
  import SearchIcon from '@lucide/svelte/icons/search'
  import XIcon from '@lucide/svelte/icons/x'

  let { view, level }: { view: ResultsView; level: LevelState } = $props()

  const names = {
    proteins: { filter: 'Filter proteins', placeholder: 'Accession, gene, name, peptide…', q: '' },
    peptides: { filter: 'Filter peptides', placeholder: 'Sequence, modification, accession…', q: 'Best PSM q-value' },
    psms: { filter: 'Filter PSMs', placeholder: 'Sequence, modification, accession…', q: 'PSM FDR' },
  } as const
  const name = $derived(names[level.level])
  const m = $derived(view.model)
  const qId = $derived(`q-filter-${level.level}`)
  const xlId = $derived(`xl-filter-${level.level}`)

  /** The search has cross-links (any PSM row is one): the kind filter and the cross-link cutoff show. */
  const hasXl = $derived(m.tables.psms.xl.isXL.includes(1))
  const kinds = $derived<{ value: Kind; label: string; title: string }[]>(
    level.level === 'proteins'
      ? [
          { value: 'all', label: 'All', title: 'All proteins' },
          { value: 'xl', label: 'Cross-linked', title: 'Proteins with a cross-link PSM within the cross-link FDR' },
        ]
      : [
          { value: 'all', label: 'All', title: `All ${level.level === 'psms' ? 'PSMs' : 'peptides'}` },
          { value: 'xl', label: 'Cross-links', title: `Cross-linked ${level.level === 'psms' ? 'PSMs' : 'peptides'} only` },
          { value: 'peptide', label: 'Peptides', title: `${level.level === 'psms' ? 'PSMs of peptides' : 'Peptides'} without a cross-link only` },
        ],
  )

  // the adducts and nucleotides of the search's PSMs; '*' is any (a select's value cannot be empty)
  const ANY = '*'
  const choices = $derived(crossLinkChoices(m))
  const adductOptions = $derived([
    { value: ANY, label: 'Any adduct' },
    ...choices.adducts.map((c) => ({ value: c.value, label: `${adductLabel(c.value)} (${formatCount(c.psms)})` })),
  ])
  const nucleotideOptions = $derived([
    { value: ANY, label: 'Any nucleotide' },
    ...choices.nucleotides.map((c) => ({ value: c.value, label: `${adductLabel(c.value)} (${formatCount(c.psms)})` })),
  ])
  /** The cutoff popover's trigger: the peptide PSMs' and, with cross-links, theirs. */
  const qSummary = $derived(
    hasXl
      ? `${name.q} ≤ ${formatPercent(level.filters.maxQ)} · XL ≤ ${formatPercent(level.filters.maxXlQ)}`
      : `${name.q} ≤ ${formatPercent(level.filters.maxQ)}`,
  )

  /** The peptide (ProForma) that the PSM table is restricted to ("All n in the PSM table"). */
  const peptide = $derived.by(() => {
    const k = level.filters.peptideFilter
    return k === undefined || level.level !== 'psms' ? null : (view.model.tables.peptides.proforma[k] ?? null)
  })

  /** The protein the table is restricted to ("Open in PSM table"), as its accession shows in the tables. */
  const protein = $derived.by(() => {
    const p = level.filters.proteinFilter
    if (p === undefined || level.level === 'proteins') return null
    const accession = view.model.tables.proteins.accession[p]
    return accession === undefined ? null : { id: parseAccession(accession).id, accession }
  })

  // typing filters after a short pause, so that 150,000 PSMs are not filtered on every key
  // the bar is made anew for each level (Results keys it), so the first value is the one
  // svelte-ignore state_referenced_locally
  let draft = $state(level.filters.text)
  let timer: ReturnType<typeof setTimeout> | undefined
  function type(event: Event & { currentTarget: HTMLInputElement }) {
    draft = event.currentTarget.value
    clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      level.filters.text = draft
    }, 150)
  }
  function clearText() {
    clearTimeout(timer)
    timer = undefined
    draft = ''
    level.filters.text = ''
  }
  // a text the view set itself (opening a PSM that the text hides clears it): the field shows it
  $effect(() => {
    const text = level.filters.text
    untrack(() => {
      if (timer === undefined && draft !== text) draft = text
    })
  })

  const peptideChoices = [
    { value: '0', label: 'Any number of peptides' },
    { value: '2', label: '≥ 2 peptides' },
    { value: '3', label: '≥ 3 peptides' },
    { value: '5', label: '≥ 5 peptides' },
  ]
  /** The most biological samples of a condition: "found in ≥ n" offers 2 … that. */
  const maxReplicates = $derived(Math.max(0, ...view.model.conditionColumns.map((c) => c.samples.length)))
  const foundChoices = $derived([
    { value: '0', label: 'Found in any sample' },
    ...Array.from({ length: Math.max(0, maxReplicates - 1) }, (_, i) => ({
      value: String(i + 2),
      label: `Found in ≥ ${i + 2} replicates of a condition`,
    })),
  ])

  const chip =
    'inline-flex h-7 items-center gap-1.5 rounded-full border bg-background pr-2 pl-3 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none'
  const selectLike =
    'inline-flex h-8 items-center gap-1.5 rounded-md border bg-background px-2.5 text-[13px] whitespace-nowrap hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none'
</script>

<div class="flex flex-wrap items-center gap-2" data-testid="filter-bar">
  <label class="relative flex h-8 max-w-80 min-w-[18.5rem] grow basis-[18.5rem] items-center">
    <span class="sr-only">{name.filter}</span>
    <SearchIcon class="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground" aria-hidden="true" />
    <input
      type="search"
      class="h-8 w-full rounded-md border bg-background pr-7 pl-8 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      placeholder={name.placeholder}
      aria-label={name.filter}
      autocomplete="off"
      spellcheck="false"
      value={draft}
      oninput={type}
      onkeydown={(e) => e.key === 'Escape' && draft && (e.preventDefault(), clearText())} />
  </label>

  {#if hasXl}
    <div class="inline-flex h-8 items-center rounded-md border bg-background p-0.5" role="group" aria-label="Show" data-testid="kind-filter">
      {#each kinds as k (k.value)}
        <button
          type="button"
          aria-pressed={level.filters.kind === k.value}
          title={k.title}
          class={cn(
            'h-full rounded-[5px] px-2.5 text-[13px] whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
            level.filters.kind === k.value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onclick={() => (level.filters.kind = k.value)}>{k.label}</button>
      {/each}
    </div>
  {/if}

  {#if level.level !== 'proteins'}
    <!-- (proteins: no protein FDR, nothing to tighten; they count the PSMs at the search's cutoffs) -->
    <Popover.Root>
      <Popover.Trigger class={selectLike} data-testid="q-filter">
        {qSummary}
        <ChevronDown class="size-3.5 text-muted-foreground" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Content class="w-80" align="start">
        <div class="grid gap-3">
          <div class="grid gap-2">
            <label for={qId} class="text-xs font-medium">{name.q}{hasXl ? ', peptides' : ''}</label>
            <FdrInput id={qId} bind:value={level.filters.maxQ} max={m.psmFdr} />
          </div>
          {#if hasXl}
            <div class="grid gap-2">
              <label for={xlId} class="text-xs font-medium">{name.q}, cross-links</label>
              <FdrInput id={xlId} bind:value={level.filters.maxXlQ} max={m.xlFdr} />
            </div>
          {/if}
          <p class="text-xs text-muted-foreground">
            {#if hasXl}
              The search's cutoffs are {formatPercent(m.psmFdr)} ({formatQ(m.psmFdr)}) for peptides and
              {formatPercent(m.xlFdr)} ({formatQ(m.xlFdr)}) for cross-links: OpenNuXL estimates their FDRs apart.
            {:else}
              The search's cutoff is {formatPercent(m.psmFdr)} ({formatQ(m.psmFdr)}).
            {/if}
            You can tighten {hasXl ? 'them' : 'it'} here. A looser cutoff needs a new search.
          </p>
        </div>
      </Popover.Content>
    </Popover.Root>
  {/if}

  {#if level.level !== 'proteins' && level.filters.kind !== 'peptide' && choices.adducts.length > 1}
    <ChoiceSelect
      class="w-auto max-w-56"
      ariaLabel="Adduct"
      value={level.filters.adduct || ANY}
      options={adductOptions}
      onChange={(v) => (level.filters.adduct = v === ANY ? '' : v)} />
  {/if}
  {#if level.level !== 'proteins' && level.filters.kind !== 'peptide' && choices.nucleotides.length > 1}
    <ChoiceSelect
      class="w-auto"
      ariaLabel="Nucleotide"
      value={level.filters.nucleotide || ANY}
      options={nucleotideOptions}
      onChange={(v) => (level.filters.nucleotide = v === ANY ? '' : v)} />
  {/if}

  {#if level.level === 'proteins'}
    <ChoiceSelect
      class="w-auto"
      ariaLabel="Minimum peptides"
      value={String(level.filters.minPeptides)}
      options={peptideChoices}
      onChange={(v) => (level.filters.minPeptides = Number(v))} />
    {#if maxReplicates >= 2}
      <ChoiceSelect
        class="w-auto"
        ariaLabel="Found in replicates of a condition"
        value={String(level.filters.minReplicatesInCondition)}
        options={foundChoices}
        onChange={(v) => (level.filters.minReplicatesInCondition = Number(v))} />
    {/if}
  {/if}

  {#if protein}
    <button type="button" class={chip} title={protein.accession} onclick={() => (level.filters.proteinFilter = undefined)}>
      Protein: {protein.id}<XIcon class="size-3" aria-hidden="true" /><span class="sr-only">(remove the filter)</span>
    </button>
  {/if}
  {#if peptide}
    <button type="button" class={chip} title={peptide} onclick={() => (level.filters.peptideFilter = undefined)}>
      <span class="max-w-[16rem] truncate">Peptide: {peptide}</span><XIcon class="size-3 shrink-0" aria-hidden="true" /><span class="sr-only">(remove the filter)</span>
    </button>
  {/if}
  {#if level.filters.hideContaminants}
    <button type="button" class={chip} onclick={() => (level.filters.hideContaminants = false)}>
      Contaminants hidden<XIcon class="size-3" aria-hidden="true" /><span class="sr-only">(show them)</span>
    </button>
  {/if}
  {#if level.filters.showDecoys}
    <button type="button" class={chip} onclick={() => (level.filters.showDecoys = false)}>
      Decoys shown<XIcon class="size-3" aria-hidden="true" /><span class="sr-only">(hide them)</span>
    </button>
  {/if}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none aria-expanded:bg-muted">
      + Filter
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="w-auto min-w-48">
      <DropdownMenu.CheckboxItem bind:checked={level.filters.hideContaminants}>Hide contaminants</DropdownMenu.CheckboxItem>
    </DropdownMenu.Content>
  </DropdownMenu.Root>

  <span class="ml-auto text-xs text-muted-foreground tabular-nums" data-testid="row-count" aria-live="polite"
    >{formatCount(level.rows.length)} of {formatCount(level.total)}</span>
</div>
