<script lang="ts">
  // Rescoring: Percolator (ProSE's `rescore`, through the search request) and PeptDeep's features
  // (`peptdeep:enable` with the models), which are Percolator features and so need Percolator.
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import { searchForm as form } from '$lib/search/form.svelte'
  import { toolState } from '$lib/search/tool.svelte'
  import { choiceLabel, INSTRUMENT_LABELS } from '$lib/settings/labels'
  import ChoiceSelect from './ChoiceSelect.svelte'

  const instruments = $derived(
    (form.entry('peptdeep:instrument')?.validStrings ?? Object.keys(INSTRUMENT_LABELS)).map((v) => ({
      value: v,
      label: choiceLabel('peptdeep:instrument', v),
    })),
  )

  /** The ProSE tool has ONNX Runtime (unknown while it is asked). */
  const onnx = $derived(toolState.info?.onnx ?? true)
  const peptdeepBlocked = $derived(!form.rescore ? 'percolator' : !onnx ? 'onnx' : null)
  const peptdeepOn = $derived(form.peptdeep && peptdeepBlocked === null)
</script>

<Card.Root size="sm" class="gap-1 rounded-lg shadow-none">
  <Card.Header class="flex items-center">
    <Card.Title class="text-[14px] font-semibold">Rescoring</Card.Title>
  </Card.Header>
  <Card.Content class="divide-y">
    <div class="flex items-start gap-3 py-2.5">
      <Switch id="percolator" class="mt-0.5" bind:checked={form.rescore} aria-describedby="percolator-hint" />
      <div class="min-w-0">
        <Label for="percolator" class="text-[13px] font-semibold">Percolator</Label>
        <p id="percolator-hint" class="mt-0.5 text-xs text-muted-foreground">
          Learns which PSM features separate targets from decoys. This typically gives 10–20 % more PSMs at the same FDR.
        </p>
      </div>
    </div>
    <div class="flex flex-wrap items-start gap-3 py-2.5">
      <Switch
        id="peptdeep"
        class="mt-0.5"
        checked={peptdeepOn}
        disabled={peptdeepBlocked !== null}
        onCheckedChange={(c) => (form.peptdeep = c)}
        aria-describedby="peptdeep-hint" />
      <div class="min-w-0 flex-1">
        <Label for="peptdeep" class="text-[13px] font-semibold">PeptDeep predictions</Label>
        <p id="peptdeep-hint" class="mt-0.5 text-xs text-muted-foreground">
          Percolator also uses how well the fragment intensities and retention times match PeptDeep's predictions.
          {#if peptdeepBlocked === 'percolator'}
            <span class="text-foreground">Switch on Percolator to use PeptDeep.</span>
          {:else if peptdeepBlocked === 'onnx'}
            <span class="text-foreground">This ProSE build has no ONNX Runtime, which PeptDeep needs.</span>
          {/if}
        </p>
      </div>
      <div class="grid w-[190px] gap-1">
        <Label for="instrument" class="text-xs">Instrument</Label>
        <ChoiceSelect
          id="instrument"
          disabled={!peptdeepOn}
          value={String(form.value('peptdeep:instrument') ?? 'QE')}
          options={instruments}
          onChange={(v) => form.setParam('peptdeep:instrument', v)} />
      </div>
    </div>
  </Card.Content>
</Card.Root>
