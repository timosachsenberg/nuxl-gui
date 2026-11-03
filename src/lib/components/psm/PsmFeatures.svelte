<script lang="ts">
  // The PSM's features (mockup 3): its score (Percolator's when the run was rescored, else NuXL's), q-value and PEP,
  // the peaks NuXL's annotation shown explains, the cross-link (adduct, nucleotide, site), errors, missed cleavages,
  // the modifications; OpenNuXL's main scores; where else its peptide was found; and every feature of the search,
  // in groups (scores first), under "All features".
  import { signedNumber } from '$lib/format/number'
  import { formatCount, formatQValue, formatScore } from '$lib/results/display'
  import type { ResultModel } from '$lib/results/model'
  import { featureValue, modificationList } from '$lib/psm/psm'
  import { featureGroups } from './nuxl-psm'

  let {
    model,
    row,
    fixedMods,
    matched,
  }: {
    model: ResultModel
    row: number
    fixedMods: string[]
    /** Of the spectrum shown: the peaks NuXL's annotation shown explains, and the share of the intensity they carry. */
    matched: { peaks: number; total: number; intensityFraction: number } | null
  } = $props()

  const ps = $derived(model.tables.psms)
  const pt = $derived(model.tables.peptides)
  const xl = $derived(ps.xl)
  const k = $derived(ps.peptide[row])
  const names = $derived(ps.featureNames)
  const feature = (name: string) => featureValue(names, ps.features, row, name)
  const number = (v: number, digits = 3) => (Number.isFinite(v) ? String(Number(v.toPrecision(digits + 1))) : '–')

  const adduct = $derived(xl.adduct[row] ?? '')
  // the adduct is the cross-link's, said apart: not one of the modifications
  const modifications = $derived(modificationList(pt, k, fixedMods).filter((m) => adduct === '' || !m.startsWith(`${adduct} (`)))

  /** The samples (other than this PSM's) where the peptide has PSMs at the search's FDR. */
  const alsoIn = $derived.by(() => {
    const nS = model.samples.length
    const mine = model.psmSample[row]
    const out: string[] = []
    for (let s = 0; s < nS; s++) if (s !== mine && model.peptide.perSample[k * nS + s] > 0) out.push(model.samples[s].label)
    return out
  })

  /** The PSMs of the other forms of the sequence (modified, with another adduct, or without) at the search's FDR. */
  const otherForms = $derived.by(() => {
    const sequence = pt.sequence[k]
    let psms = 0
    let forms = 0
    for (let j = 0; j < pt.count; j++) {
      if (j === k || pt.sequence[j] !== sequence || pt.decoy[j] !== pt.decoy[k]) continue
      if (model.peptide.psms[j] > 0) (psms += model.peptide.psms[j]), forms++
    }
    return { psms, forms }
  })

  const scoreName = $derived(model.rescored ? 'Percolator score' : 'NuXL score')
  const groups = $derived(featureGroups(names))

  type Item = { name: string; value: string; title?: string }
  const items = $derived.by(() => {
    const list: Item[] = [{ name: scoreName, value: formatScore(ps.score[row], ps.qValue[row]) }]
    list.push({ name: 'q-value', value: formatQValue(ps.qValue[row]) })
    if (Number.isFinite(ps.xl.peptideQValue[row]))
      list.push({
        name: 'Peptide q-value',
        value: formatQValue(ps.xl.peptideQValue[row]),
        title: 'OpenNuXL’s peptide-level q-value (by the best PSM of the sequence); a peptide PSM counts at the peptide FDR only if this is below it too.',
      })
    if (Number.isFinite(ps.pep[row])) list.push({ name: 'PEP', value: formatQValue(ps.pep[row]) })
    if (model.rescored && Number.isFinite(feature('NuXL:score'))) list.push({ name: 'NuXL score', value: number(feature('NuXL:score'), 3) })
    if (matched) {
      const share = Number.isFinite(matched.intensityFraction) ? ` · ${Math.round(matched.intensityFraction * 100)} % int.` : ''
      list.push({
        name: 'Annotated peaks',
        value: `${formatCount(matched.peaks)} / ${formatCount(matched.total)}${share}`,
        title: 'The peaks NuXL’s annotation explains, of the ions shown by the toggles above. The percentage is the share of the spectrum’s intensity in them.',
      })
    }
    if (adduct !== '') {
      const mass = xl.adductMass[row]
      list.push({ name: 'Adduct', value: Number.isFinite(mass) && mass !== 0 ? `${adduct} (${signedNumber(mass, 4)} Da)` : adduct, title: 'The nucleic acid adduct of the precursor (NuXL:NA)' })
      if (xl.nucleotide[row]) list.push({ name: 'Cross-linked nucleotide', value: xl.nucleotide[row] })
      if (xl.adductLength[row] > 0) list.push({ name: 'Adduct length', value: `${xl.adductLength[row]} nt` })
    }
    if (xl.isXL[row]) {
      const site = xl.site[row]
      const sequence = pt.sequence[k]
      list.push({ name: 'Cross-linked residue', value: site >= 0 && site < sequence.length ? `${sequence[site]}${site + 1}` : 'not localized' })
      if (Number.isFinite(xl.siteScore[row])) list.push({ name: 'Localization score', value: number(xl.siteScore[row], 3), title: 'NuXL:best_localization_score' })
    }
    if (xl.fdrGroup[row]) list.push({ name: 'FDR group', value: xl.fdrGroup[row] })
    list.push({ name: 'Precursor error', value: `${signedNumber(ps.precursorErrorPpm[row], 2)} ppm` })
    list.push({ name: 'Isotope error', value: String(ps.isotopeError[row]) })
    const missed = Number.isFinite(feature('missed_cleavages')) ? feature('missed_cleavages') : feature('enzInt')
    if (Number.isFinite(missed)) list.push({ name: 'Missed cleavages', value: String(missed) })
    list.push({ name: 'Modifications', value: modifications.length > 0 ? modifications.join(' · ') : 'none' })
    return list
  })

  /** OpenNuXL's main scores (the first of its "Scores"), for a glance. */
  const scores = $derived.by(() => {
    const top = groups.find((g) => g.title === 'Scores')?.features ?? []
    return top
      .filter((f) => !(f.name === 'NuXL:score' && (!model.rescored || items.some((i) => i.name === 'NuXL score'))))
      .slice(0, 8)
      .map((f) => ({ ...f, value: ps.features[row * names.length + f.index] }))
      .filter((f) => Number.isFinite(f.value))
  })
