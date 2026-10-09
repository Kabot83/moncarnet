/**
 * Ajustement intelligent des ingrédients — module indépendant, sans dépendance
 * à React ni à la base de données.
 *
 * ## Principe
 *
 * Un ajustement est décrit par des **coefficients** appliqués aux quantités
 * d'origine, jamais par des quantités recalculées puis réutilisées :
 *
 *     coefficient = nouvelle quantité de la référence / quantité d'origine de la référence
 *     quantité affichée = quantité d'origine × coefficient
 *
 * Si l'on change ensuite un autre ingrédient, le nouveau coefficient est de
 * nouveau calculé à partir de **sa quantité d'origine**. Aucune valeur arrondie
 * n'est donc jamais réinjectée dans un calcul : pas d'accumulation d'erreurs.
 *
 * ## Groupes
 *
 * Le coefficient `global` s'applique à tous les ingrédients. Un groupe
 * (« Sauce », « Pâte ») peut recevoir son propre coefficient lorsque l'on
 * ajuste « ce groupe seulement » ; un ajustement global efface ces exceptions.
 *
 * ## Ingrédients exclus
 *
 * Ne sont jamais recalculés : les ingrédients marqués non proportionnels (sel,
 * épices, levure…), « selon le goût », et ceux sans quantité numérique > 0.
 *
 * La recette d'origine n'est jamais modifiée par ce module : toutes les
 * fonctions sont pures et renvoient de nouveaux objets.
 */
import type { Ingredient, ScaleState } from '@/models/types'

export type ScalableIngredient = Pick<Ingredient, 'id' | 'quantity' | 'group' | 'scalable' | 'toTaste'>

export const IDENTITY_SCALE: ScaleState = Object.freeze({ global: 1, groups: {}, referenceId: null }) as ScaleState

const EPS = 1e-9

/** Un ingrédient participe-t-il à la proportionnalité ? */
export function isScalable(ing: ScalableIngredient): boolean {
  return (
    ing.scalable !== false &&
    !ing.toTaste &&
    typeof ing.quantity === 'number' &&
    Number.isFinite(ing.quantity) &&
    ing.quantity > 0
  )
}

/** Coefficient applicable à un groupe donné. */
export function factorFor(state: ScaleState, group: string): number {
  const g = state.groups?.[group]
  return typeof g === 'number' && g > 0 ? g : state.global
}

/**
 * Quantité ajustée (non arrondie) d'un ingrédient.
 * Renvoie `null` si l'ingrédient n'a pas de quantité numérique.
 */
export function scaledQuantity(ing: ScalableIngredient, state: ScaleState): number | null {
  if (ing.quantity == null || !Number.isFinite(ing.quantity)) return null
  if (!isScalable(ing)) return ing.quantity
  return ing.quantity * factorFor(state, ing.group ?? '')
}

export type ScaleScope = 'all' | 'group'

/**
 * Prend un ingrédient comme référence et lui donne une nouvelle quantité.
 * Toutes les autres quantités proportionnelles suivent.
 *
 * Sans effet (renvoie l'état reçu) si l'ingrédient n'est pas proportionnel,
 * si sa quantité d'origine est nulle/absente (aucune division par zéro) ou si
 * la nouvelle quantité n'est pas un nombre strictement positif.
 */
export function scaleFromIngredient(
  ingredients: readonly ScalableIngredient[],
  state: ScaleState,
  ingredientId: string,
  newQuantity: number,
  scope: ScaleScope = 'all',
): ScaleState {
  const ing = ingredients.find((i) => i.id === ingredientId)
  if (!ing || !isScalable(ing)) return state
  if (!Number.isFinite(newQuantity) || newQuantity <= 0) return state
  const factor = newQuantity / (ing.quantity as number)
  if (scope === 'group' && ing.group) {
    return { global: state.global, groups: { ...state.groups, [ing.group]: factor }, referenceId: ing.id }
  }
  return { global: factor, groups: {}, referenceId: ing.id }
}

/** Ajuste via le nombre de portions (coefficient global). */
export function scaleByServings(state: ScaleState, originalServings: number | null, newServings: number): ScaleState {
  if (!originalServings || originalServings <= 0 || !Number.isFinite(newServings) || newServings <= 0) return state
  return { global: newServings / originalServings, groups: {}, referenceId: null }
}

/** Ajuste par un coefficient direct (×2, ×0,5…). */
export function scaleByFactor(factor: number): ScaleState {
  if (!Number.isFinite(factor) || factor <= 0) return IDENTITY_SCALE
  return { global: factor, groups: {}, referenceId: null }
}

/** Nombre de portions correspondant au coefficient global. */
export function scaledServings(state: ScaleState, originalServings: number | null): number | null {
  if (originalServings == null) return null
  return originalServings * state.global
}

/** L'état diffère-t-il des proportions d'origine ? */
export function isAdjusted(state: ScaleState | null | undefined): boolean {
  if (!state) return false
  if (Math.abs(state.global - 1) > EPS) return true
  return Object.values(state.groups ?? {}).some((f) => Math.abs(f - 1) > EPS)
}

/** Retour aux proportions d'origine. */
export const resetScale = (): ScaleState => ({ global: 1, groups: {}, referenceId: null })

/**
 * Applique l'ajustement et renvoie de NOUVEAUX ingrédients (pour une variante
 * ou le remplacement de l'original). Les quantités sont arrondies à 2
 * décimales pour le stockage : elles deviennent les nouvelles valeurs d'origine.
 */
export function applyScale<T extends ScalableIngredient>(ingredients: readonly T[], state: ScaleState): T[] {
  return ingredients.map((ing) => {
    const q = scaledQuantity(ing, state)
    if (q == null || !isScalable(ing)) return { ...ing }
    return { ...ing, quantity: Math.round(q * 100) / 100 }
  })
}

/** Groupes présents dans la recette (« » = groupe principal), dans l'ordre d'apparition. */
export function ingredientGroups(ingredients: readonly Pick<Ingredient, 'group'>[]): string[] {
  const seen: string[] = []
  for (const i of ingredients) if (!seen.includes(i.group ?? '')) seen.push(i.group ?? '')
  return seen
}

/** Résumé lisible d'un coefficient : « × 1,33 ». */
export function describeFactor(f: number): string {
  return `× ${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(f)}`
}

/**
 * Exclusion automatique proposée à la création d'un ingrédient : sel, poivre,
 * épices, levures et agents levants ne suivent généralement pas une
 * proportionnalité stricte. L'utilisateur garde toujours la main.
 */
export function suggestNonScalable(name: string): boolean {
  return /(?<!\p{L})(sel|poivre|piment|épices?|muscade|cannelle|curry|paprika|cumin|levure|bicarbonate|vanille|herbes|thym|laurier|romarin|origan|fleur de sel)(?!\p{L})/iu.test(
    name,
  )
}
