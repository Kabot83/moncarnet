/**
 * Test RÉEL de bout en bout (désactivé par défaut) : moteur de synchronisation de l'application
 * contre un vrai serveur Carnet Sync lancé localement (dossier de données temporaire).
 *
 *   SYNC_LIVE_PY=<python avec fastapi, uvicorn, argon2-cffi> npx vitest run tests/unit/sync-live.test.ts
 *
 * Chaque « téléphone » est une base Dexie distincte ; deux comptes : alice et bob.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CarnetDB, db as legacyDb } from '@/db/db'
import { seedDemoData } from '@/db/seed'
import { emptyIngredient, emptyRecipe, emptyStep } from '@/services/recipes'
import { httpSyncApi, type SyncApi, type TokenSource } from '@/sync/api'
import { SyncEngine } from '@/sync/engine'
import { localDbName, migrationSummary, signIn, signOut, SIGNED_OUT_DB, type DeviceBinding } from '@/sync/account'

const PY = process.env.SYNC_LIVE_PY
const PORT = 18000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER_DIR = resolve(__dirname, '../../nas/carnet-sync')
let server: ChildProcess | null = null
let dataDir = ''

const PASSWORDS: Record<string, string> = { alice: 'mot-de-passe-alice', bob: 'mot-de-passe-bob1' }

async function session(login: string, device: string): Promise<{ api: SyncApi; tokens: TokenSource & { refreshCount: number; spoil(): void }; userId: string }> {
  const r = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: PASSWORDS[login], device }) })
  const t = (await r.json()) as { access_token: string; refresh_token: string; user: { id: string } }
  let access = t.access_token
  let refresh = t.refresh_token
  const tokens = {
    refreshCount: 0,
    access: async () => access,
    refresh: async () => {
      const rr = await fetch(`${BASE}/v1/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refresh }) })
      if (!rr.ok) throw new Error('session révoquée')
      const n = (await rr.json()) as typeof t
      access = n.access_token
      refresh = n.refresh_token
      tokens.refreshCount++
      return access
    },
    spoil: () => {
      access = 'mca_expire'
    },
  }
  return { api: httpSyncApi(BASE, tokens), tokens, userId: t.user.id }
}

/** Réseau coupé : toute requête échoue (comme un téléphone hors ligne). */
function offline(api: SyncApi): SyncApi & { online: boolean } {
  const w = { online: false } as SyncApi & { online: boolean }
  for (const k of Object.keys(api) as (keyof SyncApi)[]) {
    ;(w as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
      if (!w.online) return Promise.reject(new TypeError('Failed to fetch'))
      return (api[k] as (...x: unknown[]) => Promise<unknown>)(...a)
    }
  }
  return w
}

function png(seed: number): Blob {
  const bytes = new Uint8Array(256).map((_, i) => (i * 31 + seed) & 0xff)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return new Blob([bytes], { type: 'image/png' })
}

async function addPhoto(d: CarnetDB, id: string, seed: number) {
  const blob = png(seed)
  await d.photos.put({ id, blob, thumb: png(seed + 1), mime: 'image/png', width: 10, height: 10, size: blob.size, createdAt: 1, isDemo: false })
}

function soupe(id: string, photoId: string | null) {
  return emptyRecipe({
    id,
    title: 'Soupe à l’oignon',
    description: 'Gratinée',
    servings: 4,
    cookTime: 40,
    mainPhotoId: photoId,
    ingredients: [
      emptyIngredient({ name: 'oignons', quantity: 4, nutrition: { food: { source: 'ciqual', id: '20034', name: 'Oignon, cru', per100: { kcal: 40 } }, gramsPerUnit: 150 } as never }),
    ],
    steps: [emptyStep({ text: 'Émincer et caraméliser' })],
    notes: { tips: 'Un trait de vin blanc', modifications: 'Mon secret : du porto', mistakes: '', ideas: '', storage: '', reheating: '' },
    favorite: true,
    rating: 5,
  })
}

