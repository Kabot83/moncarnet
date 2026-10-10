/**
 * « À essayer » : liens TikTok / Instagram, partage, enrichissement (réponses oEmbed réelles
 * enregistrées dans tests/fixtures), doublons, conversion en recette, sauvegarde.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/photos', async (orig) => ({
  ...(await orig<typeof import('@/services/photos')>()),
  addPhotoFromFile: vi.fn(async () => 'ph_thumb'),
}))

import { db } from '@/db/db'
import { applyRestore, exportBackup, readBackup } from '@/services/backup'
import { saveRecipe } from '@/services/recipes'
import { extractFromCaption, recipeFromPostLocally } from '@/social/extract'
import { embedUrl, parseSharedContent, parseSocialUrl, sourceAppLabel, titleFromText } from '@/social/links'
import { enrichPost, filterPosts, savePostFromLink, updatePost } from '@/social/posts'
import { processShare, routeForShare } from '@/social/share'

const fixture = (f: string) => JSON.parse(readFileSync(`tests/fixtures/${f}`, 'utf-8'))
const TIKTOK = fixture('tiktok-oembed-6718335390845095173.json')
const IG = fixture('instagram-oembed-CUbHfhpswxt.json')
const IG_404 = fixture('instagram-oembed-notfound.json')

describe('reconnaissance des liens', () => {
  it.each([
    ['https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1&sender_device=pc&web_id=123', 'tiktok', 'video', '6718335390845095173', 'https://www.tiktok.com/@scout2015/video/6718335390845095173'],
    ['https://tiktok.com/@chef.julie/video/7301234567890123456', 'tiktok', 'video', '7301234567890123456', 'https://www.tiktok.com/@chef.julie/video/7301234567890123456'],
    ['https://m.tiktok.com/v/7301234567890123456.html?_r=1', 'tiktok', 'video', '7301234567890123456', 'https://www.tiktok.com/video/7301234567890123456'],
    ['https://www.tiktok.com/@chef/photo/7301234567890123456', 'tiktok', 'photo', '7301234567890123456', 'https://www.tiktok.com/@chef/photo/7301234567890123456'],
    ['https://www.instagram.com/reel/C2aZ6aZv2k5/?igsh=MWQ1ZGUxMzBkMA==', 'instagram', 'reel', 'C2aZ6aZv2k5', 'https://www.instagram.com/reel/C2aZ6aZv2k5/'],
    ['https://instagram.com/reels/C2aZ6aZv2k5', 'instagram', 'reel', 'C2aZ6aZv2k5', 'https://www.instagram.com/reel/C2aZ6aZv2k5/'],
    ['https://www.instagram.com/p/CUbHfhpswxt/?utm_source=ig_web_copy_link', 'instagram', 'post', 'CUbHfhpswxt', 'https://www.instagram.com/p/CUbHfhpswxt/'],
    ['https://www.instagram.com/cuisine.maison/reel/C2aZ6aZv2k5/', 'instagram', 'reel', 'C2aZ6aZv2k5', 'https://www.instagram.com/reel/C2aZ6aZv2k5/'],
    ['instagr.am/p/CUbHfhpswxt', 'instagram', 'post', 'CUbHfhpswxt', 'https://www.instagram.com/p/CUbHfhpswxt/'],
  ])('%s', (raw, platform, kind, id, url) => {
    expect(parseSocialUrl(raw)).toMatchObject({ platform, kind, postId: id, url, short: false })
  })

  it('liens courts : reconnus, identifiant inconnu jusqu’à résolution', () => {
    expect(parseSocialUrl('https://vm.tiktok.com/ZMhvqjAbC/')).toMatchObject({ platform: 'tiktok', short: true, url: 'https://vm.tiktok.com/ZMhvqjAbC/', dedupeKey: 'tiktok-short:vm.tiktok.com/ZMhvqjAbC' })
    expect(parseSocialUrl('vt.tiktok.com/ZSabc123')).toMatchObject({ short: true })
    expect(parseSocialUrl('https://www.tiktok.com/t/ZTRabc12/')).toMatchObject({ short: true })
    expect(parseSocialUrl('https://www.instagram.com/share/reel/BAJxyz12345/')).toMatchObject({ platform: 'instagram', kind: 'reel', short: true })
  })

  it('même publication, liens différents : même clé (pas de doublon)', () => {
    const a = parseSocialUrl('https://www.instagram.com/reel/C2aZ6aZv2k5/?igsh=abc')!
    const b = parseSocialUrl('https://instagram.com/p/C2aZ6aZv2k5')!
    expect(a.dedupeKey).toBe(b.dedupeKey)
    expect(parseSocialUrl('https://www.tiktok.com/@a/video/6718335390845095173?x=1')!.dedupeKey).toBe(parseSocialUrl('https://m.tiktok.com/v/6718335390845095173.html')!.dedupeKey)
  })

  it('liens invalides ou qui ne sont pas des publications', () => {
    for (const bad of ['', 'pas un lien', 'https://www.tiktok.com/@scout2015', 'https://www.instagram.com/cuisine.maison/', 'https://www.tiktok.com/', 'https://example.com/video/123456789', 'ftp://tiktok.com/@a/video/123456789012', 'https://evil-tiktok.com/@a/video/123456789012'])
      expect(parseSocialUrl(bad)).toBeNull()
  })

  it('partage avec texte, titre et plusieurs liens', () => {
    const c = parseSharedContent('Pâtes crémeuses 🍝 #recette #pasta\nhttps://vm.tiktok.com/ZMh1/ et aussi https://www.instagram.com/p/CUbHfhpswxt/?igsh=x.', 'Regarde cette vidéo')
    expect(c.urls).toEqual(['https://vm.tiktok.com/ZMh1/', 'https://www.instagram.com/p/CUbHfhpswxt/?igsh=x'])
    expect(c.text).toBe('Pâtes crémeuses 🍝 #recette #pasta\net aussi')
    expect(c.subject).toBe('Regarde cette vidéo')
    expect(titleFromText(c.text)).toBe('Pâtes crémeuses 🍝')
    expect(titleFromText('Regarde cette vidéo TikTok de @chef !')).toBe('')
    expect(titleFromText('Lasagnes du dimanche | TikTok')).toBe('Lasagnes du dimanche')
  })

  it('application d’origine et lecteurs officiels', () => {
    expect(sourceAppLabel('android-app://com.zhiliaoapp.musically')).toBe('TikTok')
    expect(sourceAppLabel('android-app://com.instagram.android')).toBe('Instagram')
    expect(sourceAppLabel('android-app://com.android.chrome')).toBe('Chrome')
    expect(sourceAppLabel('')).toBeNull()
    expect(embedUrl({ platform: 'tiktok', postId: '6718335390845095173', kind: 'video' })).toMatch(/^https:\/\/www\.tiktok\.com\/player\/v1\/6718335390845095173/)
    expect(embedUrl({ platform: 'instagram', postId: 'C2aZ6aZv2k5', kind: 'reel' })).toBe('https://www.instagram.com/reel/C2aZ6aZv2k5/embed/captioned/')
    expect(embedUrl({ platform: 'tiktok', postId: null, kind: 'unknown' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------

type Route = (url: string) => { status: number; body?: unknown; image?: boolean } | undefined
function mockFetch(route: Route) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const r = route(url)
      if (!r) throw new TypeError('Failed to fetch')
      if (r.image) return new Response(new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' }), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}
const online = (v: boolean) => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => v })

describe('enregistrement et enrichissement', () => {
  beforeEach(async () => {
    await db.posts.clear()
    await db.recipes.clear()
    online(true)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('TikTok : enregistrement immédiat puis informations de l’oEmbed officiel', async () => {
    mockFetch((u) => (u.startsWith('https://www.tiktok.com/oembed') ? { status: 200, body: TIKTOK } : u.includes('tiktokcdn') ? { status: 200, image: true } : undefined))
    const o = await processShare({ text: 'https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1&sender_device=pc', referrer: 'android-app://com.zhiliaoapp.musically' })
    expect(o).toMatchObject({ kind: 'post', existing: false, from: 'TikTok' })
    expect(routeForShare(o)).toMatch(/^\/a-essayer\/p_.+\?partage=nouveau&depuis=TikTok$/)
    const id = (o as { postId: string }).postId
    const saved = (await db.posts.get(id))!
    expect(saved).toMatchObject({ platform: 'tiktok', postId: '6718335390845095173', metaStatus: 'pending', title: 'Vidéo TikTok de @scout2015' })
    expect(saved.originalUrl).toContain('is_from_webapp')
    const r = await enrichPost(id)
    expect(r).toEqual({ id, status: 'ok', merged: false })
    const p = (await db.posts.get(id))!
    expect(p).toMatchObject({
      metaStatus: 'ok',
      author: 'Scout, Suki & Stella',
      authorHandle: 'scout2015',
      description: TIKTOK.title,
      title: 'Scramble up ur name & I’ll try to guess it😍❤️',
      thumbnailPhotoId: 'ph_thumb',
      url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    })
  })

  it('les corrections manuelles ne sont jamais écrasées', async () => {
    mockFetch((u) => (u.startsWith('https://www.tiktok.com/oembed') ? { status: 200, body: TIKTOK } : { status: 404 }))
    const link = parseSocialUrl('https://www.tiktok.com/@scout2015/video/6718335390845095173')!
    const { post } = await savePostFromLink(link, { originalUrl: link.url })
    await updatePost(post.id, { title: 'Mes pâtes', author: 'Julie' })
    await enrichPost(post.id)
    expect(await db.posts.get(post.id)).toMatchObject({ title: 'Mes pâtes', author: 'Julie', description: TIKTOK.title, edited: ['title', 'author'] })
  })

  it('déjà enregistrée : aucun doublon, le texte nouveau est conservé', async () => {
    const a = await processShare({ text: 'https://www.instagram.com/reel/C2aZ6aZv2k5/?igsh=1' })
    const b = await processShare({ text: 'Super recette https://instagram.com/reels/C2aZ6aZv2k5' })
    expect(b).toMatchObject({ kind: 'post', existing: true, postId: (a as { postId: string }).postId })
    expect(await db.posts.count()).toBe(1)
    expect((await db.posts.toArray())[0].sharedText).toBe('Super recette')
  })

  it('hors connexion : le lien est enregistré, les informations attendent le réseau', async () => {
    online(false)
    mockFetch(() => undefined)
    const o = await processShare({ text: 'https://vm.tiktok.com/ZMhvqjAbC/' })
    const id = (o as { postId: string }).postId
    expect(await enrichPost(id)).toMatchObject({ status: 'pending' })
    expect(await db.posts.get(id)).toMatchObject({ url: 'https://vm.tiktok.com/ZMhvqjAbC/', metaStatus: 'pending', title: 'Vidéo TikTok' })
  })

  it('publication privée ou supprimée : signalée, le lien reste', async () => {
    mockFetch((u) => (u.includes('tiktok.com/oembed') ? { status: 400, body: { message: 'Something went wrong', code: 400 } } : u.includes('instagram_oembed') ? { status: 400, body: IG_404 } : undefined))
    const t = await processShare({ text: 'https://www.tiktok.com/@nobody/video/7000000000000000001' })
    const i = await processShare({ text: 'https://www.instagram.com/reel/C2aZ6aZv2k5/' })
    for (const o of [t, i]) {
      const id = (o as { postId: string }).postId
      expect(await enrichPost(id)).toMatchObject({ status: 'unavailable' })
      expect((await db.posts.get(id))!.metaMessage).toMatch(/privée, supprimée/)
    }
  })

  it('serveur injoignable : nouvel essai plus tard', async () => {
    mockFetch(() => undefined)
    const o = await processShare({ text: 'https://www.tiktok.com/@a/video/7301234567890123456' })
    expect(await enrichPost((o as { postId: string }).postId)).toMatchObject({ status: 'failed' })
  })

  it('Instagram : seulement ce que l’oEmbed officiel fournit (aucun titre ni miniature inventés)', async () => {
    mockFetch((u) => (u.includes('instagram_oembed') ? { status: 200, body: IG } : undefined))
    const o = await processShare({ text: 'https://www.instagram.com/p/CUbHfhpswxt/?igsh=abc' })
    const id = (o as { postId: string }).postId
    expect(await enrichPost(id)).toMatchObject({ status: 'limited' })
    expect(await db.posts.get(id)).toMatchObject({ title: 'Publication Instagram', description: '', thumbnailPhotoId: null, metaStatus: 'limited' })
  })

  it('lien court résolu vers une publication déjà enregistrée : fusion, jamais de doublon', async () => {
    const full = await processShare({ text: 'https://www.tiktok.com/@scout2015/video/6718335390845095173' })
    const fullId = (full as { postId: string }).postId
    await updatePost(fullId, { notes: 'À faire dimanche' })
    // L'oEmbed accepte le lien court et renvoie l'identifiant de la vidéo.
    mockFetch((u) => (u.includes('tiktok.com/oembed') ? { status: 200, body: TIKTOK } : undefined))
    const short = await processShare({ text: 'https://vm.tiktok.com/ZMhvqjAbC/' })
    const shortId = (short as { postId: string }).postId
    await updatePost(shortId, { tags: ['pâtes'] })
    const r = await enrichPost(shortId)
    expect(r).toEqual({ id: fullId, status: 'ok', merged: true })
    expect(await db.posts.count()).toBe(1)
    expect(await db.posts.get(fullId)).toMatchObject({ notes: 'À faire dimanche', tags: ['pâtes'], metaStatus: 'ok' })
  })

  it('lien d’un autre site → import de recette ; texte seul → import par texte ; profil → message clair', async () => {
    expect(await processShare({ text: 'https://www.marmiton.org/recettes/recette_crepes_12345.aspx', subject: 'Crêpes' })).toEqual({ kind: 'recipeUrl', url: 'https://www.marmiton.org/recettes/recette_crepes_12345.aspx' })
    expect(await processShare({ text: '200 g de farine, 3 œufs' })).toMatchObject({ kind: 'text' })
    expect(await processShare({ text: 'https://www.tiktok.com/@scout2015' })).toMatchObject({ kind: 'invalid' })
    expect(await processShare({ text: '' })).toMatchObject({ kind: 'invalid' })
    expect(await db.posts.count()).toBe(0)
  })

  it('plusieurs liens dans un même partage', async () => {
    const o = await processShare({ text: 'https://www.tiktok.com/@a/video/7301234567890123456\nhttps://www.instagram.com/p/CUbHfhpswxt/' })
    expect(o).toEqual({ kind: 'posts', count: 2, existing: 0 })
  })

  it('recherche et filtres', async () => {
    await processShare({ text: 'Tarte aux pommes https://www.tiktok.com/@a/video/7301234567890123456' })
    await processShare({ text: 'Risotto https://www.instagram.com/p/CUbHfhpswxt/' })
    const all = await db.posts.toArray()
    expect(filterPosts(all, { query: 'tarte', platform: 'all', status: 'all', favorite: false }).map((p) => p.platform)).toEqual(['tiktok'])
    expect(filterPosts(all, { query: '', platform: 'instagram', status: 'all', favorite: false })).toHaveLength(1)
    expect(filterPosts(all, { query: '', platform: 'all', status: 'tested', favorite: false })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------

describe('transformer en recette', () => {
  const caption = `Cookies moelleux 🍪 #cookies #recette
Ingrédients :
- 200 g de farine
- 100 g de beurre mou
- 1 œuf
- pépites de chocolat
Préparation :
1. Mélanger le beurre et le sucre jusqu’à obtenir une crème.
2. Ajouter l’œuf puis la farine, former des boules.
3. Cuire 10 minutes à 180 °C.`

  it('extraction locale : seulement ce qui est écrit, manques signalés', () => {
    const ex = extractFromCaption(caption)
    expect(ex.ingredients.map((i) => [i.quantity, i.unit, i.name])).toEqual([
      [200, 'g', 'farine'],
      [100, 'g', 'beurre mou'],
      [1, '', 'œuf'],
      [null, '', 'pépites de chocolat'],
    ])
    expect(ex.steps).toHaveLength(3)
    expect(ex.warnings).toEqual(['1 ingrédient sans quantité dans le texte : à compléter.'])
    const none = extractFromCaption('Trop bon ce plat 😍 #food')
    expect(none.ingredients).toEqual([])
    expect(none.warnings[0]).toMatch(/Aucun ingrédient/)
  })

  it('la fiche garde la source ; l’enregistrer marque la publication « recette créée »', async () => {
    await db.posts.clear()
    const o = await processShare({ text: 'https://www.tiktok.com/@chef/video/7301234567890123456' })
    const id = (o as { postId: string }).postId
    await updatePost(id, { description: caption, tags: ['goûter'] })
    const post = (await db.posts.get(id))!
    const { recipe } = recipeFromPostLocally(post)
    expect(recipe).toMatchObject({ sourcePostId: id, sourceUrl: 'https://www.tiktok.com/@chef/video/7301234567890123456', source: 'TikTok · @chef', tags: ['goûter'], toTry: true })
    expect(recipe.ingredients[0].nutrition).toBeNull() // calcul nutritionnel automatique ensuite
    await saveRecipe(recipe)
    expect(await db.posts.get(id)).toMatchObject({ status: 'converted', recipeId: recipe.id })
  })
})

// ---------------------------------------------------------------------------

describe('sauvegarde ZIP', () => {
  it('les publications font l’aller-retour, sans doublon à la fusion', async () => {
    await db.posts.clear()
    await processShare({ text: 'https://www.tiktok.com/@a/video/7301234567890123456' })
    const before = await db.posts.toArray()
    await updatePost(before[0].id, { notes: 'Note importante', favorite: true })
    const zip = await exportBackup()
    const parsed = await readBackup(zip)
    expect(parsed.posts).toHaveLength(1)
    expect(parsed.posts[0]).toMatchObject({ notes: 'Note importante', favorite: true })
    await applyRestore(parsed, 'merge')
    expect(await db.posts.count()).toBe(1)
    await db.posts.clear()
    await applyRestore(parsed, 'replace')
    expect(await db.posts.get(before[0].id)).toMatchObject({ notes: 'Note importante' })
  })
})
