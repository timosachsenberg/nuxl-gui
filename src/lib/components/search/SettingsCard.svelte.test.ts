// @vitest-environment happy-dom
// The search settings as the page shows them: the protocol with its line, the longest adduct, the FDRs of the
// peptide and the cross-link PSMs; the custom protocol links to its adducts in the "All parameters" dialog.
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/desktop', () => ({
  cpuCount: vi.fn(async () => 8),
  toolInfo: vi.fn(async () => ({ version: '3.7.0', path: '/x/OpenNuXL' })),
  inspectFiles: vi.fn(async () => []),
  exampleFiles: vi.fn(),
  errorText: (e: unknown) => String(e),
}))
vi.mock('$lib/route.svelte', () => ({ navigate: vi.fn(), router: { route: { view: 'search' } } }))

const { default: SettingsCard } = await import('./SettingsCard.svelte')
const { searchForm: form } = await import('$lib/search/form.svelte')

let shown: Record<string, unknown> | null = null
afterEach(() => {
  if (shown) unmount(shown)
  shown = null
  document.body.innerHTML = ''
  form.choosePreset('nuxl-defaults')
})

function show() {
  shown = mount(SettingsCard, { target: document.body })
  flushSync()
}

describe('SettingsCard', () => {
  it('shows the protocol of the default preset with its line, the longest adduct and both FDRs', () => {
    show()
    expect(document.querySelector('[data-testid="protocol-summary"]')?.textContent?.trim()).toBe(
      'RNA, UV light · cross-links at U · 10 nucleotide adducts',
    )
    expect((document.getElementById('adduct-length') as HTMLInputElement).value).toBe('2')
    expect((document.getElementById('precursor-tolerance') as HTMLInputElement).value).toBe('6')
    expect((document.getElementById('peptide-fdr') as HTMLInputElement).value).toBe('1')
    expect((document.getElementById('xl-fdr') as HTMLInputElement).value).toBe('1')
    expect(document.body.textContent).toContain('All 40 parameters')
    expect(document.body.textContent).not.toContain('Edit the adducts')
  })

  it('the custom protocol says where its adducts come from and links to them', () => {
    form.setProtocol('none')
    show()
    const summary = document.querySelector('[data-testid="protocol-summary"]')!
    expect(summary.textContent).toContain('Custom: the nucleotides and adducts of the NuXL parameters')
    expect(summary.querySelector('button')?.textContent).toBe('Edit the adducts')
    // the dialog opens on the NuXL parameters, which count now (not disabled)
    summary.querySelector('button')!.click()
    flushSync()
    const find = document.querySelector('input[aria-label="Find a parameter"]') as HTMLInputElement
    expect(find.value).toBe('NuXL:')
    const modifications = document.getElementById('param-NuXL-modifications') as HTMLTextAreaElement
    expect(modifications.disabled).toBe(false)
    expect(document.body.textContent).not.toContain('The protocol sets this.')
  })

  it('with a protocol, the dialog shows the adduct fields disabled, saying why', () => {
    show()
    ;[...document.querySelectorAll('button')].find((b) => b.textContent?.startsWith('All 40 parameters'))!.click()
    flushSync()
    expect((document.getElementById('param-NuXL-modifications') as HTMLTextAreaElement).disabled).toBe(true)
    expect(document.body.textContent).toContain('The protocol sets this.')
  })

  it('a longest peptide of no limit shows as empty', () => {
    show()
    const longest = document.querySelector('[aria-label="Longest peptide (residues; empty: no limit)"]') as HTMLInputElement
    expect(longest.value).toBe('')
    expect(longest.placeholder).toBe('any')
  })
})
