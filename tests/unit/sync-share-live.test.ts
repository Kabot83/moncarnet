/**
 * Mon Carnet 1.6.0 (serveur réel 0.2.1, désactivé par défaut) : carnet PRIVÉ par compte,
 * partage d'une copie avec acceptation, repartage d'une nouvelle version (mettre à jour /
 * garder les deux / refuser), protection de l'éditeur entre deux appareils du même compte.
 *
 *   SYNC_LIVE_PY=<python avec fastapi, uvicorn, argon2-cffi> npx vitest run tests/unit/sync-share-live.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CarnetDB, db as alexDb } from '@/db/db'
import { type OpenedSession, type SessionBackend, SessionError } from '@/platform/carnetSync'
import { RecipeSchema } from '@/models/types'
import { emptyIngredient, emptyRecipe, rebaseEditDetailed, saveRecipe } from '@/services/recipes'
import { localDbName, readBinding, SIGNED_OUT_DB } from '@/sync/binding'
import { SyncService } from '@/sync/service'
import { modifiedSinceReception, previousCopy } from '@/pages/ReceivedRecipesPage'

const PY = process.env.SYNC_LIVE_PY
const PORT = 23000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER_DIR = resolve(__dirname, '../../nas/carnet-sync')
const PW: Record<string, string> = { alex: 'mot-de-passe-alex', jona: 'mot-de-passe-jona' }
let server: ChildProcess | null = null
let dataDir = ''
let env: NodeJS.ProcessEnv = {}

const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }

const net = { online: true }
const phoneFetch: typeof fetch = (i, init) => (net.online ? fetch(i, init) : Promise.reject(new TypeError('Failed to fetch')))

function fakeNative(): SessionBackend {
  let session: { url: string; refresh: string; user: OpenedSession['user'] } | null = null
  const post = async (url: string, path: string, body: unknown) => {
    if (!net.online) throw new SessionError('network', 'Serveur injoignable.')
    return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  }
  const opened = (url: string, t: { access_token: string; refresh_token: string; expires_at: number; user: OpenedSession['user'] }) => {
    session = { url, refresh: t.refresh_token, user: t.user }
    return { accessToken: t.access_token, expiresAt: t.expires_at, user: t.user }
  }
  return {
    available: true,
    getSession: async () => ({ configured: !!session, url: session?.url ?? '', user: session?.user ?? null }),
    login: async (url, login, password, device) => opened(url, await (await post(url, '/v1/auth/login', { login, password, device })).json()),
    refresh: async () => {
      if (!session) throw new SessionError('no_session', 'Aucune session.')
      return opened(session.url, await (await post(session.url, '/v1/auth/refresh', { refresh_token: session.refresh })).json())
    },
    logout: async () => {
      session = null
    },
  }
}

/** Un téléphone : son stockage local, sa base (celle du compte), son service de synchronisation. */
async function phone(login: string, firstAccount = false) {
  // Premier compte du téléphone : il reprend le carnet historique « mon-carnet » (comme dans l'application).
  const own = new Map([['moncarnet.sync.binding', JSON.stringify({ primaryUserId: firstAccount ? null : 'u_ancien', currentUserId: null, everSignedIn: true })]])
  const native = fakeNative()
  const on = async <T,>(f: () => Promise<T>): Promise<T> => {
    const saved = new Map(store)
    store.clear()
    for (const [k, v] of own) store.set(k, v)
    try {
      return await f()
    } finally {
      own.clear()
      for (const [k, v] of store) own.set(k, v)
      store.clear()
      for (const [k, v] of saved) store.set(k, v)
    }
  }
  const p = await on(async () => {
    const reloads: string[] = []
    const first = new SyncService({ backend: native, db: new CarnetDB(`${SIGNED_OUT_DB}-${login}-${Math.random()}`), fetchImpl: phoneFetch, manual: true, reload: () => void reloads.push(localDbName(readBinding())) })
    await first.init()
    expect(await first.login(BASE, login, PW[login])).toBe('switching')
    const db = new CarnetDB(reloads.pop()!)
    const svc = new SyncService({ backend: native, db, fetchImpl: phoneFetch, manual: true, reload: () => undefined })
    await svc.init()
    await svc.syncNow() // synchronisation d'ouverture terminée
    return { db, svc }
  })
  return { ...p, on }
}

