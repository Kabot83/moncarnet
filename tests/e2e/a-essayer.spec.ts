/**
 * « À essayer » dans la PWA : import d'un lien, cible de partage, doublons, hors ligne,
 * transformation en recette. Les réponses de TikTok / Instagram sont simulées à partir de
 * réponses réelles enregistrées (tests/fixtures) : aucun appel réseau pendant les tests.
 */
import { readFileSync } from 'node:fs'
import { type Page, expect, test } from '@playwright/test'

const TIKTOK = JSON.parse(readFileSync('tests/fixtures/tiktok-oembed-6718335390845095173.json', 'utf-8'))
const IG_404 = JSON.parse(readFileSync('tests/fixtures/instagram-oembed-notfound.json', 'utf-8'))
const THUMB = readFileSync('public/icons/icon-192.png')
const CAPTION = `Cookies moelleux 🍪 #cookies
Ingrédients :
- 200 g de farine
- 100 g de beurre
- 1 œuf
Préparation :
1. Mélanger le beurre mou et la farine.
2. Ajouter l’œuf, former des boules et cuire 10 minutes.`

async function mockPlatforms(page: Page, caption = TIKTOK.title as string) {
  await page.route('https://www.tiktok.com/oembed**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ...TIKTOK, title: caption }) }),
  )
  await page.route('https://p16-common-sign.tiktokcdn-eu.com/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: THUMB }))
  await page.route('https://graph.facebook.com/**', (r) =>
    r.fulfill({ status: 400, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(IG_404) }),
  )
}

async function importLink(page: Page, url: string) {
  await page.goto('./#/a-essayer')
  await page.getByRole('button', { name: 'Importer un lien' }).first().click()
  await page.getByLabel('Lien de la publication').fill(url)
  await page.getByRole('button', { name: 'Enregistrer dans À essayer' }).click()
}

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(page.getByText('qu’est-ce qu’on cuisine')).toBeVisible()
})

