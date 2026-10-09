/**
 * Schémas des réponses structurées demandées à Gemini (JSON Schema envoyé
 * via `responseJsonSchema`) et leurs équivalents Zod pour la validation.
 * Une réponse n'est jamais utilisée sans être passée par Zod.
 */
import { z } from 'zod'
import { AiRecipeSchema } from '@/models/types'

const num = { type: ['number', 'null'] }
const str = { type: 'string' }

export const RECIPE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: str,
    description: str,
    category: { type: 'string', enum: ['entree', 'plat', 'dessert', 'petit-dejeuner', 'collation', 'autre'] },
    prepTime: { ...num, description: 'minutes' },
    cookTime: { ...num, description: 'minutes' },
    restTime: { ...num, description: 'minutes' },
    servings: num,
    difficulty: { type: 'integer', minimum: 1, maximum: 3 },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'nom seul, sans quantité' },
          quantity: { ...num, description: 'nombre décimal, null si non chiffré' },
          unit: { type: 'string', description: 'g, kg, ml, cl, l, c. à soupe, c. à café, pincée, ou vide pour une pièce' },
          note: str,
          group: { type: 'string', description: 'sous-préparation éventuelle (Pâte, Sauce…), sinon vide' },
        },
        required: ['name', 'quantity', 'unit'],
      },
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: str,
          durationMin: num,
          temperatureC: num,
        },
        required: ['text'],
      },
    },
    tips: str,
    tags: { type: 'array', items: str },
  },
  required: ['title', 'ingredients', 'steps'],
} as const

export const CHAT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Réponse conversationnelle en français, concise.' },
    recipes: { type: 'array', items: RECIPE_JSON_SCHEMA, description: 'Recettes complètes proposées, 0 à 3.' },
    saveRequested: {
      type: 'boolean',
      description: "true si l'utilisateur demande explicitement d'enregistrer la dernière recette proposée",
    },
  },
  required: ['reply', 'recipes', 'saveRequested'],
} as const

export const ChatResponseSchema = z.object({
  reply: z.string().max(8000),
  recipes: z.array(z.unknown()).max(5).default([]),
  saveRequested: z.boolean().default(false),
})

export const IMPORT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'false si aucun contenu de recette exploitable' },
    recipe: RECIPE_JSON_SCHEMA,
    warnings: { type: 'array', items: str, description: 'passages illisibles ou incertains' },
  },
  required: ['found'],
} as const

export const ImportResponseSchema = z.object({
  found: z.boolean(),
  recipe: z.unknown().optional(),
  warnings: z.array(z.string().max(500)).max(20).default([]),
})

export const SUBSTITUTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: str,
          amount: { type: 'string', description: 'quantité de remplacement pour la quantité indiquée' },
          taste: str,
          texture: str,
          cooking: { type: 'string', description: 'effet sur la cuisson' },
          notes: str,
        },
        required: ['name', 'amount', 'taste', 'texture', 'cooking'],
      },
    },
    warning: str,
  },
  required: ['alternatives'],
} as const

export const SubstitutionSchema = z.object({
  alternatives: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        amount: z.string().max(200),
        taste: z.string().max(600),
        texture: z.string().max(600),
        cooking: z.string().max(600),
        notes: z.string().max(600).nullable().optional(),
      }),
    )
    .min(1)
    .max(6),
  warning: z.string().max(600).nullable().optional(),
})
export type Substitution = z.infer<typeof SubstitutionSchema>

export const NUTRITION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    kcal: { type: 'number' },
    protein: { type: 'number' },
    carbs: { type: 'number' },
    fat: { type: 'number' },
    fiber: { type: 'number' },
    comment: str,
  },
  required: ['kcal', 'protein', 'carbs', 'fat', 'fiber'],
} as const

export const NutritionEstimateSchema = z.object({
  kcal: z.number().min(0).max(50000),
  protein: z.number().min(0).max(5000),
  carbs: z.number().min(0).max(5000),
  fat: z.number().min(0).max(5000),
  fiber: z.number().min(0).max(1000),
  comment: z.string().max(1000).nullable().optional(),
})

/** Valide une liste de recettes IA ; les recettes invalides sont écartées et comptées. */
export function validateRecipes(items: unknown[]) {
  const ok = []
  let rejected = 0
  for (const it of items) {
    const r = AiRecipeSchema.safeParse(normalizeAiRecipe(it))
    if (r.success && r.data.ingredients.length > 0) ok.push(r.data)
    else rejected++
  }
  return { recipes: ok, rejected }
}

/** Corrige les écarts fréquents avant validation (chaînes numériques, champs vides). */
function normalizeAiRecipe(it: unknown): unknown {
  if (!it || typeof it !== 'object') return it
  const r = { ...(it as Record<string, unknown>) }
  const toNum = (v: unknown) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(',', '.'))
      return Number.isFinite(n) ? n : null
    }
    return null
  }
  for (const k of ['prepTime', 'cookTime', 'restTime', 'servings', 'difficulty']) if (k in r) r[k] = toNum(r[k])
  if (typeof r.difficulty === 'number') r.difficulty = Math.min(3, Math.max(1, Math.round(r.difficulty)))
  if (Array.isArray(r.ingredients))
    r.ingredients = r.ingredients
      .filter((i) => i && typeof i === 'object' && String((i as { name?: unknown }).name ?? '').trim())
      .map((i) => {
        const x = { ...(i as Record<string, unknown>) }
        x.quantity = toNum(x.quantity)
        if (typeof x.quantity === 'number' && (x.quantity < 0 || x.quantity > 100000)) x.quantity = null
        return x
      })
  if (Array.isArray(r.steps))
    r.steps = r.steps
      .map((s) => (typeof s === 'string' ? { text: s } : s))
      .filter((s) => s && typeof s === 'object' && String((s as { text?: unknown }).text ?? '').trim())
      .map((s) => {
        const x = { ...(s as Record<string, unknown>) }
        x.durationMin = toNum(x.durationMin)
        x.temperatureC = toNum(x.temperatureC)
        if (typeof x.temperatureC === 'number' && (x.temperatureC < -40 || x.temperatureC > 400)) x.temperatureC = null
        return x
      })
  return r
}