const bytes = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString('hex')

describe.skipIf(!PY)('Carnet Sync — bout en bout (serveur local réel)', () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'carnet-sync-'))
    const env = { ...process.env, SYNC_DATA_DIR: dataDir, SYNC_PORT: String(PORT), SYNC_HOST: '127.0.0.1', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    const mk = spawnSync(PY!, ['-c', `from app import auth; from app.config import Settings; from app.db import Database
s = Settings.from_env(); db = Database(s.data_dir / 'carnet-sync.sqlite3')
auth.create_user(db, 'alice', 'Alice', '${PASSWORDS.alice}'); auth.create_user(db, 'bob', 'Bob', '${PASSWORDS.bob}')`], { cwd: SERVER_DIR, env })
    expect(mk.status, mk.stderr?.toString()).toBe(0)
    server = spawn(PY!, ['-m', 'app.serve'], { cwd: SERVER_DIR, env, stdio: 'ignore' })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${BASE}/v1/health`)).ok) return
      } catch {
        /* démarrage */
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('Serveur non démarré')
  }, 30_000)

  afterAll(() => {
    server?.kill()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* Windows : fichier encore ouvert */
    }
  })

  // Téléphone 1 : base 1.4.1 existante (« mon-carnet »), avec démonstration + données personnelles.
  let binding: DeviceBinding = { primaryUserId: null, currentUserId: null, everSignedIn: false }
  let phone1: SyncEngine
  let alice1: Awaited<ReturnType<typeof session>>

  it('14. migration des données 1.4.1 : résumé, accord, sans démonstration, sans doublon, reprise', async () => {
    await seedDemoData()
    await addPhoto(legacyDb, 'ph_soupe', 1)
    await legacyDb.recipes.put(soupe('r_soupe', 'ph_soupe'))
    await legacyDb.recipes.put(emptyRecipe({ id: 'r_tarte', title: 'Tarte aux pommes' }))
    await legacyDb.journal.put({ id: 'j_1', recipeId: 'r_soupe', date: 1, comment: 'Journal privé : trop salé', isDemo: false } as never)
    await legacyDb.collections.put({ id: 'c_hiver', name: 'Hiver', recipeIds: ['r_soupe'], order: 0, isDemo: false, createdAt: 1, updatedAt: 1 } as never)

    const summary = await migrationSummary(legacyDb)
    expect(summary.personal).toMatchObject({ recipes: 2, photos: 1, journal: 1, collections: 1 })
    expect(summary.demo.recipes).toBeGreaterThan(0)

    alice1 = await session('alice', 'téléphone 1')
    binding = signIn(binding, alice1.userId)
    expect(localDbName(binding)).toBe('mon-carnet') // la base existante est reprise telle quelle

    // Coupure réseau au milieu : le serveur a reçu un envoi mais la réponse est perdue.
    let cut = true
    const flaky: SyncApi = {
      ...alice1.api,
      push: async (c) => {
        const r = await alice1.api.push(c)
        if (cut) {
          cut = false
          throw new TypeError('Failed to fetch')
        }
        return r
      },
    }
    const first = new SyncEngine(legacyDb, flaky, { deviceLabel: 'téléphone 1' })
    // Aucune synchronisation tant que l'utilisateur n'a pas confirmé la migration.
    await expect(first.sync()).rejects.toMatchObject({ code: 'not_bound' })
    expect((await alice1.api.changes(0)).changes).toEqual([])
    await first.bindToAccount() // accord donné après le résumé
    await expect(first.sync()).rejects.toThrow('Failed to fetch')
    phone1 = new SyncEngine(legacyDb, alice1.api, { deviceLabel: 'téléphone 1' })
    await phone1.sync() // reprise
    const check = await phone1.verify()
    expect(check).toMatchObject({ ok: true, checked: 5 })

    // Aucun doublon, aucune donnée de démonstration sur le serveur.
    const all = await alice1.api.changes(0)
    expect(all.changes.map((c) => `${c.collection}/${c.id}`).sort()).toEqual(['collections/c_hiver', 'journal/j_1', 'photos/ph_soupe', 'recipes/r_soupe', 'recipes/r_tarte'])
    expect((await phone1.sync()).pushed).toBe(0)
    // Les données locales (démonstration comprise) sont toujours là.
    expect(await legacyDb.recipes.filter((r) => r.isDemo).count()).toBe(summary.demo.recipes)
  })

  let phone2: CarnetDB
  let sync2: SyncEngine
  let net2: ReturnType<typeof offline>

  it('4. deux appareils sur le même compte (photos et nutrition comprises)', async () => {
    phone2 = new CarnetDB('telephone-2')
    const alice2 = await session('alice', 'téléphone 2')
    net2 = offline(alice2.api)
    net2.online = true
    sync2 = new SyncEngine(phone2, net2, { deviceLabel: 'téléphone 2' })
    await sync2.bindToAccount() // base vide : liaison directe
    await sync2.sync()
    const r = await phone2.recipes.get('r_soupe')
    expect(r?.ingredients[0].nutrition?.food.id).toBe('20034')
    expect(await bytes((await phone2.photos.get('ph_soupe'))!.blob)).toBe(await bytes((await legacyDb.photos.get('ph_soupe'))!.blob))
    expect(await phone2.recipes.count()).toBe(2) // pas de démonstration recopiée
  })

  it('5–6. modification hors ligne puis conflit : les deux versions sont conservées', async () => {
    net2.online = false
    await phone2.recipes.update('r_tarte', { title: 'Tarte (téléphone 2, hors ligne)' })
    await phone2.recipes.put(emptyRecipe({ id: 'r_offline', title: 'Créée hors ligne' }))
    await expect(sync2.sync()).rejects.toThrow() // hors ligne : l'application continue, rien n'est perdu

    await legacyDb.recipes.update('r_tarte', { title: 'Tarte (téléphone 1)' })
    await phone1.sync()

    net2.online = true // retour du réseau : reprise automatique
    const rep = await sync2.sync()
    expect(rep.conflicts.map((c) => c.kind)).toContain('copy')
    const titles = (await phone2.recipes.toArray()).map((x) => x.title).sort()
    expect(titles).toEqual(['Créée hors ligne', 'Soupe à l’oignon', 'Tarte (téléphone 1)', 'Tarte (téléphone 2, hors ligne) (conflit — téléphone 2)'])
    await phone1.sync()
    expect((await legacyDb.recipes.filter((r) => !r.isDemo).toArray()).map((x) => x.title).sort()).toEqual(titles)
  })

  it('collections fusionnées ; suppression transmise ; modification contre suppression', async () => {
    await legacyDb.collections.update('c_hiver', { recipeIds: ['r_soupe', 'r_tarte'], updatedAt: 2 })
    await phone2.collections.update('c_hiver', { recipeIds: ['r_soupe', 'r_offline'], updatedAt: 3 })
    await phone1.sync()
    await sync2.sync()
    await phone1.sync()
    expect((await legacyDb.collections.get('c_hiver'))!.recipeIds.sort()).toEqual(['r_offline', 'r_soupe', 'r_tarte'])

    await legacyDb.recipes.delete('r_offline')
    await phone1.sync()
    await sync2.sync()
    expect(await phone2.recipes.get('r_offline')).toBeUndefined()

    // Supprimée sur le téléphone 1, modifiée hors ligne sur le téléphone 2 : la modification l'emporte.
    net2.online = false
    await phone2.recipes.update('r_tarte', { description: 'Avec cannelle' })
    await legacyDb.recipes.delete('r_tarte')
    await phone1.sync()
    net2.online = true
    const rep = await sync2.sync()
    expect(rep.conflicts.map((c) => c.kind)).toContain('resurrected')
    await phone1.sync()
    expect((await legacyDb.recipes.get('r_tarte'))?.description).toBe('Avec cannelle')
  })

  it('perte partielle ou totale d’IndexedDB : jamais de suppression sur le serveur', async () => {
    // Seconde connexion à la même base, hors application (sans suivi) : simule ce que le système
    // efface lui-même. L'application, elle, ne fait que des suppressions suivies (volontaires).
    const raw = new CarnetDB('telephone-2')
    const before = await phone2.recipes.count()

    // Perte d'un seul élément : re-téléchargé, rien n'est supprimé sur le serveur.
    await raw.recipes.delete('r_soupe')
    let rep = await sync2.sync()
    expect(rep.recovered).toEqual([{ collection: 'recipes', count: 1 }])
    expect(await phone2.recipes.get('r_soupe')).toBeTruthy()

    // Perte de la recette, puis nettoyage des photos « orphelines » par l'application (suppression
    // volontaire) : le serveur refuse de supprimer une photo encore utilisée → tout revient.
    await raw.recipes.delete('r_soupe')
    await phone2.photos.delete('ph_soupe')
    rep = await sync2.sync()
    expect(rep.conflicts.map((c) => c.kind)).toContain('restored')
    expect(await phone2.recipes.get('r_soupe')).toBeTruthy()
    expect(await bytes((await phone2.photos.get('ph_soupe'))!.blob)).toBe(await bytes(png(1)))

    // Perte totale : tout est re-téléchargé.
    await raw.recipes.clear()
    await raw.photos.clear()
    await raw.journal.clear()
    rep = await sync2.sync()
    expect(rep.recovered.map((r) => r.collection).sort()).toEqual(['journal', 'photos', 'recipes'])
    expect(await phone2.recipes.count()).toBe(before)
    expect(await phone2.photos.count()).toBe(1)
    expect((await phone1.verify()).ok).toBe(true)
    raw.close()
  })

  it('suppressions volontaires : transmises, y compris en nombre', async () => {
    const ids = ['r_v1', 'r_v2', 'r_v3', 'r_v4']
    await legacyDb.recipes.bulkPut(ids.map((id) => emptyRecipe({ id, title: id })))
    await phone1.sync()
    await sync2.sync()
    expect(await phone2.recipes.where('id').anyOf(ids).count()).toBe(4)
    await phone2.recipes.bulkDelete(ids)
    await sync2.sync()
    await phone1.sync()
    expect(await legacyDb.recipes.where('id').anyOf(ids).count()).toBe(0)
  })

  it('16. nouveau téléphone : restauration complète depuis le compte', async () => {
    const fresh = new CarnetDB('telephone-neuf')
    const s = new SyncEngine(fresh, (await session('alice', 'téléphone neuf')).api)
    await s.bindToAccount()
    await s.sync()
    expect((await s.verify()).ok).toBe(true)
    expect(await fresh.recipes.count()).toBe(await legacyDb.recipes.filter((r) => !r.isDemo).count())
    expect((await fresh.journal.get('j_1'))?.comment).toBe('Journal privé : trop salé')
  })

  it('jeton expiré : renouvellement automatique de la session', async () => {
    alice1.tokens.spoil()
    await phone1.sync()
    expect(alice1.tokens.refreshCount).toBe(1)
  })

  let bob: Awaited<ReturnType<typeof session>>
  let bobDb: CarnetDB

  it('1–3. second compte sur le même téléphone : base séparée, rien de visible', async () => {
    binding = signOut(binding)
    expect(localDbName(binding)).toBe(SIGNED_OUT_DB) // la personne suivante ne voit pas le carnet d'Alice
    bob = await session('bob', 'téléphone 1')
    binding = signIn(binding, bob.userId)
    expect(localDbName(binding)).toBe(`mon-carnet@${bob.userId}`)
    bobDb = new CarnetDB(localDbName(binding))
    const s = new SyncEngine(bobDb, bob.api)
    await s.bindToAccount()
    await s.sync()
    expect(await bobDb.recipes.count()).toBe(0)
    // Carnet d'Alice + session de Bob (erreur de l'application, base mal choisie) : refusé
    // avant tout échange ; rien n'arrive dans le compte de Bob.
    await expect(new SyncEngine(legacyDb, bob.api).sync()).rejects.toMatchObject({ code: 'other_account' })
    await expect(new SyncEngine(legacyDb, bob.api).bindToAccount()).rejects.toMatchObject({ code: 'other_account' })
    expect((await bob.api.changes(0)).changes).toEqual([])
    expect(await bob.api.getBlob('0'.repeat(64)).catch((e) => e.status)).toBe(404)
    // Données d'Alice toujours intactes dans sa base ; reconnexion : retrouvées.
    expect(localDbName(signIn(signOut(binding), alice1.userId))).toBe('mon-carnet')
    expect(await legacyDb.recipes.get('r_soupe')).toBeTruthy()
  })

  it('7–13. envoi Alice → Bob : copie indépendante, sans notes privées, acceptation unique', async () => {
    expect(await alice1.api.lookupUser('bo')).toBeNull()
    expect(await alice1.api.lookupUser('bob')).toEqual({ login: 'bob', display_name: 'Bob' })
    const t = await alice1.api.sendTransfer('bob', 'recipe', 'r_soupe', true)

    // 11. Alice modifie puis supprime l'original après l'envoi.
    await legacyDb.recipes.update('r_soupe', { title: 'Soupe modifiée après envoi' })
    await phone1.sync()
    await legacyDb.recipes.delete('r_soupe')
    await phone1.sync()

    const inbox = await bob.api.inbox()
    expect(inbox).toMatchObject([{ id: t.id, title: 'Soupe à l’oignon', sender: { login: 'alice', display_name: 'Alice' }, has_cover: true }])
    const a1 = await bob.api.acceptTransfer(t.id)
    const a2 = await bob.api.acceptTransfer(t.id) // 9. pas de doublon
    expect(a2.id).toBe(a1.id)

    const s = new SyncEngine(bobDb, bob.api)
    await s.sync()
    const recus = await bobDb.recipes.toArray()
    expect(recus).toHaveLength(1)
    const copy = recus[0]
    expect(copy.title).toBe('Soupe à l’oignon')
    expect(copy.ingredients[0].nutrition?.food.id).toBe('20034') // 12
    expect(await bytes((await bobDb.photos.get(copy.mainPhotoId!))!.blob)).toBe(await bytes(png(1))) // 12
    expect(copy.notes.tips).toBe('Un trait de vin blanc')
    expect(copy.notes.modifications).toBe('') // 13
    expect([copy.favorite, copy.rating]).toEqual([false, 0])
    expect(await bobDb.journal.count()).toBe(0) // 13
    expect((copy as unknown as { receivedFrom: { login: string } }).receivedFrom.login).toBe('alice')

    // 10. Bob modifie sa copie : Alice n'en voit rien (sa recette reste supprimée).
    await bobDb.recipes.update(copy.id, { title: 'Ma soupe' })
    await s.sync()
    await phone1.sync()
    expect(await legacyDb.recipes.get('r_soupe')).toBeUndefined()
    expect(await legacyDb.recipes.get(copy.id)).toBeUndefined()
  })

  it('8. refus : rien n’est ajouté', async () => {
    await legacyDb.recipes.put(emptyRecipe({ id: 'r_quiche', title: 'Quiche' }))
    await phone1.sync()
    const t = await alice1.api.sendTransfer('bob', 'recipe', 'r_quiche', false)
    await bob.api.declineTransfer(t.id)
    expect(await bob.api.inbox()).toEqual([])
    await expect(bob.api.acceptTransfer(t.id)).rejects.toMatchObject({ status: 409 })
    await new SyncEngine(bobDb, bob.api).sync()
    expect((await bobDb.recipes.toArray()).map((r) => r.title)).toEqual(['Ma soupe'])
  })
})
