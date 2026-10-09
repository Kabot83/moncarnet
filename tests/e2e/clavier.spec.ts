import { type Page, expect, test } from '@playwright/test'

/**
 * Mise en page avec le clavier virtuel. Le clavier est simulé comme sur un
 * téléphone : la zone visible rétrécit pendant qu'un champ a le focus.
 */
const FULL = { width: 412, height: 839 }
const WITH_KEYBOARD = { width: 412, height: 839 - 330 }

const nav = (page: Page) => page.getByRole('navigation', { name: 'Navigation principale' })
const fab = (page: Page) => page.getByRole('button', { name: 'Ajouter une recette' })

async function openKeyboard(page: Page, field: ReturnType<Page['getByLabel']>) {
  await field.click()
  await page.setViewportSize(WITH_KEYBOARD)
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'open')
}

async function closeKeyboard(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.setViewportSize(FULL)
  await expect(page.locator('html')).toHaveAttribute('data-keyboard', 'closed')
}

/** Le champ actif est entièrement visible et rien de fixe ne le recouvre. */
async function expectFieldVisible(page: Page) {
  const ok = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const top = document.elementFromPoint(cx, cy)
    return r.top >= 0 && r.bottom <= window.innerHeight && (top === el || el.contains(top))
  })
  expect(ok).toBe(true)
}

/** Aucune bande vide : le document remplit toujours la hauteur visible. */
async function expectNoGap(page: Page) {
  const gap = await page.evaluate(() => window.innerHeight - document.documentElement.getBoundingClientRect().bottom)
  expect(gap).toBeLessThanOrEqual(1)
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize(FULL)
  await page.goto('./')
  await expect(page.getByText('qu’est-ce qu’on cuisine')).toBeVisible()
})

test('accueil : le titre n’est pas masqué et la navigation est en bas', async ({ page }) => {
  const title = await page.getByRole('heading', { level: 1 }).boundingBox()
  expect(title!.y).toBeGreaterThanOrEqual(16)
  const navBox = await nav(page).boundingBox()
  expect(Math.round(navBox!.y + navBox!.height)).toBe(FULL.height)
  const fabBox = await fab(page).boundingBox()
  expect(fabBox!.y + fabBox!.height).toBeLessThanOrEqual(navBox!.y)
})

test('recherche de l’accueil : navigation et + masqués pendant la saisie, puis restaurés', async ({ page }) => {
  await openKeyboard(page, page.getByLabel('Rechercher dans mes recettes'))
  await expect(nav(page)).toBeHidden()
  await expect(fab(page)).toBeHidden()
  await expectFieldVisible(page)
  await expectNoGap(page)
  await closeKeyboard(page)
  await expect(nav(page)).toBeVisible()
  await expect(fab(page)).toBeVisible()
  const navBox = await nav(page).boundingBox()
  expect(Math.round(navBox!.y + navBox!.height)).toBe(FULL.height)
})

test('catalogue : recherche avec clavier ouvert puis navigation entre pages', async ({ page }) => {
  await page.goto('./#/recettes')
  await openKeyboard(page, page.getByLabel('Rechercher'))
  await page.keyboard.type('crêpes')
  await expect(page.getByRole('heading', { name: 'Crêpes de base' })).toBeVisible()
  await expect(nav(page)).toBeHidden()
  await expectFieldVisible(page)
  await closeKeyboard(page)
  await nav(page).getByRole('link', { name: 'Collections' }).click()
  await expect(page.getByRole('heading', { name: 'Collections' })).toBeVisible()
  await expect(nav(page)).toBeVisible()
})

test('création de recette : le champ en bas de page reste visible au-dessus du clavier', async ({ page }) => {
  await page.goto('./#/recettes/nouvelle')
  const save = page.getByRole('button', { name: 'Ajouter au carnet' })
  await expect(save).toBeVisible()
  await openKeyboard(page, page.getByLabel('Étape 1'))
  await expect(save).toBeHidden() // barre d'actions masquée pendant la saisie
  await page.keyboard.type('Mélanger la pâte.')
  await expectFieldVisible(page)
  await openKeyboard(page, page.getByLabel('Nom de la recette *'))
  await page.keyboard.type('Gaufres')
  await expectFieldVisible(page)
  await closeKeyboard(page)
  await expect(save).toBeVisible()
})

test('modification de recette : édition d’une note dans une feuille avec clavier', async ({ page }) => {
  await page.goto('./#/recettes')
  await page.getByLabel('Rechercher').fill('Crêpes de base')
  await page.getByRole('heading', { name: 'Crêpes de base' }).click()
  await page.getByRole('button', { name: 'Modifier mes notes' }).click()
  const tips = page.getByRole('dialog').getByLabel('Mes astuces')
  await openKeyboard(page, tips)
  await expectFieldVisible(page)
  const dialog = await page.getByRole('dialog').boundingBox()
  expect(dialog!.y).toBeGreaterThanOrEqual(0)
  expect(dialog!.y + dialog!.height).toBeLessThanOrEqual(WITH_KEYBOARD.height + 1)
  await closeKeyboard(page)
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('Chef IA : la zone de saisie suit le clavier sans zone vide', async ({ page }) => {
  await page.goto('./#/reglages/ia')
  await page.getByRole('radio', { name: /Clé sur ce téléphone/ }).click()
  await page.goto('./#/chef')
  const input = page.getByLabel('Message pour le Chef IA')
  const before = await input.boundingBox()
  expect(before!.y + before!.height).toBeLessThanOrEqual((await nav(page).boundingBox())!.y)
  await openKeyboard(page, input)
  const after = await input.boundingBox()
  expect(after!.y + after!.height).toBeLessThanOrEqual(WITH_KEYBOARD.height)
  expect(WITH_KEYBOARD.height - (after!.y + after!.height)).toBeLessThan(40) // posée juste au-dessus du clavier
  await expectFieldVisible(page)
})
