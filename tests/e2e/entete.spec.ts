import { type Page, expect, test } from '@playwright/test'

/** Luminance relative WCAG d'une couleur CSS « rgb(r, g, b) ». */
function luminance(css: string): number {
  const [r, g, b] = (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
    const c = Number(v) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

async function checkHeader(page: Page) {
  const header = page.locator('[data-app-header]')
  await expect(header).toBeVisible()
  const box = (await header.boundingBox())!
  expect(box.y).toBe(0)
  expect(box.height).toBeGreaterThanOrEqual(56)
  expect(box.height).toBeLessThanOrEqual(64)
  const s = await page.evaluate(() => {
    const h = document.querySelector('[data-app-header]')!
    const title = h.querySelector('span')!
    const icon = h.querySelector('svg')!
    const t = title.getBoundingClientRect()
    const i = icon.getBoundingClientRect()
    return {
      headerBg: getComputedStyle(h).backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(title).color,
      icon: getComputedStyle(icon).color,
      terra: getComputedStyle(document.documentElement).getPropertyValue('--c-terra').trim(),
      titleCenter: t.top + t.height / 2,
      iconCenter: i.top + i.height / 2,
      iconSize: [i.width, i.height],
    }
  })
  expect(s.headerBg).toBe(s.bodyBg) // même fond que l'application
  expect(contrast(s.text, s.headerBg)).toBeGreaterThan(7) // texte parfaitement lisible
  expect(Math.abs(s.titleCenter - s.iconCenter)).toBeLessThanOrEqual(2) // alignement vertical
  expect(s.iconSize).toEqual([22, 22]) // petite icône, non déformée
  const rgb = (hex: string) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`
  expect(s.icon).toBe(rgb(s.terra))
  // Pas d'espace vide excessif entre l'en-tête et le contenu.
  const welcome = (await page.getByRole('region', { name: 'Bienvenue' }).boundingBox())!
  expect(welcome.y - (box.y + box.height)).toBeLessThanOrEqual(16)
  expect(welcome.y).toBeGreaterThanOrEqual(box.y + box.height)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`en-tête de l’accueil en mode ${scheme === 'light' ? 'clair' : 'sombre'}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('./')
    await expect(page.getByText('qu’est-ce qu’on cuisine')).toBeVisible()
    await checkHeader(page)
  })
}

test('en-tête collant au défilement et avec le clavier ouvert', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.setViewportSize({ width: 412, height: 839 })
  await page.goto('./')
  await page.mouse.wheel(0, 900)
  await expect(page.locator('[data-app-header]')).toBeInViewport()
  expect((await page.locator('[data-app-header]').boundingBox())!.y).toBe(0)
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.getByLabel('Rechercher dans mes recettes').click()
  await page.setViewportSize({ width: 412, height: 509 })
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open')
  const header = (await page.locator('[data-app-header]').boundingBox())!
  const field = (await page.getByLabel('Rechercher dans mes recettes').boundingBox())!
  expect(field.y).toBeGreaterThanOrEqual(header.y + header.height) // pas de chevauchement
  expect(field.y + field.height).toBeLessThanOrEqual(509)
})

test('les autres pages gardent leur propre en-tête, sans bandeau', async ({ page }) => {
  for (const [path, title] of [
    ['./#/recettes', 'Mes recettes'],
    ['./#/collections', 'Collections'],
    ['./#/reglages', 'Réglages'],
    ['./#/chef', 'Mon Chef IA'],
  ]) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.locator('[data-app-header]')).toHaveCount(0)
    const h1 = (await page.getByRole('heading', { level: 1, name: title }).boundingBox())!
    expect(h1.y).toBeGreaterThanOrEqual(0)
  }
})
