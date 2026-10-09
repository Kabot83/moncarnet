/**
 * Opérations sur les recettes, le journal et les collections.
 * Toute écriture passe par une validation Zod.
 */
import { db } from '@/db/db'
import { newId } from '@/lib/id'
import { applyScale, scaledServings, suggestNonScalable } from '@/lib/scaling'
import {
  type Collection,
  CollectionSchema,
  type Ingredient,
  type JournalEntry,
  JournalEntrySchema,
  type NutritionValues,
  type Recipe,
  RecipeSchema,
  type ScaleState,
  type Step,
} from '@/models/types'
import { collectOrphanPhotos } from './photos'

export function emptyIngredient(partial: Partial<Ingredient> = {}): Ingredient {
  const name = partial.name ?? ''
  return {
    id: newId('i_'),
    name,
    quantity: null,
    unit: '',
    quantityText: '',
    note: '',
    group: '',
    scalable: !suggestNonScalable(name),
    toTaste: false,
    ...partial,
  }
}

export function emptyStep(partial: Partial<Step> = {}): Step {
  return { id: newId('s_'), text: '', durationMin: null, temperatureC: null, photoId: null, timerMin: null, ...partial }
}

/** Fiche vierge (le titre peut être vide : il est exigé seulement à l'enregistrement). */
export function emptyRecipe(partial: Partial<Recipe> = {}): Recipe {
  const now = Date.now()
  const r = RecipeSchema.parse({
    id: newId('r_'),
    createdAt: now,
    updatedAt: now,
    ...partial,
    title: partial.title?.trim() ? partial.title : 'Nouvelle recette',
  })
  return { ...r, title: partial.title ?? r.title }
}

export class ValidationError extends Error {
  constructor(public issues: string[]) {
    super(issues.join('\n'))
  }
}

/** Valide puis enregistre une recette (création ou mise à jour). */
export async function saveRecipe(recipe: Recipe, { touch = true } = {}): Promise<Recipe> {
  const cleaned: Recipe = {
    ...recipe,
    title: recipe.title.trim(),
    tags: [...new Set(recipe.tags.map((t) => t.trim()).filter(Boolean))],
    ingredients: recipe.ingredients.filter((i) => i.name.trim() || i.quantity != null),
    steps: recipe.steps.filter((s) => s.text.trim() || s.photoId),
    updatedAt: touch ? Date.now() : recipe.updatedAt,
  }
  const parsed = RecipeSchema.safeParse(cleaned)
  if (!parsed.success) {
    throw new ValidationError(
      parsed.error.issues.map((i) => (i.path[0] === 'title' ? 'Le nom de la recette est obligatoire.' : `${i.path.join('.')} : ${i.message}`)),
    )
  }
  await db.recipes.put(parsed.data)
  return parsed.data
}

export async function patchRecipe(id: string, patch: Partial<Recipe>, touch = true) {
  await db.recipes.update(id, { ...patch, ...(touch ? { updatedAt: Date.now() } : {}) })
}

export const toggleFavorite = (r: Recipe) => patchRecipe(r.id, { favorite: !r.favorite }, false)
export const toggleToTry = (r: Recipe) => patchRecipe(r.id, { toTry: !r.toTry }, false)

/** Supprime une recette et tout ce qui en dépend (journal, préparation, minuteries, collections, photos). */
export async function deleteRecipe(id: string) {
  await db.transaction('rw', [db.recipes, db.journal, db.sessions, db.timers, db.collections, db.drafts], async () => {
    await db.recipes.delete(id)
    await db.journal.where('recipeId').equals(id).delete()
    await db.sessions.delete(id)
    await db.timers.where('recipeId').equals(id).delete()
    await db.drafts.delete(`edit:${id}`)
    await db.collections
      .where('recipeIds')
      .equals(id)
      .modify((c: Collection) => {
        c.recipeIds = c.recipeIds.filter((x) => x !== id)
      })
  })
  await collectOrphanPhotos()
}

/** Copie profonde avec de nouveaux identifiants d'ingrédients et d'étapes. */
function cloneContent(r: Recipe): Pick<Recipe, 'ingredients' | 'steps'> {
  return {
    ingredients: r.ingredients.map((i) => ({ ...i, id: newId('i_') })),
    steps: r.steps.map((s) => ({ ...s, id: newId('s_') })),
  }
}

