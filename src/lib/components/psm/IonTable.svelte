<script lang="ts">
  // The ion table (mockup 3): per residue the theoretical m/z of the linear peptide's N-terminal ions of its
  // number (left of the residue) and of its C-terminal ions counted from the other end (right of it), for the series
  // and charges shown; the ions NuXL annotated marked by a tint of their series' colour, bold, and for screen readers
  // in words. Beside a series with ions shifted by the nucleotide, a column of those NuXL annotated (their m/z as
  // observed, in the cross-link's colour, with the shift of each beside it; all of a number's in the tooltip). A real
  // table: it is the spectrum's table view too.
  import { modTitle, type PeptideView } from '$lib/format/peptide'
  import { isNTerminal } from '$lib/psm/psm'
  import type { NuxlIonCell, NuxlIonColumn, NuxlIonTable } from './nuxl-psm'

  let { table, peptide, label }: { table: NuxlIonTable; peptide: PeptideView; label: string } = $props()

  const n = $derived(peptide.residues.length)

  function cellClass(col: NuxlIonColumn, matched: boolean): string {
    if (!matched) return 'text-muted-foreground'
    return col.shifted ? 'matched ms' : isNTerminal(col.type) ? 'matched mb' : 'matched my'
  }
</script>

{#snippet shiftOf(cell: NuxlIonCell)}
  <span class="shift" aria-hidden="true">{cell.shift}{#if cell.more}<span class="more"> +{cell.more}</span>{/if}</span><span class="sr-only"> {cell.ion}</span>
{/snippet}

<div class="overflow-x-auto">
  <table class="ions w-full border-separate border-spacing-0 text-xs tabular-nums" data-testid="ion-table">
    <caption class="sr-only">Fragment ions of {label}: theoretical m/z, those NuXL annotated marked; shifted ions as annotated</caption>
    <thead>
      <tr>
        <th scope="col" class="text-muted-foreground">#</th>
        {#each table.n as col (col.header)}<th scope="col" aria-label={col.header} class:sh={col.shifted} title={col.shifted ? 'Ions shifted by the nucleotide, as NuXL annotated them' : undefined}
            >{col.type}<sup>{col.charge === 1 ? '+' : `${col.charge}+`}</sup>{#if col.shifted}<span class="sh-mark" aria-hidden="true">*</span>{/if}</th>{/each}
        <th scope="col" class="text-center">AA</th>
        {#each table.c as col (col.header)}<th scope="col" aria-label={col.header} class:sh={col.shifted} title={col.shifted ? 'Ions shifted by the nucleotide, as NuXL annotated them' : undefined}
            >{col.type}<sup>{col.charge === 1 ? '+' : `${col.charge}+`}</sup>{#if col.shifted}<span class="sh-mark" aria-hidden="true">*</span>{/if}</th>{/each}
        <th scope="col" class="text-muted-foreground">#</th>
      </tr>
    </thead>
    <tbody>
      {#each table.rows as row (row.index)}
        {@const r = peptide.residues[row.index]}
        <tr>
          <td class="text-muted-foreground">{row.index + 1}</td>
          {#each row.n as cell, j (j)}
            <td
              data-type={table.n[j].type}
              data-ion={cell?.ion}
              data-matched={cell ? String(cell.matched) : undefined}
              data-shifted={table.n[j].shifted ? '' : undefined}
              title={cell?.title}
              class={cell ? cellClass(table.n[j], cell.matched) : ''}
              >{#if cell}{cell.mz.toFixed(4)}{#if table.n[j].shifted}{@render shiftOf(cell)}{:else if cell.matched}<span class="sr-only"> annotated</span>{/if}{/if}</td>
          {/each}
          <th scope="row" class="aa" title={r.mod ? modTitle(r.mod) : undefined}
            >{#if r.mod}<span class="m">{r.residue}<sup>{r.mod.label}</sup></span>{:else}{r.residue}{/if}</th>
          {#each row.c as cell, j (j)}
            <td
              data-type={table.c[j].type}
              data-ion={cell?.ion}
              data-matched={cell ? String(cell.matched) : undefined}
              data-shifted={table.c[j].shifted ? '' : undefined}
              title={cell?.title}
              class={cell ? cellClass(table.c[j], cell.matched) : ''}
              >{#if cell}{cell.mz.toFixed(4)}{#if table.c[j].shifted}{@render shiftOf(cell)}{:else if cell.matched}<span class="sr-only"> annotated</span>{/if}{/if}</td>
          {/each}
          <td class="text-muted-foreground">{n - row.index}</td>
        </tr>
      {/each}
    </tbody>
  </table>
  {#if table.n.some((c) => c.shifted) || table.c.some((c) => c.shifted)}
    <p class="px-[7px] pt-1.5 text-[11px] text-muted-foreground" data-testid="shifted-note">
      * Ions shifted by a fragment of the cross-linked nucleotide, at the m/z NuXL annotated, each with its shift (+1: one
      more shifted ion of that number, in the tooltip).
    </p>
  {/if}
</div>

<style>
  .ions th,
  .ions td {
    padding: 3px 7px;
    text-align: right;
    white-space: nowrap;
    border-bottom: 1px solid var(--color-border);
  }
  .ions thead th {
    font-weight: 500;
    color: var(--color-muted-foreground);
  }
  .ions thead sup {
    font-size: 9px;
    margin-left: 1px;
  }
  .ions thead th.sh {
    color: var(--mod-fg);
  }
  .shift {
    margin-left: 5px;
    font-size: 10px;
    font-weight: 500;
  }
  .shift .more {
    opacity: 0.7;
  }
  .sh-mark {
    margin-left: 1px;
  }
  .ions .aa {
    text-align: center;
    font-weight: 600;
    font-family: var(--font-sequence);
  }
  .matched {
    font-weight: 600;
  }
  /* matched: a tint of the series' colour, the text darker for contrast (b, y, other series) */
  .mb {
    color: var(--ion-b-fg);
    background: var(--ion-b-bg);
  }
  .my {
    color: var(--ion-y-fg);
    background: var(--ion-y-bg);
  }
  .ms {
    color: var(--mod-fg);
    background: var(--mod-bg);
  }
  .m {
    background: var(--mod-bg);
    color: var(--mod-fg);
    border-radius: 3px;
    padding: 0 1px;
    box-shadow: inset 0 -1.5px 0 var(--mod);
  }
  .m sup {
    font-family: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
    font-size: 9px;
    font-weight: 600;
    line-height: 0;
    margin-left: 1px;
  }
</style>
