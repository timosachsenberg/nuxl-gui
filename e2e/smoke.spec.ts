import { invoke } from './lib.ts'

describe('smoke', () => {
  it('the window shows the NuXL top bar', async () => {
    const header = await $('header')
    await header.waitForDisplayed({ timeout: 20000 })
    await expect(header).toHaveText(expect.stringContaining('NuXL'))
    const nav = await $('nav[aria-label="Main"]')
    for (const label of ['New search', 'Results', 'History']) {
      await expect(nav.$(`a=${label}`)).toBeDisplayed()
    }
  })

  it('the OpenMS logo loads (the bundled image, as the CSP lets it)', async () => {
    const logo = await $('[data-testid="openms-logo"]')
    await expect(logo).toBeDisplayed()
    await browser.waitUntil(() => browser.execute((img: HTMLImageElement) => img.complete, logo as unknown as HTMLImageElement))
    const size = await browser.execute((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight, img.width], logo as unknown as HTMLImageElement)
    expect(size).toEqual([180, 180, 36])
  })

  it('the tool is found: NUXL_TOOL, its version, and New search can start with the example', async function () {
    if (!process.env.NUXL_TOOL) {
      console.log('skipped: set NUXL_TOOL (or NUXL_FAKE=1) to check the tool the app finds')
      return this.skip()
    }
    const { result, failure } = await invoke('tool_info')
    expect(failure).toBeUndefined()
    expect(result.path).toBe(process.env.NUXL_TOOL)
    expect(result.version).toMatch(/^\d+\.\d+/)
    await $('[data-testid="view-search"]').waitForDisplayed({ timeout: 20000 })
    await $('button=Try the example').click()
    await expect($('[data-testid="fasta-proteins"]')).toHaveText('5 proteins')
    // no problem line ("OpenNuXL cannot be run: ..."): the plan, and Start search can be clicked
    expect(String(await $('[data-testid="search-plan"]').getProperty('textContent'))).not.toContain('cannot be run')
    await expect($('button*=Start search')).toBeEnabled()
  })
})
