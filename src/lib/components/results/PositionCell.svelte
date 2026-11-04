<script lang="ts">
  // A position of a peptide in its protein in a table cell ("12", "Cas7 K123"): a "?" after a position the search
  // recorded but the protein's sequence does not confirm, "+n" for the peptide's other proteins or occurrences
  // (`position-cells.ts`; the tooltip lists them all).
  import type { PositionView } from './position-cells'

  /** `plain`: in the body font (a line of prose, the PSM view's header), not monospace. */
  let { view, plain = false }: { view: PositionView; plain?: boolean } = $props()
</script>

<span class={plain ? undefined : 'font-mono text-[12.5px]'}>{view.text}</span>{#if view.inexact}<span class="text-muted-foreground">?</span>{/if}{#if view.more > 0}<span
    class="text-muted-foreground">{' '}+{view.more}</span
  >{/if}
