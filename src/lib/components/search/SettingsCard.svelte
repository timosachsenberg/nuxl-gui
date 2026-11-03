<script lang="ts">
  // Search settings: the preset (PresetPicker), the ten common parameters (in the mockup's order), "Advanced": the
  // threads (all cores by default), the database chunks and co-isolated precursors, and the web app's "All N parameters" dialog
  // (AllParametersDialog), made from the pinned ProSE's parameter list.
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import FdrInput from '$lib/components/FdrInput.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import { searchForm as form } from '$lib/search/form.svelte'
  import { NO_FDR_HINT, searchPlan } from '$lib/search/plan.svelte'
  import { loadCores, machine } from '$lib/search/tool.svelte'
  import { onMount } from 'svelte'
  import { dialogEntries } from '$lib/settings/parameters'
  import AllParametersDialog from './AllParametersDialog.svelte'
  import ChoiceSelect from './ChoiceSelect.svelte'
  import ModificationsField from './ModificationsField.svelte'
  import NumberField from './NumberField.svelte'
  import PresetPicker from './PresetPicker.svelte'
  import RangeField from './RangeField.svelte'
  import ToleranceField from './ToleranceField.svelte'

  let dialogOpen = $state(false)
  const count = $derived(dialogEntries([...form.entries.values()]).length)

  // the cores of this computer (the default of the threads)
  onMount(loadCores)
  const cores = $derived(machine.cores)

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
    const valid = form.entry('enzyme')?.validStrings ?? [String(form.value('enzyme'))]
    const common = COMMON_ENZYMES.filter((e) => valid.includes(e))
    const rest = valid.filter((e) => !common.includes(e)).sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
    return [...common, ...rest].map((e) => ({ value: e, label: e }))
  })

  const lower = $derived(form.value<number>('precursor:mass_tolerance_lower'))
  const upper = $derived(form.value<number>('precursor:mass_tolerance_upper'))

  function setPrecursor(v: number) {
    form.setParam('precursor:mass_tolerance_lower', v)
    form.setParam('precursor:mass_tolerance_upper', v)
  }

  // ranges whose lowest value is above the highest: marked, and the search waits (plan.svelte.ts)
  const fdrClass = '[&>div:first-child]:h-8 [&>div:first-child]:bg-background [&>div:first-child]:shadow-none'

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
    <Button variant="ghost" size="sm" class="h-7 px-2 text-xs text-muted-foreground" onclick={() => (dialogOpen = true)}>
      All {count} parameters<ChevronRightIcon class="size-3.5" />
    </Button>
  </Card.Header>

  <Card.Content class="grid grid-cols-2 gap-x-4 gap-y-3.5 md:grid-cols-4">
    <div class="grid min-w-0 gap-1">
      <Label for="enzyme" class="text-xs">Enzyme</Label>
      <ChoiceSelect id="enzyme" value={String(form.value('enzyme'))} options={enzymeOptions} onChange={(v) => form.setParam('enzyme', v)} />
    </div>
    <div class="grid min-w-0 gap-1">
      <Label for="missed-cleavages" class="text-xs">Missed cleavages</Label>
      <NumberField
        id="missed-cleavages"
        kind="int"
        min={0}
        value={form.value<number>('peptide:missed_cleavages')}
        onChange={(v) => form.setParam('peptide:missed_cleavages', v)} />
    </div>
    <div class="grid min-w-0 gap-1">
      <Label for="precursor-tolerance" class="text-xs">Precursor tolerance</Label>
      <ToleranceField
        id="precursor-tolerance"
        label="Precursor tolerance"
        value={upper}
        unit={String(form.value('precursor:mass_tolerance_unit'))}
        onValue={setPrecursor}
        onUnit={(u) => form.setParam('precursor:mass_tolerance_unit', u)} />
      {#if lower !== upper}
        <p class="text-xs text-muted-foreground">The tolerance is asymmetric (−{lower} / +{upper}). Typing a value sets both sides.</p>
      {/if}
    </div>
    <div class="grid min-w-0 gap-1">
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

    {#if searchPlan.fdrBlocked}
      <!-- without decoys: no FDR (both off and disabled; the values come back with the decoys) -->
      <div class="col-span-2 grid min-w-0 grid-cols-2 content-start gap-x-4 gap-y-1">
        <Label for="psm-fdr" class="text-xs">PSM FDR</Label>
        <Label for="protein-fdr" class="text-xs">Protein FDR</Label>
        <FdrInput id="psm-fdr" off disabled value={0} aria-describedby="no-fdr-hint" class={fdrClass} />
        <FdrInput id="protein-fdr" off disabled value={0} aria-describedby="no-fdr-hint" class={fdrClass} />
        <p id="no-fdr-hint" class="col-span-2 text-xs text-muted-foreground" data-testid="no-fdr-hint">{NO_FDR_HINT}</p>
      </div>
    {:else}
      <div class="grid min-w-0 content-start gap-1">
        <Label for="psm-fdr" class="text-xs">PSM FDR</Label>
        <FdrInput
          id="psm-fdr"
          class={fdrClass}
          bind:value={() => form.value<number>('FDR:PSM'), (v) => form.setParam('FDR:PSM', v)} />
      </div>
      <div class="grid min-w-0 content-start gap-1">
        <Label for="protein-fdr" class="text-xs">Protein FDR</Label>
        <!-- off (0): ProSE applies no protein FDR (the example's setting) -->
        <FdrInput
          id="protein-fdr"
          off
          class={fdrClass}
          bind:value={() => form.value<number>('FDR:protein'), (v) => form.setParam('FDR:protein', v)} />
      </div>
    {/if}
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
        to={form.value<number>('peptide:max_size')}
        fromLabel="Shortest peptide (residues)"
        toLabel="Longest peptide (residues)"
        min={1}
        invalid={lengthInverted}
        describedBy="length-inverted"
        onFrom={(v) => form.setParam('peptide:min_size', v)}
        onTo={(v) => form.setParam('peptide:max_size', v)} />
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
          <Label for="chunk-size" class="text-xs">Database chunk size</Label>
          <NumberField
            id="chunk-size"
            kind="int"
            min={0}
            value={form.value<number>('database:chunk_size')}
            onChange={(v) => form.setParam('database:chunk_size', v)} />
          <p class="text-xs text-muted-foreground">How many proteins go into each part of the fragment index. 0 indexes the whole database at once.</p>
        </div>
        <div class="col-span-2 flex items-start gap-3">
          <Switch
            id="chimeric"
            class="mt-0.5"
            checked={form.value('chimeric:enabled') === true && !searchPlan.chimericBlocked}
            disabled={searchPlan.chimericBlocked}
            onCheckedChange={(c) => form.setParam('chimeric:enabled', c)}
            aria-describedby="chimeric-hint" />
          <div class="min-w-0">
            <Label for="chimeric" class="text-xs">Co-isolated precursors</Label>
            <p id="chimeric-hint" class="mt-0.5 text-xs text-muted-foreground">
              Also identifies the other precursors in each MS2 spectrum's isolation window, found in its survey scan.
              {#if searchPlan.chimericBlocked}
                <span class="text-foreground">Set the database chunk size to 0 to use it.</span>
              {/if}
            </p>
          </div>
        </div>
      </div>
    {/if}
  </Card.Content>
</Card.Root>

<AllParametersDialog bind:open={dialogOpen} />