</script>

<div data-testid="psm-features">
  <h3 class="mb-1.5 text-[13px] font-semibold">PSM features</h3>
  <!-- one name and value per line, flowing into columns as the card gets wider -->
  <dl class="kv">
    {#each items as item (item.name)}
      <div class="kv-row">
        <dt title={item.title}>{item.name}</dt>
        <dd title={item.title}>{item.value}</dd>
      </div>
    {/each}
  </dl>
  {#if scores.length > 0}
    <h4 class="mt-3 mb-1 text-xs font-medium text-muted-foreground">NuXL scores</h4>
    <dl class="kv" data-testid="nuxl-scores">
      {#each scores as f (f.name)}
        <div class="kv-row">
          <dt title={f.name}>{f.label}</dt>
          <dd>{number(f.value, 4)}</dd>
        </div>
      {/each}
    </dl>
  {/if}
  {#if alsoIn.length > 0 || otherForms.psms > 0}
    <p class="mt-2.5 text-xs text-muted-foreground">
      {#if alsoIn.length > 0}Also identified in {alsoIn.join(', ')}{/if}{#if alsoIn.length > 0 && otherForms.psms > 0}{' · '}{/if}{#if otherForms.psms > 0}{formatCount(otherForms.psms)}
        {otherForms.psms === 1 ? 'PSM' : 'PSMs'} of {otherForms.forms === 1 ? 'another form' : 'other forms'} of the sequence{/if}
    </p>
  {/if}
  {#if names.length > 0}
    <details class="mt-2.5 text-xs">
      <summary class="cursor-pointer text-muted-foreground hover:text-foreground">All {names.length} features</summary>
      {#each groups as g (g.title)}
        <h4 class="mt-2 mb-0.5 text-[11px] font-medium text-muted-foreground">{g.title}</h4>
        <dl class="kv">
          {#each g.features as f (f.name)}
            <div class="kv-row">
              <dt title={f.name}>{f.label}</dt>
              <dd>{number(ps.features[row * names.length + f.index], 4)}</dd>
            </div>
          {/each}
        </dl>
      {/each}
    </details>
  {/if}
</div>

<style>
  .kv {
    columns: 240px;
    column-gap: 32px;
    font-size: 12px;
  }
  .kv-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 1.5px 0;
    break-inside: avoid;
  }
  .kv dt {
    color: var(--color-muted-foreground);
  }
  .kv dd {
    margin: 0;
    text-align: right;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
</style>
