/**
 * Reconnaissance automatique des ingrédients — module pur (catalogue et mémoire passés en paramètre).
 *
 * Ordre de priorité pour chaque ingrédient :
 *   1. référence choisie par l'utilisateur pour cette recette (`ingredient.nutrition`) ;
 *   2. préférence mémorisée pour ce nom d'ingrédient (« retenir pour mes prochaines recettes ») ;
 *   3. dictionnaire des ingrédients courants (codes CIQUAL vérifiés) ;
 *   4. recherche approchée dans la table CIQUAL, retenue seulement si elle est sans ambiguïté
 *      nutritionnelle. Sinon : « à confirmer », jamais compté au hasard.
 *
 * Poids usuels : poids d'une pièce, d'une unité (gousse, sachet…) et masse volumique pour les
 * cuillères. Toujours des ESTIMATIONS, signalées comme telles ; une valeur saisie par
 * l'utilisateur est toujours prioritaire.
 */
import { normalize } from '@/lib/text'
import { normalizeUnit } from '@/lib/units'
import type { Food, FoodLink, Ingredient } from '@/models/types'
import { COOKED, type CiqualFood, ciqualToFood, scoreCiqual } from './ciqual'
import { DICTIONARY, type DictionaryEntry, GENERIC_UNIT_WEIGHTS, SIZE_FACTORS, SOURCE_LABEL, type UsualWeight } from './dictionary'

// ---------------------------------------------------------------------------
// Normalisation des noms
// ---------------------------------------------------------------------------

export const singular = (w: string) => (w.length > 3 ? w.replace(/(s|x)$/, '') : w)

/** Mots normalisés d'un nom : minuscules, sans accents, au singulier, sans parenthèses. */
export function words(name: string): string[] {
  return normalize(name)
    .replace(/\(.*?\)/g, ' ')
    .split(/[^a-z0-9]+/) // « 15 % » et « 15% » donnent le même mot
    .filter(Boolean)
    .map(singular)
}

const STOP = new Set(['de', 'd', 'du', 'des', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'en', 'et', 'un', 'une', 'pour', 'environ', 'bien', 'tres', 'quelque', 'facultatif'])

/** Mots qui précisent l'état ou la préparation sans changer l'aliment (valeurs pour la partie comestible crue). */
const DESCRIPTORS = new Set(
  [
    'cru', 'crue', 'frai', 'fraiche', 'epluche', 'epluchee', 'pele', 'pelee', 'emince', 'emincee', 'hache', 'hachee', 'coupe', 'coupee',
    'rondelle', 'lamelle', 'morceau', 'de', 'rape', 'rapee', 'cisele', 'ciselee', 'ecrase', 'ecrasee', 'presse', 'pressee', 'fondu', 'fondue',
    'mou', 'molle', 'ramolli', 'ramollie', 'pommade', 'tiede', 'froid', 'froide', 'battu', 'battue', 'mixe', 'mixee', 'bio', 'maison',
    'fin', 'fine', 'moyen', 'moyenne', 'gro', 'grosse', 'petit', 'petite', 'beau', 'belle', 'mur', 'mure', 'entier', 'entiere', 'nature',
    'vierge', 'extra', 'tendre', 'denoyaute', 'denoyautee', 'egoutte', 'egouttee', 'lave', 'lavee', 'taille', 'paquet', 'botte',
    'zeste', // (zeste seul : valeur du fruit, ordre de grandeur négligeable)
    'bouquet', 'brin', 'branche', 'poignee', 'farineuse', 'farineux', 'ferme', 'chair',
  ].map(singular),
)
/** Mots d'unité parfois saisis dans le nom (« 10 carrés de chocolat », « 4 filets de poulet »). */
const UNIT_WORDS = new Set(['carre', 'cube', 'tranche', 'bouquet', 'brin', 'branche', 'poignee', 'morceau', 'pave', 'filet', 'sachet', 'pot', 'gousse', 'feuille', 'boite', 'botte'])
/** Unités équivalentes à « une pièce » quand l'aliment n'a pas de poids propre pour elles. */
const PIECE_LIKE = new Set(['', 'piece', 'filet', 'pave', 'escalope', 'unite'])
const SMALL = new Set(['petit', 'petite'].map(singular))
const LARGE = new Set(['gro', 'grosse', 'beau', 'belle'].map(singular))

// ---------------------------------------------------------------------------
// Dictionnaire
// ---------------------------------------------------------------------------

