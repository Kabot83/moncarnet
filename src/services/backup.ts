/**
 * « Sauvegarder mon carnet » / « Restaurer mon carnet ».
 *
 * Archive ZIP :
 *   data.json                — données versionnées (recettes, journal, collections…)
 *   photos/<id>.<ext>        — photos pleine taille
 *   photos/<id>.thumb.<ext>  — miniatures
 *
 * Les secrets (clé API Gemini, jeton du proxy) ne sont JAMAIS exportés.
 * À la restauration, chaque enregistrement est validé individuellement ;
 * les photos sont contrôlées par empreinte SHA-256.
 */
import JSZip from 'jszip'
import { z } from 'zod'
import { type FoodEntry, type FoodMemory, db } from '@/db/db'
import {
  type AppSettings,
  type Collection,
  CollectionSchema,
  type Conversation,
  type CulinaryProfile,
  type JournalEntry,
  JournalEntrySchema,
  type Photo,
  type Recipe,
  RecipeSchema,
  type ShoppingItem,
  ShoppingItemSchema,
  defaultSettings,
  FoodSchema,
  emptyProfile,
} from '@/models/types'
import { getProfile, getSettings, updateSettings } from './settings'

export const BACKUP_FORMAT = 'mon-carnet-backup'
/** v2 : données nutritionnelles personnelles (aliments utilisés, mémoire des associations). */
export const BACKUP_VERSION = 2
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

/** Réglages exportables (aucun secret, rien de propre à l'appareil). */
const EXPORTABLE_SETTINGS = [
  'theme',
  'catalogView',
  'rounding',
  'allowHalfEggs',
  'aiModel',
  'aiFallbackModel',
  'aiDailyLimit',
  'nutritionEnabled',
] as const satisfies readonly (keyof AppSettings)[]

const PhotoEntrySchema = z.object({
  id: z.string().min(1).max(64),
  mime: z.string().max(60),
  width: z.number(),
  height: z.number(),
  createdAt: z.number(),
  isDemo: z.boolean().default(false),
  file: z.string().max(200),
  thumbFile: z.string().max(200).nullable(),
  sha256: z.string().length(64),
  thumbSha256: z.string().length(64).nullable(),
})

const EnvelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.number(),
  app: z.string().optional(),
  counts: z.record(z.string(), z.number()).optional(),
  recipes: z.array(z.unknown()),
  journal: z.array(z.unknown()).default([]),
  collections: z.array(z.unknown()).default([]),
  shopping: z.array(z.unknown()).default([]),
  conversations: z.array(z.unknown()).default([]),
  foods: z.array(z.unknown()).default([]),
  foodMemory: z.array(z.unknown()).default([]),
  profile: z.record(z.string(), z.string()).default({}),
  settings: z.record(z.string(), z.unknown()).default({}),
  photos: z.array(z.unknown()).default([]),
})

const FoodEntrySchema = z.object({
  key: z.string().min(1).max(100),
  food: FoodSchema,
  favorite: z.boolean().default(false),
  lastUsedAt: z.number().default(0),
  useCount: z.number().int().min(0).default(0),
  updatedAt: z.number().default(0),
})

const FoodMemorySchema = z.object({
  nameKey: z.string().min(1).max(300),
  foodKey: z.string().min(1).max(100),
  gramsPerUnit: z.number().positive().nullable().default(null),
  density: z.number().positive().nullable().default(null),
  updatedAt: z.number().default(0),
})

const ConversationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    messages: z.array(z.object({ id: z.string(), role: z.enum(['user', 'model']), text: z.string(), createdAt: z.number() }).passthrough()),
    recipeId: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .passthrough()

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const EXT: Record<string, string> = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/svg+xml': 'svg', 'image/gif': 'gif' }

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ExportProgress {
  (done: number, total: number): void
}

