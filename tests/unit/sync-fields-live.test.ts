/**
 * Régression (serveur réel, désactivé par défaut) : chaque champ familial modifiable, modifié
 * séparément sur l'un puis l'autre de deux téléphones indépendants, doit arriver sur l'autre —
 * sans conflit et sans perte.
 *
 *   SYNC_LIVE_PY=<python avec fastapi, uvicorn, argon2-cffi> npx vitest run tests/unit/sync-fields-live.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CarnetDB, db as samsungDb } from '@/db/db'
import { type Recipe, RecipeSchema } from '@/models/types'
import { emptyIngredient, emptyRecipe, emptyStep, saveRecipe } from '@/services/recipes'
import { seedDemoData } from '@/db/seed'
import { httpSyncApi, type SyncApi } from '@/sync/api'
import { SyncEngine } from '@/sync/engine'

const PY = process.env.SYNC_LIVE_PY
const PORT = 20000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER_DIR = resolve(__dirname, '../../nas/carnet-sync')
let server: ChildProcess | null = null
let dataDir = ''
let env: NodeJS.ProcessEnv = {}

function admin(code: string) {
  const r = spawnSync(PY!, ['-c', `from app import auth, spaces; from app.config import Settings; from app.db import Database
s = Settings.from_env(); db = Database(s.data_dir / 'carnet-sync.sqlite3')
${code}`], { cwd: SERVER_DIR, env })
  expect(r.status, r.stderr?.toString()).toBe(0)
}

async function session(login: string): Promise<SyncApi> {
  const r = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: `mot-de-passe-${login}` }) })
  const t = (await r.json()) as { access_token: string }
  return httpSyncApi(BASE, { access: async () => t.access_token, refresh: async () => t.access_token })
}

/** Enregistrement comme dans l'éditeur, sur le téléphone de Jona (même validation que saveRecipe). */
async function saveOn(d: CarnetDB, r: Recipe) {
  await d.recipes.put(RecipeSchema.parse({ ...r, updatedAt: Date.now() }))
}

type Edit = { field: string; apply: (r: Recipe) => Recipe; check: (r: Recipe) => unknown; expected: unknown }

const EDITS: Edit[] = [
  { field: 'title', apply: (r) => ({ ...r, title: 'Soupe gratinée' }), check: (r) => r.title, expected: 'Soupe gratinée' },
  { field: 'description', apply: (r) => ({ ...r, description: 'Une soupe réconfortante' }), check: (r) => r.description, expected: 'Une soupe réconfortante' },
  { field: 'description (vidée)', apply: (r) => ({ ...r, description: '' }), check: (r) => r.description, expected: '' },
  { field: 'servings', apply: (r) => ({ ...r, servings: 6 }), check: (r) => r.servings, expected: 6 },
  { field: 'prepTime', apply: (r) => ({ ...r, prepTime: 20 }), check: (r) => r.prepTime, expected: 20 },
  { field: 'cookTime', apply: (r) => ({ ...r, cookTime: 45 }), check: (r) => r.cookTime, expected: 45 },
  { field: 'restTime', apply: (r) => ({ ...r, restTime: 10 }), check: (r) => r.restTime, expected: 10 },
  { field: 'difficulty', apply: (r) => ({ ...r, difficulty: 3 }), check: (r) => r.difficulty, expected: 3 },
  { field: 'category', apply: (r) => ({ ...r, category: 'entree' as Recipe['category'] }), check: (r) => r.category, expected: 'entree' },
  { field: 'tags', apply: (r) => ({ ...r, tags: ['hiver', 'rapide'] }), check: (r) => r.tags, expected: ['hiver', 'rapide'] },
  { field: 'source', apply: (r) => ({ ...r, source: 'Mamie' }), check: (r) => r.source, expected: 'Mamie' },
  { field: 'sourceUrl', apply: (r) => ({ ...r, sourceUrl: 'https://exemple.fr/soupe' }), check: (r) => r.sourceUrl, expected: 'https://exemple.fr/soupe' },
  { field: 'ingrédient (quantité)', apply: (r) => ({ ...r, ingredients: r.ingredients.map((i, k) => (k === 0 ? { ...i, quantity: 6 } : i)) }), check: (r) => r.ingredients[0].quantity, expected: 6 },
  { field: 'ingrédient (nom, unité)', apply: (r) => ({ ...r, ingredients: r.ingredients.map((i, k) => (k === 1 ? { ...i, name: 'beurre doux', unit: 'g' } : i)) }), check: (r) => [r.ingredients[1].name, r.ingredients[1].unit], expected: ['beurre doux', 'g'] },
  { field: 'ingrédient (ajout)', apply: (r) => ({ ...r, ingredients: [...r.ingredients, emptyIngredient({ id: 'i3', name: 'gruyère', quantity: 100, unit: 'g' })] }), check: (r) => r.ingredients.map((i) => i.id), expected: ['i1', 'i2', 'i3'] },
  { field: 'ingrédient (retrait)', apply: (r) => ({ ...r, ingredients: r.ingredients.filter((i) => i.id !== 'i3') }), check: (r) => r.ingredients.map((i) => i.id), expected: ['i1', 'i2'] },
  { field: 'étape (texte)', apply: (r) => ({ ...r, steps: r.steps.map((s, k) => (k === 0 ? { ...s, text: 'Émincer finement' } : s)) }), check: (r) => r.steps[0].text, expected: 'Émincer finement' },
  { field: 'étape (ajout)', apply: (r) => ({ ...r, steps: [...r.steps, emptyStep({ id: 's3', text: 'Gratiner 5 min' })] }), check: (r) => r.steps.length, expected: 3 },
  { field: 'astuces', apply: (r) => ({ ...r, notes: { ...r.notes, tips: 'Un trait de vin blanc' } }), check: (r) => r.notes.tips, expected: 'Un trait de vin blanc' },
  { field: 'nutrition', apply: (r) => ({ ...r, nutrition: { total: { kcal: 900, protein: 20, carbs: 80, fat: 50, fiber: 6 }, source: 'manual', updatedAt: Date.now() } }), check: (r) => r.nutrition?.total.kcal, expected: 900 },
  { field: 'poids après cuisson', apply: (r) => ({ ...r, cookedWeightG: 1500 }), check: (r) => r.cookedWeightG, expected: 1500 },
]

