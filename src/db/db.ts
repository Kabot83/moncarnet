/**
 * Base de données locale (IndexedDB via Dexie).
 *
 * Migrations : ne JAMAIS modifier une version existante. Pour faire évoluer le
 * schéma, ajouter `this.version(N + 1).stores({...}).upgrade(tx => ...)` en
 * ne listant que les tables modifiées. Dexie applique les versions dans l'ordre
 * sur les appareils déjà installés.
 */
import Dexie, { type Table } from 'dexie'
import type {
  Collection,
  Food,
  Conversation,
  CookingSession,
  Draft,
  JournalEntry,
  Photo,
  Recipe,
  ShoppingItem,
  SocialPost,
  Timer,
} from '@/models/types'

export interface SettingRow {
  key: string
  value: unknown
}

export interface AiUsageRow {
  /** Date locale AAAA-MM-JJ. */
  day: string
  count: number
}

/** Aliment utilisé (favori, récent, produit Open Food Facts en cache, aliment personnel). */
export interface FoodEntry {
  /** « ciqual:9435 », « off:3229820787015 », « custom:… » */
  key: string
  food: Food
  favorite: boolean
  lastUsedAt: number
  useCount: number
  updatedAt: number
}

/** Mémoire des associations : « farine d'avoine » → aliment choisi la dernière fois. */
export interface FoodMemory {
  /** Nom d'ingrédient normalisé. */
  nameKey: string
  foodKey: string
  gramsPerUnit: number | null
  density: number | null
  updatedAt: number
}

export const DB_NAME = 'mon-carnet'
export const DB_VERSION = 4

export class CarnetDB extends Dexie {
  recipes!: Table<Recipe, string>
  photos!: Table<Photo, string>
  journal!: Table<JournalEntry, string>
  collections!: Table<Collection, string>
  shopping!: Table<ShoppingItem, string>
  sessions!: Table<CookingSession, string>
  timers!: Table<Timer, string>
  drafts!: Table<Draft, string>
  conversations!: Table<Conversation, string>
  settings!: Table<SettingRow, string>
  /** Secrets (clé API, jeton du proxy) : table séparée, jamais exportée. */
  secrets!: Table<SettingRow, string>
  aiUsage!: Table<AiUsageRow, string>
  foods!: Table<FoodEntry, string>
  foodMemory!: Table<FoodMemory, string>
  /** Publications TikTok / Instagram enregistrées (« À essayer »). */
  posts!: Table<SocialPost, string>

  constructor(name = DB_NAME) {
    super(name)
    this.version(1).stores({
      recipes: 'id, title, category, updatedAt, createdAt, favorite, toTry, lastCookedAt, isDemo, *tags',
      photos: 'id, createdAt, isDemo',
      journal: 'id, recipeId, date, isDemo',
      collections: 'id, order, *recipeIds, isDemo',
      shopping: 'id, category, checked, createdAt',
      sessions: 'recipeId, updatedAt',
      timers: 'id, endsAt, recipeId',
      drafts: 'id, updatedAt',
      conversations: 'id, updatedAt, recipeId',
      settings: 'key',
      secrets: 'key',
      aiUsage: 'day',
    })
    // v2 : index sur la note et le nombre de réalisations (tri du catalogue).
    this.version(2)
      .stores({
        recipes: 'id, title, category, updatedAt, createdAt, favorite, toTry, lastCookedAt, isDemo, rating, cookCount, *tags',
      })
      .upgrade(async (tx) => {
        await tx
          .table('recipes')
          .toCollection()
          .modify((r: Partial<Recipe>) => {
            r.rating ??= 0
            r.cookCount ??= 0
          })
      })
    // v3 : nutrition (aliments utilisés, mémoire des associations, poids après cuisson).
    // Les recettes existantes reçoivent les nouveaux champs vides : rien n'est associé d'office.
    this.version(3)
      .stores({
        foods: 'key, favorite, lastUsedAt, updatedAt',
        foodMemory: 'nameKey, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('recipes')
          .toCollection()
          .modify((r: Partial<Recipe>) => {
            r.cookedWeightG ??= null
            r.cookedWeightRawG ??= null
            r.ingredients?.forEach((i) => {
              i.nutrition ??= null
              i.nutritionExcluded ??= false
            })
          })
      })
    // v4 : bibliothèque « À essayer » (TikTok, Instagram). Nouvelle table ; les recettes
    // reçoivent seulement le lien (vide) vers leur publication source.
    this.version(4)
      .stores({
        posts: 'id, &dedupeKey, platform, status, createdAt, updatedAt, recipeId, *tags',
        recipes: 'id, title, category, updatedAt, createdAt, favorite, toTry, lastCookedAt, isDemo, rating, cookCount, sourcePostId, *tags',
      })
      .upgrade(async (tx) => {
        await tx
          .table('recipes')
          .toCollection()
          .modify((r: Partial<Recipe>) => {
            r.sourcePostId ??= null
          })
      })
  }
}

export const db = new CarnetDB()

/** Estimation de l'espace utilisé / disponible (si le navigateur le permet). */
export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  if (!navigator.storage?.estimate) return null
  const { usage = 0, quota = 0 } = await navigator.storage.estimate()
  const persisted = (await navigator.storage.persisted?.()) ?? false
  return { usage, quota, persisted }
}

/** Demande au navigateur de ne pas effacer les données en cas de manque d'espace. */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
