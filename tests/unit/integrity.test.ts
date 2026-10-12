/**
 * Persistance sur Android : repère croisé IndexedDB / fichiers natifs, copie de sécurité,
 * vidéos. Le système de fichiers natif (@capacitor/filesystem) est simulé en mémoire avec la
 * même API ; la base est une vraie base Dexie (fake-indexeddb).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const files = new Map<string, Buffer>()
const key = (p: string) => p.replace(/^\/+/, '')
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Data: 'DATA' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: {
    readFile: async ({ path, encoding }: { path: string; encoding?: string }) => {
      const b = files.get(key(path))
      if (!b) throw new Error('File does not exist')
      return { data: encoding ? b.toString('utf8') : b.toString('base64') }
    },
    writeFile: async ({ path, data, encoding }: { path: string; data: string; encoding?: string }) => {
      files.set(key(path), encoding ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64'))
      return { uri: `file:///data/${path}` }
    },
    appendFile: async ({ path, data }: { path: string; data: string }) => {
      files.set(key(path), Buffer.concat([files.get(key(path)) ?? Buffer.alloc(0), Buffer.from(data, 'base64')]))
    },
    deleteFile: async ({ path }: { path: string }) => {
      if (!files.delete(key(path))) throw new Error('File does not exist')
    },
    rename: async ({ from, to }: { from: string; to: string }) => {
      files.set(key(to), files.get(key(from))!)
      files.delete(key(from))
    },
    copy: async ({ from, to }: { from: string; to: string }) => {
      files.set(key(to), Buffer.from(files.get(key(from))!))
    },
    stat: async ({ path }: { path: string }) => {
      const b = files.get(key(path))
      if (!b) throw new Error('File does not exist')
      return { size: b.length }
    },
  },
}))
vi.mock('@/platform/native', async (orig) => ({ ...(await orig<typeof import('@/platform/native')>()), isNative: true }))

import { db } from '@/db/db'
import { emptyIngredient, emptyRecipe, saveRecipe } from '@/services/recipes'
import { getSettings } from '@/services/settings'
import { acknowledgeLoss, checkIntegrity, checkVideos, refreshSnapshot, restoreSnapshot } from '@/services/integrity'
import { savePostFromLink, updatePost } from '@/social/posts'
import { parseSocialUrl } from '@/social/links'

/** Ce que ferait Android en vidant la base de la WebView (fichiers de l'application intacts). */
async function wipeWebViewDatabase() {
  await Promise.all(db.tables.filter((t) => t.name !== 'secrets').map((t) => t.clear()))
}

async function sampleData() {
  const r = emptyRecipe({
    title: 'Soupe à l’oignon',
    ingredients: [emptyIngredient({ name: 'oignon', quantity: 4, unit: '', nutrition: { food: { source: 'ciqual', id: '20034', name: 'Oignon, cru', brand: '', basis: '100g', per100: { kcal: 39, kj: 163, protein: 1.2, carbs: 7.2, fat: 0.2, fiber: 1.9, sugars: 4.7, satFat: 0, salt: 0.01 }, version: 'Ciqual 2025', notes: [], fetchedAt: 1 }, gramsPerUnit: 150, density: null, overrides: {}, linkedAt: 1 } })],
    notes: { tips: 'Bien caraméliser', modifications: '', mistakes: '', ideas: '', storage: '', reheating: '' },
  })
  await saveRecipe(r)
  const link = parseSocialUrl('https://www.instagram.com/reel/DMmxU4bKcsR/')!
  const { post } = await savePostFromLink(link, { originalUrl: link.url })
  await updatePost(post.id, { notes: 'À tester dimanche' })
  return { recipeId: r.id, postId: post.id }
}

beforeEach(async () => {
  files.clear()
  await Promise.all(db.tables.map((t) => t.clear()))
})