describe.skipIf(!PY)('Régression : chaque champ familial, modifié séparément, arrive sur l’autre téléphone', () => {
  let samsung: SyncEngine
  let jona: SyncEngine
  let jonaDb: CarnetDB

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'carnet-sync-fields-'))
    env = { ...process.env, SYNC_DATA_DIR: dataDir, SYNC_PORT: String(PORT), SYNC_HOST: '127.0.0.1', SYNC_SCHEDULER: '0', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    admin(`for u in ('alexandre', 'jona'): auth.create_user(db, u, u.capitalize(), 'mot-de-passe-' + u)
spaces.create_family(db, 'Le Carnet Familial', 'alexandre'); spaces.add_member(db, 'jona')`)
    server = spawn(PY!, ['-m', 'app.serve'], { cwd: SERVER_DIR, env, stdio: 'ignore' })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${BASE}/v1/health`)).ok) break
      } catch {
        /* démarrage */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    samsung = new SyncEngine(samsungDb, await session('alexandre'))
    jonaDb = new CarnetDB('telephone-jona')
    jona = new SyncEngine(jonaDb, await session('jona'))
    await samsung.bindToAccount()
    await jona.bindToAccount()
    await samsungDb.settings.put({ key: 'syncNewRecipeSpace', value: 'family' })
    await saveRecipe(
      emptyRecipe({
        id: 'r_soupe', title: 'Soupe', description: 'Simple', servings: 4, favorite: true,
        ingredients: [emptyIngredient({ id: 'i1', name: 'oignons', quantity: 4 }), emptyIngredient({ id: 'i2', name: 'beurre', quantity: 30, unit: 'g' })],
        steps: [emptyStep({ id: 's1', text: 'Émincer' }), emptyStep({ id: 's2', text: 'Cuire' })],
      }),
    )
    await samsung.sync()
    await jona.sync()
  }, 60_000)

  afterAll(() => {
    server?.kill()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* Windows */
    }
  })

  for (const e of EDITS) {
    it(`${e.field} : Samsung → Jona puis Jona → Samsung`, async () => {
      // Modification dans l'éditeur du Samsung (saveRecipe), puis synchronisations.
      await saveRecipe(e.apply((await samsungDb.recipes.get('r_soupe'))!))
      const r1 = await samsung.sync()
      await jona.sync()
      expect(e.check((await jonaDb.recipes.get('r_soupe'))!)).toEqual(e.expected)
      // Retour : Jona modifie un AUTRE champ (le titre, ou la description quand c'est le titre testé) ;
      // il arrive sur le Samsung et le champ testé y reste intact.
      const other = e.field === 'title' ? { description: `Par Jona après ${e.field}` } : { title: `Titre de Jona après ${e.field}` }
      await saveOn(jonaDb, { ...(await jonaDb.recipes.get('r_soupe'))!, ...other })
      await jona.sync()
      await samsung.sync()
      const back = (await samsungDb.recipes.get('r_soupe'))!
      expect(back).toMatchObject(other)
      expect(e.check(back)).toEqual(e.expected)
      // Aucun conflit fabriqué, partie personnelle intacte.
      expect([...r1.conflicts.map((c) => c.kind)].filter((k) => k === 'family-conflict')).toEqual([])
      expect((await samsungDb.recipes.get('r_soupe'))!.favorite).toBe(true)
    })
  }

  // --- Cas réels : historique de la recette ---------------------------------------------

  const editDescriptionOnSamsung = async (id: string, text: string) => {
    await saveRecipe({ ...(await samsungDb.recipes.get(id))!, description: text })
    await samsung.sync()
    await jona.sync()
    return (await jonaDb.recipes.get(id))!.description
  }

  it('recette créée par Jona, description modifiée sur le Samsung', async () => {
    await saveOn(jonaDb, emptyRecipe({ id: 'r_jona', title: 'Tarte de Jona', description: 'Initiale', space: 'family' }))
    await jona.sync()
    await samsung.sync()
    expect(await editDescriptionOnSamsung('r_jona', 'Modifiée sur le Samsung')).toBe('Modifiée sur le Samsung')
  })

  it('recette migrée depuis la 1.4.1 (ancien format, sans champ « description »)', async () => {
    const now = Date.now()
    // Ligne brute, jamais passée par la validation actuelle (comme certaines fiches anciennes).
    await samsungDb.recipes.put({
      id: 'r_ancienne', title: 'Ancienne recette', category: 'plat', tags: [], servings: 4, difficulty: 1, source: '', sourceUrl: '',
      mainPhotoId: null, galleryPhotoIds: [], prepTime: null, cookTime: null, restTime: null, createdAt: now, updatedAt: now,
      favorite: false, toTry: false, rating: 0, cookCount: 0, lastCookedAt: null, isDemo: false, variantOf: null, nutrition: null,
      ingredients: [{ id: 'a1', name: 'farine', quantity: 200, unit: 'g' }], steps: [{ id: 'b1', text: 'Mélanger' }],
      notes: { tips: '', modifications: 'perso' }, space: 'family',
    } as unknown as Recipe)
    await samsung.sync()
    await jona.sync()
    expect(await editDescriptionOnSamsung('r_ancienne', 'Description ajoutée')).toBe('Description ajoutée')
    expect(await editDescriptionOnSamsung('r_ancienne', 'Description corrigée')).toBe('Description corrigée')
  })

  it('description modifiée sur le Samsung pendant que Jona modifie un ingrédient hors ligne', async () => {
    const j = (await jonaDb.recipes.get('r_soupe'))!
    await saveOn(jonaDb, { ...j, ingredients: j.ingredients.map((i, k) => (k === 0 ? { ...i, quantity: 9 } : i)) }) // pas encore envoyé
    await saveRecipe({ ...(await samsungDb.recipes.get('r_soupe'))!, description: 'Pendant que Jona cuisine' })
    await samsung.sync()
    await jona.sync()
    await samsung.sync()
    for (const d of [samsungDb, jonaDb]) {
      const r = (await d.recipes.get('r_soupe'))!
      expect([r.description, r.ingredients[0].quantity]).toEqual(['Pendant que Jona cuisine', 9])
    }
  })

  it('recette déplacée de mon carnet vers la famille, puis description modifiée', async () => {
    await saveRecipe({ ...emptyRecipe({ id: 'r_perso', title: 'Perso', description: 'Avant' }), space: 'personal' })
    await samsung.sync()
    await samsung.moveRecipe('r_perso', 'family', true)
    await jona.sync()
    expect((await jonaDb.recipes.get('r_perso'))?.description).toBe('Avant')
    expect(await editDescriptionOnSamsung('r_perso', 'Après déplacement')).toBe('Après déplacement')
  })

  it('deux modifications de suite, Jona synchronisant entre les deux', async () => {
    expect(await editDescriptionOnSamsung('r_jona', 'Première')).toBe('Première')
    expect(await editDescriptionOnSamsung('r_jona', 'Seconde')).toBe('Seconde')
  })

  // --- Recettes de démonstration : la cause du symptôme observé ------------------------------

  it('recette de démonstration modifiée : jamais envoyée (par conception), puis partagée volontairement', async () => {
    await seedDemoData() // chaque téléphone a ses exemplaires (identifiants différents, mêmes noms)
    const demo = (await samsungDb.recipes.filter((r) => !!r.isDemo).first())!
    await saveRecipe({ ...demo, description: 'Modifiée sur le Samsung' })
    const r = await samsung.sync()
    await jona.sync()
    expect(r.pushed).toBe(0) // rien n'est parti : la démonstration n'est jamais synchronisée
    expect(await jonaDb.recipes.get(demo.id)).toBeUndefined()
    // « En faire une recette familiale » (1.5.1) : la recette ET sa photo deviennent de vraies données.
    await samsungDb.transaction('rw', samsungDb.recipes, samsungDb.photos, async () => {
      await samsungDb.photos.update(demo.mainPhotoId!, { isDemo: false })
      await samsungDb.recipes.update(demo.id, { isDemo: false, space: 'family' })
    })
    await samsung.sync()
    await jona.sync()
    const there = (await jonaDb.recipes.get(demo.id))!
    expect(there.description).toBe('Modifiée sur le Samsung')
    expect(await jonaDb.photos.get(demo.mainPhotoId!)).toBeTruthy()
    expect(await editDescriptionOnSamsung(demo.id, 'Et maintenant synchronisée')).toBe('Et maintenant synchronisée')
  })
})