interface PreparedName {
  tokens: string[]
  assumed: boolean
}
interface PreparedEntry {
  entry: DictionaryEntry
  names: PreparedName[]
  allow: Set<string>
}

let prepared: PreparedEntry[] | null = null
function entries(): PreparedEntry[] {
  prepared ??= DICTIONARY.map((entry) => ({
    entry,
    names: entry.names.map((n) => ({ tokens: words(n.replace(/^~/, '')), assumed: n.startsWith('~') })),
    allow: new Set((entry.allow ?? []).map(singular)),
  }))
  return prepared
}

export interface DictionaryMatch {
  entry: DictionaryEntry
  /** Variante courante supposée (nom générique). */
  assumed: boolean
  /** Mots restants (descriptifs). */
  rest: string[]
}

/** Correspondance avec le dictionnaire : tous les mots du nom reconnu présents, les autres seulement descriptifs. */
export function matchDictionary(name: string): DictionaryMatch | null {
  const ws = words(name)
  if (!ws.length) return null
  let best: (DictionaryMatch & { size: number }) | null = null
  for (const p of entries()) {
    for (const n of p.names) {
      const rest = [...ws]
      let ok = true
      for (const t of n.tokens) {
        const i = rest.indexOf(t)
        if (i < 0) {
          ok = false
          break
        }
        rest.splice(i, 1)
      }
      if (!ok) continue
      if (!rest.every((w) => STOP.has(w) || DESCRIPTORS.has(w) || p.allow.has(w))) continue
      const size = n.tokens.length
      if (!best || size > best.size || (size === best.size && best.assumed && !n.assumed)) best = { entry: p.entry, assumed: n.assumed, rest, size }
    }
  }
  return best ? { entry: best.entry, assumed: best.assumed, rest: best.rest } : null
}

/** Entrée du dictionnaire pour un aliment CIQUAL donné (pour retrouver ses poids usuels). */
export const dictionaryForCode = (code: string) => DICTIONARY.find((e) => e.ciqual === code) ?? null

// ---------------------------------------------------------------------------
// Recherche approchée
// ---------------------------------------------------------------------------

/** Teneurs proches au point de ne pas changer le résultat de façon notable. */
export function nutritionallyClose(a: CiqualFood, b: CiqualFood): boolean {
  const num = (f: CiqualFood, k: 'kcal' | 'protein' | 'carbs' | 'fat') => {
    const v = f.per100[k]
    return typeof v === 'number' ? v : v === 't' || (typeof v === 'string' && v.startsWith('<')) ? 0 : null
  }
  const ka = num(a, 'kcal')
  const kb = num(b, 'kcal')
  if (ka == null || kb == null) return false
  if (Math.abs(ka - kb) > Math.max(25, 0.15 * Math.max(ka, kb))) return false
  for (const k of ['protein', 'carbs', 'fat'] as const) {
    const x = num(a, k)
    const y = num(b, k)
    if (x == null || y == null) return false
    if (Math.abs(x - y) > Math.max(3, 0.25 * Math.max(x, y))) return false
  }
  return true
}

/** Requête de recherche : le nom sans les mots vides ni les précisions de taille. */
export function searchQuery(name: string): string {
  const ws = words(name).filter((w) => !STOP.has(w))
  const core = ws.filter((w) => !DESCRIPTORS.has(w))
  return (core.length ? core : ws).join(' ')
}

export interface FuzzyResult {
  best: CiqualFood | null
  candidates: CiqualFood[]
  /** Vrai si les meilleurs candidats ont des teneurs nettement différentes : ne pas choisir. */
  ambiguous: boolean
}

