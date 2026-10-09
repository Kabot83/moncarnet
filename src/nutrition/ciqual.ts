/**
 * Table CIQUAL 2025 (ANSES), embarquée dans l'application : recherche 100 % hors ligne.
 * Fichier généré par scripts/build-ciqual.mjs depuis la table officielle, sans modification
 * des valeurs. Licence Ouverte — mention obligatoire : CIQUAL_CITATION.
 */
import { normalize, tokens } from '@/lib/text'
import { type Food, NUTRIENT_KEYS, type NutrientValue, type Per100 } from '@/models/types'

export const CIQUAL_CITATION = 'Anses. 2025. Table de composition nutritionnelle des aliments Ciqual'
export const CIQUAL_EDITION = 'Ciqual 2025'
export const CIQUAL_URL = 'https://ciqual.anses.fr/'

interface RawCatalog {
  edition: string
  citation: string
  nutrients: string[]
  groups: string[]
  foods: Array<[string, string, number, ...NutrientValue[]]>
}

export interface CiqualFood {
  code: string
  name: string
  group: string
  per100: Per100
  /** Nom normalisé pour la recherche. */
  norm: string
  words: string[]
}

let catalog: Promise<CiqualFood[]> | null = null

/** Charge la table (une fois). Le fichier fait partie de l'application : disponible hors ligne. */
export function loadCiqual(): Promise<CiqualFood[]> {
  catalog ??= import('@/data/ciqual-2025.json').then((m) => {
    const raw = (m.default ?? m) as unknown as RawCatalog
    const keys = raw.nutrients as (keyof Per100)[]
    if (keys.join() !== NUTRIENT_KEYS.join()) throw new Error('Catalogue CIQUAL incompatible')
    return raw.foods.map(([code, name, groupIdx, ...values]) => {
      const per100 = Object.fromEntries(keys.map((k, i) => [k, values[i] ?? null])) as Per100
      const norm = normalize(name)
      return { code, name, group: raw.groups[groupIdx] ?? '', per100, norm, words: norm.split(/[^a-z0-9%]+/).filter(Boolean) }
    })
  })
  return catalog
}

const COOKED = /\b(cuit|cuite|bouilli|grille|frit|roti|poele|vapeur|braise|au four)\b/
const singular = (w: string) => (w.length > 3 ? w.replace(/(s|x)$/, '') : w)

/** Score de pertinence (0 = ne correspond pas). Tous les mots de la requête doivent être présents. */
export function scoreCiqual(food: CiqualFood, query: string): number {
  const q = tokens(query).map(singular)
  if (!q.length) return 0
  let score = 0
  for (const [i, w] of q.entries()) {
    const exact = food.words.some((x) => singular(x) === w)
    const prefix = !exact && food.words.some((x) => x.startsWith(w))
    if (!exact && !prefix && !food.norm.includes(w)) return 0
    score += exact ? 10 : prefix ? 6 : 2
    if (i === 0 && singular(food.words[0] ?? '') === w) score += 8 // le premier mot est l'aliment lui-même
  }
  // Préférence pour les libellés courts et les aliments crus (sauf si on cherche du cuit).
  score -= Math.min(10, food.words.length) * 0.5
  if (!COOKED.test(normalize(query)) && /\bcru|crue\b/.test(food.norm)) score += 2
  if (/aliment moyen/.test(food.norm)) score += 1
  return score
}

export async function searchCiqual(query: string, limit = 30): Promise<CiqualFood[]> {
  const foods = await loadCiqual()
  return foods
    .map((f) => [f, scoreCiqual(f, query)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name, 'fr'))
    .slice(0, limit)
    .map(([f]) => f)
}

export async function getCiqualFood(code: string): Promise<CiqualFood | undefined> {
  return (await loadCiqual()).find((f) => f.code === code)
}

export function ciqualToFood(f: CiqualFood): Food {
  return {
    source: 'ciqual',
    id: f.code,
    name: f.name,
    brand: '',
    basis: '100g',
    per100: { ...f.per100 },
    version: CIQUAL_EDITION,
    notes: [],
    fetchedAt: Date.now(),
  }
}
