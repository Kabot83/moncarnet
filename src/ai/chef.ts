/**
 * Fonctions du Chef IA. Chaque fonction correspond à UNE action volontaire de
 * l'utilisateur et à UN appel à Gemini au maximum. Aucune génération en
 * arrière-plan.
 */
import type { Content } from '@google/genai'
import { type AiRecipe, type ChatMessage, type CulinaryProfile, type Ingredient, PROFILE_FIELDS, type Recipe } from '@/models/types'
import { blobToBase64, compressImage } from '@/services/photos'
import { getProfile } from '@/services/settings'
import { type CatalogContext } from './catalog'
import { generate, parseJson } from './client'
import { aiRecipeToContext, recipeToContext } from './convert'
import { AiError, aiMessage } from './errors'
import {
  CHAT_JSON_SCHEMA,
  ChatResponseSchema,
  IMPORT_JSON_SCHEMA,
  ImportResponseSchema,
  NUTRITION_JSON_SCHEMA,
  NutritionEstimateSchema,
  SUBSTITUTION_JSON_SCHEMA,
  type Substitution,
  SubstitutionSchema,
  validateRecipes,
} from './schemas'

const BASE_RULES = `Tu es « Mon Chef », un assistant culinaire bienveillant et précis, qui répond toujours en français.
Règles :
- Recettes réalistes, testables dans une cuisine familiale, avec des quantités en unités métriques (g, ml, cl, l, c. à soupe, c. à café, pincée ou pièces).
- Températures en °C et durées en minutes. Signale toute consigne de sécurité alimentaire importante (cuisson de la volaille, du porc, des œufs pour les personnes fragiles).
- Ne prétends jamais garantir l'absence d'un allergène : rappelle de vérifier les étiquettes si l'utilisateur a des allergies.
- Les informations nutritionnelles sont toujours des estimations.
- Sois concis : pas de longs préambules.`

function profileText(p: CulinaryProfile): string {
  const lines = PROFILE_FIELDS.filter((f) => p[f.id]?.trim()).map((f) => `- ${f.label} : ${p[f.id].trim().slice(0, 300)}`)
  return lines.length ? `\nProfil culinaire de l'utilisateur (à respecter quand c'est pertinent) :\n${lines.join('\n')}` : ''
}

async function systemPrompt(extra = ''): Promise<string> {
  return `${BASE_RULES}${profileText(await getProfile())}${extra ? `\n${extra}` : ''}`
}

