import { readFileSync } from 'node:fs'
import { type Page, expect, test } from '@playwright/test'

const panel = (page: Page) => page.locator('dl[aria-label="Valeurs nutritionnelles"]')
const values = async (page: Page) => (await panel(page).locator('dd').allInnerTexts()).map((t) => t.replace(/\s/g, ''))

async function openRecipe(page: Page, title: string) {
  await page.goto('./#/recettes')
  await page.getByLabel('Rechercher').fill(title)
  await page.getByRole('heading', { name: title }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
  await page.getByRole('heading', { name: 'Nutrition' }).scrollIntoViewIfNeeded()
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(page.getByText('qu’est-ce qu’on cuisine')).toBeVisible()
})

test('pancakes protéinés : 3 modes, fiabilité, suivi de l’ajustement', async ({ page }) => {
  await openRecipe(page, 'Pancakes protéinés')
  await page.getByRole('radio', { name: 'Total' }).click()
  // 601,4 kcal ; P 64,9 ; G 48,6 ; L 16,0 (CIQUAL 2025 + Open Food Facts)
  await expect.poll(() => values(page)).toEqual(['601', '65', '49', '16'])
  await expect(page.getByRole('button', { name: /Calcul vérifié/ })).toBeVisible()
  await page.getByRole('radio', { name: 'Portion' }).click()
  await expect.poll(() => values(page)).toEqual(['301', '32', '24', '8'])
  await page.getByRole('radio', { name: '100 g' }).click()
  await expect(page.getByRole('button', { name: /Estimation/ })).toBeVisible()
  await expect(page.getByText(/base 427 g d’ingrédients/)).toBeVisible()
  // 3 œufs au lieu de 2 : tout suit (levure fixe).
  await page.getByRole('radio', { name: 'Total' }).click()
  await page.getByRole('button', { name: 'Augmenter œufs' }).click()
  await expect.poll(() => values(page)).toEqual(['899', '97', '72', '24'])
  await page.getByRole('button', { name: 'Réinitialiser' }).click()
  await expect.poll(() => values(page)).toEqual(['601', '65', '49', '16'])
})

test('poids après cuisson : base des valeurs pour 100 g', async ({ page }) => {
  await openRecipe(page, 'Pancakes protéinés')
  await page.getByRole('radio', { name: '100 g' }).click()
  await page.getByRole('button', { name: 'Poids après cuisson' }).click()
  await page.getByLabel('Poids de la préparation cuite').fill('380')
  await page.getByRole('dialog').getByRole('button', { name: 'Enregistrer' }).click()
  await expect(page.getByText('Pour 100 g de préparation cuite · 380 g')).toBeVisible()
  await expect.poll(async () => (await values(page))[0]).toBe('158') // 601,4 / 3,8
  await expect(page.getByRole('button', { name: /Calcul vérifié/ })).toBeVisible()
  await page.reload()
  await page.getByRole('heading', { name: 'Nutrition' }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: /Cuit : 380 g/ })).toBeVisible()
})

test('détail par ingrédient avec sources', async ({ page }) => {
  await openRecipe(page, 'Pancakes protéinés')
  await page.getByRole('button', { name: 'Détail par ingrédient' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Open Food Facts · Whey isolate')).toBeVisible()
  await expect(dialog.getByText('CIQUAL · Farine de sarrasin')).toBeVisible()
  await expect(dialog.getByText('Selon le goût (non compté)')).toBeVisible()
  await expect(dialog.getByText(/Anses\. 2025\. Table de composition nutritionnelle des aliments Ciqual/)).toBeVisible()
})

test('calcul automatique sans association, correction en un geste', async ({ page }) => {
  await openRecipe(page, 'Cottage pie')
  // Tout est reconnu sauf la sauce Worcestershire : le total est un minimum, signalé.
  await expect(page.getByRole('button', { name: /Partiel · 11\/12 ingrédients/ })).toBeVisible()
  await page.getByRole('radio', { name: 'Total' }).click()
  await expect(panel(page).locator('dd').first()).toContainText('≥')

  await page.getByRole('button', { name: 'Fiabilité par ingrédient' }).click()
  const detail = page.getByRole('dialog', { name: 'Détail par ingrédient' })
  await expect(detail.getByText(/Poids usuel estimé : 1 oignon ≈ 110 g/)).toBeVisible()
  await detail.getByRole('button', { name: /^oignon/ }).click()
  const onion = page.getByRole('dialog', { name: 'oignon' })
  await expect(onion.getByRole('heading', { name: 'Oignon, cru' })).toBeVisible()
  await expect(onion.getByText('Reconnu automatiquement')).toBeVisible()
  await onion.getByLabel(/Poids d’une pièce/).fill('150')
  await onion.getByRole('button', { name: 'Valider' }).click()
  await expect(page.getByText('Enregistré, et retenu pour vos prochaines recettes')).toBeVisible()
  await expect(detail.getByText('CIQUAL · Oignon, cru (votre choix)')).toBeVisible()

  // Ingrédient inconnu : on choisit de ne pas le compter, le calcul n'est plus partiel.
  await detail.getByRole('button', { name: /^sauce Worcestershire/ }).click()
  const sauce = page.getByRole('dialog', { name: 'sauce Worcestershire' })
  await sauce.getByRole('switch', { name: /Ne pas compter cet ingrédient/ }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /Estimation · 11\/11 ingrédients/ })).toBeVisible()
  await expect(panel(page).locator('dd').first()).not.toContainText('≥')
})

