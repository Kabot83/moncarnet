/**
 * Recherche de divergence (serveur réel, désactivé par défaut) : séquences aléatoires de
 * modifications et de synchronisations sur deux téléphones ; après convergence, les deux
 * téléphones doivent afficher la même recette commune.
 *
 *   SYNC_LIVE_PY=<python> npx vitest run tests/unit/sync-fuzz-live.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CarnetDB, db as samsungDb } from '@/db/db'
import { type Recipe, RecipeSchema } from '@/models/types'
import { emptyIngredient, emptyRecipe, emptyStep, saveRecipe } from '@/services/recipes'
import { httpSyncApi, type SyncApi } from '@/sync/api'
import { SyncEngine, familyShared } from '@/sync/engine'

const PY = process.env.SYNC_LIVE_PY
const PORT = 21000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`
const SERVER_DIR = resolve(__dirname, '../../nas/carnet-sync')
let server: ChildProcess | null = null
let dataDir = ''
let env: NodeJS.ProcessEnv = {}

async function session(login: string): Promise<SyncApi> {
  const r = await fetch(`${BASE}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, password: `mot-de-passe-${login}` }) })
  const t = (await r.json()) as { access_token: string }
  return httpSyncApi(BASE, { access: async () => t.access_token, refresh: async () => t.access_token })
}

let seed = Number(process.env.FUZZ_SEED ?? 12345)
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)]

const FIELDS: ((r: Recipe, n: number) => Partial<Recipe>)[] = [
  (_r, n) => ({ description: `Description ${n}` }),
  (_r, n) => ({ title: `Titre ${n}` }),
  (_r, n) => ({ servings: 1 + (n % 9) }),
  (r, n) => ({ ingredients: r.ingredients.map((i, k) => (k === 0 ? { ...i, quantity: n } : i)) }),
  (r, n) => ({ steps: r.steps.map((s, k) => (k === 0 ? { ...s, text: `Étape ${n}` } : s)) }),
  (r, n) => ({ notes: { ...r.notes, tips: `Astuce ${n}` } }),
  (_r, n) => ({ cookTime: n }),
]

describe.skipIf(!PY)('Divergence entre deux téléphones (séquences aléatoires)', () => {
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'carnet-sync-fuzz-'))
    env = { ...process.env, SYNC_DATA_DIR: dataDir, SYNC_PORT: String(PORT), SYNC_HOST: '127.0.0.1', SYNC_SCHEDULER: '0', PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }
    const r = spawnSync(PY!, ['-c', `from app import auth, spaces; from app.config import Settings; from app.db import Database
s = Settings.from_env(); db = Database(s.data_dir / 'carnet-sync.sqlite3')
for u in ('alexandre', 'jona'): auth.create_user(db, u, u, 'mot-de-passe-' + u)
spaces.create_family(db, 'F', 'alexandre'); spaces.add_member(db, 'jona')`], { cwd: SERVER_DIR, env })
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

  it('les deux téléphones convergent toujours', async () => {
    const A = new SyncEngine(samsungDb, await session('alexandre'))
    const jonaDb = new CarnetDB('telephone-jona-fuzz')
    const B = new SyncEngine(jonaDb, await session('jona'))
    await A.bindToAccount()
    await B.bindToAccount()
    await samsungDb.settings.put({ key: 'syncNewRecipeSpace', value: 'family' })
    await saveRecipe(emptyRecipe({ id: 'r_x', title: 'X', ingredients: [emptyIngredient({ id: 'i1', name: 'a', quantity: 1 })], steps: [emptyStep({ id: 's1', text: 'e' })] }))
    await A.sync()
    await B.sync()
    const log: string[] = []
    for (let n = 1; n <= 120; n++) {
      const op = pick(['editA', 'editB', 'syncA', 'syncB', 'syncA', 'syncB'])
      if (op === 'editA') {
        const f = pick(FIELDS)
        const r = (await samsungDb.recipes.get('r_x'))!
        await saveRecipe({ ...r, ...f(r, n) })
        log.push(`A:${Object.keys(f(r, n))[0]}=${n}`)
      } else if (op === 'editB') {
        const f = pick(FIELDS)
        const r = (await jonaDb.recipes.get('r_x'))!
        await jonaDb.recipes.put(RecipeSchema.parse({ ...r, ...f(r, n), updatedAt: Date.now() }))
        log.push(`B:${Object.keys(f(r, n))[0]}=${n}`)
      } else {
        await (op === 'syncA' ? A : B).sync()
        log.push(op)
      }
      if (n % 20 === 0) {
        for (let k = 0; k < 2; k++) {
          await A.sync()
          await B.sync()
        }
        const a = familyShared((await samsungDb.recipes.get('r_x'))! as never)
        const b = familyShared((await jonaDb.recipes.get('r_x'))! as never)
        delete a.updatedAt
        delete b.updatedAt
        expect(b, `divergence après : ${log.slice(-25).join(' ')}`).toEqual(a)
      }
    }
  }, 120_000)
})
