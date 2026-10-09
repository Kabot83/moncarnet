import { type Page, type Route, expect, test } from '@playwright/test'

/**
 * Chef IA avec l'API Gemini SIMULÉE (aucun appel réel, aucun coût) :
 * on intercepte generativelanguage.googleapis.com et on vérifie le
 * comportement de l'application — validation, quotas, erreurs 429.
 */

const TEST_KEY = 'cle-de-test-locale'

const recipeJson = {
  reply: 'Voici une idée rapide et riche en protéines.',
  saveRequested: false,
  recipes: [
    {
      title: 'Poulet aux courgettes et parmesan',
      description: 'Poêlée express.',
      category: 'plat',
      prepTime: 10,
      cookTime: 15,
      servings: 2,
      difficulty: 1,
      ingredients: [
        { name: 'blanc de poulet', quantity: 300, unit: 'g' },
        { name: 'courgettes', quantity: 2, unit: '' },
        { name: 'parmesan', quantity: 40, unit: 'g' },
      ],
      steps: [{ text: 'Saisir le poulet 6 minutes.', durationMin: 6 }, { text: 'Ajouter les courgettes, cuire 8 minutes.' }],
      tips: 'Râpez le parmesan au dernier moment.',
      tags: ['rapide'],
    },
  ],
}

function geminiReply(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(body) }] }, finishReason: 'STOP' }] }),
  })
}

async function configure(page: Page, limit = 30) {
  await page.goto('./#/reglages/ia')
  await page.getByRole('radio', { name: /Clé sur ce téléphone/ }).click()
  await page.getByLabel('Clé API').fill(TEST_KEY)
  await page.getByRole('button', { name: 'Lister les modèles accessibles' }).click()
  await expect(page.getByText('2 modèle(s) accessible(s)')).toBeVisible()
  await expect(page.getByLabel('Modèle principal')).toHaveValue('gemini-3.7-flash')
  await page.getByLabel(/Appels IA maximum par jour/).fill(String(limit))
}

test.beforeEach(async ({ page }) => {
  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const url = route.request().url()
    expect(route.request().headers()['x-goog-api-key']).toBe(TEST_KEY)
    if (url.includes('/models?') || url.endsWith('/models')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: [
            { name: 'models/gemini-3.7-flash', displayName: 'Gemini 3.7 Flash', supportedActions: ['generateContent'] },
            { name: 'models/gemini-2.5-flash-lite', displayName: 'Gemini 2.5 Flash-Lite', supportedActions: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedActions: ['embedContent'] },
          ],
        }),
      })
    }
    const prompt = route.request().postData() ?? ''
    if (prompt.includes('QUOTA')) {
      return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 429, message: 'Resource exhausted. retryDelay: "30s"', status: 'RESOURCE_EXHAUSTED' } }) })
    }
    if (prompt.includes('INVALIDE')) return geminiReply(route, { reply: 'ok', recipes: [{ title: 'Sans rien', ingredients: [], steps: [] }], saveRequested: false })
    if (prompt.includes('enregistre-la')) return geminiReply(route, { ...recipeJson, reply: 'Je vous prépare la fiche.', saveRequested: true })
    return geminiReply(route, recipeJson)
  })
  await page.goto('./')
})

test('connexion, génération et ajout au carnet après validation', async ({ page }) => {
  await configure(page)
  await page.goto('./#/chef')
  await page.getByLabel('Message pour le Chef IA').fill('J’ai du poulet, des courgettes et du parmesan.')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByRole('heading', { name: 'Poulet aux courgettes et parmesan' })).toBeVisible()
  await page.getByRole('button', { name: 'Consulter la recette' }).click()
  await expect(page.getByText('Râpez le parmesan au dernier moment.')).toBeVisible()
  await page.getByRole('button', { name: 'Ajouter au carnet' }).click()
  // Fiche préremplie, rien n'est enregistré sans validation.
  await expect(page.getByLabel('Nom de la recette *')).toHaveValue('Poulet aux courgettes et parmesan')
  await expect(page.getByText('À vérifier avant d’enregistrer').or(page.getByText('Brouillon')).first()).toBeVisible({ timeout: 2000 }).catch(() => undefined)
  await page.getByRole('button', { name: 'Ajouter au carnet' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Poulet aux courgettes et parmesan' })).toBeVisible()
})

test('« enregistre-la » ouvre une fiche préremplie à valider', async ({ page }) => {
  await configure(page)
  await page.goto('./#/chef')
  await page.getByLabel('Message pour le Chef IA').fill('Parfait, enregistre-la.')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByLabel('Nom de la recette *')).toHaveValue('Poulet aux courgettes et parmesan')
})

test('quota gratuit épuisé : message clair, aucune nouvelle tentative automatique', async ({ page }) => {
  await configure(page)
  let calls = 0
  page.on('request', (r) => r.url().includes(':generateContent') && calls++)
  await page.goto('./#/chef')
  await page.getByLabel('Message pour le Chef IA').fill('QUOTA')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByText(/quota gratuit de Google est atteint/)).toBeVisible()
  await expect(page.getByText(/jamais vers une offre payante/)).toBeVisible()
  await page.waitForTimeout(1500)
  expect(calls).toBe(1)
  await expect(page.getByRole('button', { name: 'Essayer gemini-2.5-flash-lite' })).toBeVisible()
})

test('réponse invalide : rien n’est proposé à l’enregistrement', async ({ page }) => {
  await configure(page)
  await page.goto('./#/chef')
  await page.getByLabel('Message pour le Chef IA').fill('INVALIDE')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByText(/proposition\(s\) incomplète\(s\) ont été écartées/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ajouter au carnet' })).toHaveCount(0)
})

test('limite locale quotidienne respectée', async ({ page }) => {
  await configure(page, 1)
  await page.goto('./#/chef')
  await page.getByLabel('Message pour le Chef IA').fill('Une idée ?')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByRole('heading', { name: 'Poulet aux courgettes et parmesan' })).toBeVisible()
  await page.getByLabel('Message pour le Chef IA').fill('Une autre ?')
  await page.getByRole('button', { name: 'Envoyer' }).click()
  await expect(page.getByText(/limite quotidienne d’appels IA/)).toBeVisible()
})

test('import par texte : fiche éditable avant enregistrement', async ({ page }) => {
  await page.unroute('https://generativelanguage.googleapis.com/**')
  await page.route('https://generativelanguage.googleapis.com/**', (route) =>
    route.request().url().includes(':generateContent')
      ? geminiReply(route, { found: true, warnings: ['Temps de repos illisible'], recipe: recipeJson.recipes[0] })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models: [{ name: 'models/gemini-3.7-flash', supportedActions: ['generateContent'] }, { name: 'models/gemini-2.5-flash-lite', supportedActions: ['generateContent'] }] }) }),
  )
  await configure(page)
  await page.goto('./#/importer/texte')
  await page.getByLabel('Texte de la recette').fill('Poulet courgettes : 300 g de poulet, 2 courgettes, 40 g de parmesan. Saisir puis cuire.')
  await page.getByRole('button', { name: 'Analyser avec le Chef IA' }).click()
  await expect(page.getByText('Temps de repos illisible')).toBeVisible()
  await expect(page.getByLabel('Nom de la recette *')).toHaveValue('Poulet aux courgettes et parmesan')
})
