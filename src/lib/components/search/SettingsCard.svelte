<script lang="ts">
  // Search settings: the preset (PresetPicker); the cross-linking protocol (OpenNuXL's `NuXL:presets`, with a line on
  // what it searches), the longest nucleotide adduct and the scoring; the common peptide-search parameters; the FDRs of
  // the peptide and the cross-link PSMs. "Advanced": the threads (all cores by default), the isotopes, the variable
  // modifications per peptide and the FDR group of short cross-links; and the "All N parameters" dialog
  // (AllParametersDialog), made from OpenNuXL's option list of the OpenMS pin.
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import FdrInput from '$lib/components/FdrInput.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import * as InputGroup from '$lib/components/ui/input-group'
  import { Label } from '$lib/components/ui/label'
  import { searchForm as form } from '$lib/search/form.svelte'
  import { searchPlan } from '$lib/search/plan.svelte'
  import { loadCores, machine } from '$lib/search/tool.svelte'
  import { onMount } from 'svelte'
  import { choiceLabel } from '$lib/settings/labels'
  import { dialogEntries, sameValue } from '$lib/settings/parameters'
  import { protocolSummary } from '$lib/settings/protocols'
  import AllParametersDialog from './AllParametersDialog.svelte'
  import ChoiceSelect from './ChoiceSelect.svelte'
  import ModificationsField from './ModificationsField.svelte'
  import NumberField from './NumberField.svelte'
  import PresetPicker from './PresetPicker.svelte'
  import RangeField from './RangeField.svelte'
  import ToleranceField from './ToleranceField.svelte'

  let dialogOpen = $state(false)
  /** What the dialog opens filtered by ("NuXL:" from the custom protocol's link). */
  let dialogFilter = $state('')
  const count = $derived(dialogEntries([...form.entries.values()]).length)

  function openDialog(filter = '') {
    dialogFilter = filter
    dialogOpen = true
  }

  // the cores of this computer (the default of the threads)
  onMount(loadCores)
  const cores = $derived(machine.cores)

  /** The choices of a parameter with their labels. */
  const choices = (name: string) =>
    (form.entry(name)?.validStrings ?? [String(form.value(name))]).map((v) => ({ value: v, label: choiceLabel(name, v) }))

  const protocol = $derived(String(form.value('NuXL:presets')))
  const protocolOptions = $derived(choices('NuXL:presets'))
  const summary = $derived(protocolSummary(protocol))

  // the usual enzymes first, then the others alphabetically
  const COMMON_ENZYMES = [
    'Trypsin/P',
    'Trypsin',
    'Lys-C',
    'Lys-C/P',
    'Arg-C',
    'Asp-N',
    'Glu-C+P',
    'Chymotrypsin',
    'Chymotrypsin/P',
    'unspecific cleavage',
  ]
  const enzymeOptions = $derived.by(() => {
    const valid = form.entry('peptide:enzyme')?.validStrings ?? [String(form.value('peptide:enzyme'))]
    const common = COMMON_ENZYMES.filter((e) => valid.includes(e))
    const rest = valid.filter((e) => !common.includes(e)).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    return [...common, ...rest].map((e) => ({ value: e, label: e }))
  })

  // the isotopes OpenNuXL considers for the precursor (its default: the monoisotopic peak only), and the one a
  // preset may hold besides
  const ISOTOPES: { value: number[]; label: string }[] = [
    { value: [0], label: 'Monoisotopic only' },
    { value: [0, 1], label: '0 and +1' },
    { value: [0, 1, 2], label: '0 to +2' },
    { value: [-1, 0, 1], label: '−1 to +1' },
  ]
  const isotopes = $derived(form.value<number[]>('precursor:isotopes') ?? [0])
  const isotopeOptions = $derived.by(() => {
    const list = ISOTOPES.some((o) => sameValue(o.value, isotopes))
      ? ISOTOPES
      : [...ISOTOPES, { value: isotopes, label: isotopes.map((i) => (i > 0 ? `+${i}` : i < 0 ? `−${-i}` : '0')).join(', ') }]
    return list.map((o) => ({ value: o.value.join(','), label: o.label }))
  })

  // the longest peptide: OpenNuXL's default (1,000,000 residues) is no limit, shown as such
  const NO_LIMIT = Number(form.entry('peptide:max_size')?.value ?? 1e6)
  const maxSize = $derived(form.value<number>('peptide:max_size'))

  const fdrClass = '[&>div:first-child]:h-8 [&>div:first-child]:bg-background [&>div:first-child]:shadow-none'

  // ranges whose lowest value is above the highest: marked, and the search waits (plan.svelte.ts)
  const chargesInverted = $derived(searchPlan.inverted.some((r) => r.min === 'precursor:min_charge'))
  const lengthInverted = $derived(searchPlan.inverted.some((r) => r.min === 'peptide:min_size'))

  const modOptions = $derived(form.entry('modifications:variable')?.validStrings)
  const fixedOptions = $derived(form.entry('modifications:fixed')?.validStrings)
