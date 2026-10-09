import { db } from '@/db/db'
import { newId } from '@/lib/id'
import type { Draft, Recipe } from '@/models/types'

/** Crée un brouillon (import, proposition IA) et renvoie son identifiant. */
export async function createDraft(data: Recipe, origin: Draft['origin'], warnings: string[] = []): Promise<string> {
  const id = newId('d_')
  await db.drafts.put({ id, data, origin, warnings, updatedAt: Date.now() })
  return id
}

export const saveDraft = (d: Draft) => db.drafts.put({ ...d, updatedAt: Date.now() })
export const deleteDraft = (id: string) => db.drafts.delete(id)
