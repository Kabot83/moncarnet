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
  await expect(page.getByRole('button', { name: /Calcul complet/ })).toBeVisible()
  await page.getByRole('radio', { name: 'Portion' }).click()
  await expect.poll(() => values(page)).toEqual(['301', '32', '24', '8'])
  await page.getByRole('radio', { name: '100 g' }).click()
  await expect(page.getByRole('button', { name: /Calcul estimatif/ })).toBeVisible()
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
  await expect(page.getByRole('button', { name: /Calcul complet/ })).toBeVisible()
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

test('associer des ingrédients CIQUAL, poids d’une pièce obligatoire, données incomplètes signalées', async ({ page }) => {
  await openRecipe(page, 'Cottage pie')
  await page.getByRole('button', { name: 'Associer les ingrédients' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /bœuf haché 15 %/ }).click()
  const link = page.getByRole('dialog', { name: 'bœuf haché 15 %' })
  await link.getByLabel('Rechercher dans CIQUAL').fill('boeuf haché 15%')
  await link.getByRole('button', { name: /Boeuf, steak haché 15% MG cru/ }).click()
  await link.getByRole('button', { name: /Associer à/ }).click()
  await expect(page.getByText('Valeurs nutritionnelles associées')).toBeVisible()

  // Un oignon (pièce) : impossible de valider sans poids.
  await page.getByRole('dialog').getByRole('button', { name: /^oignon/ }).click()
  const onion = page.getByRole('dialog', { name: 'oignon' })
  await onion.getByLabel('Rechercher dans CIQUAL').fill('oignon cru')
  await onion.getByRole('button', { name: /^Oignon, cru/ }).first().click()
  await expect(onion.getByRole('button', { name: /Associer à/ })).toBeDisabled()
  await onion.getByLabel(/Poids d’une pièce/).fill('110')
  await onion.getByRole('button', { name: /Associer à/ }).click()

  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /Données incomplètes · 2\/\d+ ingrédients/ })).toBeVisible()
  await page.getByRole('radio', { name: 'Total' }).click()
  await expect(panel(page).locator('dd').first()).toContainText('≥')
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
  await page.getByRole('button', { name: 'Associer les ingrédients' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^sucre/ }).click()
  const sheet = page.getByRole('dialog', { name: 'sucre' })
  await sheet.getByRole('radio', { name: 'Marques' }).click()
  await sheet.getByLabel('Rechercher dans Open Food Facts').fill('skyr yoplait')
  await sheet.getByRole('button', { name: 'Chercher' }).click()
  await sheet.getByRole('button', { name: /Skyr nature 0%/ }).click()
  await expect(sheet.getByText(/code-barres 3329770077003/)).toBeVisible()
  await sheet.getByRole('button', { name: 'Ajouter aux favoris' }).click()
  await sheet.getByRole('button', { name: /Associer à/ }).click()
  // L'aliment est retrouvé sans nouvelle recherche.
  await page.getByRole('dialog').getByRole('button', { name: /^farine/ }).click()
  const flour = page.getByRole('dialog', { name: 'farine' })
  await flour.getByRole('radio', { name: 'Mes aliments' }).click()
  await expect(flour.getByText('Skyr nature 0%')).toHaveCount(2) // favoris + récents
})

test('hors ligne : calcul et recherche CIQUAL sans réseau', async ({ page, context }) => {
  await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)
  await page.reload()
  await context.setOffline(true)
  await page.reload()
  await openRecipe(page, 'Cottage pie')
  await page.getByRole('button', { name: 'Associer les ingrédients' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^carottes/ }).click()
  const sheet = page.getByRole('dialog', { name: 'carottes' })
  await sheet.getByLabel('Rechercher dans CIQUAL').fill('carotte crue')
  await expect(sheet.getByRole('button', { name: /^Carotte, crue/ }).first()).toBeVisible()
  await sheet.getByRole('radio', { name: 'Marques' }).click()
  await expect(sheet.getByText(/Hors ligne : la recherche de produits de marque/)).toBeVisible()
  await context.setOffline(false)
})