export async function exportBackup(onProgress?: ExportProgress): Promise<Blob> {
  const zip = new JSZip()
  const [recipes, journal, collections, shopping, conversations, profile, settings, foods, foodMemory] = await Promise.all([
    db.recipes.toArray(),
    db.journal.toArray(),
    db.collections.toArray(),
    db.shopping.toArray(),
    db.conversations.toArray(),
    getProfile(),
    getSettings(),
    db.foods.toArray(),
    db.foodMemory.toArray(),
  ])
  const photoEntries: z.infer<typeof PhotoEntrySchema>[] = []
  const total = await db.photos.count()
  let done = 0
  // Parcours une photo à la fois : évite de charger toutes les photos en mémoire d'un coup.
  const photoIds = await db.photos.toCollection().primaryKeys()
  for (const id of photoIds) {
    const p = await db.photos.get(id)
    if (!p) continue
    const ext = EXT[p.mime] ?? 'bin'
    const full = new Uint8Array(await p.blob.arrayBuffer())
    const hasThumb = p.thumb && p.thumb !== p.blob && p.thumb.size !== p.blob.size
    const thumb = hasThumb ? new Uint8Array(await p.thumb.arrayBuffer()) : null
    const file = `photos/${p.id}.${ext}`
    const thumbFile = thumb ? `photos/${p.id}.thumb.${EXT[p.thumb.type] ?? ext}` : null
    zip.file(file, full, { compression: 'STORE' }) // déjà compressées
    if (thumb && thumbFile) zip.file(thumbFile, thumb, { compression: 'STORE' })
    photoEntries.push({
      id: p.id,
      mime: p.mime,
      width: p.width,
      height: p.height,
      createdAt: p.createdAt,
      isDemo: p.isDemo,
      file,
      thumbFile,
      sha256: await sha256Hex(full),
      thumbSha256: thumb ? await sha256Hex(thumb) : null,
    })
    onProgress?.(++done, total)
  }
  const exportedSettings = Object.fromEntries(EXPORTABLE_SETTINGS.map((k) => [k, settings[k]]))
  const data = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    app: APP_VERSION,
    counts: {
      recipes: recipes.length,
      journal: journal.length,
      collections: collections.length,
      photos: photoEntries.length,
      shopping: shopping.length,
      conversations: conversations.length,
    },
    recipes,
    journal,
    collections,
    shopping,
    conversations,
    foods,
    foodMemory,
    profile,
    settings: exportedSettings,
    photos: photoEntries,
  }
  zip.file('data.json', JSON.stringify(data, null, 1))
  zip.file(
    'LISEZMOI.txt',
    'Sauvegarde de Mon Carnet.\nPour restaurer : Réglages → Sauvegarde → Restaurer mon carnet, puis choisir ce fichier.\nCe fichier ne contient aucune clé API.\n',
  )
  const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  await updateSettings({ lastBackupAt: Date.now() })
  return new Blob([bytes as BlobPart], { type: 'application/zip' })
}

export function backupFileName(ts = Date.now()) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `mon-carnet-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`
}

// ---------------------------------------------------------------------------
// Lecture et contrôle
// ---------------------------------------------------------------------------

export class BackupError extends Error {}

export interface ParsedBackup {
  exportedAt: number
  version: number
  recipes: Recipe[]
  journal: JournalEntry[]
  collections: Collection[]
  shopping: ShoppingItem[]
  conversations: Conversation[]
  foods: FoodEntry[]
  foodMemory: FoodMemory[]
  profile: CulinaryProfile
  settings: Partial<AppSettings>
  photos: Photo[]
  /** Problèmes non bloquants détectés. */
  warnings: string[]
  invalid: { recipes: number; journal: number; collections: number; photos: number; other: number }
}

export interface RestorePreview {
  backup: ParsedBackup
  newRecipes: number
  /** Recettes déjà présentes (même identifiant). */
  duplicates: number
  /** Doublons dont la version de la sauvegarde est plus récente. */
  newerInBackup: number
  /** Recettes au même nom mais d'identifiant différent (possibles doublons). */
  sameTitle: number
  local: { recipes: number; photos: number }
}