test('importer un lien TikTok : fiche préremplie, informations publiques, aucun doublon', async ({ page }) => {
  await mockPlatforms(page)
  await importLink(page, 'https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1&sender_device=pc')
  await expect(page.getByText('Enregistrée dans « À essayer »')).toBeVisible()
  // Informations de l'oEmbed officiel, récupérées après l'enregistrement.
  await expect(page.getByLabel('Titre')).toHaveValue('Scramble up ur name & I’ll try to guess it😍❤️')
  await expect(page.getByText('Scout, Suki & Stella ·')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Voir sur TikTok' })).toBeVisible()
  await expect(page.getByText(/Lecteur officiel TikTok · nécessite Internet/)).toBeVisible()
  // Lien nettoyé (canonique) et lien reçu (avec paramètres de suivi), tous deux conservés.
  await expect(page.getByText(/Lien : https:\/\/www\.tiktok\.com\/@scout2015\/video\/6718335390845095173\s*Lien reçu : .*is_from_webapp=1/)).toBeVisible()

  // Titre corrigé à la main, notes et tag : conservés.
  await page.getByLabel('Titre').fill('Mes cookies du dimanche')
  await page.getByLabel('Mes notes').click()
  await page.getByLabel('Mes notes').fill('Doubler la recette')
  await page.getByLabel('Tags').fill('goûter')
  await page.getByLabel('Tags').press('Enter')
  await page.getByLabel('Mes notes').blur()

  // Même vidéo, autre lien : pas de doublon.
  await importLink(page, 'https://m.tiktok.com/v/6718335390845095173.html')
  await expect(page.getByText('Déjà dans « À essayer »')).toBeVisible()
  await expect(page.getByLabel('Titre')).toHaveValue('Mes cookies du dimanche')
  await expect(page.getByLabel('Mes notes')).toHaveValue('Doubler la recette')

  await page.goto('./#/a-essayer')
  await expect(page.getByRole('button', { name: /Mes cookies du dimanche/ })).toHaveCount(1)
  await page.getByLabel('Rechercher dans À essayer').fill('goûter')
  await expect(page.getByRole('button', { name: /Mes cookies du dimanche/ })).toBeVisible()
  await page.getByRole('button', { name: 'Instagram', exact: true }).click()
  await expect(page.getByText('Aucune publication ne correspond.')).toBeVisible()
})

test('partage vers la PWA (cible de partage) : Instagram privé ou supprimé, le lien reste', async ({ page }) => {
  await mockPlatforms(page)
  await page.goto('./?text=Gnocchi%20au%20beurre%20de%20sauge&url=https%3A%2F%2Fwww.instagram.com%2Freel%2FC2aZ6aZv2k5%2F%3Figsh%3DMWQ1ZGUx')
  await expect(page.getByText('Enregistrée dans « À essayer »')).toBeVisible()
  await expect(page.getByLabel('Titre')).toHaveValue('Gnocchi au beurre de sauge')
  await expect(page.getByText(/privée, supprimée ou non intégrable/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Voir sur Instagram' })).toBeVisible()
  await expect(page.getByText('Lien : https://www.instagram.com/reel/C2aZ6aZv2k5/')).toBeVisible()
})

test('lien invalide : message clair, rien n’est enregistré', async ({ page }) => {
  await page.goto('./#/a-essayer')
  await page.getByRole('button', { name: 'Importer un lien' }).first().click()
  await page.getByLabel('Lien de la publication').fill('https://www.tiktok.com/@scout2015')
  await expect(page.getByText('Ce lien ne mène pas à une publication.')).toBeVisible()
  await page.getByRole('button', { name: 'Enregistrer dans À essayer' }).click()
  await expect(page.getByRole('alert')).toContainText('ne mène pas à une publication')
})

test('hors connexion : le lien est enregistré, les informations arrivent au retour du réseau', async ({ page, context }) => {
  await mockPlatforms(page)
  // Application installée (service worker actif), comme sur le téléphone.
  await page.evaluate(async () => !!(await navigator.serviceWorker.ready).active)
  await page.reload()
  await page.goto('./#/a-essayer')
  await page.getByRole('button', { name: 'Importer un lien' }).first().click()
  await page.getByLabel('Lien de la publication').fill('https://vm.tiktok.com/ZMhvqjAbC/')
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Enregistrer dans À essayer' }).click()
  await expect(page.getByText('Enregistrée dans « À essayer »')).toBeVisible()
  await expect(page.getByLabel('Titre')).toHaveValue('Vidéo TikTok')
  await expect(page.getByText(/Hors connexion : le lien est enregistré/)).toBeVisible()
  await expect(page.getByText('Hors connexion : la lecture nécessite Internet')).toHaveCount(0) // pas de lecteur sans identifiant
  await context.setOffline(false)
  // Au retour du réseau, l'oEmbed (simulé) répond pour le lien court : la vidéo est identifiée.
  await expect(page.getByLabel('Titre')).toHaveValue('Scramble up ur name & I’ll try to guess it😍❤️', { timeout: 10_000 })
})

test('transformer en recette sans IA : ingrédients repris du texte, source conservée', async ({ page }) => {
  await mockPlatforms(page, CAPTION)
  await importLink(page, 'https://www.tiktok.com/@scout2015/video/6718335390845095173')
  await expect(page.getByLabel('Titre')).toHaveValue('Cookies moelleux 🍪')
  await page.getByRole('button', { name: 'Transformer en recette' }).click()
  const sheet = page.getByRole('dialog', { name: 'Transformer en recette' })
  await expect(sheet.getByText('Repéré dans ce texte : 3 ingrédients et 2 étapes.')).toBeVisible()
  await sheet.getByRole('button', { name: 'Créer la fiche' }).click()

  await expect(page.getByText('À vérifier avant d’enregistrer')).toBeVisible()
  await expect(page.getByText(/La vidéo elle-même \(son, images\) n’a pas été analysée/)).toBeVisible()
  await expect(page.getByLabel('Nom de l’ingrédient').first()).toHaveValue('farine')
  await expect(page.getByLabel('Quantité de l’ingrédient 1')).toHaveValue('200')
  await page.getByRole('button', { name: 'Ajouter au carnet' }).click()

  await expect(page.getByRole('heading', { level: 1, name: 'Cookies moelleux 🍪' })).toBeVisible()
  await page.getByRole('link', { name: /Voir la publication d’origine/ }).click()
  await expect(page.getByText('Fiche recette créée')).toBeVisible()
  await expect(page.getByRole('radio', { name: 'Recette' })).toHaveAttribute('aria-checked', 'true')
})

test('navigation : « À essayer » est un onglet de « Mes recettes »', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Navigation principale' })
  await page.goto('./#/recettes')
  await page.getByRole('navigation', { name: 'Bibliothèque' }).getByRole('link', { name: 'À essayer' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'À essayer' })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Mes recettes' })).toHaveClass(/text-terra/)
  await expect(nav.getByRole('link', { name: 'Accueil' })).toHaveClass(/text-muted/)
})
