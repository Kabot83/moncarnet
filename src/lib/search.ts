/**
 * Recherche instantanée et filtres combinables du catalogue, 100 % locaux.
 * Conçu pour rester fluide avec plusieurs centaines de recettes : l'index
 * texte de chaque recette est calculé une fois et mis en cache.
 */
import { CATEGORIES, type CategoryId, NOTE_FIELDS, type Recipe, categoryLabel } from '@/models/types'
import { totalTime } from './format'
import { normalize, tokens } from './text'

export interface RecipeFilters {
  query: string
  categories: CategoryId[]
  /** Durée totale maximale en minutes. */
  maxTime: number | null
  difficulties: number[]
  favorite: boolean
  cooked: boolean
  toTry: boolean
  tags: string[]
}

export type SortKey = 'recent' | 'alpha' | 'rating' | 'mostCooked' | 'quickest' | 'lastCooked'

export const SORTS: { id: SortKey; label: string }[] = [
  { id: 'recent', label: 'Récemment modifiées' },
  { id: 'alpha', label: 'Ordre alphabétique' },
  { id: 'rating', label: 'Mieux notées' },
  { id: 'mostCooked', label: 'Les plus cuisinées' },
  { id: 'lastCooked', label: 'Cuisinées récemment' },
  { id: 'quickest', label: 'Les plus rapides' },
]

export const emptyFilters = (): RecipeFilters => ({
  query: '',
  categories: [],
  maxTime: null,
  difficulties: [],
  favorite: false,
  cooked: false,
  toTry: false,
  tags: [],
})

export function activeFilterCount(f: RecipeFilters): number {
  return (
    f.categories.length +
    (f.maxTime ? 1 : 0) +
    f.difficulties.length +
    (f.favorite ? 1 : 0) +
    (f.cooked ? 1 : 0) +
    (f.toTry ? 1 : 0) +
    f.tags.length
  )
}

interface Index {
  updatedAt: number
  title: string
  rest: string
}
const cache = new Map<string, Index>()

function indexOf(r: Recipe): Index {
  const hit = cache.get(r.id)
  if (hit && hit.updatedAt === r.updatedAt) return hit
  const rest = normalize(
    [
      r.description,
      r.ingredients.map((i) => `${i.name} ${i.note} ${i.group}`).join(' '),
      NOTE_FIELDS.map((f) => r.notes[f.id]).join(' '),
      r.tags.join(' '),
      categoryLabel(r.category),
      CATEGORIES.find((c) => c.id === r.category)?.label ?? '',
      r.source,
    ].join(' '),
  )
  const idx = { updatedAt: r.updatedAt, title: normalize(r.title), rest }
  cache.set(r.id, idx)
  return idx
}

/** Score de pertinence (0 = ne correspond pas). */
export function matchScore(r: Recipe, query: string): number {
  const words = tokens(query)
  if (!words.length) return 1
  const idx = indexOf(r)
  let score = 0
  for (const word of words) {
    // Pluriels simples : « courgettes » trouve « courgette ».
    const w = word.length > 3 ? word.replace(/(s|x)$/, '') : word
    if (idx.title.startsWith(w)) score += 6
    else if (idx.title.includes(` ${w}`)) score += 5
    else if (idx.title.includes(w)) score += 4
    else if (idx.rest.includes(w)) score += 1
    else return 0 // tous les mots doivent être trouvés
  }
  return score
}

export function filterRecipes(recipes: readonly Recipe[], f: RecipeFilters, sort: SortKey = 'recent'): Recipe[] {
  const tagSet = new Set(f.tags.map(normalize))
  const scored: Array<[Recipe, number]> = []
  for (const r of recipes) {
    if (f.categories.length && !f.categories.includes(r.category)) continue
    if (f.difficulties.length && !f.difficulties.includes(r.difficulty)) continue
    if (f.favorite && !r.favorite) continue
    if (f.toTry && !r.toTry) continue
    if (f.cooked && !r.cookCount) continue
    if (f.maxTime) {
      const t = totalTime(r)
      if (!t || t > f.maxTime) continue
    }
    if (tagSet.size && !r.tags.some((t) => tagSet.has(normalize(t)))) continue
    const s = matchScore(r, f.query)
    if (s > 0) scored.push([r, s])
  }
  const hasQuery = tokens(f.query).length > 0
  scored.sort(([a, sa], [b, sb]) => {
    if (hasQuery && sa !== sb) return sb - sa
    return compare(a, b, sort)
  })
  return scored.map(([r]) => r)
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true })

function compare(a: Recipe, b: Recipe, sort: SortKey): number {
  switch (sort) {
    case 'alpha':
      return collator.compare(a.title, b.title)
    case 'rating':
      return b.rating - a.rating || collator.compare(a.title, b.title)
    case 'mostCooked':
      return b.cookCount - a.cookCount || collator.compare(a.title, b.title)
    case 'lastCooked':
      return (b.lastCookedAt ?? 0) - (a.lastCookedAt ?? 0)
    case 'quickest':
      return (totalTime(a) || 1e9) - (totalTime(b) || 1e9)
    default:
      return b.updatedAt - a.updatedAt
  }
}

/** Tous les tags utilisés, du plus fréquent au moins fréquent. */
export function allTags(recipes: readonly Recipe[]): string[] {
  const counts = new Map<string, { label: string; n: number }>()
  for (const r of recipes)
    for (const t of r.tags) {
      const k = normalize(t)
      const e = counts.get(k)
      if (e) e.n++
      else counts.set(k, { label: t, n: 1 })
    }
  return [...counts.values()].sort((a, b) => b.n - a.n || collator.compare(a.label, b.label)).map((e) => e.label)
}

/**
 * « À redécouvrir » : recettes déjà cuisinées mais pas depuis longtemps.
 * La sélection varie chaque jour (graine = date) mais reste stable dans la journée.
 */
export function rediscover(recipes: readonly Recipe[], count = 6, now = Date.now()): Recipe[] {
  const DAY = 86_400_000
  const old = recipes
    .filter((r) => r.lastCookedAt && now - r.lastCookedAt > 30 * DAY)
    .sort((a, b) => (a.lastCookedAt ?? 0) - (b.lastCookedAt ?? 0))
  const pool = old.length >= count ? old.slice(0, count * 3) : [...old, ...recipes.filter((r) => !r.lastCookedAt && !r.toTry && !old.includes(r))]
  const seed = Math.floor(now / DAY)
  return shuffleSeeded(pool, seed).slice(0, count)
}

function shuffleSeeded<T>(arr: readonly T[], seed: number): T[] {
  const out = [...arr]
  let s = seed % 2147483647 || 1
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
