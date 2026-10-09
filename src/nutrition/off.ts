/**
 * Open Food Facts — produits industriels et de marques.
 *
 * - API officielle, appelée directement, sans proxy :
 *   · fiches produit (/api/v2/product) : ouvertes à toutes les origines (CORS), fiables ;
 *   · recherche : dans l'APK (requête native, sans contrainte CORS), moteur
 *     search.openfoodfacts.org, plus fiable ; dans la PWA, ce moteur refusant les
 *     navigateurs (CORS), recherche historique /cgi/search.pl, parfois saturée (503) :
 *     une seule nouvelle tentative espacée, puis un message clair.
 * - Un produit choisi dans les résultats est relu par sa fiche complète (code-barres)
 *   pour garantir l'unité de référence (100 g ou 100 ml) et des valeurs à jour.
 * - Identification de l'application : User-Agent dans l'APK (requête native) ;
 *   dans le navigateur, où le User-Agent ne peut pas être modifié, paramètres app_name/app_version.
 * - Limites d'utilisation respectées : recherche uniquement sur demande (jamais à chaque
 *   lettre), au plus 8 recherches et 60 fiches produit par minute depuis l'appareil ;
 *   les produits choisis sont conservés localement (pas de nouvel appel ensuite).
 * - Données sous licence ODbL : attribution « Open Food Facts » affichée avec les résultats.
 */
import { formatDate } from '@/lib/format'
import type { Food, Per100 } from '@/models/types'
import { isNative } from '@/platform/native'
import { kjToKcal } from './engine'

export const OFF_ATTRIBUTION = 'Open Food Facts — données sous licence ODbL'
export const OFF_URL = 'https://world.openfoodfacts.org'
export const OFF_SEARCH_URL = 'https://search.openfoodfacts.org'
const APP = { name: 'MonCarnet', version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev' }
const USER_AGENT = `${APP.name}/${APP.version} (https://github.com/Kabot83/moncarnet)`
const FIELDS = 'code,product_name,product_name_fr,generic_name_fr,brands,quantity,nutriments,nutrition_data_per,last_modified_t'

export class OffError extends Error {
  constructor(
    public kind: 'offline' | 'rate' | 'not-found' | 'invalid' | 'network' | 'busy',
    message: string,
  ) {
    super(message)
  }
}

// --- Limitation locale du débit ------------------------------------------------

const calls: Record<'search' | 'product', number[]> = { search: [], product: [] }
const LIMITS = { search: 8, product: 60 }

export function checkRate(kind: 'search' | 'product', now = Date.now()) {
  calls[kind] = calls[kind].filter((t) => now - t < 60_000)
  if (calls[kind].length >= LIMITS[kind]) {
    const wait = Math.ceil((60_000 - (now - calls[kind][0])) / 1000)
    throw new OffError('rate', `Trop de recherches en une minute : réessayez dans ${wait} s (limite d’Open Food Facts).`)
  }
  calls[kind].push(now)
}

export function resetRate() {
  calls.search = []
  calls.product = []
}

const BUSY = 'Le service de recherche d’Open Food Facts est momentanément saturé. Réessayez dans quelques secondes, ou saisissez le code-barres du produit.'

async function getJson(url: string): Promise<unknown> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OffError('offline', 'Hors ligne : Open Food Facts est indisponible. La table CIQUAL reste utilisable.')
  try {
    if (isNative) {
      const { CapacitorHttp } = await import('@capacitor/core')
      const res = await CapacitorHttp.get({ url, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, connectTimeout: 15_000, readTimeout: 20_000 })
      if (res.status === 404) throw new OffError('not-found', 'Produit introuvable dans Open Food Facts.')
      if (res.status === 429) throw new OffError('rate', 'Open Food Facts limite temporairement les requêtes. Réessayez dans une minute.')
      if (res.status >= 500) throw new OffError('busy', BUSY)
      if (res.status >= 400) throw new OffError('network', `Open Food Facts a répondu ${res.status}.`)
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data
    }
    const sep = url.includes('?') ? '&' : '?'
    const res = await fetch(`${url}${sep}app_name=${APP.name}&app_version=${encodeURIComponent(APP.version)}`, { signal: AbortSignal.timeout(20_000) })
    if (res.status === 404) throw new OffError('not-found', 'Produit introuvable dans Open Food Facts.')
    if (res.status === 429) throw new OffError('rate', 'Open Food Facts limite temporairement les requêtes. Réessayez dans une minute.')
    if (res.status >= 500) throw new OffError('busy', BUSY)
    if (!res.ok) throw new OffError('network', `Open Food Facts a répondu ${res.status}.`)
    return await res.json()
  } catch (e) {
    if (e instanceof OffError) throw e
    throw new OffError('network', 'Impossible de joindre Open Food Facts. Vérifiez la connexion.')
  }
}

// --- Conversion d'un produit -------------------------------------------------

