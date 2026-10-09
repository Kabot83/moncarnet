/**
 * Moteur de calcul nutritionnel — module pur, sans base de données ni réseau.
 *
 * Principes (non négociables) :
 * - Une valeur inconnue n'est JAMAIS remplacée par zéro : le total est alors « incomplet ».
 * - « traces » et « < x » (conventions CIQUAL) comptent pour 0 dans le total, mais le
 *   résultat devient « estimatif » et la borne haute est conservée.
 * - Poids : valeur saisie par l'utilisateur, sinon poids usuel du dictionnaire (oignon ≈ 110 g,
 *   1 c. à soupe d'huile ≈ 13,7 g…) TOUJOURS signalé comme estimation. Poids inconnu :
 *   l'ingrédient n'est pas compté et le total est « partiel », sans bloquer le reste.
 *   Sans masse volumique connue, 1 ml est compté pour 1 g (signalé).
 * - Les quantités viennent de `scaledQuantity` (module d'ajustement) : toujours recalculées
 *   depuis les quantités d'origine, sans arrondi intermédiaire.
 * - Les calculs internes ne sont jamais arrondis ; seul l'affichage arrondit.
 */
import { IDENTITY_SCALE, scaledQuantity, scaledServings } from '@/lib/scaling'
import { normalizeUnit } from '@/lib/units'
import { type FoodLink, type Ingredient, MAIN_NUTRIENTS, NUTRIENT_KEYS, type NutrientKey, type NutrientValue, type ScaleState } from '@/models/types'
import type { AutoMap, AutoMatch, UsualConversion } from './auto'

/** 1 kcal = 4,184 kJ (règlement UE 1169/2011). */
export const KJ_PER_KCAL = 4.184
export const kjToKcal = (kj: number) => kj / KJ_PER_KCAL
export const kcalToKj = (kcal: number) => kcal * KJ_PER_KCAL

/** Volumes de référence des cuillères (mesures culinaires normalisées). */
export const SPOON_ML: Record<string, number> = { 'c. à soupe': 15, 'c. à café': 5, tasse: 240 }

export type Interpreted =
  | { kind: 'exact'; value: number }
  | { kind: 'trace'; value: 0 }
  | { kind: 'below'; value: 0; max: number }
  | { kind: 'derived'; value: number; note: string }
  | { kind: 'missing' }

/** Lecture d'une teneur selon les conventions CIQUAL. */
export function interpret(v: NutrientValue | undefined): Interpreted {
  if (v == null) return { kind: 'missing' }
  if (typeof v === 'number') return Number.isFinite(v) ? { kind: 'exact', value: v } : { kind: 'missing' }
  if (v === 't') return { kind: 'trace', value: 0 }
  const lt = /^<(\d+(?:\.\d+)?)$/.exec(v)
  if (lt) return { kind: 'below', value: 0, max: Number(lt[1]) }
  return { kind: 'missing' }
}

/** Teneur effective pour 100 g/ml : correction manuelle d'abord, sinon la source. */
export function effectiveValue(link: FoodLink, key: NutrientKey): Interpreted {
  const o = link.overrides?.[key]
  if (typeof o === 'number') return { kind: 'exact', value: o }
  const v = interpret(link.food.per100[key])
  // Énergie : si seule la valeur en kJ est connue, conversion explicite (jamais kJ pris pour des kcal).
  if (key === 'kcal' && v.kind === 'missing') {
    const kj = interpret(link.food.per100.kj)
    if (kj.kind === 'exact') return { kind: 'derived', value: kjToKcal(kj.value), note: 'Énergie calculée depuis les kJ' }
  }
  return v
}

// ---------------------------------------------------------------------------
// Quantité → grammes / millilitres
// ---------------------------------------------------------------------------

export interface Amount {
  /** Quantité dans l'unité de référence de l'aliment (g pour « 100 g », ml pour « 100 ml »). */
  basisAmount: number
  /** Poids en grammes (pour le poids total de la préparation). */
  grams: number
  approx: string[]
}

export type AmountResult = Amount | { error: string }

