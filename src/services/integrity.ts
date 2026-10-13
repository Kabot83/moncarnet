/**
 * Persistance des données sur Android (APK) : vérification réelle et copie de sécurité.
 *
 * Constat : dans une WebView Android, `navigator.storage.persist()` est TOUJOURS refusé
 * (Chromium, android_webview/browser/aw_permission_manager.cc) : la base IndexedDB reste en mode
 * « best-effort ». Elle vit dans l'espace privé de l'application, mais le gestionnaire de quotas
 * de Chromium pourrait en théorie l'effacer si le téléphone est presque plein.
 *
 * Ce module ne prétend donc pas que le stockage est « garanti ». Il :
 * 1. pose un repère identique dans IndexedDB et dans les fichiers natifs de l'application
 *    (hors WebView) ; au démarrage, un repère natif présent sans son double IndexedDB prouve
 *    une perte de la base → alerte et restauration proposée ;
 * 2. tient une copie de sécurité automatique (ZIP complet sans les vidéos) dans les fichiers
 *    natifs, renouvelée quand les données changent ;
 * 3. contrôle la présence réelle des fichiers vidéo enregistrés.
 * Une désinstallation ou « Effacer les données » supprime tout, y compris ces copies : seule une
 * sauvegarde ZIP exportée hors du téléphone protège de ces cas.
 */
import { DB_NAME, db } from '@/db/db'
import { isNative } from '@/platform/native'
import { type ParsedBackup, applyRestore, exportBackup, readBackup } from './backup'

/**
 * Dossier propre à la base ouverte : « securite/ » pour le carnet historique (inchangé depuis
 * 1.4.1) ; un sous-dossier par compte Carnet Sync supplémentaire. La copie d'un compte ne peut
 * donc jamais être restaurée dans la base d'un autre.
 */
export function securityDir(name: string = db.name): string {
  return name === DB_NAME ? 'securite' : `securite/base-${name.replace(/[^A-Za-z0-9_-]/g, '_')}`
}
const MARKER_FILE = `${securityDir()}/repere.json`
const SNAPSHOT_FILE = `${securityDir()}/copie-auto.zip`
const SNAPSHOT_PREVIOUS = `${securityDir()}/copie-auto-precedente.zip`
const SETTINGS_KEY = 'integrity'

export interface IntegrityMarker {
  installId: string
  createdAt: number
}

export interface SnapshotInfo {
  at: number
  bytes: number
  fingerprint: string
  recipes: number
}

interface NativeMarker extends IntegrityMarker {
  lastCheckAt: number
  snapshot: SnapshotInfo | null
}

export type IntegrityState =
  | { kind: 'web' }
  | { kind: 'initialized'; since: number; snapshot: SnapshotInfo | null }
  | { kind: 'ok'; since: number; snapshot: SnapshotInfo | null }
  | { kind: 'lost'; since: number; snapshot: SnapshotInfo | null }
  | { kind: 'unverifiable'; reason: string }

// ---------------------------------------------------------------------------
// Fichiers natifs (dossier privé de l'application, hors WebView)
// ---------------------------------------------------------------------------

async function fs() {
  const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem')
  return { Filesystem, Data: Directory.Data, Encoding }
}