describe('vérification de la persistance (APK)', () => {
  it('premier lancement → repère posé dans la base ET dans les fichiers natifs', async () => {
    expect(await checkIntegrity(true)).toMatchObject({ kind: 'initialized' })
    expect(files.has('securite/repere.json')).toBe(true)
    expect((await db.settings.get('integrity'))?.value).toMatchObject({ installId: expect.stringMatching(/^ins_/) })
  })

  it('redémarrage / fermeture forcée / mise à jour de l’APK (base et fichiers conservés) → aucune perte', async () => {
    await checkIntegrity(true)
    await sampleData()
    expect(await checkIntegrity(true)).toMatchObject({ kind: 'ok' })
  })

  it('base de la WebView vidée, fichiers intacts → perte détectée, copie restaurée avec nutrition, notes et publications', async () => {
    await checkIntegrity(true)
    const { recipeId, postId } = await sampleData()
    const snap = await refreshSnapshot()
    expect(snap).toMatchObject({ recipes: 1 })
    expect((await getSettings()).lastBackupAt).toBeNull() // une copie automatique n'est pas une sauvegarde

    await wipeWebViewDatabase()
    const state = await checkIntegrity(true)
    expect(state).toMatchObject({ kind: 'lost', snapshot: { recipes: 1 } })
    // Une base vide ne doit jamais écraser la bonne copie.
    expect(await refreshSnapshot(true)).toBeNull()

    expect(await restoreSnapshot()).toEqual({ recipes: 1 })
    const r = (await db.recipes.get(recipeId))!
    expect(r.notes.tips).toBe('Bien caraméliser')
    expect(r.ingredients[0].nutrition).toMatchObject({ gramsPerUnit: 150, food: { id: '20034' } })
    expect(await db.posts.get(postId)).toMatchObject({ notes: 'À tester dimanche' })
    expect(await checkIntegrity(true)).toMatchObject({ kind: 'ok' })
  })

  it('copie de sécurité : renouvelée seulement si les données changent, précédente conservée', async () => {
    await checkIntegrity(true)
    await sampleData()
    const a = await refreshSnapshot()
    const b = await refreshSnapshot()
    expect(b!.at).toBe(a!.at) // rien n'a changé
    await saveRecipe(emptyRecipe({ title: 'Tarte' }))
    const c = await refreshSnapshot()
    expect(c!.recipes).toBe(2)
    expect(files.has('securite/copie-auto-precedente.zip')).toBe(true)
    expect([...files.keys()].some((k) => k.endsWith('.tmp'))).toBe(false)
  })

  it('perte acceptée sans restaurer : nouveau départ, plus d’alerte', async () => {
    await checkIntegrity(true)
    await wipeWebViewDatabase()
    expect((await checkIntegrity(true)).kind).toBe('lost')
    await acknowledgeLoss()
    expect((await checkIntegrity(true)).kind).toBe('ok')
  })

  it('fichiers natifs perdus mais base intacte → base conservée, repère recréé', async () => {
    await checkIntegrity(true)
    files.clear()
    expect(await checkIntegrity(true)).toMatchObject({ kind: 'ok' })
    expect(files.has('securite/repere.json')).toBe(true)
  })
})

describe('vidéos enregistrées', () => {
  it('présence réelle de chaque fichier vérifiée', async () => {
    const { postId } = await sampleData()
    const other = (await savePostFromLink(parseSocialUrl('https://www.tiktok.com/@a/video/7301234567890123456')!, { originalUrl: 'x' })).post
    const video = (name: string) => ({ name, uri: `file:///${name}`, bytes: 5, duration: 1, width: 1, height: 1, sha256: '', source: 'nas' as const, savedAt: 1 })
    await db.posts.update(postId, { video: video('a.mp4') })
    await db.posts.update(other.id, { video: video('b.mp4'), title: 'Vidéo disparue' })
    files.set('carnet-videos/a.mp4', Buffer.alloc(2048))
    expect(await checkVideos()).toEqual({ referenced: 2, present: 1, bytes: 2048, missing: [{ postId: other.id, title: 'Vidéo disparue' }] })
  })
})