/**
 * Convertit une quantité de recette dans l'unité de référence de l'aliment.
 * Renvoie une erreur explicite plutôt que d'inventer un poids.
 */
export function toBasisAmount(quantity: number, unit: string, link: FoodLink, usual: UsualConversion = {}): AmountResult {
  const def = normalizeUnit(unit)
  const basis = link.food.basis
  const approx: string[] = []
  // Masse volumique : saisie > préférence/valeur usuelle (signalée) > 1 g/ml (signalé).
  const knownDensity = link.density ?? usual.density?.value ?? null
  const density = () => {
    if (link.density) return link.density
    if (usual.density) {
      if (usual.density.note) approx.push(spoonNote(def.canonical, usual.density.value) ?? usual.density.note)
      return usual.density.value
    }
    approx.push('Masse volumique inconnue : 1 ml compté pour 1 g')
    return 1
  }
  let grams: number | null = null
  let ml: number | null = null

  if (def.kind === 'mass') grams = quantity * (def.toBase ?? 1)
  else if (def.kind === 'volume') ml = quantity * (def.toBase ?? 1)
  else if (def.kind === 'spoon' && SPOON_ML[def.canonical] != null) {
    ml = quantity * SPOON_ML[def.canonical]
    if (def.canonical === 'tasse') approx.push('1 tasse comptée 240 ml')
  } else if (link.gramsPerUnit) grams = quantity * link.gramsPerUnit
  else if (usual.gramsPerUnit) {
    grams = quantity * usual.gramsPerUnit.grams
    if (usual.gramsPerUnit.note) approx.push(usual.gramsPerUnit.note)
  } else if (def.kind === 'count') return { error: 'Poids usuel inconnu : poids d’une pièce à préciser' }
  else if (def.kind === 'pinch') return { error: 'Poids d’une pincée à préciser' }
  else return { error: `Unité « ${unit} » : poids à préciser` }

  if (basis === '100g') {
    if (grams == null) grams = ml! * density()
    return { basisAmount: grams, grams, approx: [...new Set(approx)] }
  }
  // Aliment exprimé pour 100 ml
  if (ml == null) ml = grams! / density()
  if (grams == null) grams = ml * (knownDensity ?? 1)
  if (!knownDensity && def.kind !== 'mass') approx.push('Poids estimé avec 1 ml = 1 g')
  return { basisAmount: ml, grams, approx: [...new Set(approx)] }
}

/** « 1 c. à soupe ≈ 13,7 g (valeur usuelle) » : plus parlant qu'une masse volumique. */
function spoonNote(canonical: string, density: number): string | null {
  const ml = SPOON_ML[canonical]
  if (!ml || canonical === 'tasse') return null
  const g = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(ml * density)
  return `Poids usuel estimé : 1 ${canonical} ≈ ${g} g`
}

// ---------------------------------------------------------------------------
// Calcul par ingrédient et total
// ---------------------------------------------------------------------------

export type RowStatus = 'ok' | 'excluded' | 'toTaste' | 'negligible' | 'unlinked' | 'toConfirm' | 'noQuantity' | 'noConversion'

/**
 * Fiabilité d'une ligne, telle qu'affichée :
 * verified : référence sûre et poids connu ; estimated : poids usuel, variante supposée ou autre
 * approximation ; uncertain : correspondance approchée ; missing : non compté (données manquantes).
 */
export type RowQuality = 'verified' | 'estimated' | 'uncertain' | 'missing' | 'ignored'

export interface NutrientCell {
  /** Contribution (0 pour traces / sous le seuil), ou null si la teneur est inconnue. */
  value: number | null
  /** Borne haute pour une valeur « < x ». */
  max?: number
  kind: Interpreted['kind']
}

export interface IngredientRow {
  ingredient: Ingredient
  status: RowStatus
  /** Quantité ajustée (unité de la recette). */
  quantity: number | null
  grams: number | null
  basisAmount: number | null
  cells: Partial<Record<NutrientKey, NutrientCell>>
  approx: string[]
  message?: string
  /** Référence utilisée (choisie, mémorisée ou reconnue automatiquement). */
  link: FoodLink | null
  match: AutoMatch | null
  quality: RowQuality
}