function catalogText(ctx: CatalogContext | null): string {
  if (!ctx || (!ctx.detailed.length && !ctx.summaries.length)) return ''
  const parts: string[] = []
  if (ctx.detailed.length) parts.push(`Recette(s) de mon carnet concernée(s) :\n${ctx.detailed.map((r) => recipeToContext(r, 'full')).join('\n\n')}`)
  if (ctx.summaries.length) parts.push(`Extrait de mon carnet :\n${ctx.summaries.map((r) => recipeToContext(r, 'summary')).join('\n')}`)
  return `\n\n---\n${parts.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// Conversation (fonctions A, C, D, E, F)
// ---------------------------------------------------------------------------

export interface ChatResult {
  reply: string
  recipes: AiRecipe[]
  saveRequested: boolean
  rejected: number
}

/** Historique compact : 10 derniers messages, recettes résumées (sauf la dernière). */
function historyToContents(history: ChatMessage[]): Content[] {
  const recent = history.filter((m) => !m.error).slice(-10)
  const lastWithRecipes = [...recent].reverse().find((m) => m.role === 'model' && m.recipes?.length)
  return recent.map((m) => {
    let text = m.text
    if (m.recipes?.length) {
      const detail =
        m === lastWithRecipes
          ? m.recipes.map((r) => recipeToContext(aiAsRecipeLike(r), 'full')).join('\n\n')
          : m.recipes.map(aiRecipeToContext).join('\n')
      text = `${text}\n${detail}`
    }
    return { role: m.role, parts: [{ text: text.slice(0, 6000) }] }
  })
}

/** Adaptateur minimal pour réutiliser recipeToContext sur une proposition IA. */
function aiAsRecipeLike(r: AiRecipe): Recipe {
  return {
    title: r.title,
    servings: r.servings ?? null,
    prepTime: r.prepTime ?? null,
    cookTime: r.cookTime ?? null,
    ingredients: r.ingredients.map((i) => ({ name: i.name, quantity: i.quantity ?? null, unit: i.unit ?? '', note: i.note ?? '', group: i.group ?? '', quantityText: '', toTaste: false })),
    steps: r.steps.map((s) => ({ text: s.text })),
    notes: { tips: '', modifications: '', mistakes: '' },
  } as unknown as Recipe
}

export interface ChatOptions {
  signal?: AbortSignal
  /** Modèle choisi explicitement par l'utilisateur (repli). */
  model?: string
  /** Recette du carnet sur laquelle porte toute la conversation (amélioration). */
  pinnedRecipe?: Recipe | null
}

/**
 * Fonctions A à F : un tour de conversation. Les recettes proposées sont
 * validées par Zod ; celles qui sont invalides sont écartées (et comptées).
 */
export async function chat(history: ChatMessage[], userText: string, catalog: CatalogContext | null, opts: ChatOptions = {}): Promise<ChatResult> {
  const contents: Content[] = [
    ...historyToContents(history),
    { role: 'user', parts: [{ text: `${userText.slice(0, 4000)}${catalogText(catalog)}` }] },
  ]
  const pinned = opts.pinnedRecipe
    ? `
La conversation porte sur cette recette de l'utilisateur. Propose des améliorations explicites et justifiées ; si tu proposes une nouvelle version, fournis-la complète dans "recipes" (elle sera enregistrée comme variante, jamais à la place de l'original).
${recipeToContext(opts.pinnedRecipe, 'full')}`
    : ''
  const system = await systemPrompt(`Tu dialogues librement. Quand tu proposes ou modifies une recette, fournis-la COMPLÈTE dans "recipes" (titre, description, temps, portions, ingrédients chiffrés, étapes, conseils) et garde "reply" court.
Si l'utilisateur adapte une recette précédente (ingrédient manquant, autre mode de cuisson…), renvoie la version complète modifiée.
Si l'utilisateur demande d'enregistrer, mets "saveRequested" à true et renvoie la recette concernée dans "recipes".
Pour une simple question, "recipes" est une liste vide.${pinned}`)
  const { text } = await generate({ contents, system, schema: CHAT_JSON_SCHEMA, signal: opts.signal, model: opts.model })
  const parsed = ChatResponseSchema.safeParse(parseJson(text))
  if (!parsed.success) throw new AiError('invalid-response', aiMessage('invalid-response'))
  const { recipes, rejected } = validateRecipes(parsed.data.recipes)
  return { reply: parsed.data.reply, recipes, saveRequested: parsed.data.saveRequested, rejected }
}

/** Fonction F : idées spontanées, sur demande explicite uniquement. */
export const SURPRISE_PROMPT =
  'Surprends-moi : propose 3 idées de plats de saison, variées, adaptées à mes goûts et à mon temps habituel. Évite les recettes trop banales.'

/** Fonction G : remplacement d'un ingrédient. */
export async function substituteIngredient(recipe: Recipe, ingredient: Ingredient, constraint = '', signal?: AbortSignal): Promise<Substitution> {
  const system = await systemPrompt('Tu es spécialiste des substitutions d’ingrédients. Sois concret sur les proportions.')
  const qty = ingredient.quantity != null ? `${ingredient.quantity} ${ingredient.unit}`.trim() : ingredient.quantityText || 'quantité non précisée'
  const { text } = await generate({
    contents: `Dans la recette « ${recipe.title} », par quoi puis-je remplacer : ${ingredient.name} (${qty}) ?${constraint ? ` Contrainte : ${constraint.slice(0, 300)}.` : ''}