test('aperçu nutritionnel en direct pendant la saisie', async ({ page }) => {
  await page.goto('./#/recettes/nouvelle')
  await page.getByLabel('Nom de la recette *').fill('Galettes test')
  const add = page.getByRole('button', { name: 'Ajouter un ingrédient' })
  const lines: Array<[string, string, string]> = [
    ['1', '', 'oignon'],
    ['2', '', 'œufs'],
    ['150', 'g', 'farine'],
    ['1', 'c. à soupe', 'huile d’olive'],
  ]
  for (const [i, [q, u, n]] of lines.entries()) {
    if (i > 0) await add.click()
    await page.getByLabel(`Quantité de l’ingrédient ${i + 1}`).fill(q)
    if (u) await page.getByLabel('Unité').nth(i).fill(u)
    await page.getByLabel('Nom de l’ingrédient').nth(i).fill(n)
  }
  const live = page.getByLabel('Aperçu nutritionnel')
  // 110 g d'oignon + 100 g d'œufs + 150 g de farine + 13,65 g d'huile : 831 kcal (CIQUAL 2025).
  await expect(live).toContainText('Recette entière : 831 kcal')
  await expect(live).toContainText('Par portion (4) : 208 kcal')
  await expect(live).toContainText('Estimation · 4/4 ingrédients calculés automatiquement')
})

test('produit de marque Open Food Facts (réseau simulé) et mémoire « Mes aliments »', async ({ page }) => {
  const product = JSON.parse(readFileSync('tests/fixtures/off-skyr-3329770077003.json', 'utf-8')).product
  await page.route('https://world.openfoodfacts.org/**', (route) => {
    const url = route.request().url()
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(url.includes('/cgi/search.pl') ? { count: 1, products: [product] } : { product }),
    })
  })
  await openRecipe(page, 'Gâteau au chocolat fondant')
  await page.getByRole('button', { name: 'Détail par ingrédient' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^sucre/ }).click()
  const sheet = page.getByRole('dialog', { name: 'sucre' })
  await expect(sheet.getByRole('heading', { name: 'Sucre blanc' })).toBeVisible()
  await sheet.getByRole('button', { name: /Recherche avancée/ }).click()
  await sheet.getByRole('radio', { name: 'Marques' }).click()
  await sheet.getByLabel('Rechercher dans Open Food Facts').fill('skyr yoplait')
  await sheet.getByRole('button', { name: 'Chercher' }).click()
  await sheet.getByRole('button', { name: /Skyr nature 0%/ }).click()
  await expect(sheet.getByText(/code-barres 3329770077003/)).toBeVisible()
  await sheet.getByRole('button', { name: 'Ajouter aux favoris' }).click()
  await sheet.getByRole('button', { name: 'Valider' }).click()
  // L'aliment est retrouvé sans nouvelle recherche.
  await page.getByRole('dialog').getByRole('button', { name: /^farine/ }).click()
  const flour = page.getByRole('dialog', { name: 'farine' })
  await flour.getByRole('button', { name: /Recherche avancée/ }).click()
  await flour.getByRole('radio', { name: 'Mes aliments' }).click()
  await expect(flour.getByText('Skyr nature 0%')).toHaveCount(2) // favoris + récents
})

test('hors ligne : calcul et recherche CIQUAL sans réseau', async ({ page, context }) => {
  await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)
  await page.reload()
  await context.setOffline(true)
  await page.reload()
  await openRecipe(page, 'Cottage pie')
  await expect(page.getByRole('button', { name: /Partiel · 11\/12 ingrédients/ })).toBeVisible()
  await page.getByRole('button', { name: 'Détail par ingrédient' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^carottes/ }).click()
  const sheet = page.getByRole('dialog', { name: 'carottes' })
  await expect(sheet.getByRole('heading', { name: 'Carotte, crue' })).toBeVisible()
  await sheet.getByRole('button', { name: /Recherche avancée/ }).click()
  await sheet.getByLabel('Rechercher dans CIQUAL').fill('carotte crue')
  await expect(sheet.getByRole('button', { name: /^Carotte, crue/ }).first()).toBeVisible()
  await sheet.getByRole('radio', { name: 'Marques' }).click()
  await expect(sheet.getByText(/Hors ligne : la recherche de produits de marque/)).toBeVisible()
  await context.setOffline(false)
})
