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
    nutrition: null,
    nutritionExcluded: false,
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

/** Clé (réglages) de l'espace des nouvelles recettes quand la synchronisation familiale est active. */
export const NEW_RECIPE_SPACE_KEY = 'syncNewRecipeSpace'

/**
 * Nouvelle recette (création, copie, variante) : synchronisation familiale active → catalogue
 * familial par défaut, sauf choix « Garder privée ». Une restauration de sauvegarde ne passe pas
 * par ici : elle ne partage jamais rien d'office.
 */
async function forNewRecipe(recipe: Recipe): Promise<Recipe> {
  if (await db.recipes.get(recipe.id)) return recipe
  const { familyInfo: _info, receivedFrom: _from, ...rest } = recipe
  const def = (await db.settings.get(NEW_RECIPE_SPACE_KEY))?.value
  return { ...rest, space: recipe.space ?? (def === 'family' ? 'family' : undefined) }
}

type Obj = Record<string, unknown>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Champs tenus par l'application ou le serveur : jamais considérés comme un désaccord. */
const BOOKKEEPING = new Set(['updatedAt', 'familyInfo'])

/** Liste d'éléments à identifiant : les éléments touchés par l'utilisateur, le reste tel qu'à présent. */
function rebaseList(base: Obj[], edited: Obj[], current: Obj[], path: string, clashes: string[], preferCurrent: boolean): Obj[] {
  const b = new Map(base.map((x) => [x.id, x]))
  const c = new Map(current.map((x) => [x.id, x]))
  const out: Obj[] = []
  for (const e of edited) {
    const bx = b.get(e.id)
    const cx = c.get(e.id)
    if (bx && same(e, bx)) {
      if (cx) out.push(cx) // inchangé ici : version actuelle
      continue // inchangé ici et supprimé ailleurs entre-temps : reste supprimé
    }
    if (bx && cx && !same(cx, bx) && !same(cx, e)) {
      clashes.push(`${path}[${String(e.id)}]`) // modifié ici ET ailleurs
      out.push(preferCurrent ? cx : e)
      continue
    }
    if (bx && !cx) clashes.push(`${path}[${String(e.id)}]`) // modifié ici, supprimé ailleurs : gardé, signalé
    out.push(e)
  }
  const kept = new Set(edited.map((x) => x.id))
  for (const x of current) {
    if (kept.has(x.id)) continue
    const bx = b.get(x.id)
    if (!bx) out.push(x) // ajouté ailleurs entre-temps : conservé
    else if (!same(x, bx)) {
      clashes.push(`${path}[${String(x.id)}]`) // supprimé ici, modifié ailleurs : gardé, signalé
      out.push(x)
    }
  }
  return out
}

/**
 * Éditeur (ou brouillon) commencé sur une version `base`, alors que la recette a changé depuis
 * (synchronisation entre appareils) : seules les modifications faites dans l'éditeur sont
 * appliquées sur la version actuelle ; rien de ce qui a été reçu n'est écrasé. Un même élément
 * modifié des deux côtés est signalé dans `clashes` (jamais tranché en silence) : la version de
 * l'éditeur est retenue, ou celle reçue si `preferCurrent`.
 */
export function rebaseEditDetailed(base: Recipe, edited: Recipe, current: Recipe, preferCurrent = false): { recipe: Recipe; clashes: string[] } {
  const clashes: string[] = []
  const out: Obj = { ...current }
  const B = base as unknown as Obj
  const E = edited as unknown as Obj
  const C = current as unknown as Obj
  for (const k of new Set([...Object.keys(E), ...Object.keys(B)])) {
    if (BOOKKEEPING.has(k) || same(E[k], B[k])) continue
    if ((k === 'ingredients' || k === 'steps') && Array.isArray(E[k]) && Array.isArray(B[k]) && Array.isArray(C[k])) {
      out[k] = rebaseList(B[k] as Obj[], E[k] as Obj[], C[k] as Obj[], k, clashes, preferCurrent)
    } else if (k === 'notes' && E[k] && B[k] && C[k]) {
      const n: Obj = { ...(C[k] as Obj) }
      for (const sub of Object.keys(E[k] as Obj)) {
        const [e, b, c] = [(E[k] as Obj)[sub], (B[k] as Obj)[sub], (C[k] as Obj)[sub]]
        if (same(e, b)) continue
        if (!same(c, b) && !same(c, e)) {
          clashes.push(`notes.${sub}`)
          if (preferCurrent) continue
        }
        n[sub] = e
      }
      out[k] = n
    } else {
      if (!same(C[k], B[k]) && !same(C[k], E[k])) {
        clashes.push(k)
        if (preferCurrent) continue
      }
      out[k] = E[k]
    }
  }
  return { recipe: out as unknown as Recipe, clashes }
}

