/**
 * Informations nutritionnelles (module facultatif).
 *
 * Architecture prévue pour brancher une source fiable :
 *   - CIQUAL (ANSES, licence ouverte Etalab) : import de la table en local ;
 *   - Open Food Facts (ODbL) : recherche de produits, avec attribution.
 * Les deux s'implémentent via l'interface `NutritionProvider` ci-dessous.
 *
 * Aujourd'hui, trois sources coexistent et sont toujours signalées :
 *   - `manual` : valeurs saisies par l'utilisateur ;
 *   - `database` : calcul à partir d'une table de référence (voir provider) ;
 *   - `ai-estimate` : estimation par Gemini, présentée comme ESTIMATIVE.
 * Toutes les valeurs suivent les quantités ajustées (coefficient global).
 */
import type { Ingredient, Nutrition, NutritionValues, ScaleState } from '@/models/types'
import { scaledQuantity } from './scaling'
import { normalize } from './text'
import { isEgg, normalizeUnit, toBaseUnit } from './units'

export const NUTRIENTS: Array<{ id: keyof NutritionValues; label: string; unit: string }> = [
  { id: 'kcal', label: 'Énergie', unit: 'kcal' },
  { id: 'protein', label: 'Protéines', unit: 'g' },
  { id: 'carbs', label: 'Glucides', unit: 'g' },
  { id: 'fat', label: 'Lipides', unit: 'g' },
  { id: 'fiber', label: 'Fibres', unit: 'g' },
]

export const SOURCE_LABELS: Record<Nutrition['source'], string> = {
  manual: 'Valeurs saisies',
  database: 'Calculé (table indicative)',
  'ai-estimate': 'Estimation IA — valeurs approximatives',
}

/** Valeurs pour 100 g (ou 100 ml). */
export interface Per100 {
  kcal: number
  protein: number
  carbs: number
  fat: number
  fiber: number
}

export interface NutritionProvider {
  id: string
  label: string
  /** Valeurs pour 100 g de l'aliment, ou `null` si inconnu. */
  lookup(name: string): Per100 | null
  /** Poids moyen d'une pièce (œuf, oignon…), pour les quantités sans unité. */
  pieceWeight?(name: string): number | null
}

/**
 * Table indicative de valeurs moyennes pour des aliments courants (ordres de
 * grandeur cohérents avec les tables publiques). Elle sert de démonstration de
 * l'architecture : pour des valeurs de référence, brancher CIQUAL.
 */
const BASIC: Array<[RegExp, Per100, number?]> = [
  [/\b(oeufs?|oeuf)\b/, { kcal: 140, protein: 12.5, carbs: 0.7, fat: 9.8, fiber: 0 }, 50],
  [/\bfarine\b/, { kcal: 345, protein: 10, carbs: 72, fat: 1.2, fiber: 3 }],
  [/\blait\b(?! de coco)/, { kcal: 46, protein: 3.3, carbs: 4.8, fat: 1.6, fiber: 0 }],
  [/\bbeurre\b/, { kcal: 745, protein: 0.7, carbs: 0.6, fat: 82, fiber: 0 }],
  [/\bsucre\b/, { kcal: 400, protein: 0, carbs: 100, fat: 0, fiber: 0 }],
  [/\bhuile\b/, { kcal: 900, protein: 0, carbs: 0, fat: 100, fiber: 0 }],
  [/\bchocolat\b/, { kcal: 570, protein: 8, carbs: 34, fat: 42, fiber: 11 }],
  [/\bcreme\b/, { kcal: 300, protein: 2.3, carbs: 3, fat: 30, fiber: 0 }],
  [/\bskyr|fromage blanc\b/, { kcal: 60, protein: 10, carbs: 4, fat: 0.2, fiber: 0 }],
  [/\bwhey|proteine en poudre\b/, { kcal: 380, protein: 75, carbs: 8, fat: 6, fiber: 0 }],
  [/\bavoine\b/, { kcal: 375, protein: 13, carbs: 60, fat: 7, fiber: 10 }],
  [/\bpoulet|dinde\b/, { kcal: 165, protein: 25, carbs: 0, fat: 7, fiber: 0 }],
  [/\bboeuf hache\b/, { kcal: 220, protein: 18, carbs: 0, fat: 16, fiber: 0 }],
  [/\b(boeuf|jarret)\b/, { kcal: 160, protein: 21, carbs: 0, fat: 8, fiber: 0 }],
  [/\bpommes? de terre\b/, { kcal: 80, protein: 2, carbs: 17, fat: 0.1, fiber: 2 }],
  [/\bcarottes?\b/, { kcal: 36, protein: 0.8, carbs: 7, fat: 0.3, fiber: 2.7 }, 100],
  [/\boignons?\b/, { kcal: 40, protein: 1.2, carbs: 8, fat: 0.2, fiber: 1.8 }, 100],
  [/\bcourgettes?\b/, { kcal: 17, protein: 1.2, carbs: 2, fat: 0.3, fiber: 1 }, 250],
  [/\btomates?\b/, { kcal: 18, protein: 0.9, carbs: 3, fat: 0.2, fiber: 1.2 }, 120],
  [/\bparmesan|cheddar|gruyere|comte|emmental\b/, { kcal: 400, protein: 30, carbs: 0.5, fat: 30, fiber: 0 }],
  [/\briz\b/, { kcal: 355, protein: 7, carbs: 78, fat: 0.6, fiber: 1.4 }],
  [/\bpates|spaghetti|penne\b/, { kcal: 355, protein: 12, carbs: 71, fat: 1.5, fiber: 3 }],
  [/\bpetits? pois\b/, { kcal: 80, protein: 5.4, carbs: 13, fat: 0.4, fiber: 5 }],
  [/\bbananes?\b/, { kcal: 90, protein: 1.1, carbs: 20, fat: 0.3, fiber: 2.6 }, 120],
  [/\bvin\b/, { kcal: 85, protein: 0.1, carbs: 2.6, fat: 0, fiber: 0 }],
]

