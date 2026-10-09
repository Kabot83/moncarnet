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
  Conversation,
  CookingSession,
  Draft,
  JournalEntry,
  Photo,
  Recipe,
  ShoppingItem,
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

export const DB_NAME = 'mon-carnet'
export const DB_VERSION = 2

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