export const rebaseEdit = (base: Recipe, edited: Recipe, current: Recipe): Recipe => rebaseEditDetailed(base, edited, current).recipe

/** Libellé lisible d'un désaccord (« Description », « Ingrédient « crème » »…). */
export function clashLabel(path: string, r: Recipe): string {
  const m = /^(ingredients|steps)\[(.+)\]$/.exec(path)
  if (m) {
    if (m[1] === 'ingredients') return `Ingrédient « ${r.ingredients.find((i) => i.id === m[2])?.name ?? '?'} »`
    const n = r.steps.findIndex((x) => x.id === m[2])
    return n >= 0 ? `Étape ${n + 1}` : 'Une étape'
  }
  const L: Record<string, string> = {
    title: 'Titre', description: 'Description', servings: 'Nombre de parts', prepTime: 'Préparation', cookTime: 'Cuisson', restTime: 'Repos',
    category: 'Catégorie', difficulty: 'Difficulté', tags: 'Étiquettes', source: 'Source', sourceUrl: 'Lien', nutrition: 'Nutrition',
    'notes.tips': 'Astuces', mainPhotoId: 'Photo principale', galleryPhotoIds: 'Galerie', cookedWeightG: 'Poids après cuisson',
  }
  return L[path] ?? (path.startsWith('notes.') ? 'Mes notes' : path)
}

/** Valide puis enregistre une recette (création ou mise à jour). */
export async function saveRecipe(recipe: Recipe, { touch = true } = {}): Promise<Recipe> {
  recipe = await forNewRecipe(recipe)
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
  // Fiche issue d'une publication « À essayer » : la publication passe à « Transformée en recette ».
  const postId = parsed.data.sourcePostId
  if (postId) {
    const post = await db.posts.get(postId)
    // Une variante ou une copie garde la source, sans « reprendre » le lien de la fiche d'origine.
    if (post && (post.recipeId == null || post.recipeId === parsed.data.id) && (post.recipeId !== parsed.data.id || post.status !== 'converted'))
      await db.posts.update(postId, { recipeId: parsed.data.id, status: 'converted', updatedAt: Date.now() })
  }
  return parsed.data
}

export async function patchRecipe(id: string, patch: Partial<Recipe>, touch = true) {
  await db.recipes.update(id, { ...patch, ...(touch ? { updatedAt: Date.now() } : {}) })
}

export const toggleFavorite = (r: Recipe) => patchRecipe(r.id, { favorite: !r.favorite }, false)
export const toggleToTry = (r: Recipe) => patchRecipe(r.id, { toTry: !r.toTry }, false)

/** Supprime une recette et tout ce qui en dépend (journal, préparation, minuteries, collections, photos). */
export async function deleteRecipe(id: string) {
  await db.transaction('rw', [db.recipes, db.journal, db.sessions, db.timers, db.collections, db.drafts, db.posts], async () => {
    await db.recipes.delete(id)
    // Publication d'origine : conservée, redevient « à essayer ».
    await db.posts.where('recipeId').equals(id).modify({ recipeId: null, status: 'toTry', updatedAt: Date.now() })
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
    // Les quantités changent : le plat cuit devra être pesé à nouveau.
    cookedWeightG: null,
    cookedWeightRawG: null,
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
  return saveRecipe(buildVariant(recipe, scale, title), { touch: false })
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
  return saveRecipe(copy, { touch: false })
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