describe.skipIf(!PY)('Mon Carnet 1.6.0 — carnet privé, partage par copie, repartage', () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'carnet-sync-share-'))
    env = { ...process.env, SYNC_DATA_DIR: dataDir, SYNC_PORT: String(PORT), SYNC_HOST: '127.0.0.1', SYNC_SCHEDULER: '0', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    // Comme sur votre serveur : un ancien catalogue familial existe encore.
    const r = spawnSync(PY!, ['-c', `from app import auth, spaces; from app.config import Settings; from app.db import Database
s = Settings.from_env(); db = Database(s.data_dir / 'carnet-sync.sqlite3')
for u, n in (('alex', 'Alexandre'), ('jona', 'Jona')): auth.create_user(db, u, n, 'mot-de-passe-' + u)
spaces.create_family(db, 'Le Carnet Familial', 'alex'); spaces.add_member(db, 'jona')`], { cwd: SERVER_DIR, env })
    expect(r.status, r.stderr?.toString()).toBe(0)
    server = spawn(PY!, ['-m', 'app.serve'], { cwd: SERVER_DIR, env, stdio: 'ignore' })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${BASE}/v1/health`)).ok) break
      } catch {
        /* démarrage */
      }
      await new Promise((res) => setTimeout(res, 100))
    }
  }, 60_000)

  afterAll(() => {
    server?.kill()
    try {
      rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* Windows */
    }
  })

  let alex: Awaited<ReturnType<typeof phone>>
  let jona: Awaited<ReturnType<typeof phone>>
  let alexSvc: SyncService

  it('nouvelles recettes privées par défaut, même avec un ancien catalogue familial', async () => {
    jona = await phone('jona')
    alex = await phone('alex', true)
    alexSvc = alex.svc
    expect(alex.db.name).toBe(alexDb.name) // même base que l'application (saveRecipe)
    expect(alexSvc.state.status).toBe('idle')
    await alexSvc.syncNow()
    const r = await saveRecipe({ ...emptyRecipe({ id: 'r_soupe', title: 'Soupe', description: 'v1', notes: { tips: 'Vin blanc', modifications: 'secret d’Alex', mistakes: '', ideas: '', storage: '', reheating: '' }, favorite: true, rating: 5, ingredients: [emptyIngredient({ id: 'i1', name: 'oignons', quantity: 4 })] }) })
    expect(r.space).toBeUndefined() // privée
    await alex.on(() => alexSvc.syncNow())
    await jona.on(() => jona.svc.syncNow())
    expect(await jona.db.recipes.get('r_soupe')).toBeUndefined() // invisible des autres comptes
  })

  it('partage refusé tant que la dernière version n’est pas sur le serveur (hors connexion)', async () => {
    await alexDb.recipes.update('r_soupe', { description: 'v1 bis' })
    net.online = false
    await expect(alex.on(() => alexSvc.shareRecipe('r_soupe', 'jona', true))).rejects.toThrow(/pas encore sur le serveur/)
    net.online = true
  })

  let firstCopy = ''

  it('partage : la personne reçoit une copie, l’ajoute ; notes personnelles jamais transmises', async () => {
    expect(await alex.on(() => alexSvc.shareRecipe('r_soupe', 'jona', true))).toEqual({ to: 'Jona' })
    await jona.on(() => jona.svc.refreshCounters())
    expect(jona.svc.state.received).toBe(1)
    const [item] = await jona.on(() => jona.svc.api.inbox())
    expect([item.title, item.sender.display_name, item.has_cover]).toEqual(['Soupe', 'Alexandre', false])
    expect(previousCopy(await jona.db.recipes.toArray(), item)).toBeNull() // première réception : « Ajouter »
    firstCopy = (await jona.on(() => jona.svc.decideReceived(item.id, { kind: 'add' })))!
    const c = (await jona.db.recipes.get(firstCopy))!
    expect([c.description, c.notes.tips, c.notes.modifications, c.favorite, c.rating]).toEqual(['v1 bis', 'Vin blanc', '', false, 0])
    expect(c.receivedFrom?.name).toBe('Alexandre')
    expect(c.receivedFrom?.sourceKey).toMatch(/^src_/)
    expect(c.space).toBe('personal')
  })

  it('copies indépendantes dans les deux sens', async () => {
    await saveRecipe({ ...(await alexDb.recipes.get('r_soupe'))!, title: 'Soupe d’Alex modifiée' })
    await alex.on(() => alexSvc.syncNow())
    await jona.on(() => jona.svc.syncNow())
    expect((await jona.db.recipes.get(firstCopy))!.title).toBe('Soupe')
    await jona.db.recipes.update(firstCopy, { favorite: true, rating: 4, notes: { ...(await jona.db.recipes.get(firstCopy))!.notes, modifications: 'moins de sel' }, description: 'ma version', updatedAt: Date.now() + 120_000 })
    await jona.on(() => jona.svc.syncNow())
    await alex.on(() => alexSvc.syncNow())
    expect((await alexDb.recipes.get('r_soupe'))!.description).toBe('v1 bis')
  })

  it('repartage : « Mettre à jour ma recette » garde favoris, note et notes personnelles ; avertit des modifications', async () => {
    await saveRecipe({ ...(await alexDb.recipes.get('r_soupe'))!, description: 'v2 améliorée' })
    await alex.on(() => alexSvc.syncNow())
    await alex.on(() => alexSvc.shareRecipe('r_soupe', 'jona', true))
    const [item] = await jona.on(() => jona.svc.api.inbox())
    const prev = previousCopy(await jona.db.recipes.toArray(), item)!
    expect(prev.id).toBe(firstCopy) // reconnue comme nouvelle version
    expect(modifiedSinceReception(prev)).toBe(true) // l'interface avertit avant de remplacer
    expect(await jona.on(() => jona.svc.decideReceived(item.id, { kind: 'replace', targetId: prev.id }))).toBe(firstCopy)
    const c = (await jona.db.recipes.get(firstCopy))!
    expect([c.title, c.description]).toEqual(['Soupe d’Alex modifiée', 'v2 améliorée'])
    expect([c.favorite, c.rating, c.notes.modifications]).toEqual([true, 4, 'moins de sel'])
    expect((await jona.db.recipes.filter((r) => !!r.receivedFrom).toArray()).length).toBe(1) // aucun doublon
  })

  it('repartage : « Garder les deux » ajoute une recette distincte ; « Refuser » ne change rien', async () => {
    await alex.on(() => alexSvc.shareRecipe('r_soupe', 'jona', true))
    let [item] = await jona.on(() => jona.svc.api.inbox())
    const second = (await jona.on(() => jona.svc.decideReceived(item.id, { kind: 'add' })))!
    expect(second).not.toBe(firstCopy)
    await alex.on(() => alexSvc.shareRecipe('r_soupe', 'jona', false))
    ;[item] = await jona.on(() => jona.svc.api.inbox())
    expect(previousCopy(await jona.db.recipes.toArray(), item)?.id).toBe(second) // la plus récente
    await jona.on(() => jona.svc.decideReceived(item.id, { kind: 'decline' }))
    expect((await jona.db.recipes.filter((r) => !!r.receivedFrom).toArray()).map((r) => r.id).sort()).toEqual([firstCopy, second].sort())
    expect(await jona.on(() => jona.svc.api.inbox())).toEqual([])
  })

  it('deux appareils du même compte : l’éditeur ouvert ne remet jamais une ancienne version, les désaccords sont signalés', async () => {
    const alex2 = await phone('alex') // second téléphone d'Alex
    await alex2.on(() => alex2.svc.syncNow())
    const ouvert = (await alexDb.recipes.get('r_soupe'))! // éditeur ouvert sur le téléphone 1
    // Téléphone 2 : change la description.
    await alex2.db.recipes.put(RecipeSchema.parse({ ...(await alex2.db.recipes.get('r_soupe'))!, description: 'depuis le téléphone 2', updatedAt: Date.now() }))
    await alex2.on(() => alex2.svc.syncNow())
    await alex.on(() => alexSvc.syncNow()) // reçue pendant l'édition sur le téléphone 1
    // Téléphone 1 : ajoute un ingrédient dans son éditeur, puis enregistre.
    const edited = { ...ouvert, ingredients: [...ouvert.ingredients, emptyIngredient({ id: 'i2', name: 'beurre', quantity: 30 })] }
    const r = rebaseEditDetailed(ouvert, edited, (await alexDb.recipes.get('r_soupe'))!)
    expect(r.clashes).toEqual([])
    await saveRecipe(r.recipe)
    await alex.on(() => alexSvc.syncNow())
    await alex2.on(() => alex2.svc.syncNow())
    const x = (await alex2.db.recipes.get('r_soupe'))!
    expect([x.description, x.ingredients.map((i) => i.id)]).toEqual(['depuis le téléphone 2', ['i1', 'i2']])
    // Même champ modifié des deux côtés : signalé, jamais tranché en silence.
    const ouvert2 = (await alexDb.recipes.get('r_soupe'))!
    await alex2.db.recipes.put(RecipeSchema.parse({ ...x, description: 'téléphone 2 encore', updatedAt: Date.now() }))
    await alex2.on(() => alex2.svc.syncNow())
    await alex.on(() => alexSvc.syncNow())
    const clash = rebaseEditDetailed(ouvert2, { ...ouvert2, description: 'téléphone 1' }, (await alexDb.recipes.get('r_soupe'))!)
    expect(clash.clashes).toEqual(['description'])
  })
})