/** Migrations du format de sauvegarde : version N → N+1. */
const MIGRATIONS: Record<number, (d: Record<string, unknown>) => Record<string, unknown>> = {
  // v1 → v2 : pas encore de données nutritionnelles personnelles.
  1: (d) => ({ ...d, version: 2, foods: [], foodMemory: [] }),
  // 1: (d) => ({ ...d, version: 2, ... }),
}

function migrate(data: Record<string, unknown>): Record<string, unknown> {
  let d = data
  while ((d.version as number) < BACKUP_VERSION) {
    const m = MIGRATIONS[d.version as number]
    if (!m) throw new BackupError(`Version de sauvegarde ${String(d.version)} non prise en charge.`)
    d = m(d)
  }
  return d
}

function validateEach<T>(items: unknown[], schema: z.ZodType<T>): { ok: T[]; bad: number } {
  const ok: T[] = []
  let bad = 0
  for (const it of items) {
    const r = schema.safeParse(it)
    if (r.success) ok.push(r.data)
    else bad++
  }
  return { ok, bad }
}

export async function readBackup(file: Blob): Promise<ParsedBackup> {
  if (file.size === 0) throw new BackupError('Le fichier est vide.')
  if (file.size > 2 * 1024 ** 3) throw new BackupError('Fichier trop volumineux.')
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer())
  } catch {
    throw new BackupError("Ce fichier n'est pas une archive ZIP valide.")
  }
  const dataFile = zip.file('data.json')
  if (!dataFile) throw new BackupError("Cette archive n'est pas une sauvegarde de Mon Carnet (data.json manquant).")
  let raw: unknown
  try {
    raw = JSON.parse(await dataFile.async('string'))
  } catch {
    throw new BackupError('Le fichier data.json est illisible ou corrompu.')
  }
  const head = z.object({ format: z.string(), version: z.number() }).safeParse(raw)
  if (!head.success || head.data.format !== BACKUP_FORMAT) throw new BackupError("Ce fichier n'est pas une sauvegarde de Mon Carnet.")
  if (head.data.version > BACKUP_VERSION)
    throw new BackupError('Cette sauvegarde provient d’une version plus récente de Mon Carnet. Mettez l’application à jour.')
  const env = EnvelopeSchema.safeParse(migrate(raw as Record<string, unknown>))
  if (!env.success) throw new BackupError('Structure de sauvegarde invalide.')
  const e = env.data
  const warnings: string[] = []

  const recipes = validateEach(e.recipes, RecipeSchema)
  const journal = validateEach(e.journal, JournalEntrySchema)
  const collections = validateEach(e.collections, CollectionSchema)
  const shopping = validateEach(e.shopping, ShoppingItemSchema)
  const conversations = validateEach(e.conversations, ConversationSchema)

  // Photos : présence et intégrité.
  const photos: Photo[] = []
  let badPhotos = 0
  for (const item of e.photos) {
    const pe = PhotoEntrySchema.safeParse(item)
    if (!pe.success || pe.data.file.includes('..')) {
      badPhotos++
      continue
    }
    const f = zip.file(pe.data.file)
    if (!f) {
      badPhotos++
      continue
    }
    const bytes = await f.async('uint8array')
    if ((await sha256Hex(bytes)) !== pe.data.sha256) {
      badPhotos++
      continue
    }
    const blob = new Blob([bytes as BlobPart], { type: pe.data.mime })
    let thumb = blob
    if (pe.data.thumbFile && pe.data.thumbSha256) {
      const tf = zip.file(pe.data.thumbFile)
      const tb = tf ? await tf.async('uint8array') : null
      if (tb && (await sha256Hex(tb)) === pe.data.thumbSha256) thumb = new Blob([tb as BlobPart], { type: pe.data.mime })
      else warnings.push(`Miniature corrompue pour une photo : la photo pleine taille sera utilisée.`)
    }
    photos.push({
      id: pe.data.id,
      blob,
      thumb,
      mime: pe.data.mime,
      width: pe.data.width,
      height: pe.data.height,
      size: blob.size + (thumb === blob ? 0 : thumb.size),
      createdAt: pe.data.createdAt,
      isDemo: pe.data.isDemo,
    })
  }

  // Références vers des éléments absents : nettoyées plutôt que refusées.
  const photoIds = new Set(photos.map((p) => p.id))
  const recipeIds = new Set(recipes.ok.map((r) => r.id))
  let dangling = 0
  const fixPhoto = (id: string | null) => {
    if (id && !photoIds.has(id)) {
      dangling++
      return null
    }
    return id
  }
  for (const r of recipes.ok) {
    r.mainPhotoId = fixPhoto(r.mainPhotoId)
    r.galleryPhotoIds = r.galleryPhotoIds.filter((id) => fixPhoto(id) != null)
    r.steps.forEach((s) => (s.photoId = fixPhoto(s.photoId)))
  }
  journal.ok.forEach((j) => (j.photoId = fixPhoto(j.photoId)))
  collections.ok.forEach((c) => {
    c.coverPhotoId = fixPhoto(c.coverPhotoId)
    c.recipeIds = c.recipeIds.filter((id) => recipeIds.has(id))
  })
  const orphanJournal = journal.ok.filter((j) => !recipeIds.has(j.recipeId)).length
  const journalOk = journal.ok.filter((j) => recipeIds.has(j.recipeId))
  if (dangling) warnings.push(`${dangling} référence(s) vers des photos manquantes ont été retirées.`)
  if (orphanJournal) warnings.push(`${orphanJournal} réalisation(s) sans recette associée ont été ignorées.`)
  if (recipes.bad) warnings.push(`${recipes.bad} recette(s) corrompue(s) seront ignorées.`)
  if (badPhotos) warnings.push(`${badPhotos} photo(s) manquante(s) ou corrompue(s) seront ignorées.`)

  const settings: Partial<AppSettings> = {}
  const defaults = defaultSettings()
  for (const k of EXPORTABLE_SETTINGS) {
    const v = e.settings[k]
    if (v !== undefined && typeof v === typeof defaults[k]) (settings as Record<string, unknown>)[k] = v
  }

  return {
    exportedAt: e.exportedAt,
    version: e.version,
    recipes: recipes.ok,
    journal: journalOk,
    collections: collections.ok,
    shopping: shopping.ok,
    conversations: conversations.ok as unknown as Conversation[],
    foods: validateEach(e.foods, FoodEntrySchema).ok,
    foodMemory: validateEach(e.foodMemory, FoodMemorySchema).ok,
    profile: { ...emptyProfile(), ...(e.profile as Partial<CulinaryProfile>) },
    settings,
    photos,
    warnings,
    invalid: {
      recipes: recipes.bad,
      journal: journal.bad + orphanJournal,
      collections: collections.bad,
      photos: badPhotos,
      other: shopping.bad + conversations.bad,
    },
  }
}

