/**
 * Conversion entre les recettes de l'IA et les fiches du carnet, et
 * préparation de contextes compacts (pour limiter les tokens envoyés).
 */
import { type AiRecipe, type CategoryId, type Recipe, categoryIds } from '@/models/types'
import { formatDuration } from '@/lib/format'
import { normalize } from '@/lib/text'
import { normalizeUnit } from '@/lib/units'
import { emptyIngredient, emptyRecipe, emptyStep } from '@/services/recipes'

const CATEGORY_GUESS: Array<[RegExp, CategoryId]> = [
  [/entree|starter|appetizer|salade/, 'entree'],
  [/dessert|gateau|cake|tarte sucree|patisserie/, 'dessert'],
  [/petit.?dejeuner|breakfast|brunch/, 'petit-dejeuner'],
  [/collation|snack|gouter|en.?cas/, 'collation'],
  [/plat|main|diner|dejeuner|dinner|lunch/, 'plat'],
]

export function guessCategory(raw: string | null | undefined): CategoryId {
  if (!raw) return 'plat'
  if ((categoryIds as string[]).includes(raw)) return raw as CategoryId
  const n = normalize(raw)
  return CATEGORY_GUESS.find(([re]) => re.test(n))?.[1] ?? 'plat'
}

export interface ConvertedRecipe {
  recipe: Recipe
  /** Points à vérifier par l'utilisateur avant enregistrement. */
  warnings: string[]
}

/** Transforme une proposition validée en fiche éditable (jamais enregistrée directement). */
export function aiRecipeToRecipe(ai: AiRecipe, extra: Partial<Recipe> = {}): ConvertedRecipe {
  const warnings: string[] = []
  const ingredients = ai.ingredients.map((i) => {
    const unitDef = normalizeUnit(i.unit ?? '')
    if (i.unit && unitDef.kind === 'other') warnings.push(`Unité inhabituelle pour « ${i.name} » : « ${i.unit} ».`)
    return emptyIngredient({
      name: i.name.trim(),
      quantity: i.quantity ?? null,
      unit: i.unit ? unitDef.canonical || i.unit : '',
      note: i.note ?? '',
      group: i.group ?? '',
      toTaste: i.quantity == null && /go[uû]t|besoin|facultatif/i.test(`${i.note ?? ''} ${i.name}`),
    })
  })
  const missingQty = ingredients.filter((i) => i.quantity == null && !i.toTaste).length
  if (missingQty) warnings.push(`${missingQty} ingrédient(s) sans quantité chiffrée.`)

  const steps = ai.steps.map((s) => {
    if (s.temperatureC != null && (s.temperatureC > 300 || (s.temperatureC > 0 && s.temperatureC < 50 && /four/i.test(s.text))))
      warnings.push(`Température à vérifier : ${s.temperatureC} °C.`)
    return emptyStep({
      text: s.text.trim(),
      durationMin: s.durationMin ?? null,
      temperatureC: s.temperatureC ?? null,
      timerMin: s.durationMin && s.durationMin >= 1 && s.durationMin <= 600 ? s.durationMin : null,
    })
  })
  if ((ai.cookTime ?? 0) > 24 * 60) warnings.push('Temps de cuisson très long : à vérifier.')
  if (!steps.length) warnings.push('Aucune étape détectée.')

  const recipe = emptyRecipe({
    title: ai.title.trim().slice(0, 200) || 'Recette sans titre',
    description: ai.description ?? '',
    category: guessCategory(ai.category),
    prepTime: ai.prepTime ?? null,
    cookTime: ai.cookTime ?? null,
    restTime: ai.restTime ?? null,
    servings: ai.servings ?? null,
    difficulty: (ai.difficulty as 1 | 2 | 3 | null) ?? 1,
    tags: (ai.tags ?? []).slice(0, 8),
    ingredients,
    steps,
    notes: { tips: ai.tips ?? '', modifications: '', mistakes: '', ideas: '', storage: '', reheating: '' },
    ...extra,
  })
  return { recipe, warnings: [...new Set(warnings)] }
}

/** Fiche → texte compact pour le contexte de Gemini (pas de photo, pas d'identifiant). */
export function recipeToContext(r: Recipe, detail: 'full' | 'summary' = 'full'): string {
  const times = [
    r.prepTime ? `prép. ${formatDuration(r.prepTime)}` : '',
    r.cookTime ? `cuisson ${formatDuration(r.cookTime)}` : '',
  ]
    .filter(Boolean)
    .join(', ')
  if (detail === 'summary') {
    const main = r.ingredients
      .filter((i) => i.scalable && i.quantity)
      .slice(0, 6)
      .map((i) => i.name)
      .join(', ')
    return `- « ${r.title} » (${r.category}${times ? `, ${times}` : ''}${r.rating ? `, note ${r.rating}/5` : ''}) : ${main}`
  }
  const ings = r.ingredients
    .map((i) => {
      const q = i.quantity != null ? `${i.quantity}${i.unit ? ` ${i.unit}` : ''} ` : i.toTaste ? '(selon le goût) ' : i.quantityText ? `${i.quantityText} ` : ''
      return `- ${q}${i.name}${i.note ? ` (${i.note})` : ''}${i.group ? ` [${i.group}]` : ''}`
    })
    .join('\n')
  const steps = r.steps.map((s, k) => `${k + 1}. ${s.text}`).join('\n')
  const notes = [r.notes.tips, r.notes.modifications, r.notes.mistakes].filter(Boolean).join(' / ')
  return `RECETTE « ${r.title} » — ${r.servings ?? '?'} portions${times ? `, ${times}` : ''}
Ingrédients :
${ings}
Étapes :
${steps}${notes ? `\nNotes de l'utilisateur : ${notes.slice(0, 600)}` : ''}`
}

/** Recette IA → texte court, pour rappeler dans l'historique de conversation. */
export function aiRecipeToContext(r: AiRecipe): string {
  const ings = r.ingredients.map((i) => `${i.quantity ?? ''} ${i.unit ?? ''} ${i.name}`.trim()).join(', ')
  return `[Recette proposée : « ${r.title} » — ${r.servings ?? '?'} portions ; ingrédients : ${ings} ; ${r.steps.length} étapes]`
}