async function readJson<T>(path: string): Promise<T | null> {
  const { Filesystem, Data, Encoding } = await fs()
  try {
    const r = await Filesystem.readFile({ path, directory: Data, encoding: Encoding.UTF8 })
    return JSON.parse(String(r.data)) as T
  } catch {
    return null
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const { Filesystem, Data, Encoding } = await fs()
  await Filesystem.writeFile({ path, directory: Data, encoding: Encoding.UTF8, data: JSON.stringify(value), recursive: true })
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Écriture par tranches dans un fichier temporaire, puis remplacement : jamais de copie à moitié écrite. */
export async function writeBlob(path: string, blob: Blob): Promise<void> {
  const { Filesystem, Data } = await fs()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const tmp = `${path}.tmp`
  const CHUNK = 3 * 1024 * 1024
  for (let i = 0; i < Math.max(1, bytes.length); i += CHUNK) {
    const data = bytesToBase64(bytes.subarray(i, i + CHUNK))
    if (i === 0) await Filesystem.writeFile({ path: tmp, directory: Data, data, recursive: true })
    else await Filesystem.appendFile({ path: tmp, directory: Data, data })
  }
  try {
    await Filesystem.deleteFile({ path, directory: Data })
  } catch {
    /* pas encore de copie */
  }
  await Filesystem.rename({ from: tmp, to: path, directory: Data, toDirectory: Data })
}

async function readBlob(path: string): Promise<Blob | null> {
  const { Filesystem, Data } = await fs()
  try {
    const r = await Filesystem.readFile({ path, directory: Data })
    const bin = atob(String(r.data))
    return new Blob([Uint8Array.from(bin, (c) => c.charCodeAt(0))], { type: 'application/zip' })
  } catch {
    return null
  }
}

async function exists(path: string): Promise<boolean> {
  const { Filesystem, Data } = await fs()
  try {
    await Filesystem.stat({ path, directory: Data })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Vérification au démarrage
// ---------------------------------------------------------------------------

const newInstallId = () => `ins_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`

async function idbMarker(): Promise<IntegrityMarker | null> {
  const row = await db.settings.get(SETTINGS_KEY)
  const v = row?.value as IntegrityMarker | undefined
  return v?.installId ? v : null
}

let current: Promise<IntegrityState> | null = null

/** État de la vérification (une seule par lancement ; `force` pour la refaire). */
export function checkIntegrity(force = false): Promise<IntegrityState> {
  if (!isNative) return Promise.resolve({ kind: 'web' })
  if (!current || force) current = runCheck()
  return current
}

async function runCheck(): Promise<IntegrityState> {
  try {
    const [nat, idb] = await Promise.all([readJson<NativeMarker>(MARKER_FILE), idbMarker()])
    const now = Date.now()
    if (!nat && !idb) {
      // Premier lancement (ou application réinstallée / données effacées : indiscernable).
      const m: IntegrityMarker = { installId: newInstallId(), createdAt: now }
      await db.settings.put({ key: SETTINGS_KEY, value: m })
      await writeJson(MARKER_FILE, { ...m, lastCheckAt: now, snapshot: null } satisfies NativeMarker)
      return { kind: 'initialized', since: now, snapshot: null }
    }
    if (nat && !idb) {
      // Les fichiers de l'application sont là, mais la base IndexedDB a disparu : perte réelle.
      return { kind: 'lost', since: nat.createdAt, snapshot: nat.snapshot && (await exists(SNAPSHOT_FILE)) ? nat.snapshot : null }
    }
    if (!nat && idb) {
      // Fichiers natifs absents (rare) : repère recréé à partir de la base, intacte.
      await writeJson(MARKER_FILE, { ...idb, lastCheckAt: now, snapshot: null } satisfies NativeMarker)
      return { kind: 'ok', since: idb.createdAt, snapshot: null }
    }
    if (nat!.installId !== idb!.installId) {
      // Base restaurée par la sauvegarde Android d'un autre téléphone : on adopte la base.
      await writeJson(MARKER_FILE, { ...idb!, lastCheckAt: now, snapshot: nat!.snapshot } satisfies NativeMarker)
      return { kind: 'ok', since: idb!.createdAt, snapshot: nat!.snapshot }
    }
    await writeJson(MARKER_FILE, { ...nat!, lastCheckAt: now })
    return { kind: 'ok', since: nat!.createdAt, snapshot: nat!.snapshot && (await exists(SNAPSHOT_FILE)) ? nat!.snapshot : null }
  } catch (e) {
    return { kind: 'unverifiable', reason: e instanceof Error ? e.message : 'erreur inconnue' }
  }
}

// ---------------------------------------------------------------------------
// Copie de sécurité automatique
// ---------------------------------------------------------------------------

/** Empreinte bon marché du contenu : change dès qu'une donnée est ajoutée, modifiée ou supprimée. */
export async function dataFingerprint(): Promise<{ fingerprint: string; recipes: number }> {
  const maxUpdated = async (t: typeof db.recipes | typeof db.posts) => (await t.orderBy('updatedAt').last())?.updatedAt ?? 0
  const [recipes, posts, journal, collections, foods, foodMemory, shopping, photos, r, p] = await Promise.all([
    db.recipes.count(),
    db.posts.count(),
    db.journal.count(),
    db.collections.count(),
    db.foods.count(),
    db.foodMemory.count(),
    db.shopping.count(),
    db.photos.count(),
    maxUpdated(db.recipes),
    maxUpdated(db.posts),
  ])
  const journalMax = (await db.journal.orderBy('date').last())?.date ?? 0
  const collectionsMax = (await db.collections.toArray()).reduce((m, c) => Math.max(m, c.updatedAt ?? 0), 0)
  const foodsMax = (await db.foods.orderBy('updatedAt').last())?.updatedAt ?? 0
  const memMax = (await db.foodMemory.orderBy('updatedAt').last())?.updatedAt ?? 0
  return { fingerprint: [recipes, posts, journal, collections, foods, foodMemory, shopping, photos, r, p, journalMax, collectionsMax, foodsMax, memMax].join('.'), recipes }
}

/**
 * Crée la copie de sécurité si les données ont changé depuis la dernière (ou si `force`).
 * L'ancienne copie est gardée jusqu'à ce que la nouvelle soit complète.
 */
export async function refreshSnapshot(force = false): Promise<SnapshotInfo | null> {
  if (!isNative) return null
  const state = await checkIntegrity()
  if (state.kind === 'lost' || state.kind === 'unverifiable' || state.kind === 'web') return null // ne jamais écraser une bonne copie par une base vide
  const marker = await readJson<NativeMarker>(MARKER_FILE)
  if (!marker) return null
  const { fingerprint, recipes } = await dataFingerprint()
  if (!force && marker.snapshot?.fingerprint === fingerprint && (await exists(SNAPSHOT_FILE))) return marker.snapshot
  // Une base devenue vide ne remplace jamais une copie qui contenait des recettes.
  if (recipes === 0 && (marker.snapshot?.recipes ?? 0) > 0) return marker.snapshot
  const blob = await exportBackup(undefined, { record: false })
  const { Filesystem, Data } = await fs()
  if (await exists(SNAPSHOT_FILE)) {
    try {
      await Filesystem.deleteFile({ path: SNAPSHOT_PREVIOUS, directory: Data })
    } catch {
      /* pas de copie précédente */
    }
    await Filesystem.copy({ from: SNAPSHOT_FILE, to: SNAPSHOT_PREVIOUS, directory: Data, toDirectory: Data })
  }
  await writeBlob(SNAPSHOT_FILE, blob)
  const info: SnapshotInfo = { at: Date.now(), bytes: blob.size, fingerprint, recipes }
  await writeJson(MARKER_FILE, { ...marker, snapshot: info })
  current = Promise.resolve({ ...state, snapshot: info } as IntegrityState)
  return info
}

/** Copie lisible, intacte et complète (autant de recettes que lors de sa création) ; null sinon. */
async function readCompleteSnapshot(path: string, expected: number | null): Promise<ParsedBackup | null> {
  const blob = await readBlob(path)
  if (!blob) return null
  try {
    const parsed = await readBackup(blob)
    const intact = parsed.invalid.recipes === 0 && parsed.invalid.photos === 0 && parsed.invalid.journal === 0 && parsed.invalid.collections === 0
    const complete = expected == null ? parsed.recipes.length > 0 : parsed.recipes.length >= expected
    return intact && complete ? parsed : null
  } catch {
    return null
  }
}

/**
 * Restaure la copie de sécurité automatique (remplace la base ; vidéos non concernées).
 * Refusée si aucune perte n'a été détectée, si la copie est vide, corrompue ou incomplète, ou
 * si la base actuelle contient plus de recettes personnelles que la copie.
 */
export async function restoreSnapshot(): Promise<{ recipes: number }> {
  const state = await checkIntegrity()
  if (state.kind !== 'lost') throw new Error('La base actuelle est intacte : la copie de sécurité ne peut pas la remplacer.')
  const marker = await readJson<NativeMarker>(MARKER_FILE)
  const parsed = (await readCompleteSnapshot(SNAPSHOT_FILE, marker?.snapshot?.recipes ?? null)) ?? (await readCompleteSnapshot(SNAPSHOT_PREVIOUS, null))
  if (!parsed) throw new Error('Aucune copie de sécurité complète et intacte sur ce téléphone.')
  const local = await db.recipes.filter((r) => !r.isDemo).count()
  if (local > parsed.recipes.length) throw new Error('La base actuelle contient plus de recettes que la copie : restauration refusée.')
  const res = await applyRestore(parsed, 'replace')
  // La base restaurée reçoit de nouveau le repère de ce téléphone.
  if (marker) await db.settings.put({ key: SETTINGS_KEY, value: { installId: marker.installId, createdAt: marker.createdAt } })
  current = null
  return { recipes: res.recipes }
}

/** L'utilisateur choisit de repartir de zéro malgré la perte : nouveau repère, copie conservée. */
export async function acknowledgeLoss(): Promise<void> {
  const marker = await readJson<NativeMarker>(MARKER_FILE)
  if (!marker) return
  await db.settings.put({ key: SETTINGS_KEY, value: { installId: marker.installId, createdAt: marker.createdAt } })
  current = null
}

// ---------------------------------------------------------------------------
// Vidéos enregistrées
// ---------------------------------------------------------------------------

export interface VideoCheck {
  referenced: number
  present: number
  bytes: number
  missing: Array<{ postId: string; title: string }>
}

/** Vérifie que chaque vidéo référencée par une fiche existe réellement dans les fichiers de l'application. */
export async function checkVideos(): Promise<VideoCheck | null> {
  if (!isNative) return null
  const { Filesystem, Data } = await fs()
  const posts = await db.posts.filter((p) => !!p.video).toArray()
  const res: VideoCheck = { referenced: posts.length, present: 0, bytes: 0, missing: [] }
  for (const p of posts) {
    try {
      const st = await Filesystem.stat({ path: `carnet-videos/${p.video!.name}`, directory: Data })
      res.present++
      res.bytes += Number(st.size) || 0
    } catch {
      res.missing.push({ postId: p.id, title: p.title })
    }
  }
  return res
}
