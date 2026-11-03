<script lang="ts">
  // The key figures above the tables: what the search found at its own cutoffs (peptide PSMs at the peptide
  // FDR, cross-link PSMs at the cross-link FDR). OpenNuXL has no protein FDR and no protein groups: the
  // proteins are those of the PSMs.
  import { formatPercent } from '$lib/format/fdr'
  import { formatCount } from '$lib/results/display'
  import type { KeyFigures } from '$lib/results/figures'

  let { figures }: { figures: KeyFigures } = $props()

  const fdr = (q: number) => (q >= 1 ? 'no FDR' : `${formatPercent(q)} FDR`)
  // the share of the MS2 spectra that are identified (spectra, not PSMs), when the search reports its MS2 spectra
  const share = $derived(figures.identifiedShareOfMs2 === null ? null : `${(figures.identifiedShareOfMs2 * 100).toFixed(0)} % of MS2`)
  const stats = $derived([
    {
      value: formatCount(figures.proteins),
      note: ['proteins', figures.xlProteins > 0 ? `${formatCount(figures.xlProteins)} cross-linked` : null].filter(Boolean).join(' · '),
      title: `Target proteins with a PSM at the search's cutoffs, contaminants included (OpenNuXL estimates no protein FDR). ${formatCount(figures.xlProteins)} of them have a cross-link PSM.`,
      testid: 'protein-count',
    },
    {
      value: formatCount(figures.peptides),
      note: ['peptides', figures.xlPeptides > 0 ? `${formatCount(figures.xlPeptides)} cross-linked` : null].filter(Boolean).join(' · '),
      title: `Target peptides with a PSM at the search's cutoffs. Each modified form and each adduct counts as its own peptide. ${formatCount(figures.xlPeptides)} of them are cross-linked.`,
      testid: 'peptide-count',
    },
    {
      value: formatCount(figures.psms),
      note: ['PSMs', `peptides ${fdr(figures.peptideFdr)}`, share].filter(Boolean).join(' · '),
      title:
        `Target PSMs at the search's cutoffs: ${formatCount(figures.psms - figures.xlPsms)} peptide PSMs at the peptide FDR (${formatPercent(figures.peptideFdr)}) ` +
        `and ${formatCount(figures.xlPsms)} cross-link PSMs at the cross-link FDR (${formatPercent(figures.xlFdr)}).` +
        (figures.ms2 > 0 ? ` They identify ${formatCount(figures.spectra)} of the ${formatCount(figures.ms2)} MS2 spectra.` : ''),
      testid: 'psm-count',
    },
    {
      value: formatCount(figures.xlPsms),
      note: ['cross-link PSMs', fdr(figures.xlFdr)].join(' · '),
      title: `Target cross-link PSMs (a peptide cross-linked to a nucleotide) at the search's cross-link FDR (${formatPercent(figures.xlFdr)}).`,
      testid: 'xl-psm-count',
    },
    {
      value: formatCount(figures.samples),
      note: `${figures.samples === 1 ? 'sample' : 'samples'}${figures.conditions > 0 ? ` · ${figures.conditions} ${figures.conditions === 1 ? 'condition' : 'conditions'}` : ''}`,
      title: 'Biological samples in the design. Each condition and replicate is one sample.',
      testid: 'sample-count',
    },
    {
      value: figures.medianAbsPpm === null ? '–' : `${figures.medianAbsPpm.toFixed(1)} ppm`,
      note: 'median |precursor error|',
      title: "Median absolute precursor mass error of the target PSMs at the search's cutoffs",
      testid: 'precursor-error',
    },
  ])
</script>

<div class="grid grid-cols-3 gap-2.5 xl:grid-cols-6">
  {#each stats as s (s.testid)}
    <div class="rounded-lg border bg-background px-3 py-2.5" title={s.title}>
      <div class="text-xl font-semibold tracking-tight tabular-nums" data-testid={s.testid}>{s.value}</div>
      <div class="truncate text-xs text-muted-foreground">{s.note}</div>
    </div>
  {/each}
</div>