/** Nouvelle recette construite avec les proportions ajustées. L'original n'est pas touché. */
export function buildVariant(recipe: Recipe, scale: ScaleState, title?: string): Recipe {
  const now = Date.now()
  const servings = scaledServings(scale, recipe.servings)
  const scaled = { ...recipe, ingredients: applyScale(recipe.ingredients, scale) }
  return {
    ...recipe,
    ...cloneContent(scaled),
    id: newId('r_'),
    title: title ?? `${recipe.title} (variante)`,
    servings: servings == null ? null : Math.round(servings * 100) / 100,
    createdAt: now,
    updatedAt: now,
    favorite: false,
    rating: 0,
    cookCount: 0,
    lastCookedAt: null,
    variantOf: recipe.id,
    isDemo: false,
    nutrition: recipe.nutrition
      ? {
          ...recipe.nutrition,
          total: Object.fromEntries(
            Object.entries(recipe.nutrition.total).map(([k, v]) => [k, v == null ? null : Math.round(v * scale.global * 10) / 10]),
          ) as NutritionValues,
        }
      : null,
  }
}

export async function saveVariant(recipe: Recipe, scale: ScaleState, title?: string): Promise<Recipe> {
  const v = buildVariant(recipe, scale, title)
  await saveRecipe(v, { touch: false })
  return v
}

/** Remplace les quantités de l'original par les quantités ajustées (action confirmée). */
export async function replaceOriginalQuantities(recipe: Recipe, scale: ScaleState): Promise<void> {
  const servings = scaledServings(scale, recipe.servings)
  await saveRecipe({
    ...recipe,
    ingredients: applyScale(recipe.ingredients, scale),
    servings: servings == null ? null : Math.round(servings * 100) / 100,
    nutrition: buildVariant(recipe, scale).nutrition,
  })
}

/** Duplique une recette (sans ajustement). */
export async function duplicateRecipe(recipe: Recipe): Promise<Recipe> {
  const now = Date.now()
  const copy: Recipe = {
    ...recipe,
    ...cloneContent(recipe),
    id: newId('r_'),
    title: `${recipe.title} (copie)`,
    createdAt: now,
    updatedAt: now,
    cookCount: 0,
    lastCookedAt: null,
    isDemo: false,
  }
  await saveRecipe(copy, { touch: false })
  return copy
}

// ---------------------------------------------------------------------------
// Journal de cuisine
// ---------------------------------------------------------------------------

/** Recalcule « Cuisinée X fois » et la date de dernière réalisation. */
export async function refreshCookStats(recipeId: string) {
  const entries = await db.journal.where('recipeId').equals(recipeId).toArray()
  const last = entries.reduce<number | null>((m, e) => (m == null || e.date > m ? e.date : m), null)
  await db.recipes.update(recipeId, { cookCount: entries.length, lastCookedAt: last })
}

export async function saveJournalEntry(entry: Omit<JournalEntry, 'id'> & { id?: string }): Promise<JournalEntry> {
  const parsed = JournalEntrySchema.parse({ ...entry, id: entry.id ?? newId('j_') })
  await db.journal.put(parsed)
  await refreshCookStats(parsed.recipeId)
  return parsed
}

export async function deleteJournalEntry(entry: JournalEntry) {
  await db.journal.delete(entry.id)
  await refreshCookStats(entry.recipeId)
  await collectOrphanPhotos()
}

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

export async function saveCollection(c: Partial<Collection> & { name: string }): Promise<Collection> {
  const now = Date.now()
  const existing = c.id ? await db.collections.get(c.id) : undefined
  const order = existing?.order ?? (await db.collections.count())
  const parsed = CollectionSchema.parse({
    recipeIds: [],
    createdAt: now,
    ...existing,
    ...c,
    id: c.id ?? newId('c_'),
    order: c.order ?? order,
    updatedAt: now,
    name: c.name.trim(),
  })
  await db.collections.put(parsed)
  return parsed
}

export async function deleteCollection(id: string) {
  await db.collections.delete(id)
  await collectOrphanPhotos()
}

export async function setRecipeInCollection(collectionId: string, recipeId: string, inside: boolean) {
  await db.collections.where('id').equals(collectionId).modify((c: Collection) => {
    const has = c.recipeIds.includes(recipeId)
    if (inside && !has) c.recipeIds.push(recipeId)
    if (!inside && has) c.recipeIds = c.recipeIds.filter((x) => x !== recipeId)
    c.updatedAt = Date.now()
  })
}

export async function reorderCollectionRecipes(collectionId: string, recipeIds: string[]) {
  await db.collections.update(collectionId, { recipeIds, updatedAt: Date.now() })
}

export async function reorderCollections(ids: string[]) {
  await db.transaction('rw', db.collections, async () => {
    await Promise.all(ids.map((id, order) => db.collections.update(id, { order })))
  })
}

// ---------------------------------------------------------------------------
// Données de démonstration
// ---------------------------------------------------------------------------

export async function countDemo(): Promise<number> {
  return db.recipes.filter((r) => r.isDemo).count()
}

export async function deleteDemoData() {
  const ids = await db.recipes.filter((r) => r.isDemo).primaryKeys()
  for (const id of ids) await deleteRecipe(id)
  await db.collections.filter((c) => c.isDemo).delete()
  await db.journal.filter((j) => j.isDemo).delete()
  await collectOrphanPhotos()
}