export interface NutrientTotal {
  value: number
  /** Ingrédients dont la teneur est inconnue pour ce nutriment. */
  missing: string[]
  /** Somme des bornes hautes « < x » non comptées. */
  upperExtra: number
  approximate: boolean
}

export interface NutritionResult {
  rows: IngredientRow[]
  totals: Record<NutrientKey, NutrientTotal>
  /** Poids total des ingrédients calculés (g). */
  rawGrams: number
  /** Vrai si le poids de chaque ingrédient compté est connu. */
  rawGramsComplete: boolean
  /** Ingrédients qui empêchent un calcul complet. */
  blocking: IngredientRow[]
  approximations: string[]
  /** Nombre d'ingrédients pris en compte / à prendre en compte. */
  coverage: { done: number; expected: number }
}

/**
 * Calcule les apports de chaque ingrédient puis du total, pour un ajustement donné.
 * `auto` : correspondances automatiques (module auto.ts). Sans elles, seules les références
 * choisies par l'utilisateur sont comptées.
 */
export function computeNutrition(ingredients: readonly Ingredient[], scale: ScaleState = IDENTITY_SCALE, auto?: AutoMap | null): NutritionResult {
  const rows: IngredientRow[] = ingredients.map((ing) => {
    const match = auto?.get(ing.id) ?? null
    const link = ing.nutrition ?? match?.link ?? null
    const base: IngredientRow = { ingredient: ing, status: 'ok', quantity: null, grams: null, basisAmount: null, cells: {}, approx: [], link, match, quality: 'missing' }
    if (ing.nutritionExcluded) return { ...base, status: 'excluded', quality: 'ignored' }
    if (!ing.name.trim()) return { ...base, status: 'excluded', quality: 'ignored' }
    const q = scaledQuantity(ing, scale)
    if (ing.toTaste && q == null) return { ...base, status: 'toTaste', quality: 'ignored' }
    if (!link) {
      if (match?.confidence === 'ambiguous') return { ...base, quantity: q, status: 'toConfirm', message: 'Plusieurs aliments possibles : à confirmer' }
      return { ...base, quantity: q, status: 'unlinked', message: auto ? 'Ingrédient non reconnu' : 'Aliment non associé' }
    }
    if (q == null && match?.seasoning) return { ...base, status: 'toTaste', quality: 'ignored', message: 'Assaisonnement sans quantité : apport négligeable' }
    if (q == null) return { ...base, status: 'noQuantity', message: 'Quantité non chiffrée' }
    const amount = toBasisAmount(q, ing.unit, link, match?.usual)
    // Herbes, épices… dont le poids ou les teneurs sont inconnus : non comptées, signalées (total estimatif).
    const negligible = { ...base, quantity: q, status: 'negligible' as const, quality: 'ignored' as const, message: 'Assaisonnement : apport négligeable, non compté' }
    if ('error' in amount) return match?.seasoning ? negligible : { ...base, quantity: q, status: 'noConversion', message: amount.error }
    if (match?.seasoning && MAIN_NUTRIENTS.every((k) => effectiveValue(link, k).kind === 'missing')) return negligible
    const cells: IngredientRow['cells'] = {}
    const approx = [...amount.approx]
    if (!ing.nutrition && match?.note && match.confidence !== 'sure') approx.unshift(match.note)
    const weightOrMatchApprox = approx.length > 0
    for (const key of NUTRIENT_KEYS) {
      const v = effectiveValue(link, key)
      if (v.kind === 'missing') cells[key] = { value: null, kind: 'missing' }
      else {
        cells[key] = { value: (v.value * amount.basisAmount) / 100, kind: v.kind, ...(v.kind === 'below' ? { max: (v.max * amount.basisAmount) / 100 } : {}) }
        if (MAIN_NUTRIENTS.includes(key as (typeof MAIN_NUTRIENTS)[number])) {
          if (v.kind === 'trace') approx.push('Teneur à l’état de traces comptée pour 0')
          if (v.kind === 'below') approx.push(`Teneur inférieure à ${v.max} g/100 comptée pour 0`)
          if (v.kind === 'derived') approx.push(v.note)
        }
      }
    }
    const quality: RowQuality = MAIN_NUTRIENTS.some((k) => cells[k]?.value == null)
      ? 'missing'
      : !ing.nutrition && match?.confidence === 'approx'
        ? 'uncertain'
        : weightOrMatchApprox
          ? 'estimated'
          : 'verified'
    return { ...base, quantity: q, grams: amount.grams, basisAmount: amount.basisAmount, cells, approx: [...new Set(approx)], quality }
  })

  const totals = {} as Record<NutrientKey, NutrientTotal>
  for (const key of NUTRIENT_KEYS) {
    const t: NutrientTotal = { value: 0, missing: [], upperExtra: 0, approximate: false }
    for (const r of rows) {
      if (r.status !== 'ok') continue
      const c = r.cells[key]
      if (!c || c.value == null) t.missing.push(r.ingredient.name)
      else {
        t.value += c.value
        if (c.kind !== 'exact') t.approximate = true
        if (c.max) t.upperExtra += c.max
      }
    }
    totals[key] = t
  }

  const counted = rows.filter((r) => r.status !== 'excluded' && r.status !== 'toTaste' && r.status !== 'negligible')
  const blocking = counted.filter((r) => r.status !== 'ok')
  const ok = counted.filter((r) => r.status === 'ok')
  const negligible = rows.filter((r) => r.status === 'negligible').map((r) => `${r.ingredient.name} : apport négligeable, non compté`)
  return {
    rows,
    totals,
    rawGrams: ok.reduce((s, r) => s + (r.grams ?? 0), 0),
    rawGramsComplete: blocking.length === 0,
    blocking,
    approximations: [...new Set([...ok.flatMap((r) => r.approx), ...negligible])],
    coverage: { done: ok.length, expected: counted.length },
  }
}

