<script lang="ts">
  // The Overview tab: what was searched and how (the settings that matter for reading the numbers: the
  // protocol preset, the two FDRs, the rescoring, and the engine: OpenNuXL's version), a table of the
  // searched files with what OpenNuXL reports of each run (its peptide and cross-link PSMs, Percolator
  // applied or skipped and why, its notes), and two charts of the cross-link PSMs: their adducts and the
  // amino acids they are cross-linked to. The key figures stand above the tabs.
  import ChartCard from '$lib/components/charts/ChartCard.svelte'
  import FileBars from '$lib/components/charts/FileBars.svelte'
  import * as Table from '$lib/components/ui/table'
  import { COLORS } from '$lib/psm/psm'
  import { formatCount } from '$lib/results/display'
  import { adductLabel } from '$lib/format/peptide'
  import { adductCounts, cutoffText, fdrFacts, fileRows, formatSeconds, residueCounts, totalsOf, type EngineNote } from '$lib/results/overview'
  import type { ResultsView } from '$lib/results/view.svelte'
  import { toolState } from '$lib/search/tool.svelte'
  import { NUXL_PARAMETERS } from '$lib/settings/nuxl'
  import { defaultsOf } from '$lib/settings/parameters'

  let { view }: { view: ResultsView } = $props()

  const result = $derived(view.result)
  const summary = $derived(result.outcome.summary)
  const nuxl = $derived(result.outcome.nuxl)
  const settings = $derived(result.settings)
  const m = $derived(view.model)
  const rows = $derived(fileRows(m, summary, nuxl))
  const totals = $derived(totalsOf(rows))
  const showMs2 = $derived(rows.some((r) => r.ms2 !== null))

  const rescoring = $derived.by(() => {
    const applied = rows.filter((r) => r.percolator.kind === 'applied').length
    if (applied === rows.length && applied > 0) return 'Percolator'
    if (applied > 0) return `Percolator (${applied} of ${rows.length} files)`
    if (rows.some((r) => r.percolator.kind === 'skipped')) return 'Percolator was skipped'
    return settings.rescore ? 'Percolator (not reported)' : 'none (NuXL score)'
  })

  // the protocol: what the folder says OpenNuXL ran with, else the request's
  const preset = $derived.by(() => {
    const asked = settings.parameters['NuXL:presets']
    return nuxl?.preset ?? (typeof asked === 'string' && asked !== '' ? asked : (settings.presetId ?? 'none'))
  })

  // the tool that searched: OpenNuXL's version (that of this session's tool, or the stored search's)
  const engine = $derived.by(() => {
    const version = result.stored?.moduleVersion ?? toolState.info?.version ?? ''
    const short = /^\d+\.\d+(\.\d+)?/.exec(version)?.[0] ?? version
    return {
      value: short ? `OpenNuXL ${short}` : 'OpenNuXL',
      title: `OpenNuXL of OpenMS${version ? ` ${version}` : ''}${toolState.info && !result.stored ? ` (${toolState.info.path})` : ''}`,
    }
  })

  // a parameter of the search: as the request gave it (only those that differ from OpenNuXL's defaults), else the default
  const defaults = defaultsOf(NUXL_PARAMETERS)
  const param = (name: string): unknown => settings.parameters[name] ?? defaults[name]
  const list = (name: string): string => {
    const v = param(name)
    return Array.isArray(v) && v.length > 0 ? v.join(', ') : 'none'
  }
  const tolerance = (what: 'precursor' | 'fragment') => `${param(`${what}:mass_tolerance`)} ${param(`${what}:mass_tolerance_unit`)}`
  const length = $derived(Number(param('NuXL:length')))
  const scoring = $derived(String(param('NuXL:scoring')))

  const facts: { name: string; value: string; title?: string }[] = $derived([
    { name: 'Database', value: `${settings.database}${settings.contaminants ? ' + contaminants' : ''}` },
    { name: 'Protocol (NuXL preset)', value: preset },
    {
      name: 'Adducts',
      value: length === 0 ? 'none (peptides only)' : `up to ${length} ${length === 1 ? 'nucleotide' : 'nucleotides'} · ${scoring} scoring`,
      title: `Longest nucleotide adduct (NuXL:length ${length}); scoring ${scoring} (fast: total loss only, slow: all losses)`,
    },
    ...fdrFacts(m),
    { name: 'Mass tolerance', value: `precursor ${tolerance('precursor')} · fragment ${tolerance('fragment')}` },
    { name: 'Enzyme', value: `${param('peptide:enzyme')} · ${param('peptide:missed_cleavages')} missed cleavages` },
    { name: 'Fixed modifications', value: settings.fixedMods.length > 0 ? settings.fixedMods.join(', ') : 'none' },
    { name: 'Variable modifications', value: list('modifications:variable') },
    { name: 'Rescoring', value: rescoring },
    { name: 'Total time', value: formatSeconds(result.outcome.seconds) },
    { name: 'Engine', ...engine },
  ])

  // the cross-link PSMs: their adducts and residues
  const xlCutoff = $derived(cutoffText(m.xlFdr))
  const adducts = $derived(adductCounts(m))
  const residues = $derived(residueCounts(m))
  const xlTotal = $derived(adducts.reduce((n, a) => n + a.count, 0))
  const localized = $derived(xlTotal - residues.unlocalized)
  const share = (n: number, of: number) => (of === 0 ? '0 %' : `${((n / of) * 100).toFixed(0)} %`)
  const range = (items: { count: number }[]) =>
    items.length === 0 ? '' : `, from ${formatCount(Math.min(...items.map((i) => i.count)))} to ${formatCount(Math.max(...items.map((i) => i.count)))} PSMs`

  const head = 'h-auto border-b px-2.5 py-1.5 font-medium text-muted-foreground'
  const cell = 'border-b px-2.5 py-1.5'
  const foot = 'px-2.5 py-1.5 font-medium'
