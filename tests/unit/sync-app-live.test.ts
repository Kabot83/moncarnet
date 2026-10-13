/**
 * Test RÉEL (désactivé par défaut) : la synchronisation telle que l'application l'utilise
 * (SyncService : session, migration, automatisme, déconnexion) contre un vrai serveur Carnet Sync.
 * Seul le plugin natif est remplacé par des requêtes équivalentes (même API, jeton de
 * renouvellement gardé hors de l'interface).
 *
 *   SYNC_LIVE_PY=<python avec fastapi, uvicorn, argon2-cffi> npx vitest run tests/unit/sync-app-live.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CarnetDB, db as phoneDb } from '@/db/db'
import { seedDemoData } from '@/db/seed'
import { type OpenedSession, type SessionBackend, SessionError } from '@/platform/carnetSync'
import { applyRestore, exportBackup, readBackup } from '@/services/backup'
import { deleteRecipe, emptyIngredient, emptyRecipe, emptyStep, saveRecipe } from '@/services/recipes'
import { httpSyncApi } from '@/sync/api'
import { localDbName, readBinding, SIGNED_OUT_DB } from '@/sync/binding'
import { applyChoices } from '@/sync/conflicts'
import { SyncService } from '@/sync/service'

const PY = process.env.SYNC_LIVE_PY
const PORT = 19000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER_DIR = resolve(__dirname, '../../nas/carnet-sync')
const PW: Record<string, string> = { alice: 'mot-de-passe-alice', carol: 'mot-de-passe-carol' }
let server: ChildProcess | null = null
let dataDir = ''
let env: NodeJS.ProcessEnv = {}

// localStorage (choix de la base du compte) : absent de Node.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }

function admin(code: string) {
  const r = spawnSync(PY!, ['-c', `from app import auth, spaces; from app.config import Settings; from app.db import Database
s = Settings.from_env(); db = Database(s.data_dir / 'carnet-sync.sqlite3')
${code}`], { cwd: SERVER_DIR, env })
  expect(r.status, r.stderr?.toString()).toBe(0)
}

/** Réseau du « téléphone » : coupé à volonté. */
const net = { online: true }
const phoneFetch: typeof fetch = (input, init) => (net.online ? fetch(input, init) : Promise.reject(new TypeError('Failed to fetch')))

/** Équivalent du plugin natif : le jeton de renouvellement reste ici, jamais dans l'interface. */
function fakeNative(): SessionBackend & { hasSecret(): boolean } {
  let session: { url: string; refresh: string; user: OpenedSession['user'] } | null = null
  const post = async (url: string, path: string, body: unknown, bearer?: string) => {
    if (!net.online) throw new SessionError('network', 'Serveur injoignable.')
    return fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body ?? {}) })
  }
  const opened = (url: string, t: { access_token: string; refresh_token: string; expires_at: number; user: OpenedSession['user'] }) => {
    session = { url, refresh: t.refresh_token, user: t.user }
    return { accessToken: t.access_token, expiresAt: t.expires_at, user: t.user }
  }
  return {
    available: true,
    hasSecret: () => !!session,
    getSession: async () => ({ configured: !!session, url: session?.url ?? '', user: session?.user ?? null }),
    login: async (url, login, password, device) => {
      const r = await post(url, '/v1/auth/login', { login, password, device })
      if (r.status === 401) throw new SessionError('bad_credentials', 'Identifiant ou mot de passe incorrect.')
      return opened(url, await r.json())
    },
    refresh: async () => {
      if (!session) throw new SessionError('no_session', 'Aucune session.')
      const r = await post(session.url, '/v1/auth/refresh', { refresh_token: session.refresh })
      if (r.status === 401 || r.status === 403) {
        session = null
        throw new SessionError('session_revoked', 'Session expirée.')
      }
      return opened(session.url, await r.json())
    },
    logout: async (access) => {
      if (session && access) await post(session.url, '/v1/auth/logout', {}, access).catch(() => undefined)
      session = null
    },
  }
}