export const basicProvider: NutritionProvider = {
  id: 'basic',
  label: 'Table indicative intégrée',
  lookup(name) {
    const n = ` ${normalize(name)} `
    return BASIC.find(([re]) => re.test(n))?.[1] ?? null
  },
  pieceWeight(name) {
    const n = ` ${normalize(name)} `
    return BASIC.find(([re]) => re.test(n))?.[2] ?? null
  },
}

/** Grammes d'un ingrédient (ml ≈ g, approximation signalée), sinon `null`. */
function gramsOf(ing: Ingredient, q: number, provider: NutritionProvider): number | null {
  const base = toBaseUnit(q, ing.unit)
  if (base) return base.value
  const d = normalizeUnit(ing.unit)
  if (d.canonical === 'c. à soupe') return q * 15
  if (d.canonical === 'c. à café') return q * 5
  if (d.kind === 'count' && !d.canonical) {
    const w = provider.pieceWeight?.(ing.name) ?? (isEgg(ing.name) ? 50 : null)
    return w ? q * w : null
  }
  return null
}

export interface ComputedNutrition {
  total: NutritionValues
  matched: string[]
  unmatched: string[]
}

/** Calcul à partir d'une table : renvoie aussi les ingrédients non reconnus. */
export function computeNutrition(ingredients: Ingredient[], provider: NutritionProvider = basicProvider): ComputedNutrition {
  const total = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 }
  const matched: string[] = []
  const unmatched: string[] = []
  for (const ing of ingredients) {
    if (ing.quantity == null) continue
    const per = provider.lookup(ing.name)
    const g = gramsOf(ing, ing.quantity, provider)
    if (!per || g == null) {
      unmatched.push(ing.name)
      continue
    }
    matched.push(ing.name)
    for (const k of Object.keys(total) as (keyof Per100)[]) total[k] += (per[k] * g) / 100
  }
  const round = (n: number) => Math.round(n * 10) / 10
  return {
    total: { kcal: Math.round(total.kcal), protein: round(total.protein), carbs: round(total.carbs), fat: round(total.fat), fiber: round(total.fiber) },
    matched,
    unmatched,
  }
}

/** Valeurs ajustées (recette entière) selon le coefficient global. */
export function scaledNutrition(n: NutritionValues, scale: ScaleState): NutritionValues {
  const f = scale.global
  const out = {} as NutritionValues
  for (const { id } of NUTRIENTS) out[id] = n[id] == null ? null : n[id]! * f
  return out
}

export function perServing(n: NutritionValues, servings: number | null): NutritionValues | null {
  if (!servings || servings <= 0) return null
  const out = {} as NutritionValues
  for (const { id } of NUTRIENTS) out[id] = n[id] == null ? null : n[id]! / servings
  return out
}

/** Recalcule précisément avec les quantités ajustées (source « database » uniquement). */
export function computeScaled(ingredients: Ingredient[], scale: ScaleState, provider = basicProvider) {
  return computeNutrition(
    ingredients.map((i) => ({ ...i, quantity: scaledQuantity(i, scale) })),
    provider,
  )
}