</script>

<Card.Root size="sm" class="gap-3 rounded-lg shadow-none">
  <Card.Header class="flex flex-wrap items-center gap-x-2.5 gap-y-2">
    <Card.Title class="text-[14px] font-semibold">Search settings</Card.Title>
    <PresetPicker />
    <div class="flex-1"></div>
    <Button
      variant="ghost"
      size="sm"
      class="h-7 px-2 text-xs text-muted-foreground"
      aria-expanded={form.advancedSettings}
      aria-controls="advanced-settings"
      onclick={() => (form.advancedSettings = !form.advancedSettings)}>
      Advanced<ChevronRightIcon class="size-3.5 transition-transform {form.advancedSettings ? 'rotate-90' : ''}" />
    </Button>
    <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" onclick={() => openDialog()}>
      All {count} parameters<ChevronRightIcon class="size-3.5" />
    </Button>
  </Card.Header>

  <Card.Content class="grid grid-cols-2 gap-x-4 gap-y-3.5 md:grid-cols-4">
    <!-- the cross-linking protocol: what makes the search a cross-link search -->
    <div class="col-span-2 grid min-w-0 content-start gap-1">
      <Label for="protocol" class="text-xs">Protocol</Label>
      <ChoiceSelect id="protocol" value={protocol} options={protocolOptions} onChange={(v) => form.setProtocol(v)} />
      <p id="protocol-summary" class="text-xs text-muted-foreground" data-testid="protocol-summary">
        {summary}
        {#if searchPlan.customProtocol}
          <button
            type="button"
            class="rounded-sm text-foreground underline underline-offset-2 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            onclick={() => openDialog('NuXL:')}>Edit the adducts</button>
        {/if}
      </p>
    </div>
    <div class="grid min-w-0 content-start gap-1">
      <Label for="adduct-length" class="text-xs">Longest adduct</Label>
      <InputGroup.Root class="h-8 bg-background shadow-none">
        <NumberField
          id="adduct-length"
          kind="int"
          min={form.entry('NuXL:length')?.min ?? 0}
          max={form.entry('NuXL:length')?.max ?? 4}
          inGroup
          value={form.value<number>('NuXL:length')}
          onChange={(v) => form.setParam('NuXL:length', v)} />
        <InputGroup.Addon align="inline-end" class="text-xs text-muted-foreground">
          {form.value<number>('NuXL:length') === 1 ? 'nucleotide' : 'nucleotides'}
        </InputGroup.Addon>
      </InputGroup.Root>
      <p class="text-xs text-muted-foreground">0 searches peptides without adducts.</p>
    </div>
    <div class="grid min-w-0 content-start gap-1">
      <Label for="scoring" class="text-xs">Scoring</Label>
      <ChoiceSelect id="scoring" value={String(form.value('NuXL:scoring'))} options={choices('NuXL:scoring')} onChange={(v) => form.setParam('NuXL:scoring', v)} />
    </div>

    <!-- (the protocol apart from the peptide search) -->
    <div class="col-span-2 border-t md:col-span-4" aria-hidden="true"></div>
    <div class="grid min-w-0 content-start gap-1">
      <Label for="enzyme" class="text-xs">Enzyme</Label>
      <ChoiceSelect
        id="enzyme"
        value={String(form.value('peptide:enzyme'))}
        options={enzymeOptions}
        onChange={(v) => form.setParam('peptide:enzyme', v)} />
    </div>
    <div class="grid min-w-0 content-start gap-1">
      <Label for="missed-cleavages" class="text-xs">Missed cleavages</Label>
      <NumberField
        id="missed-cleavages"
        kind="int"
        min={0}
        value={form.value<number>('peptide:missed_cleavages')}
        onChange={(v) => form.setParam('peptide:missed_cleavages', v)} />
    </div>
    <div class="grid min-w-0 content-start gap-1">
      <Label for="precursor-tolerance" class="text-xs">Precursor tolerance</Label>
      <ToleranceField
        id="precursor-tolerance"
        label="Precursor tolerance"
        value={form.value<number>('precursor:mass_tolerance')}
        unit={String(form.value('precursor:mass_tolerance_unit'))}
        onValue={(v) => form.setParam('precursor:mass_tolerance', v)}
        onUnit={(u) => form.setParam('precursor:mass_tolerance_unit', u)} />
    </div>
    <div class="grid min-w-0 content-start gap-1">
      <Label for="fragment-tolerance" class="text-xs">Fragment tolerance</Label>
      <ToleranceField
        id="fragment-tolerance"
        label="Fragment tolerance"
        value={form.value<number>('fragment:mass_tolerance')}
        unit={String(form.value('fragment:mass_tolerance_unit'))}
        onValue={(v) => form.setParam('fragment:mass_tolerance', v)}
        onUnit={(u) => form.setParam('fragment:mass_tolerance_unit', u)} />
    </div>

    <div class="col-span-2 grid min-w-0 gap-1">
      <span id="fixed-mods-label" class="text-xs font-medium">Fixed modifications</span>
      <ModificationsField
        labelId="fixed-mods-label"
        kind="fixed"
        value={form.value<string[]>('modifications:fixed') ?? []}
        options={fixedOptions}
        onChange={(v) => form.setParam('modifications:fixed', v)} />
    </div>
    <div class="col-span-2 grid min-w-0 gap-1">
      <span id="variable-mods-label" class="text-xs font-medium">Variable modifications</span>
      <ModificationsField
        labelId="variable-mods-label"
        kind="variable"
        value={form.value<string[]>('modifications:variable') ?? []}
        options={modOptions}
        onChange={(v) => form.setParam('modifications:variable', v)} />
    </div>

    <!-- the two FDRs: of the peptide PSMs and of the cross-link PSMs (the request's peptideFdr, xlFdr) -->
    <div class="col-span-2 grid min-w-0 grid-cols-2 content-start gap-x-4 gap-y-1">
      <Label for="peptide-fdr" class="text-xs">Peptide FDR</Label>
      <Label for="xl-fdr" class="text-xs">Cross-link FDR</Label>
      <FdrInput
        id="peptide-fdr"
        class={fdrClass}
        aria-describedby="fdr-hint"
        bind:value={() => form.value<number>('peptideFdr'), (v) => form.setParam('peptideFdr', v)} />
      <FdrInput
        id="xl-fdr"
        class={fdrClass}
        aria-describedby="fdr-hint"
        bind:value={() => form.value<number>('xlFdr'), (v) => form.setParam('xlFdr', v)} />
      <p id="fdr-hint" class="col-span-2 text-xs text-muted-foreground">
        Cross-link PSMs and peptide PSMs are each held to their own FDR, file by file.
      </p>
    </div>
    <div class="grid min-w-0 content-start gap-1">
      <span id="charges-label" class="text-xs font-medium">Charges</span>
      <RangeField
        labelId="charges-label"
        from={form.value<number>('precursor:min_charge')}
        to={form.value<number>('precursor:max_charge')}
        fromLabel="Lowest precursor charge"
        toLabel="Highest precursor charge"
        min={form.entry('precursor:min_charge')?.min ?? 1}
        max={form.entry('precursor:max_charge')?.max}
        invalid={chargesInverted}
        describedBy="charges-inverted"
        onFrom={(v) => form.setParam('precursor:min_charge', v)}
        onTo={(v) => form.setParam('precursor:max_charge', v)} />
      {#if chargesInverted}
        <p id="charges-inverted" class="text-xs text-destructive">The lowest charge is above the highest.</p>
      {/if}
    </div>
    <div class="grid min-w-0 content-start gap-1">
      <span id="length-label" class="text-xs font-medium">Peptide length</span>
      <RangeField
        labelId="length-label"
        from={form.value<number>('peptide:min_size')}
        to={maxSize >= NO_LIMIT ? undefined : maxSize}
        fromLabel="Shortest peptide (residues)"
        toLabel="Longest peptide (residues; empty: no limit)"
        toPlaceholder="any"
        min={1}
        invalid={lengthInverted}
        describedBy="length-inverted"
        onFrom={(v) => form.setParam('peptide:min_size', v)}
        onTo={(v) => form.setParam('peptide:max_size', v)}
        onToClear={() => form.setParam('peptide:max_size', NO_LIMIT)} />
      {#if lengthInverted}
        <p id="length-inverted" class="text-xs text-destructive">The shortest length is above the longest.</p>
      {/if}
    </div>

    {#if form.advancedSettings}
      <div id="advanced-settings" class="col-span-2 grid grid-cols-2 gap-x-4 gap-y-3.5 border-t pt-3.5 md:col-span-4 md:grid-cols-4" data-testid="advanced-settings">
        <div class="grid min-w-0 content-start gap-1">
          <Label for="threads" class="text-xs">Threads</Label>
          <NumberField
            id="threads"
            kind="int"
            min={1}
            max={1024}
            placeholder={cores ? `all (${cores})` : 'all'}
            value={form.threads ?? undefined}
            onChange={(v) => (form.threads = v)}
            onClear={() => (form.threads = null)} />
          <p class="text-xs text-muted-foreground">Leave empty to use all cores.</p>
        </div>
        <div class="grid min-w-0 content-start gap-1">
          <Label for="isotopes" class="text-xs">Precursor isotopes</Label>
          <ChoiceSelect
            id="isotopes"
            value={isotopes.join(',')}
            options={isotopeOptions}
            onChange={(v) => form.setParam('precursor:isotopes', v.split(',').map(Number))} />
          <p class="text-xs text-muted-foreground">Also looks for precursors whose monoisotopic peak was misassigned.</p>
        </div>
        <div class="grid min-w-0 content-start gap-1">
          <Label for="max-variable" class="text-xs">Variable modifications per peptide</Label>
          <NumberField
            id="max-variable"
            kind="int"
            min={0}
            value={form.value<number>('modifications:variable_max_per_peptide')}
            onChange={(v) => form.setParam('modifications:variable_max_per_peptide', v)} />
        </div>
        <div class="grid min-w-0 content-start gap-1">
          <Label for="xl-fdr-groups" class="text-xs">Short cross-links' own FDR</Label>
          <ChoiceSelect
            id="xl-fdr-groups"
            value={String(form.value('report:xl_fdr_groups'))}
            options={choices('report:xl_fdr_groups')}
            onChange={(v) => form.setParam('report:xl_fdr_groups', v)} />
          <p class="text-xs text-muted-foreground">Short peptides with long adducts get an FDR of their own (auto: when they have enough decoys).</p>
        </div>
      </div>
    {/if}
  </Card.Content>
</Card.Root>

<AllParametersDialog bind:open={dialogOpen} initialFilter={dialogFilter} />