export async function previewRestore(backup: ParsedBackup): Promise<RestorePreview> {
  const local = await db.recipes.toArray()
  const byId = new Map(local.map((r) => [r.id, r]))
  const titles = new Set(local.map((r) => r.title.trim().toLowerCase()))
  let duplicates = 0
  let newerInBackup = 0
  let sameTitle = 0
  for (const r of backup.recipes) {
    const existing = byId.get(r.id)
    if (existing) {
      duplicates++
      if (r.updatedAt > existing.updatedAt) newerInBackup++
    } else if (titles.has(r.title.trim().toLowerCase())) sameTitle++
  }
  return {
    backup,
    newRecipes: backup.recipes.length - duplicates,
    duplicates,
    newerInBackup,
    sameTitle,
    local: { recipes: local.length, photos: await db.photos.count() },
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export type RestoreMode = 'merge' | 'replace'

/**
 * - `replace` : efface le carnet local puis importe la sauvegarde.
 * - `merge` : ajoute ce qui manque ; pour une même recette, garde la version la plus récente.
 * Les secrets et le compteur d'appels IA ne sont jamais touchés.
 */
export async function applyRestore(b: ParsedBackup, mode: RestoreMode): Promise<{ recipes: number; photos: number }> {
  const tables = [db.recipes, db.photos, db.journal, db.collections, db.shopping, db.conversations, db.sessions, db.timers, db.drafts, db.settings, db.foods, db.foodMemory]
  let recipesWritten = 0
  let photosWritten = 0
  await db.transaction('rw', tables, async () => {
    if (mode === 'replace') {
      await Promise.all([
        db.recipes.clear(),
        db.photos.clear(),
        db.journal.clear(),
        db.collections.clear(),
        db.shopping.clear(),
        db.conversations.clear(),
        db.foods.clear(),
        db.foodMemory.clear(),
        db.sessions.clear(),
        db.timers.clear(),
        db.drafts.clear(),
      ])
      await db.photos.bulkPut(b.photos)
      await db.recipes.bulkPut(b.recipes)
      await db.journal.bulkPut(b.journal)
      await db.collections.bulkPut(b.collections)
      await db.shopping.bulkPut(b.shopping)
      await db.conversations.bulkPut(b.conversations)
      await db.foods.bulkPut(b.foods)
      await db.foodMemory.bulkPut(b.foodMemory)
      await db.settings.put({ key: 'profile', value: b.profile })
      recipesWritten = b.recipes.length
      photosWritten = b.photos.length
      return
    }
    // Fusion
    const existingPhotos = new Set(await db.photos.toCollection().primaryKeys())
    const newPhotos = b.photos.filter((p) => !existingPhotos.has(p.id))
    await db.photos.bulkPut(newPhotos)
    photosWritten = newPhotos.length

    const localRecipes = new Map((await db.recipes.toArray()).map((r) => [r.id, r]))
    const toWrite = b.recipes.filter((r) => {
      const l = localRecipes.get(r.id)
      return !l || r.updatedAt > l.updatedAt
    })
    await db.recipes.bulkPut(toWrite)
    recipesWritten = toWrite.length

    const localJournal = new Set(await db.journal.toCollection().primaryKeys())
    await db.journal.bulkPut(b.journal.filter((j) => !localJournal.has(j.id)))

    for (const c of b.collections) {
      const l = await db.collections.get(c.id)
      if (!l) await db.collections.put(c)
      else await db.collections.put({ ...l, recipeIds: [...new Set([...l.recipeIds, ...c.recipeIds])], updatedAt: Date.now() })
    }
    const localConv = new Set(await db.conversations.toCollection().primaryKeys())
    await db.conversations.bulkPut(b.conversations.filter((c) => !localConv.has(c.id)))
    // Aliments et associations : la version la plus récente l'emporte, les favoris s'additionnent.
    for (const f of b.foods) {
      const l = await db.foods.get(f.key)
      if (!l || f.updatedAt > l.updatedAt) await db.foods.put({ ...f, favorite: f.favorite || !!l?.favorite, useCount: Math.max(f.useCount, l?.useCount ?? 0) })
      else if (f.favorite && !l.favorite) await db.foods.put({ ...l, favorite: true })
    }
    for (const m of b.foodMemory) {
      const l = await db.foodMemory.get(m.nameKey)
      if (!l || m.updatedAt > l.updatedAt) await db.foodMemory.put(m)
    }
    const localProfile = await getProfile()
    if (Object.values(localProfile).every((v) => !v)) await db.settings.put({ key: 'profile', value: b.profile })
  })
  // Statistiques de cuisson recalculées pour toutes les recettes touchées.
  const ids = new Set(b.journal.map((j) => j.recipeId))
  for (const id of ids) {
    const entries = await db.journal.where('recipeId').equals(id).toArray()
    const last = entries.reduce<number | null>((m, e) => (m == null || e.date > m ? e.date : m), null)
    await db.recipes.update(id, { cookCount: entries.length, lastCookedAt: last })
  }
  if (mode === 'replace') await updateSettings({ ...b.settings, demoSeeded: true })
  return { recipes: recipesWritten, photos: photosWritten }
}
