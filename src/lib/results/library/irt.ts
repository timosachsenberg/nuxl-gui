// The spectral library's NormalizedRetentionTime (iRT): from a reference library of the same LC setup (an MSFragger /
// EasyPQP library.tsv, whose rows have the run's retention time and its iRT), a straight line fitted to the
// reference's iRT over its retention time, applied to NuXL's retention times. Without a reference the column stays
// empty (DIA-NN then takes the retention times as they are).
//
// Ported from nuxl-app src/nuxl2dia.py (NuXL Team; NuXLDIA, github.com/timosachsenberg/NuXLDIA: `_fit_irt_model`,
// mode 'linear'), BSD-3, Copyright OpenMS Inc. -- Eberhard Karls University Tuebingen, ETH Zurich, and Freie
// Universitaet Berlin 2002-present. Differences: linear only (nuxl-app's piecewise mode needs pwlf, and falls back to
// linear without it); the ordinary least-squares slope (nuxl2dia.py's fallback without scipy divides the sample
// covariance by the population variance, a slope n/(n−1) too steep).

/** The columns of a reference: the retention time and the iRT, the first of each list that the header has. */
const RT_COLUMNS = ['RT', 'AverageExperimentalRetentionTime']
const IRT_COLUMNS = ['iRT', 'NormalizedRetentionTime']

/** A straight line iRT = intercept + slope · RT, and the reference rows it was fitted to. */
export type IrtFit = { slope: number; intercept: number; points: number }

/**
 * The (RT, iRT) rows of a reference library (tab-separated, with a header; every row with both values). Throws when
 * the header has neither column of a kind, naming the columns it looks for.
 */
export function readIrtReference(text: string): { rt: number[]; irt: number[] } {
  const lines = text.split(/\r?\n/)
  const header = (lines[0] ?? '').replace(/^\uFEFF/, '').split('\t').map((h) => h.trim())
  const column = (names: string[]) => {
    for (const n of names) {
      const k = header.indexOf(n)
      if (k >= 0) return k
    }
    return -1
  }
  const rtAt = column(RT_COLUMNS)
  const irtAt = column(IRT_COLUMNS)
  if (rtAt < 0 || irtAt < 0) {
    throw new Error(
      `The reference has no ${rtAt < 0 ? RT_COLUMNS.join(' or ') : IRT_COLUMNS.join(' or ')} column (it needs a retention time and an iRT column).`,
    )
  }
  const rt: number[] = []
  const irt: number[] = []
  for (let k = 1; k < lines.length; k++) {
    if (lines[k] === '') continue
    const fields = lines[k].split('\t')
    const x = number(fields[rtAt])
    const y = number(fields[irtAt])
    if (Number.isFinite(x) && Number.isFinite(y)) {
      rt.push(x)
      irt.push(y)
    }
  }
  return { rt, irt }
}

/** A field as a number; NaN when empty or not one. */
const number = (field: string | undefined) => (field === undefined || field.trim() === '' ? NaN : Number(field))

/**
 * The least-squares line of `irt` over `rt`. Throws with fewer than 2 rows or when all have one retention time.
 */
export function fitIrt(rt: readonly number[], irt: readonly number[]): IrtFit {
  const n = Math.min(rt.length, irt.length)
  if (n < 2) throw new Error(`The reference has ${n === 0 ? 'no row' : 'one row'} with a retention time and an iRT; a line needs two.`)
  let mx = 0
  let my = 0
  for (let k = 0; k < n; k++) {
    mx += rt[k]
    my += irt[k]
  }
  mx /= n
  my /= n
  let sxx = 0
  let sxy = 0
  for (let k = 0; k < n; k++) {
    const dx = rt[k] - mx
    sxx += dx * dx
    sxy += dx * (irt[k] - my)
  }
  if (!(sxx > 0)) throw new Error('All rows of the reference have the same retention time; no line can be fitted.')
  const slope = sxy / sxx
  return { slope, intercept: my - slope * mx, points: n }
}

/** The iRT of retention time `rt` (seconds) by `fit`; NaN without a fit or a retention time. */
export function toIrt(fit: IrtFit | null, rt: number): number {
  return fit === null || Number.isNaN(rt) ? NaN : fit.intercept + fit.slope * rt
}

/** The text of a reference file: gzip-compressed ('.tsv.gz', as FragPipe writes library.tsv.gz) or not. */
export async function referenceText(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  }
  return new TextDecoder().decode(bytes)
}