export function fuzzyMatch(name: string, catalog: readonly CiqualFood[]): FuzzyResult {
  const q = searchQuery(name)
  if (!q) return { best: null, candidates: [], ambiguous: false }
  // État : sans précision, l'aliment est cru (valeurs CIQUAL de la partie comestible crue).
  const wantsCooked = COOKED.test(q)
  const scored = catalog
    .filter((f) => wantsCooked || !COOKED.test(f.norm))
    .map((f) => [f, scoreCiqual(f, q)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || a[0].name.localeCompare(b[0].name, 'fr'))
  if (!scored.length) return { best: null, candidates: [], ambiguous: false }
  const [top, topScore] = scored[0]
  const candidates = scored.slice(0, 8).map(([f]) => f)
  // L'aliment lui-même doit être le premier mot du libellé CIQUAL (« Carotte, cuite » pour « carottes cuites »).
  const first = q.split(' ')[0]
  const identity = singular(top.words[0] ?? '') === first
  const close = scored.filter(([, s]) => s >= topScore - 4).slice(0, 6)
  const similar = close.every(([f]) => nutritionallyClose(f, top))
  return { best: top, candidates, ambiguous: !identity || !similar }
}

// ---------------------------------------------------------------------------
// Résolution d'un ingrédient
// ---------------------------------------------------------------------------

export type MatchOrigin = 'user' | 'memory' | 'dictionary' | 'search' | 'none'
/**
 * sure : référence choisie, mémorisée ou nom reconnu sans ambiguïté ;
 * assumed : variante courante supposée (« lait » → demi-écrémé) ;
 * approx : recherche approchée, candidats proches nutritionnellement ;
 * ambiguous : plusieurs références nettement différentes, à confirmer ;
 * none : non reconnu.
 */
export type MatchConfidence = 'sure' | 'assumed' | 'approx' | 'ambiguous' | 'none'

export interface UsualConversion {
  gramsPerUnit?: { grams: number; note: string; user: boolean }
  density?: { value: number; note: string; user: boolean }
}

export interface AutoMatch {
  origin: MatchOrigin
  confidence: MatchConfidence
  /** Référence utilisée pour le calcul (null : non compté). */
  link: FoodLink | null
  /** Autres références proposées en un geste. */
  candidates: Food[]
  /** Poids usuels utilisables quand la quantité n'est pas en g/ml. */
  usual: UsualConversion
  /** Explication courte (« Variante supposée : lait demi-écrémé »). */
  note?: string
  /** Assaisonnement (sel, poivre, épices…) : négligeable sans quantité. */
  seasoning?: boolean
}

export interface MemoryPreference {
  food: Food
  gramsPerUnit: number | null
  density: number | null
}

export type AutoMap = Map<string, AutoMatch>

const fmt = (n: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n)

const fmtDensity = (n: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(n)

const unitKey = (unit: string) => singular(normalize(normalizeUnit(unit).canonical || unit).replace(/[^a-z]/g, ''))

/** Poids usuels pour cet ingrédient et cette unité (null : rien de connu). */
export function usualConversion(ing: Pick<Ingredient, 'name' | 'unit'>, entry: DictionaryEntry | null, memory: MemoryPreference | null): UsualConversion {
  const out: UsualConversion = {}
  const def = normalizeUnit(ing.unit)
  const { uk, unitLabel } = effectiveUnit(ing)
  const measured = def.kind === 'mass' || def.kind === 'volume'
  const what = unitLabel ? `1 ${unitLabel}` : `1 ${entry?.label ?? 'pièce'}`

  if (measured) {
    // g, ml : pas de poids par pièce ; la masse volumique reste utile pour les ml.
  } else if (memory?.gramsPerUnit) out.gramsPerUnit = { grams: memory.gramsPerUnit, note: '', user: true }
  else {
    let w: UsualWeight | undefined
    let factor = 1
    if (entry?.units && uk && entry.units[uk]) w = entry.units[uk]
    else if (uk && GENERIC_UNIT_WEIGHTS[uk]) w = GENERIC_UNIT_WEIGHTS[uk]
    else if (entry?.piece && (def.kind === 'count' || def.kind === 'other') && PIECE_LIKE.has(uk)) {
      w = entry.piece
      const ws = words(ing.name)
      if (ws.some((x) => SMALL.has(x))) factor = SIZE_FACTORS.small
      else if (ws.some((x) => LARGE.has(x))) factor = SIZE_FACTORS.large
    }
    if (w) {
      const grams = w.grams * factor
      const size = factor < 1 ? ' (petit)' : factor > 1 ? ' (gros)' : ''
      out.gramsPerUnit = { grams, note: `Poids usuel estimé : ${what}${size} ≈ ${fmt(grams)} g (${SOURCE_LABEL[w.source]})`, user: false }
    }
  }

  if (memory?.density) out.density = { value: memory.density, note: '', user: true }
  else if (entry?.density) out.density = { value: entry.density.grams, note: `Masse volumique usuelle : ${fmtDensity(entry.density.grams)} g/ml (${SOURCE_LABEL[entry.density.source]})`, user: false }
  return out
}

/** Unité réelle : celle saisie, ou un mot d'unité en tête du nom (« carrés de chocolat »). */
export function effectiveUnit(ing: Pick<Ingredient, 'name' | 'unit'>): { name: string; uk: string; unitLabel: string } {
  const def = normalizeUnit(ing.unit)
  if (ing.unit.trim()) {
    const label = def.kind === 'pinch' ? 'pincée' : def.kind === 'count' || def.kind === 'other' ? (def.canonical || ing.unit).trim() : ''
    return { name: ing.name, uk: unitKey(ing.unit), unitLabel: label }
  }
  const raw = ing.name.trim().split(/\s+/)
  const ws = words(ing.name)
  if (ws.length > 1 && UNIT_WORDS.has(ws[0])) {
    const rest = raw.slice(1).join(' ').replace(/^(de|d['’]|des)\s*/i, '')
    return { name: rest, uk: ws[0], unitLabel: raw[0].toLowerCase().replace(/(s|x)$/, '') }
  }
  return { name: ing.name, uk: '', unitLabel: '' }
}

/** Entrée du dictionnaire pour les poids, à défaut de correspondance exacte (« carottes cuites » → carotte). */
function weightEntry(name: string): DictionaryEntry | null {
  const head = searchQuery(name).split(' ')[0]
  return head ? (matchDictionary(head)?.entry ?? null) : null
}

const linkTo = (food: Food, extra?: Partial<FoodLink>): FoodLink => ({ food, gramsPerUnit: null, density: null, overrides: {}, linkedAt: 0, ...extra })

/** Résout un ingrédient. `memory` : préférence mémorisée pour ce nom, s'il y en a une. */
export function resolveIngredient(ing: Ingredient, catalog: readonly CiqualFood[], memory: MemoryPreference | null): AutoMatch {
  // « 2 cubes de bouillon » : l'unité fait partie du nom de l'aliment.
  const eu = effectiveUnit(ing)
  const withUnit = eu.uk ? matchDictionary(`${eu.uk} ${eu.name}`) : null
  const dict = withUnit?.entry.units?.[eu.uk] ? withUnit : matchDictionary(eu.name)
  const fallback = () => dict?.entry ?? weightEntry(eu.name)
  const entryFor = (food: Food) => (food.source === 'ciqual' ? (dictionaryForCode(food.id) ?? fallback()) : fallback())

  if (ing.nutrition) {
    const memoryForWeights = memory && memory.food.id === ing.nutrition.food.id ? memory : null
    const entry = entryFor(ing.nutrition.food)
    return { origin: 'user', confidence: 'sure', link: ing.nutrition, candidates: [], usual: usualConversion(ing, entry, memoryForWeights), seasoning: entry?.seasoning }
  }
  if (memory) {
    return {
      origin: 'memory',
      confidence: 'sure',
      link: linkTo(memory.food),
      candidates: [],
      usual: usualConversion(ing, entryFor(memory.food), memory),
      seasoning: entryFor(memory.food)?.seasoning,
      note: 'Votre choix habituel',
    }
  }
  const byCode = (code: string) => catalog.find((f) => f.code === code)
  if (dict) {
    const food = byCode(dict.entry.ciqual)
    if (food) {
      const f = ciqualToFood(food)
      return {
        origin: 'dictionary',
        confidence: dict.assumed ? 'assumed' : 'sure',
        link: linkTo(f),
        candidates: [],
        usual: usualConversion(ing, dict.entry, null),
        seasoning: dict.entry.seasoning,
        note: dict.assumed ? `Variante courante supposée : ${dict.entry.label}` : undefined,
      }
    }
  }
  const fz = fuzzyMatch(eu.name, catalog)
  const candidates = fz.candidates.map(ciqualToFood)
  if (fz.best && !fz.ambiguous) {
    const f = ciqualToFood(fz.best)
    return {
      origin: 'search',
      confidence: 'approx',
      link: linkTo(f),
      candidates,
      usual: usualConversion(ing, dictionaryForCode(fz.best.code) ?? weightEntry(eu.name), null),
      note: `Correspondance approchée : ${fz.best.name}`,
    }
  }
  return {
    origin: fz.best ? 'search' : 'none',
    confidence: fz.best ? 'ambiguous' : 'none',
    link: null,
    candidates,
    usual: usualConversion(ing, null, null),
  }
}

/** Résout tous les ingrédients d'une recette. */
export function resolveAll(ingredients: readonly Ingredient[], catalog: readonly CiqualFood[], memory: (name: string) => MemoryPreference | null): AutoMap {
  const map: AutoMap = new Map()
  for (const ing of ingredients) if (ing.name.trim()) map.set(ing.id, resolveIngredient(ing, catalog, memory(ing.name)))
  return map
}
