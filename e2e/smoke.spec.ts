describe('smoke', () => {
  it('the window shows the ProSE top bar', async () => {
    const header = await $('header')
    await header.waitForDisplayed({ timeout: 20000 })
    await expect(header).toHaveText(expect.stringContaining('ProSE'))
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
})