/** « Téléphone » : la base ouverte au démarrage dépend du compte (comme db.ts). */
function phone(native: SessionBackend, db: CarnetDB) {
  const reloads: string[] = []
  const svc = new SyncService({ backend: native, db, fetchImpl: phoneFetch, manual: true, device: 'téléphone test', reload: () => void reloads.push(localDbName(readBinding())) })
  return { svc, reloads }
}

const bytes = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString('hex')
function png(seed: number): Blob {
  const a = new Uint8Array(512).map((_, i) => (i * 13 + seed) & 0xff)
  a.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return new Blob([a], { type: 'image/png' })
}

describe.skipIf(!PY)('Mon Carnet 1.5.0 — synchronisation familiale dans l’application (serveur réel)', () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'carnet-sync-app-'))
    env = { ...process.env, SYNC_DATA_DIR: dataDir, SYNC_PORT: String(PORT), SYNC_HOST: '127.0.0.1', SYNC_SCHEDULER: '0', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    admin(`for u in ('alice', 'carol'): auth.create_user(db, u, u.capitalize(), 'mot-de-passe-' + u)
spaces.create_family(db, 'Le Carnet Familial', 'alice'); spaces.add_member(db, 'carol')`)
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
      /* Windows */
    }
  })

  const native = fakeNative()
  const alice = phone(native, phoneDb)
  const serverView = async (login: string) => {
    const r = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: PW[login] }) })
    const t = (await r.json()) as { access_token: string }
    return httpSyncApi(BASE, { access: async () => t.access_token, refresh: async () => t.access_token })
  }

  it('première connexion : carnet existant détecté, rien n’est envoyé avant la migration', async () => {
    await seedDemoData()
    const blob = png(1)
    await phoneDb.photos.put({ id: 'ph_soupe', blob, thumb: png(2), mime: 'image/png', width: 10, height: 10, size: blob.size, createdAt: 1, isDemo: false })
    await phoneDb.recipes.bulkPut([
      {
        ...emptyRecipe({ id: 'r_soupe', title: 'Soupe à l’oignon', mainPhotoId: 'ph_soupe', favorite: true, rating: 5, notes: { tips: 'Vin blanc', modifications: 'Mon secret', mistakes: '', ideas: '', storage: '', reheating: '' } }),
        ingredients: [{ ...emptyIngredient({ id: 'i1', name: 'oignons', quantity: 4 }), nutrition: { food: { source: 'ciqual', id: '20034', name: 'Oignon, cru', per100: { kcal: 40 } }, gramsPerUnit: 150 } as never }],
      },
      emptyRecipe({ id: 'r_tarte', title: 'Tarte aux pommes' }),
      emptyRecipe({ id: 'r_secret', title: 'Recette secrète' }),
    ])
    await alice.svc.init()
    expect(alice.svc.state.status).toBe('signed-out')
    await expect(alice.svc.login(BASE, 'alice', 'mauvais-mot-de-passe')).rejects.toMatchObject({ code: 'bad_credentials' })
    expect(await alice.svc.login(BASE, 'alice', PW.alice)).toBe('needs-migration')
    expect(alice.reloads).toEqual([]) // premier compte : il reprend la base existante
    expect(alice.svc.state.status).toBe('needs-migration')
    expect((await (await serverView('alice')).changes(0)).changes).toEqual([])
  })

  it('migration partielle, interrompue par une coupure, puis reprise et vérifiée (sans doublon)', async () => {
    const order: string[] = []
    let cuts = 1
    const realFetch = globalThis.fetch
    const counting: typeof fetch = (i, init) => {
      if (String(i).includes('/v1/sync/push')) {
        order.push('envoi')
        if (cuts-- > 0) return realFetch(i, init).then(() => Promise.reject(new TypeError('Failed to fetch'))) // reçu par le serveur, réponse perdue
      }
      return phoneFetch(i, init)
    }
    ;(alice.svc as unknown as { deps: { fetchImpl: typeof fetch } }).deps.fetchImpl = counting
    ;(alice.svc as unknown as { makeApi(u: string): void }).makeApi(BASE)
    await expect(alice.svc.migrate(['r_soupe', 'r_tarte'], async () => void order.push('sauvegarde'))).rejects.toThrow()
    expect(order[0]).toBe('sauvegarde')
    expect(alice.svc.state.status).toBe('offline')
    const m = await alice.svc.resumeMigration()
    expect(m?.ok).toBe(true)
    const all = (await (await serverView('alice')).changes(0)).changes
    const keys = all.filter((c) => c.collection === 'recipes').map((c) => `${c.space}:${c.id}`).sort()
    expect(keys).toEqual(['family:r_soupe', 'family:r_tarte', 'personal:r_secret'])
    expect(all.filter((c) => c.id === 'r_soupe' && c.collection === 'recipes')).toHaveLength(1) // aucun doublon
    expect(await phoneDb.recipes.filter((r) => r.isDemo).count()).toBeGreaterThan(0) // rien de supprimé localement
    expect(alice.svc.state.family?.name).toBe('Le Carnet Familial')
  })

  it('création et modification hors ligne : gardées sur le téléphone, envoyées au retour du réseau', async () => {
    net.online = false
    // Ancienne recette du catalogue familial (créée en 1.5.x) : toujours partagée jusqu'à sa conversion.
    const nouvelle = await saveRecipe({ ...emptyRecipe({ title: 'Gratin', ingredients: [emptyIngredient({ id: 'i1', name: 'pommes de terre', quantity: 1000, unit: 'g' })], steps: [emptyStep({ id: 's1', text: 'Cuire' })] }), space: 'family' })
    // 1.6.0 : une nouvelle recette est PRIVÉE par défaut.
    const privee = await saveRecipe(emptyRecipe({ title: 'Mon brouillon' }))
    expect(privee.space).toBeUndefined()
    await phoneDb.recipes.update('r_tarte', { description: 'Avec cannelle' })
    await alice.svc.syncNow()
    expect(alice.svc.state.status).toBe('offline')
    await alice.svc.refreshCounters()
    expect(alice.svc.state.pending).toBeGreaterThanOrEqual(3)
    net.online = true
    await alice.svc.syncNow()
    expect(alice.svc.state.status).toBe('idle')
    expect(alice.svc.state.pending).toBe(0)
    const carolView = (await (await serverView('carol')).changes(0)).changes
    expect(carolView.find((c) => c.id === nouvelle.id)?.data?.title).toBe('Gratin')
    expect(carolView.find((c) => c.id === 'r_tarte')?.data?.description).toBe('Avec cannelle')
    expect(carolView.find((c) => c.id === privee.id)).toBeUndefined()
  })

  let carolDb: CarnetDB
  let carol: ReturnType<typeof phone>
  const carolNative = fakeNative()

  /** Autre téléphone : son propre stockage local (le choix de base d'Alice est mis de côté). */
  async function onCarolPhone<T>(f: () => Promise<T>): Promise<T> {
    const aliceStore = new Map(store)
    store.clear()
    for (const [k, v] of carolStore) store.set(k, v)
    try {
      return await f()
    } finally {
      carolStore = new Map(store)
      store.clear()
      for (const [k, v] of aliceStore) store.set(k, v)
    }
  }
  // Le téléphone de Carol a déjà servi à un autre compte : sa base est « mon-carnet@<carol> »
  // (distincte, dans ce processus, de la base « mon-carnet » d'Alice).
  let carolStore = new Map([['moncarnet.sync.binding', JSON.stringify({ primaryUserId: 'u_ancien', currentUserId: null, everSignedIn: true })]])

  it('autre membre : catalogue reçu avec photos et nutrition, sans aucune donnée personnelle d’Alice', async () => {
    await onCarolPhone(async () => {
      const first = phone(carolNative, new CarnetDB(SIGNED_OUT_DB + '-carol'))
      await first.svc.init()
      expect(await first.svc.login(BASE, 'carol', PW.carol)).toBe('switching')
      carolDb = new CarnetDB(first.reloads.pop()!)
      carol = phone(carolNative, carolDb)
      await carol.svc.init() // redémarrage sur sa base : vide, liée directement, sans démonstration
      await carol.svc.syncNow()
    })
    const soupe = await carolDb.recipes.get('r_soupe')
    expect(soupe?.ingredients[0].nutrition?.food.id).toBe('20034')
    expect(await bytes((await carolDb.photos.get('ph_soupe'))!.blob)).toBe(await bytes(png(1)))
    expect([soupe?.favorite, soupe?.rating, soupe?.notes.modifications, soupe?.notes.tips]).toEqual([false, 0, '', 'Vin blanc'])
    expect(await carolDb.recipes.get('r_secret')).toBeUndefined()
    expect(await carolDb.recipes.filter((x) => x.title === 'Mon brouillon').count()).toBe(0)
    expect(await carolDb.journal.count()).toBe(0)
    expect(await carolDb.recipes.filter((x) => !!x.isDemo).count()).toBe(0)
  })

  it('conflit entre utilisateurs : les deux versions conservées, résolution manuelle', async () => {
    const g = (await phoneDb.recipes.filter((x) => x.title === 'Gratin').first())!
    await onCarolPhone(() => carol.svc.syncNow())
    await carolDb.recipes.update(g.id, { ingredients: [{ ...g.ingredients[0], quantity: 1200 }] })
    await phoneDb.recipes.update(g.id, { ingredients: [{ ...g.ingredients[0], quantity: 800 }] })
    await alice.svc.syncNow()
    await onCarolPhone(() => carol.svc.syncNow())
    await alice.svc.refreshCounters()
    expect(alice.svc.state.conflicts).toBe(1)
    const [c] = await alice.svc.api.familyConflicts()
    expect(c.items[0].path).toBe('ingredients[i1]')
    await alice.svc.syncNow()
    const cur = (await alice.svc.engine.familyRecipeState(g.id))!
    expect((cur.data.ingredients as { quantity: number }[])[0].quantity).toBe(800) // version enregistrée gardée
    await alice.svc.api.resolveConflict(c.id, applyChoices(cur.data, c.items, [true]), cur.rev) // Alice retient 1200 g
    await alice.svc.syncNow()
    await onCarolPhone(() => carol.svc.syncNow())
    expect((await carolDb.recipes.get(g.id))!.ingredients[0].quantity).toBe(1200)
    expect((await phoneDb.recipes.get(g.id))!.ingredients[0].quantity).toBe(1200)
  })

  it('suppression volontaire → corbeille familiale ; perte locale → récupérée, jamais supprimée', async () => {
    const g = (await phoneDb.recipes.filter((x) => x.title === 'Gratin').first())!
    await deleteRecipe(g.id) // suppression faite dans l'application
    await alice.svc.syncNow()
    expect((await alice.svc.api.trash()).map((t) => t.id)).toContain(g.id)
    await onCarolPhone(() => carol.svc.syncNow())
    expect(await carolDb.recipes.get(g.id)).toBeUndefined()
    // Perte locale (effacement hors application) : récupérée depuis le serveur.
    const raw = new CarnetDB(phoneDb.name)
    await raw.recipes.delete('r_tarte')
    raw.close()
    await alice.svc.syncNow()
    expect((await phoneDb.recipes.get('r_tarte'))?.description).toBe('Avec cannelle')
    expect((await alice.svc.api.trash()).map((t) => t.id)).not.toContain('r_tarte')
  })

  it('sauvegarde ZIP : export puis restauration avec synchronisation active, sans suppression ni doublon', async () => {
    const before = (await (await serverView('alice')).changes(0)).changes.length
    await applyRestore(await readBackup(await exportBackup(undefined, { record: false })), 'replace')
    await alice.svc.syncNow()
    expect(alice.svc.state.status).toBe('idle')
    expect((await (await serverView('alice')).changes(0)).changes.length).toBe(before)
    expect((await phoneDb.recipes.get('r_soupe'))?.space).toBe('family')
    expect((await alice.svc.engine.verify()).ok).toBe(true)
  })

  it('élément refusé par le serveur : signalé comme une erreur, jamais comme une réussie', async () => {
    // Fiche anormale (plus de 512 Ko, écrite hors de l'éditeur) : le serveur la refuse.
    await phoneDb.recipes.put({ ...emptyRecipe({ id: 'r_geante', title: 'Géante' }), space: 'family', description: 'x'.repeat(600_000) })
    await alice.svc.syncNow()
    expect(alice.svc.state.status).toBe('error')
    expect(alice.svc.state.lastError).toMatch(/refusé 1 élément/)
    expect(await phoneDb.recipes.get('r_geante')).toBeTruthy() // rien n'est perdu localement
    await deleteRecipe('r_geante')
    await alice.svc.syncNow()
    expect(alice.svc.state.status).toBe('idle')
  })

  it('session révoquée : synchronisation suspendue, données conservées, reprise après reconnexion', async () => {
    admin(`db.x("UPDATE sessions SET revoked_at = strftime('%s') WHERE user_id = (SELECT id FROM users WHERE login = 'alice')")`)
    await phoneDb.recipes.update('r_secret', { description: 'Modifiée pendant la révocation' })
    await alice.svc.syncNow()
    expect(alice.svc.state.status).toBe('revoked')
    expect(native.hasSecret()).toBe(false) // secret effacé du « téléphone »
    expect((await phoneDb.recipes.get('r_secret'))?.description).toBe('Modifiée pendant la révocation')
    expect(await alice.svc.login(BASE, 'alice', PW.alice)).toBe('ok')
    await alice.svc.syncNow()
    const v = (await (await serverView('alice')).changes(0)).changes.filter((c) => c.id === 'r_secret').pop()
    expect(v?.data?.description).toBe('Modifiée pendant la révocation')
  })

  it('déconnexion puis autre compte sur le même téléphone : aucune fuite, carnet retrouvé à la reconnexion', async () => {
    await alice.svc.logout()
    expect(native.hasSecret()).toBe(false)
    expect(alice.reloads.pop()).toBe(SIGNED_OUT_DB) // carnet vide pour la personne suivante
    // Redémarrage sur le carnet vide ; Carol se connecte sur ce téléphone.
    const signedOut = new CarnetDB(SIGNED_OUT_DB)
    const p = phone(native, signedOut)
    await p.svc.init()
    expect(p.svc.state.status).toBe('signed-out')
    expect(await signedOut.recipes.count()).toBe(0)
    expect(await p.svc.login(BASE, 'carol', PW.carol)).toBe('switching')
    const carolName = p.reloads.pop()!
    expect(carolName).toMatch(/^mon-carnet@u_/) // sa propre base
    const carolHere = new CarnetDB(carolName)
    const p2 = phone(native, carolHere)
    await p2.svc.init()
    await p2.svc.syncNow()
    expect(await carolHere.recipes.get('r_soupe')).toMatchObject({ favorite: false, notes: expect.objectContaining({ modifications: '' }) })
    expect(await carolHere.recipes.get('r_secret')).toBeUndefined()
    // Alice revient : sa base d'origine, intacte.
    await p2.svc.logout()
    const p3 = phone(native, new CarnetDB(SIGNED_OUT_DB))
    await p3.svc.init()
    expect(await p3.svc.login(BASE, 'alice', PW.alice)).toBe('switching')
    expect(p3.reloads.pop()).toBe('mon-carnet')
    expect((await phoneDb.recipes.get('r_soupe'))?.notes.modifications).toBe('Mon secret')
  })
})