// ---------------------------------------------------------------------------
// Vues : 100 g, portion, total
// ---------------------------------------------------------------------------

export type NutritionMode = 'per100' | 'portion' | 'total'
export type Reliability = 'complete' | 'estimate' | 'incomplete'
export type MainKey = (typeof MAIN_NUTRIENTS)[number]

export interface RecipeWeights {
  servings: number | null
  cookedWeightG: number | null
  cookedWeightRawG: number | null
}

export interface NutritionView {
  mode: NutritionMode
  /** null si la vue n'est pas calculable (pas de portions, poids inconnu…). */
  values: Record<MainKey, number | null>
  reliability: Reliability
  /** Explications affichées sous le résultat. */
  reasons: string[]
  /** Dénominateur utilisé pour « 100 g » (g) et sa nature. */
  weight?: { grams: number; kind: 'cooked' | 'cooked-extrapolated' | 'raw' }
  available: boolean
  unavailableReason?: string
}

const REVIEW_TOLERANCE = 0.01

/**
 * Le poids après cuisson a été pesé pour un certain poids d'ingrédients. Si la recette
 * d'origine a changé depuis, la pesée doit être refaite.
 */
export function cookedWeightNeedsReview(recipe: RecipeWeights, rawOriginal: number): boolean {
  if (!recipe.cookedWeightG || !recipe.cookedWeightRawG) return false
  return Math.abs(rawOriginal - recipe.cookedWeightRawG) / recipe.cookedWeightRawG > REVIEW_TOLERANCE
}

