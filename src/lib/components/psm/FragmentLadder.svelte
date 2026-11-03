<script lang="ts">
  // The peptide with its fragment ladder (mockup 3): the residues in large monospace, a modified one
  // marked (the colour --mod and a short label below it, as in the tables; the cross-linked residue carries its
  // adduct so), and at each cleavage a mark above it where an N-terminal ion of NuXL's annotation explains it and
  // below it where a C-terminal one does: an unshifted ion in its series' colour (a/b/c blue, x/y/z orange), an ion
  // shifted by the nucleotide in the cross-link's colour (--mod) — a bracket of its own when no unshifted ion
  // explains the cleavage, else a dot at the end of the bracket. Long peptides get smaller to fit the width.
  import { modTitle, type PeptideView } from '$lib/format/peptide'
  import { COLORS } from '$lib/psm/psm'
  import type { Cut } from './nuxl-psm'

  let {
    peptide,
    cuts,
    available = 0,
  }: {
    peptide: PeptideView
    /** Per cleavage: what explains it from either end, or null (see `nuxlLadder`). */
    cuts: { n: Cut[]; c: Cut[] }
    /** The width of the row (pixels): a long peptide gets smaller to fit it, down to half size, then wraps. */
    available?: number
  } = $props()

  const n = $derived(peptide.residues.length)
  // a residue is 32 px and a cleavage 10 px at full size; long peptides shrink to the width
  const full = $derived(n * 42 + (peptide.nTerm ? 22 : 0) + (peptide.cTerm ? 22 : 0))
  const s = $derived(available > 0 ? Math.max(0.5, Math.min(1, (available - 4) / full)) : 1)

  const color = (cut: NonNullable<Cut>, terminal: 'n' | 'c') => (cut.type === null ? COLORS.mod : terminal === 'n' ? COLORS.b : COLORS.y)

  const explained = $derived.by(() => {
    const count = (list: Cut[], f: (c: NonNullable<Cut>) => boolean) => list.filter((c) => c !== null && f(c)).length
    const part = (list: Cut[]) => {
      const all = count(list, () => true)
      const shifted = count(list, (c) => c.shifted)
      return shifted > 0 ? `${all} (${shifted} by shifted ions)` : String(all)
    }
    return `${part(cuts.n)} of ${n - 1} cleavages explained by N-terminal ions, ${part(cuts.c)} by C-terminal ions`
  })
</script>

<div class="max-w-full min-w-0">
  <div
    class="ladder"
    style:--s={s}
    data-testid="fragment-ladder"
    role="img"
    aria-label="{peptide.proforma}: {explained}">
    {#if peptide.nTerm}<span class="term" title={modTitle(peptide.nTerm)}>{peptide.nTerm.label}</span>{/if}
    {#each peptide.residues as r, i (i)}
      <span class="aa" class:mod={r.mod !== undefined} title={r.mod ? modTitle(r.mod) : undefined}>
        <span class="letter" data-testid="ladder-residue">{r.residue}</span>
        {#if r.mod}<span class="label" data-testid="ladder-mod">{r.mod.label}</span>{/if}
      </span>
      {#if i < n - 1}
        <span class="cut">
          {#if cuts.n[i]}{@const cut = cuts.n[i]!}<i
              class="n"
              class:both={cut.type !== null && cut.shifted}
              data-cut={cut.type ?? 'shifted'}
              data-shifted={cut.shifted ? '' : undefined}
              style:--c={color(cut, 'n')}></i>{/if}
          {#if cuts.c[i]}{@const cut = cuts.c[i]!}<i
              class="c"
              class:both={cut.type !== null && cut.shifted}
              data-cut={cut.type ?? 'shifted'}
              data-shifted={cut.shifted ? '' : undefined}
              style:--c={color(cut, 'c')}></i>{/if}
        </span>
      {/if}
    {/each}
    {#if peptide.cTerm}<span class="term" title={modTitle(peptide.cTerm)}>{peptide.cTerm.label}</span>{/if}
  </div>
</div>

<style>
  .ladder {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    font-family: var(--font-sequence);
    font-size: calc(22px * var(--s));
    white-space: nowrap;
  }
  .aa {
    position: relative;
    width: calc(32px * var(--s));
    height: calc(52px * var(--s));
    line-height: calc(46px * var(--s));
    text-align: center;
    flex: none;
  }
  .aa.mod .letter {
    background: var(--mod-bg);
    color: var(--mod-fg);
    border-radius: 4px;
    padding: 0 3px;
    box-shadow: inset 0 -2px 0 var(--mod);
  }
  .label {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(-3px * var(--s));
    font-family: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
    font-size: 10px;
    line-height: 10px;
    font-weight: 600;
    color: var(--mod-fg);
  }
  .term {
    align-self: flex-start;
    margin-top: calc(6px * var(--s));
    font-family: 'Inter Variable', ui-sans-serif, system-ui, sans-serif;
    font-size: 11px;
    font-weight: 600;
    color: var(--mod-fg);
  }
  .cut {
    position: relative;
    width: calc(10px * var(--s));
    height: calc(46px * var(--s));
    flex: none;
  }
  /* above: a bracket opening to the N-terminal side; below: one opening to the C-terminal side */
  .cut i {
    position: absolute;
    left: calc(4px * var(--s));
    width: 2px;
    height: calc(20px * var(--s));
    background: var(--c);
  }
  .cut i::after {
    content: '';
    position: absolute;
    width: calc(8px * var(--s));
    height: 2px;
    background: var(--c);
  }
  .cut .n {
    top: 2px;
  }
  .cut .n::after {
    left: calc(-6px * var(--s));
    top: 0;
  }
  .cut .c {
    bottom: 2px;
  }
  .cut .c::after {
    left: 0;
    bottom: 0;
  }
  /* an unshifted and a shifted ion explain the cleavage: a dot of the cross-link's colour at the bracket's end */
  .cut i.both::before {
    content: '';
    position: absolute;
    left: -1px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--mod);
  }
  .cut .n.both::before {
    bottom: -5px;
  }
  .cut .c.both::before {
    top: -5px;
  }
</style>
