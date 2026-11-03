<script lang="ts">
  // The QC tab: three charts of the search's quality, each for the target PSMs the search kept (peptide
  // PSMs at the peptide FDR, cross-link PSMs at the cross-link FDR): how the peptide PSMs and the cross-link
  // PSMs score, how far the precursor masses are off, and how many PSMs each file gave. Peptide PSMs are
  // blue and cross-links orange (a validated pair); every chart says in its subtitle which PSMs it shows
  // and has a table of its numbers. (OpenNuXL's filtered files hold no decoys, so none is plotted.)
  import ChartCard from '$lib/components/charts/ChartCard.svelte'
  import FileBars from '$lib/components/charts/FileBars.svelte'
  import HistogramChart from '$lib/components/charts/HistogramChart.svelte'
  import { tickLabel } from '$lib/format/chart'
  import { cutoffText } from '$lib/results/overview'
  import { signedNumber } from '$lib/format/number'
  import { COLORS } from '$lib/psm/psm'
  import { formatCount } from '$lib/results/display'
  import { precursorErrors, psmsPerFile, scoreDistribution } from '$lib/results/qc'
  import type { ResultsView } from '$lib/results/view.svelte'

  let { view }: { view: ResultsView } = $props()

  const m = $derived(view.model)
  const fdr = $derived(`peptides ${cutoffText(m.psmFdr)}, cross-links ${cutoffText(m.xlFdr)}`)

  const targetColor = COLORS.b
  const xlColor = COLORS.y

  const score = $derived(scoreDistribution(m))
  const errors = $derived(precursorErrors(m))
  const files = $derived(psmsPerFile(m))

  const range = (edges: number[], b: number) => `${tickLabel(edges[b])} to ${tickLabel(edges[b + 1])}`
  const peak = (counts: number[]) => counts.indexOf(Math.max(...counts))

  const scoreDescription = $derived(
    score
      ? `Histogram of the ${score.scoreName} of the target PSMs at the search's cutoffs: ${formatCount(score.nPeptides)} peptide PSMs (blue bars) and ${formatCount(score.nCrossLinks)} cross-link PSMs (orange bars) in ${score.edges.length - 1} bins from ${tickLabel(score.edges[0])} to ${tickLabel(score.edges.at(-1)!)}.` +
        (score.nPeptides > 0 ? ` Most peptide PSMs score between ${range(score.edges, peak(score.peptides)).replace(' to ', ' and ')}.` : '') +
        (score.nCrossLinks > 0 ? ` Most cross-link PSMs score between ${range(score.edges, peak(score.crossLinks)).replace(' to ', ' and ')}.` : '')
      : '',
  )
  const errorDescription = $derived(
    errors
      ? `Histogram of the precursor mass error of ${formatCount(errors.n)} target PSMs, in ppm, in ${errors.edges.length - 1} bins from ${tickLabel(errors.edges[0])} to ${tickLabel(errors.edges.at(-1)!)}. The median error is ${signedNumber(errors.median, 1)} ppm.`
      : '',
  )
  const filesDescription = $derived(
    `Bar chart of the target PSMs in each of the ${files.length} searched files, from ${formatCount(Math.min(...files.map((f) => f.count)))} to ${formatCount(Math.max(...files.map((f) => f.count)))}.`,
  )
</script>

<div class="grid grid-cols-1 items-start gap-4 pb-6 xl:grid-cols-2" data-testid="qc-content">
  <!-- the cards are h3: the tab's own heading comes first, for the outline of the page -->
  <h2 class="sr-only">Quality control</h2>
  <!-- peptide PSMs against cross-link PSMs -->
  {#if score}
    <ChartCard
      testid="qc-score"
      title="Score distribution"
      subtitle="Target PSMs at the search's cutoffs ({fdr})"
      notes={score.unscored > 0 ? [`${formatCount(score.unscored)} PSMs have no score because Percolator could not rescore them. They are left out.`] : []}
      legend={[
        { label: 'Peptide PSMs', color: targetColor, value: formatCount(score.nPeptides) },
        { label: 'Cross-link PSMs', color: xlColor, value: formatCount(score.nCrossLinks) },
      ]}
      table={{
        name: 'Score distribution: PSMs per score range',
        columns: [
          { id: 'range', header: score.scoreName, align: 'left' },
          { id: 'peptides', header: 'Peptide PSMs' },
          { id: 'crosslinks', header: 'Cross-link PSMs' },
        ],
        rows: score.peptides.map((t, b) => [range(score.edges, b), formatCount(t), formatCount(score.crossLinks[b])]),
      }}>
      <HistogramChart
        title="Score distribution of peptide and cross-link PSMs"
        description={scoreDescription}
        edges={score.edges}
        xLabel={score.scoreName}
        series={[
          { name: 'Peptide PSMs', color: targetColor, counts: score.peptides, testid: 'peptide-bar' },
          { name: 'Cross-link PSMs', color: xlColor, counts: score.crossLinks, testid: 'xl-bar' },
        ]} />
    </ChartCard>
  {:else}
    <ChartCard testid="qc-score" title="Score distribution" subtitle="Target PSMs at the search's cutoffs ({fdr})">
      <p class="py-8 text-center text-xs text-muted-foreground">No PSM passes the search's FDRs, so there is nothing to plot.</p>
    </ChartCard>
  {/if}

  <!-- precursor error -->
  {#if errors}
    <ChartCard
      testid="qc-precursor"
      title="Precursor mass error"
      subtitle={`Target PSMs at the search's cutoffs (${fdr}) · ${formatCount(errors.n)} PSMs`}
      table={{
        name: 'Precursor mass error: PSMs per range',
        columns: [
          { id: 'range', header: 'Error (ppm)', align: 'left' },
          { id: 'psms', header: 'PSMs' },
        ],
        rows: errors.counts.map((c, b) => [range(errors.edges, b), formatCount(c)]),
      }}>
      <HistogramChart
        title="Precursor mass error of target PSMs"
        description={errorDescription}
        edges={errors.edges}
        xLabel="Precursor error (ppm)"
        unit="ppm"
        zeroLine
        marker={{ x: errors.median, label: `median precursor error ${signedNumber(errors.median, 1)} ppm` }}
        series={[{ name: 'Target PSMs', color: targetColor, counts: errors.counts, testid: 'error-bar' }]} />
    </ChartCard>
  {:else}
    <ChartCard testid="qc-precursor" title="Precursor mass error" subtitle="Target PSMs at the search's cutoffs ({fdr})">
      <p class="py-8 text-center text-xs text-muted-foreground">No PSM with a precursor error passes the search's FDRs.</p>
    </ChartCard>
  {/if}

  <!-- PSMs per file -->
  <ChartCard
    testid="qc-files"
    title="PSMs per file"
    subtitle="Target PSMs at the search's cutoffs ({fdr})"
    class="xl:col-span-2"
    table={{
      name: 'PSMs per file',
      columns: [
        { id: 'file', header: 'File', align: 'left' },
        { id: 'psms', header: 'PSMs' },
      ],
      rows: files.map((f) => [f.file, formatCount(f.count)]),
    }}>
    <FileBars title="Target PSMs per file" description={filesDescription} items={files} color={targetColor} />
  </ChartCard>
</div>
