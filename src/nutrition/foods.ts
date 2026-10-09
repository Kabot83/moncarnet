/**
 * Aliments utilisés : favoris, récents, produits Open Food Facts mis en cache,
 * aliments personnels, et mémoire des associations (« farine d'avoine » → aliment).
 * Tout est stocké localement (IndexedDB) et inclus dans les sauvegardes ZIP.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { type FoodEntry, type FoodMemory, db } from '@/db/db'
import { newId } from '@/lib/id'
import { normalize } from '@/lib/text'
import { type Food, type FoodLink, FoodLinkSchema, type Ingredient, type Per100, type Recipe } from '@/models/types'
import { rawOriginalGrams } from './engine'

export const foodKey = (f: Pick<Food, 'source' | 'id'>) => `${f.source}:${f.id}`

/** Clé de mémoire : nom d'ingrédient sans accents, sans quantité, au singulier approximatif. */
export function nameKey(name: string): string {
  return normalize(name)
    .replace(/\(.*?\)/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 ? w.replace(/(s|x)$/, '') : w))
    .join(' ')
}

/** Enregistre l'usage d'un aliment (récents) et l'association pour ce nom d'ingrédient. */
export async function rememberFood(food: Food, ingredientName: string, link: Pick<FoodLink, 'gramsPerUnit' | 'density'>) {
  const key = foodKey(food)
  const now = Date.now()
  await db.transaction('rw', db.foods, db.foodMemory, async () => {
    const existing = await db.foods.get(key)
    await db.foods.put({
      key,
      food,
      favorite: existing?.favorite ?? false,
      lastUsedAt: now,
      useCount: (existing?.useCount ?? 0) + 1,
      updatedAt: now,
    })
    const nk = nameKey(ingredientName)
    if (nk) await db.foodMemory.put({ nameKey: nk, foodKey: key, gramsPerUnit: link.gramsPerUnit, density: link.density, updatedAt: now })
  })
}

export async function toggleFoodFavorite(food: Food) {
  const key = foodKey(food)
  const existing = await db.foods.get(key)
  const now = Date.now()
  await db.foods.put({ key, food, favorite: !existing?.favorite, lastUsedAt: existing?.lastUsedAt ?? 0, useCount: existing?.useCount ?? 0, updatedAt: now })
}

/** Suggestions sans recherche : association déjà faite pour ce nom, favoris, récents. */
export function useFoodSuggestions(ingredientName: string) {
  return useLiveQuery(
    async () => {
      const memory = await db.foodMemory.get(nameKey(ingredientName))
      const remembered = memory ? await db.foods.get(memory.foodKey) : undefined
      // (les booléens ne sont pas indexables dans IndexedDB : simple filtre, la table reste petite)
      const favs = await db.foods.filter((f) => f.favorite).toArray()
      const recents = await db.foods.orderBy('lastUsedAt').reverse().filter((f) => f.lastUsedAt > 0).limit(12).toArray()
      return { remembered: remembered ? { entry: remembered, memory: memory as FoodMemory } : null, favorites: favs, recents }
    },
    [ingredientName],
    { remembered: null, favorites: [] as FoodEntry[], recents: [] as FoodEntry[] },
  )
}

export function useFoodEntry(food: Food | null | undefined) {
  return useLiveQuery(async () => (food ? ((await db.foods.get(foodKey(food))) ?? null) : null), [food ? foodKey(food) : ''], null)
}

/** Aliment personnel (étiquette d'un produit, recette maison…). */
export function customFood(name: string, per100: Per100, basis: Food['basis']): Food {
  return { source: 'custom', id: newId('f_'), name: name.trim(), brand: '', basis, per100, version: 'Saisie personnelle', notes: [], fetchedAt: Date.now() }
}

/** Associe (ou retire) une référence nutritionnelle à un ingrédient de recette. */
export async function setIngredientNutrition(recipeId: string, ingredientId: string, patch: Partial<Pick<Ingredient, 'nutrition' | 'nutritionExcluded'>>) {
  const recipe = await db.recipes.get(recipeId)
  if (!recipe) return
  const ingredients = recipe.ingredients.map((i) => {
    if (i.id !== ingredientId) return i
    const next = { ...i, ...patch }
    if (next.nutrition) next.nutrition = FoodLinkSchema.parse(next.nutrition)
    return next
  })
  await db.recipes.update(recipeId, { ingredients, updatedAt: Date.now() })
}

/** Enregistre le poids après cuisson, avec le poids des ingrédients au moment de la pesée. */
export async function setCookedWeight(recipe: Recipe, grams: number | null) {
  await db.recipes.update(recipe.id, {
    cookedWeightG: grams && grams > 0 ? grams : null,
    cookedWeightRawG: grams && grams > 0 ? rawOriginalGrams(recipe.ingredients) || null : null,
    updatedAt: Date.now(),
  })
}