interface OffProduct {
  code?: string
  brands?: string | string[]
  product_name?: string
  product_name_fr?: string
  generic_name_fr?: string
  quantity?: string
  nutrition_data_per?: string
  last_modified_t?: number
  nutriments?: Record<string, unknown>
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** Produit OFF → aliment. Les champs absents restent `null` (jamais zéro). */
export function offToFood(p: OffProduct): Food | null {
  const code = String(p.code ?? '').trim()
  const name = (p.product_name_fr || p.product_name || p.generic_name_fr || '').trim()
  if (!/^\d{4,14}$/.test(code) || !name) return null
  const n = p.nutriments ?? {}
  const notes: string[] = []
  // « energy_100g » est en kJ dans Open Food Facts : on ne lit QUE energy-kcal_100g et energy-kj_100g.
  let kcal = num(n['energy-kcal_100g'])
  const kj = num(n['energy-kj_100g'])
  if (kcal == null && kj != null) {
    kcal = kjToKcal(kj)
    notes.push('Énergie calculée depuis la valeur en kJ')
  }
  const per100: Per100 = {
    kcal,
    kj,
    protein: num(n.proteins_100g),
    carbs: num(n.carbohydrates_100g),
    fat: num(n.fat_100g),
    fiber: num(n.fiber_100g),
    sugars: num(n.sugars_100g),
    satFat: num(n['saturated-fat_100g']),
    salt: num(n.salt_100g),
  }
  const missingMain = (['kcal', 'protein', 'carbs', 'fat'] as const).filter((k) => per100[k] == null)
  if (missingMain.length) notes.push('Fiche incomplète dans Open Food Facts')
  return {
    source: 'off',
    id: code,
    name,
    brand: (Array.isArray(p.brands) ? (p.brands[0] ?? '') : (p.brands ?? '').split(',')[0]).trim(),
    basis: p.nutrition_data_per === '100ml' ? '100ml' : '100g',
    per100,
    version: p.last_modified_t ? `Open Food Facts, fiche du ${formatDate(p.last_modified_t * 1000)}` : 'Open Food Facts',
    notes,
    fetchedAt: Date.now(),
  }
}

export const isComplete = (f: Food) => (['kcal', 'protein', 'carbs', 'fat'] as const).every((k) => f.per100[k] != null)

export interface OffSearchResult {
  foods: Food[]
  count: number
  page: number
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Recherche par nom ou marque (sur action explicite de l'utilisateur). */
export async function searchOff(query: string, page = 1): Promise<OffSearchResult> {
  const q = query.trim()
  if (q.length < 2) throw new OffError('invalid', 'Saisissez au moins deux caractères.')
  if (/^\d{8,14}$/.test(q)) {
    const f = await getOffProduct(q)
    return { foods: [f], count: 1, page: 1 }
  }
  checkRate('search')
  if (isNative) {
    try {
      const url = `${OFF_SEARCH_URL}/search?q=${encodeURIComponent(q)}&page_size=20&page=${page}&langs=fr&fields=${FIELDS}`
      const data = (await getJson(url)) as { count?: number; hits?: OffProduct[] }
      const foods = (data.hits ?? []).map(offToFood).filter((f): f is Food => f != null)
      return { foods, count: data.count ?? foods.length, page }
    } catch (e) {
      if (e instanceof OffError && (e.kind === 'offline' || e.kind === 'rate')) throw e
      // Moteur indisponible : repli sur la recherche historique.
    }
  }
  const url = `${OFF_URL}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&json=1&page_size=20&page=${page}&lc=fr&fields=${FIELDS}`
  let data: { count?: number; products?: OffProduct[] }
  try {
    data = (await getJson(url)) as typeof data
  } catch (e) {
    if (!(e instanceof OffError) || e.kind !== 'busy') throw e
    await wait(2000) // une seule nouvelle tentative, espacée
    data = (await getJson(url)) as typeof data
  }
  const foods = (data.products ?? []).map(offToFood).filter((f): f is Food => f != null)
  return { foods, count: data.count ?? foods.length, page }
}

/**
 * Produit choisi dans les résultats : relecture de sa fiche complète (unité de référence
 * 100 g / 100 ml, valeurs à jour). Hors ligne, on garde les données de la recherche.
 */
export async function confirmOffProduct(food: Food): Promise<Food> {
  try {
    return await getOffProduct(food.id)
  } catch (e) {
    if (e instanceof OffError && (e.kind === 'offline' || e.kind === 'network' || e.kind === 'busy')) {
      return { ...food, notes: [...food.notes, 'Fiche non relue (hors ligne) : unité de référence à vérifier'] }
    }
    throw e
  }
}

/** Fiche produit par code-barres (EAN-8 / EAN-13 / UPC). */
export async function getOffProduct(barcode: string): Promise<Food> {
  const code = barcode.replace(/\s+/g, '')
  if (!/^\d{8,14}$/.test(code)) throw new OffError('invalid', 'Code-barres invalide (8 à 14 chiffres).')
  checkRate('product')
  const data = (await getJson(`${OFF_URL}/api/v2/product/${code}?fields=${FIELDS}`)) as { status?: number; product?: OffProduct }
  const food = data.product ? offToFood({ ...data.product, code: data.product.code ?? code }) : null
  if (!food) throw new OffError('not-found', 'Produit introuvable dans Open Food Facts.')
  return food
}

