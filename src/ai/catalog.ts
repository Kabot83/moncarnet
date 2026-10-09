/**
 * Exploitation du catalogue par le Chef IA, en économisant les tokens :
 * la sélection des recettes pertinentes est faite LOCALEMENT, puis seul un
 * extrait compact est transmis. Le catalogue complet n'est jamais envoyé.
 */
import { rediscover } from '@/lib/search'
import { totalTime } from '@/lib/format'
import { normalize, tokens } from '@/lib/text'
import type { Recipe } from '@/models/types'

export type CatalogScope = 'none' | 'auto' | 'favorites' | 'forgotten' | 'quick' | 'all-titles'

export const CATALOG_SCOPES: { id: CatalogScope; label: string; hint: string }[] = [
  { id: 'auto', label: 'Automatique', hint: 'Joint une recette si vous la nommez' },
  { id: 'favorites', label: 'Mes favorites', hint: 'Jusqu’à 12 favorites' },
  { id: 'forgotten', label: 'Pas cuisinées depuis longtemps', hint: 'Jusqu’à 12 recettes' },
  { id: 'quick', label: 'Rapides (≤ 30 min)', hint: 'Jusqu’à 12 recettes' },
  { id: 'none', label: 'Aucune', hint: 'Rien de mon carnet n’est envoyé' },
]

const MAX_SUMMARIES = 12

/** Recettes du carnet explicitement nommées dans le message. */
export function mentionedRecipes(message: string, recipes: readonly Recipe[]): Recipe[] {
  const msg = ` ${normalize(message)} `
  const scored: Array<[Recipe, number]> = []
  for (const r of recipes) {
    const words = tokens(r.title).filter((w) => w.length >= 4)
    if (!words.length) continue
    const hits = words.filter((w) => msg.includes(w.slice(0, Math.max(4, w.length - 1)))).length
    const ratio = hits / words.length
    if (ratio >= 0.6 || (hits >= 2 && ratio >= 0.5)) scored.push([r, ratio])
  }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, 2).map(([r]) => r)
}

/** Intention déduite du message (recherches simples faites localement). */
export function inferScope(message: string): CatalogScope {
  const m = normalize(message)
  if (/(pas|plus) (cuisine|fait|prepare)|depuis longtemps|oubli|redecouvr/.test(m)) return 'forgotten'
  if (/favori/.test(m)) return 'favorites'
  if (/rapide|vite|express|moins de (15|20|30) ?min/.test(m) && /(mes|parmi|carnet)/.test(m)) return 'quick'
  return 'auto'
}

export interface CatalogContext {
  /** Recettes détaillées (nommées dans le message). */
  detailed: Recipe[]
  /** Recettes résumées en une ligne. */
  summaries: Recipe[]
}

export function selectCatalogContext(message: string, recipes: readonly Recipe[], scope: CatalogScope): CatalogContext {
  if (scope === 'none' || !recipes.length) return { detailed: [], summaries: [] }
  const detailed = mentionedRecipes(message, recipes)
  const effective = scope === 'auto' ? inferScope(message) : scope
  let summaries: Recipe[] = []
  if (effective === 'favorites') summaries = recipes.filter((r) => r.favorite)
  else if (effective === 'forgotten') summaries = rediscover(recipes, MAX_SUMMARIES)
  else if (effective === 'quick') summaries = recipes.filter((r) => totalTime(r) > 0 && totalTime(r) <= 30)
  summaries = summaries.filter((r) => !detailed.includes(r)).slice(0, MAX_SUMMARIES)
  return { detailed, summaries }
}