</script>

<!-- an engine's note in short plain words; the whole text in its tooltip and, opened, below it; a warning says so -->
{#snippet engineNote(note: EngineNote, warning: boolean)}
  {#snippet label()}{#if warning}<span class="mr-1 font-medium text-amber-700 dark:text-amber-400" data-testid="engine-warning">Warning</span>{/if}{/snippet}
  {#if note.short === note.full}
    <span class="block max-w-[28rem] font-normal text-muted-foreground">{@render label()}{note.full}</span>
  {:else}
    <details class="max-w-[28rem] font-normal text-muted-foreground" data-testid="engine-note">
      <summary class="cursor-pointer hover:text-foreground" title={note.full}>{@render label()}{note.short}</summary>
      <p class="mt-0.5 text-xs">{note.full}</p>
    </details>
  {/if}
{/snippet}

<div class="flex flex-col gap-6 pb-6">
  <section aria-labelledby="overview-search">
    <h2 id="overview-search" class="mb-2 text-[13px] font-semibold">Search</h2>
    <dl class="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-2 text-xs" data-testid="search-facts">
      {#each facts as fact (fact.name)}
        <div class="min-w-0">
          <dt class="text-muted-foreground">{fact.name}</dt>
          <dd class="truncate" title={fact.title ?? fact.value}>{fact.value}</dd>
        </div>
      {/each}
    </dl>
  </section>

  <section aria-labelledby="overview-files">
    <h2 id="overview-files" class="mb-2 text-[13px] font-semibold">Files</h2>
    <div class="rounded-lg border bg-background">
      <Table.Root class="text-xs tabular-nums" aria-label="Searched files">
        <Table.Header>
          <Table.Row class="hover:bg-transparent">
            <Table.Head scope="col" class="{head} text-left">File</Table.Head>
            <Table.Head scope="col" class="{head} text-left" title="The sample of the design that the file belongs to">Sample</Table.Head>
            {#if showMs2}
              <Table.Head scope="col" class="{head} text-right" title="MS2 spectra in the file (–: not reported)">MS2 spectra</Table.Head>
            {/if}
            <Table.Head scope="col" class="{head} text-right" title="Target PSMs without a cross-link at the search's peptide FDR ({cutoffText(m.psmFdr)})"
              >Peptide PSMs</Table.Head>
            <Table.Head scope="col" class="{head} text-right" title="Target cross-link PSMs at the search's cross-link FDR ({xlCutoff})">Cross-link PSMs</Table.Head>
            <Table.Head scope="col" class="{head} text-left" title="Whether Percolator rescored this file's PSMs, and if not, why (OpenNuXL rescores a run of 1000 PSMs or more)"
              >Percolator</Table.Head>
            <Table.Head scope="col" class="{head} text-right" title="How long OpenNuXL's run of this file took, reading the file and the database included">Run time</Table.Head>
            <Table.Head scope="col" class="{head} text-left">Status</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each rows as r (r.index)}
            <Table.Row>
              <Table.Cell data-column="file" class="{cell} text-left font-medium"
                >{r.file}{#each r.notes as note (note.full)}{@render engineNote(note, false)}{/each}</Table.Cell>
              <Table.Cell data-column="sample" class="{cell} text-left">{r.sample ?? '–'}</Table.Cell>
              {#if showMs2}
                <Table.Cell data-column="ms2" class="{cell} text-right">{r.ms2 === null ? '–' : formatCount(r.ms2)}</Table.Cell>
              {/if}
              <Table.Cell data-column="peptide-psms" class="{cell} text-right">{formatCount(r.peptidePsms)}</Table.Cell>
              <Table.Cell data-column="xl-psms" class="{cell} text-right">{formatCount(r.xlPsms)}</Table.Cell>
              <Table.Cell data-column="percolator" class="{cell} text-left whitespace-normal {r.percolator.kind === 'off' ? 'text-muted-foreground' : ''}">
                {r.percolator.label}{#if r.percolator.detail}{@render engineNote(r.percolator.detail, false)}{/if}{#if r.percolator.warning}{@render engineNote(r.percolator.warning, true)}{/if}
              </Table.Cell>
              <Table.Cell data-column="time" class="{cell} text-right">{r.seconds === null ? '–' : formatSeconds(r.seconds)}</Table.Cell>
              <Table.Cell data-column="status" class="{cell} text-left {r.status.ok ? '' : 'font-medium text-destructive'}">{r.status.label}</Table.Cell>
            </Table.Row>
          {/each}
        </Table.Body>
        {#if rows.length > 1}
          <Table.Footer>
            <Table.Row class="hover:bg-transparent">
              <Table.Head scope="row" colspan={2} class="h-auto px-2.5 py-1.5 text-left font-semibold">All files</Table.Head>
              {#if showMs2}
                <Table.Cell data-column="ms2" class="{foot} text-right">{totals.ms2 === null ? '–' : formatCount(totals.ms2)}</Table.Cell>
              {/if}
              <Table.Cell data-column="peptide-psms" class="{foot} text-right">{formatCount(totals.peptidePsms)}</Table.Cell>
              <Table.Cell data-column="xl-psms" class="{foot} text-right">{formatCount(totals.xlPsms)}</Table.Cell>
              <Table.Cell class={foot}></Table.Cell>
              <Table.Cell data-column="time" class="{foot} text-right">{formatSeconds(totals.seconds)}</Table.Cell>
              <Table.Cell class={foot}></Table.Cell>
            </Table.Row>
          </Table.Footer>
        {/if}
      </Table.Root>
    </div>
  </section>

  <section aria-labelledby="overview-crosslinks">
    <h2 id="overview-crosslinks" class="mb-2 text-[13px] font-semibold">Cross-links</h2>
    {#if xlTotal === 0}
      <p class="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground" data-testid="no-crosslinks">
        No cross-link PSM passes the search's cross-link FDR ({xlCutoff}), so there are no adducts or cross-linked residues to show.
      </p>
    {:else}
      <div class="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
        <ChartCard
          testid="overview-adducts"
          title="Adducts"
          subtitle="Target cross-link PSMs at the cross-link FDR ({xlCutoff}) · {formatCount(xlTotal)} PSMs"
          table={{
            name: 'Cross-link PSMs per adduct',
            columns: [
              { id: 'adduct', header: 'Adduct', align: 'left' },
              { id: 'psms', header: 'PSMs' },
              { id: 'share', header: 'Share' },
            ],
            rows: adducts.map((a) => [adductLabel(a.name), formatCount(a.count), share(a.count, xlTotal)]),
          }}>
          <FileBars
            testid="adduct-chart"
            title="Cross-link PSMs per adduct"
            description="Bar chart of the {formatCount(xlTotal)} target cross-link PSMs by their nucleic acid adduct, {adducts.length} adducts{range(adducts)}."
            items={adducts.map((a) => ({ file: adductLabel(a.name), count: a.count }))}
            color={COLORS.b}
            mono />
        </ChartCard>
        <ChartCard
          testid="overview-residues"
          title="Cross-linked amino acids"
          subtitle="The residue of each localized cross-link PSM · {formatCount(localized)} of {formatCount(xlTotal)} PSMs"
          notes={residues.unlocalized > 0
            ? [`${formatCount(residues.unlocalized)} cross-link ${residues.unlocalized === 1 ? 'PSM is' : 'PSMs are'} not localized to a residue and left out.`]
            : []}
          table={{
            name: 'Cross-link PSMs per amino acid',
            columns: [
              { id: 'residue', header: 'Amino acid', align: 'left' },
              { id: 'psms', header: 'PSMs' },
              { id: 'share', header: 'Share' },
            ],
            rows: residues.residues.map((r) => [r.name, formatCount(r.count), share(r.count, localized)]),
          }}>
          {#if residues.residues.length > 0}
            <FileBars
              testid="residue-chart"
              title="Localized cross-link PSMs per amino acid"
              description="Bar chart of the {formatCount(localized)} localized target cross-link PSMs by their cross-linked amino acid, {residues.residues.length} amino acids{range(residues.residues)}."
              items={residues.residues.map((r) => ({ file: r.name, count: r.count }))}
              color={COLORS.y}
              mono />
          {:else}
            <p class="py-8 text-center text-xs text-muted-foreground">None of the cross-link PSMs is localized to a residue.</p>
          {/if}
        </ChartCard>
      </div>
    {/if}
  </section>
</div>