Contexte (ingrédients) : ${recipe.ingredients.map((i) => i.name).join(', ').slice(0, 800)}.
Pour chaque alternative (3 à 5), indique la quantité de remplacement, et les conséquences sur le goût, la texture et la cuisson.`,
    system,
    schema: SUBSTITUTION_JSON_SCHEMA,
    temperature: 0.5,
    signal,
  })
  const parsed = SubstitutionSchema.safeParse(parseJson(text))
  if (!parsed.success) throw new AiError('invalid-response', aiMessage('invalid-response'))
  return parsed.data
}

// ---------------------------------------------------------------------------
// Imports (texte, photo)
// ---------------------------------------------------------------------------

export interface ImportResult {
  recipe: AiRecipe
  warnings: string[]
}

const IMPORT_SYSTEM = `Tu extrais des recettes de documents. Règles strictes :
- Retranscris fidèlement : n'invente ni ingrédient, ni quantité, ni étape absents du document.
- Si une quantité est illisible ou absente, mets quantity à null et signale-le dans "warnings".
- Sépare quantité, unité et nom de chaque ingrédient. Convertis les fractions en nombres décimaux (½ → 0.5).
- Durées en minutes, températures en °C (convertis les thermostats : th. 6 = 180 °C).
- Si le document ne contient pas de recette, réponds found = false.
- Réponds en français (traduis si le document est dans une autre langue).`

function importResult(text: string): ImportResult {
  const parsed = ImportResponseSchema.safeParse(parseJson(text))
  if (!parsed.success) throw new AiError('invalid-response', aiMessage('invalid-response'))
  if (!parsed.data.found || !parsed.data.recipe) throw new AiError('invalid-response', 'Aucune recette n’a été reconnue dans ce contenu.')
  const { recipes } = validateRecipes([parsed.data.recipe])
  if (!recipes.length) throw new AiError('invalid-response', 'La recette reconnue est incomplète (aucun ingrédient lisible).')
  return { recipe: recipes[0], warnings: parsed.data.warnings }
}

export async function importFromText(raw: string, signal?: AbortSignal): Promise<ImportResult> {
  const text = raw.trim()
  if (text.length < 20) throw new AiError('invalid-response', 'Le texte est trop court pour contenir une recette.')
  const { text: out } = await generate({
    contents: `Transforme ce texte en fiche recette structurée :\n\n"""\n${text.slice(0, 20000)}\n"""`,
    system: IMPORT_SYSTEM,
    schema: IMPORT_JSON_SCHEMA,
    temperature: 0.1,
    signal,
  })
  return importResult(out)
}

export async function importFromImage(image: Blob, signal?: AbortSignal): Promise<ImportResult> {
  // Image réduite à 1280 px : suffisant pour la lecture, et bien moins de tokens.
  const { blob } = await compressImage(image, 1280)
  const data = await blobToBase64(blob)
  const { text } = await generate({
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: blob.type || 'image/jpeg', data } },
          { text: 'Lis cette photo de recette imprimée ou manuscrite et transforme-la en fiche recette structurée.' },
        ],
      },
    ],
    system: IMPORT_SYSTEM,
    schema: IMPORT_JSON_SCHEMA,
    temperature: 0.1,
    signal,
  })
  return importResult(text)
}

// ---------------------------------------------------------------------------
// Nutrition (estimation explicite)
// ---------------------------------------------------------------------------

export async function estimateNutrition(recipe: Recipe, signal?: AbortSignal) {
  const { text } = await generate({
    contents: `Estime les valeurs nutritionnelles TOTALES (recette entière, pas par portion) de cette recette, à partir de valeurs moyennes de type tables CIQUAL :\n\n${recipeToContext(recipe, 'full')}`,
    system: 'Tu es diététicien. Tu donnes des estimations raisonnables, en kcal et en grammes, pour la recette entière.',
    schema: NUTRITION_JSON_SCHEMA,
    temperature: 0.1,
    signal,
  })
  const parsed = NutritionEstimateSchema.safeParse(parseJson(text))
  if (!parsed.success) throw new AiError('invalid-response', aiMessage('invalid-response'))
  return parsed.data
}

/** Questions proposées depuis une fiche recette (fonction B). */
export const IMPROVE_PROMPTS = [
  'Comment améliorer ma recette ?',
  'Comment réduire les matières grasses ?',
  'Comment augmenter les protéines ?',
  'Comment la préparer entièrement au four ?',
  'Comment la rendre plus adaptée aux enfants ?',
  'Comment la rendre plus rapide ?',
]