export function nutritionView(
  result: NutritionResult,
  mode: NutritionMode,
  recipe: RecipeWeights,
  scale: ScaleState = IDENTITY_SCALE,
  rawOriginal: number = result.rawGrams,
): NutritionView {
  const reasons: string[] = []
  let reliability: Reliability = 'complete'
  const degrade = (to: Reliability) => {
    if (to === 'incomplete' || reliability === 'complete') reliability = to
  }

  // Qualité des données des ingrédients.
  if (result.blocking.length) {
    degrade('incomplete')
    reasons.push(`${result.blocking.length} ingrédient${result.blocking.length > 1 ? 's' : ''} non calculé${result.blocking.length > 1 ? 's' : ''} : ${result.blocking.map((r) => r.ingredient.name).join(', ')}`)
  }
  for (const k of MAIN_NUTRIENTS) {
    const t = result.totals[k]
    if (t.missing.length) {
      degrade('incomplete')
      reasons.push(`${LABELS[k]} : teneur inconnue pour ${t.missing.join(', ')}`)
    }
  }
  if (result.approximations.length) {
    degrade('estimate')
    reasons.push(...result.approximations)
  }

  const totals = Object.fromEntries(MAIN_NUTRIENTS.map((k) => [k, result.totals[k].value])) as Record<MainKey, number>
  const scaleBy = (d: number) => Object.fromEntries(MAIN_NUTRIENTS.map((k) => [k, totals[k] / d])) as Record<MainKey, number>

  if (mode === 'total') return { mode, values: totals, reliability, reasons, available: true }

  if (mode === 'portion') {
    const servings = scaledServings(scale, recipe.servings)
    if (!servings || servings <= 0)
      return { mode, values: nulls(), reliability, reasons, available: false, unavailableReason: 'Nombre de portions non renseigné.' }
    return { mode, values: scaleBy(servings), reliability, reasons, available: true }
  }

  // Pour 100 g : poids après cuisson si connu, sinon poids des ingrédients (estimation).
  let weight: NutritionView['weight']
  if (recipe.cookedWeightG) {
    const ref = recipe.cookedWeightRawG ?? rawOriginal
    if (cookedWeightNeedsReview(recipe, rawOriginal)) {
      degrade('estimate')
      reasons.push('Les ingrédients ont changé depuis la pesée : poids après cuisson à revoir.')
    }
    const sameAsWeighed = ref > 0 && Math.abs(result.rawGrams - ref) / ref <= REVIEW_TOLERANCE
    if (sameAsWeighed || !ref) weight = { grams: recipe.cookedWeightG, kind: 'cooked' }
    else {
      weight = { grams: (recipe.cookedWeightG * result.rawGrams) / ref, kind: 'cooked-extrapolated' }
      degrade('estimate')
      reasons.push('Quantités ajustées : poids après cuisson extrapolé proportionnellement.')
    }
  } else if (result.rawGramsComplete && result.rawGrams > 0) {
    weight = { grams: result.rawGrams, kind: 'raw' }
    degrade('estimate')
    reasons.push('Poids après cuisson non renseigné : calcul sur le poids des ingrédients avant cuisson.')
  } else {
    return { mode, values: nulls(), reliability, reasons, available: false, unavailableReason: 'Poids de la préparation inconnu : renseignez le poids après cuisson ou complétez les ingrédients.' }
  }
  return { mode, values: scaleBy(weight.grams / 100), reliability, reasons, weight, available: true }
}

const nulls = () => Object.fromEntries(MAIN_NUTRIENTS.map((k) => [k, null])) as Record<MainKey, null>

export const LABELS: Record<NutrientKey, string> = {
  kcal: 'Énergie',
  kj: 'Énergie (kJ)',
  protein: 'Protéines',
  carbs: 'Glucides',
  fat: 'Lipides',
  fiber: 'Fibres',
  sugars: 'Sucres',
  satFat: 'Acides gras saturés',
  salt: 'Sel',
}

export const UNITS: Record<NutrientKey, string> = { kcal: 'kcal', kj: 'kJ', protein: 'g', carbs: 'g', fat: 'g', fiber: 'g', sugars: 'g', satFat: 'g', salt: 'g' }

/** Arrondi d'affichage (jamais utilisé dans les calculs). */
export function formatNutrient(key: NutrientKey, v: number | null): string {
  if (v == null) return '—'
  const digits = key === 'kcal' || key === 'kj' ? 0 : v < 10 ? 1 : 0
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(v)
}

/** Poids total d'origine (sans ajustement), pour vérifier la pesée après cuisson. */
export const rawOriginalGrams = (ingredients: readonly Ingredient[], auto?: AutoMap | null) => computeNutrition(ingredients, IDENTITY_SCALE, auto).rawGrams

