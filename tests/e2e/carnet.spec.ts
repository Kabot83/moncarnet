import { type Page, expect, test } from '@playwright/test'

/** Ouvre une recette de démonstration depuis le catalogue. */
async function openRecipe(page: Page, title: string) {
  await page.goto('./#/recettes')
  await page.getByLabel('Rechercher').fill(title)
  await page.getByRole('heading', { name: title }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

const qty = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^Quantité de ${name} :`) })

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(page.getByText('qu’est-ce qu’on cuisine')).toBeVisible()
})

test('accueil et navigation principale', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'Mes favorites' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'À redécouvrir' })).toBeVisible()
  const nav = page.getByRole('navigation', { name: 'Navigation principale' })
  for (const [label, heading] of [
    ['Mes recettes', 'Mes recettes'],
    ['Chef IA', 'Mon Chef IA'],
    ['Collections', 'Collections'],
    ['Réglages', 'Réglages'],
  ]) {
    await nav.getByRole('link', { name: label }).click()
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
  }
})

test('ajustement des crêpes depuis n’importe quel ingrédient, original conservé', async ({ page }) => {
  await openRecipe(page, 'Crêpes de base')
  await page.getByRole('button', { name: 'Augmenter œufs' }).click()
  await expect(page.getByText('Ajustement temporaire — recette originale conservée')).toBeVisible()
  await expect(qty(page, 'farine')).toHaveText('135 g')
  await expect(qty(page, 'lait')).toHaveText('400 ml')
  await expect(qty(page, 'beurre fondu')).toHaveText('40 g')
  await expect(page.getByText('1 pincée')).toBeVisible() // sel exclu

  // Saisie précise sur la farine : 200 g → 6 œufs (calcul depuis l'original).
  await qty(page, 'farine').click()
  await page.getByLabel('Nouvelle quantité de farine').fill('200')
  await page.getByRole('button', { name: 'OK' }).click()
  await expect(qty(page, 'œufs')).toHaveText('6')
  await expect(qty(page, 'lait')).toHaveText('600 ml')

  // L'ajustement survit à la fermeture de l'application.
  await page.reload()
  await expect(qty(page, 'œufs')).toHaveText('6')

  // Variante : nouvelle recette, original intact.
  await page.getByRole('button', { name: 'Enregistrer comme variante' }).click()
  await page.getByLabel('Nom de la variante').fill('Crêpes ×2')
  await page.getByRole('button', { name: 'Créer la variante' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Crêpes ×2' })).toBeVisible()
  await expect(qty(page, 'œufs')).toHaveText('6')
  await expect(page.getByText('Variante de')).toBeVisible()
  await page.getByRole('link', { name: 'Crêpes de base' }).click()
  await page.getByRole('button', { name: 'Réinitialiser' }).click()
  await expect(qty(page, 'œufs')).toHaveText('3')
  await expect(qty(page, 'farine')).toHaveText('100 g')
})

test('création, recherche, favori et suppression d’une recette', async ({ page }) => {
  await page.getByRole('button', { name: 'Ajouter une recette' }).click()
  await page.getByRole('button', { name: /Saisie manuelle/ }).click()
  await page.getByLabel('Nom de la recette *').fill('Velouté de potimarron')
  await page.getByLabel('Quantité de l’ingrédient 1').fill('1,2')
  await page.getByLabel('Unité').fill('kg')
  await page.getByLabel('Nom de l’ingrédient').fill('potimarron')
  await page.getByLabel('Étape 1').fill('Cuire le potimarron 25 minutes dans le bouillon.')
  await page.getByRole('button', { name: 'Ajouter au carnet' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Velouté de potimarron' })).toBeVisible()
  await expect(qty(page, 'potimarron')).toHaveText('1,2 kg')

  await page.getByRole('button', { name: 'Ajouter aux favoris' }).click()
  await page.goto('./#/recettes')
  await page.getByLabel('Rechercher').fill('potimaron') // faute de frappe : rien
  await expect(page.getByText('Aucune recette ne correspond')).toBeVisible()
  await page.getByLabel('Rechercher').fill('POTIMARRON')
  await page.getByRole('button', { name: 'Favoris', exact: true }).click()
  await page.getByRole('heading', { name: 'Velouté de potimarron' }).click()

  await page.getByRole('button', { name: 'Plus d’actions' }).click()
  await page.getByRole('button', { name: 'Supprimer' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click()
  await expect(page.getByText('Recette supprimée')).toBeVisible()
})

test('mode cuisine : étapes, cases, minuterie, progression conservée', async ({ page }) => {
  await openRecipe(page, 'Gâteau au chocolat fondant')
  await page.getByRole('button', { name: 'Cuisiner' }).click()
  await expect(page.getByRole('heading', { name: 'Mise en place' })).toBeVisible()
  await page.getByRole('checkbox', { name: 'beurre utilisé' }).click()
  await page.getByRole('button', { name: 'Étape suivante' }).click()
  await page.getByRole('button', { name: 'Étape suivante' }).click()
  await expect(page.getByText('Étape 2 sur 6')).toBeVisible()
  await page.reload()
  await expect(page.getByText('Étape 2 sur 6')).toBeVisible()
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Étape suivante' }).click()
  await page.getByRole('button', { name: /Minuterie 22 min/ }).click()
  await expect(page.getByText(/^2[12]:\d\d$/)).toBeVisible()
  await page.getByRole('button', { name: 'Ingrédients' }).click()
  await expect(page.getByRole('checkbox', { name: 'beurre utilisé' })).toHaveAttribute('aria-checked', 'true')
  // Bouton Retour Android : ferme le panneau, pas le mode cuisine.
  await page.goBack()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('Étape 5 sur 6')).toBeVisible()
})

test('journal : « J’ai cuisiné » incrémente le compteur', async ({ page }) => {
  await openRecipe(page, 'Cottage pie')
  await expect(page.getByText('Cuisinée 1 fois', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'J’ai cuisiné' }).click()
  await page.getByRole('radiogroup', { name: 'Note de la réalisation' }).getByRole('radio', { name: '5 étoiles' }).click()
  await page.getByLabel('Commentaire').fill('Excellent, gratiné parfait.')
  await page.getByRole('button', { name: 'Enregistrer dans le journal' }).click()
  await expect(page.getByText('Cuisinée 2 fois', { exact: false })).toBeVisible()
  await page.getByRole('link', { name: 'Tout l’historique' }).click()
  await expect(page.getByText('Excellent, gratiné parfait.')).toBeVisible()
})

test('liste de courses depuis plusieurs recettes', async ({ page }) => {
  await page.goto('./#/recettes')
  await page.getByRole('button', { name: 'Sélectionner pour la liste de courses' }).click()
  await page.getByRole('button', { name: /Crêpes de base/ }).click()
  await page.getByRole('button', { name: /Gâteau au chocolat fondant/ }).click()
  await page.getByRole('button', { name: 'Ajouter à la liste de courses' }).click()
  await page.getByRole('button', { name: 'Remplacer ma liste' }).or(page.getByRole('button', { name: 'Ajouter à ma liste' })).click()
  await page.goto('./#/courses')
  // Œufs des deux recettes additionnés : 3 + 4.
  await expect(page.getByRole('listitem').filter({ hasText: 'œufs' })).toContainText('7')
  await expect(page.getByRole('heading', { name: 'Crèmerie et œufs' })).toBeVisible()
  await page.getByLabel('Ajouter un article').fill('2 citrons')
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'citrons' })).toBeVisible()
  await page.getByRole('checkbox', { name: 'citrons' }).click()
  await expect(page.getByRole('checkbox', { name: 'citrons' })).toHaveAttribute('aria-checked', 'true')
})

test('collections : créer et ranger une recette', async ({ page }) => {
  await page.goto('./#/collections')
  await page.getByRole('button', { name: 'Nouvelle collection' }).click()
  await page.getByLabel('Nom').fill('Repas rapides')
  await page.getByRole('button', { name: 'Créer la collection' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Repas rapides' })).toBeVisible()
  await page.getByRole('button', { name: 'Ajouter des recettes' }).click()
  await page.getByRole('checkbox', { name: /Pancakes protéinés/ }).click()
  await page.getByRole('button', { name: 'Terminé' }).click()
  await expect(page.getByRole('heading', { name: 'Pancakes protéinés' })).toBeVisible()
})

test('sauvegarde ZIP puis restauration avec aperçu', async ({ page }) => {
  await page.goto('./#/reglages/sauvegarde')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Sauvegarder mon carnet' }).click()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/^mon-carnet-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/)
  const path = await file.path()
  await page.locator('input[type=file]').setInputFiles(path)
  await expect(page.getByText('Déjà présentes ici')).toBeVisible()
  await page.getByRole('button', { name: 'Fusionner avec mon carnet' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Fusionner' }).click()
  await expect(page.getByText(/Restauration terminée/)).toBeVisible()
})

test('fonctionne hors ligne après la première visite', async ({ page, context }) => {
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    return !!reg.active
  })
  await page.reload()
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText('qu’est-ce qu’on cuisine')).toBeVisible()
  await openRecipe(page, 'Pancakes protéinés')
  await page.getByRole('button', { name: 'Augmenter œufs' }).click()
  await expect(qty(page, 'œufs')).toHaveText('3')
  await page.goto('./#/chef')
  await context.setOffline(false)
})
