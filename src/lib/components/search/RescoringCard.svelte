<script lang="ts">
  // Rescoring: Percolator, built into OpenMS (the request's `rescore`: `-percolator_backend builtin`, else `none`).
  // OpenNuXL rescores each run on its own and skips it for a run with too few PSMs.
  import * as Card from '$lib/components/ui/card'
  import { Label } from '$lib/components/ui/label'
  import { Switch } from '$lib/components/ui/switch'
  import { searchForm as form } from '$lib/search/form.svelte'
  import { PERCOLATOR_MIN_PSMS } from '$lib/search/plan.svelte'
</script>

<Card.Root size="sm" class="gap-1 rounded-lg shadow-none">
  <Card.Header class="flex items-center">
    <Card.Title class="text-[14px] font-semibold">Rescoring</Card.Title>
  </Card.Header>
  <Card.Content>
    <div class="flex items-start gap-3 py-2.5">
      <Switch id="percolator" class="mt-0.5" bind:checked={form.rescore} aria-describedby="percolator-hint" />
      <div class="min-w-0">
        <Label for="percolator" class="text-[13px] font-semibold">Percolator</Label>
        <p id="percolator-hint" class="mt-0.5 text-xs text-muted-foreground">
          Learns which PSM features separate targets from decoys, for more cross-links and peptides at the same FDR.
          OpenNuXL rescores each file on its own and skips files with fewer than {PERCOLATOR_MIN_PSMS.toLocaleString('en-US')}
          PSMs, which keep NuXL's own scores.
        </p>
      </div>
    </div>
  </Card.Content>
</Card.Root>
