/**
 * Génération de la liste de courses (logique pure, testée).
 *
 * - Les ingrédients identiques (même nom normalisé) sont regroupés.
 * - Les quantités d'unités compatibles sont additionnées (g + kg, ml + cl + l).
 * - Les unités incompatibles restent sur des lignes séparées (pas de conversion masse ↔ volume).
 * - Les quantités non numériques (« selon le goût ») sont conservées en mention.
 */
import type { Ingredient, Recipe, ScaleState, ShopCategory } from '@/models/types'
import { scaledQuantity } from './scaling'
import { normalize } from './text'
import { displayQuantity, normalizeUnit, toBaseUnit } from './units'

export interface ShoppingSource {
  recipe: Pick<Recipe, 'title' | 'ingredients'>
  scale: ScaleState
}

export interface ShoppingLine {
  key: string
  name: string
  quantity: number | null
  unit: string
  extra: string
  category: ShopCategory
  recipeTitles: string[]
}

/** Clé de regroupement : nom normalisé, au singulier approximatif. */
export function ingredientKey(name: string): string {
  return normalize(name)
    .replace(/\(.*?\)/g, '')
    .split(' ')
    .map((w) => (w.length > 3 ? w.replace(/(s|x)$/, '') : w))
    .join(' ')
    .trim()
}

/** Dimension de regroupement d'une unité. */
function unitBucket(unit: string): string {
  const d = normalizeUnit(unit)
  if (d.kind === 'mass') return 'mass'
  if (d.kind === 'volume') return 'volume'
  return `u:${d.canonical.toLowerCase()}`
}

export function buildShoppingLines(sources: ShoppingSource[]): ShoppingLine[] {
  const lines = new Map<string, ShoppingLine>()
  for (const { recipe, scale } of sources) {
    for (const ing of recipe.ingredients) {
      if (!ing.name.trim()) continue
      addIngredient(lines, ing, scaledQuantity(ing, scale), recipe.title)
    }
  }
  return [...lines.values()].map(finalizeLine)
}

function addIngredient(lines: Map<string, ShoppingLine>, ing: Ingredient, q: number | null, title: string) {
  const key = ingredientKey(ing.name)
  const bucket = q == null ? 'none' : unitBucket(ing.unit)
  const id = `${key}|${bucket}`
  let line = lines.get(id)
  if (!line) {
    line = {
      key,
      name: ing.name.trim(),
      quantity: null,
      unit: '',
      extra: '',
      category: categorize(ing.name),
      recipeTitles: [],
    }
    lines.set(id, line)
  }
  if (!line.recipeTitles.includes(title)) line.recipeTitles.push(title)
  if (q == null) {
    const txt = ing.toTaste ? 'selon le goût' : ing.quantityText || ''
    if (txt && !line.extra.includes(txt)) line.extra = line.extra ? `${line.extra}, ${txt}` : txt
    return
  }
  const base = toBaseUnit(q, ing.unit)
  if (base) {
    line.quantity = (line.quantity ?? 0) + base.value
    line.unit = base.unit
  } else {
    line.quantity = (line.quantity ?? 0) + q
    line.unit = normalizeUnit(ing.unit).canonical || ing.unit.trim()
  }
}

/** Convertit 1500 g en 1,5 kg pour l'affichage final de la liste. */
function finalizeLine(l: ShoppingLine): ShoppingLine {
  if (l.quantity != null && (l.unit === 'g' || l.unit === 'ml') && l.quantity >= 1000) {
    return { ...l, quantity: l.quantity / 1000, unit: l.unit === 'g' ? 'kg' : 'l' }
  }
  return l
}

/** Fusionne une ligne dans une liste existante si le produit et l'unité sont compatibles. */
export function canMerge(a: { name: string; unit: string; quantity: number | null }, b: { name: string; unit: string; quantity: number | null }) {
  if (ingredientKey(a.name) !== ingredientKey(b.name)) return false
  if (a.quantity == null || b.quantity == null) return a.quantity == null && b.quantity == null
  return unitBucket(a.unit) === unitBucket(b.unit)
}

export function mergeQuantities(a: { quantity: number | null; unit: string }, b: { quantity: number | null; unit: string }) {
  if (a.quantity == null || b.quantity == null) return { quantity: a.quantity ?? b.quantity, unit: a.unit || b.unit }
  const ba = toBaseUnit(a.quantity, a.unit)
  const bb = toBaseUnit(b.quantity, b.unit)
  if (ba && bb) return finalizeLine({ quantity: ba.value + bb.value, unit: ba.unit } as ShoppingLine)
  return { quantity: a.quantity + b.quantity, unit: a.unit }
}

// ---------------------------------------------------------------------------
// Rayons
// ---------------------------------------------------------------------------

const RAYONS: Array<[ShopCategory, RegExp]> = [
  ['Épices et condiments', /\b(sel|poivre|epice|cannelle|muscade|paprika|cumin|curry|piment|moutarde|vinaigre|sauce soja|ketchup|mayonnaise|herbes de provence|bouillon|levure|bicarbonate|vanille|cornichon|capre)/],
  ['Boucherie et poissonnerie', /\b(boeuf|veau|porc|agneau|poulet|dinde|canard|jambon|lardon|saucisse|viande|steak|jarret|cote|filet de|saumon|thon|cabillaud|crevette|poisson|moule|chorizo|bacon|hache)/],
  ['Crèmerie et œufs', /\b(oeuf|lait|beurre|creme|fromage|parmesan|mozzarella|gruyere|comte|emmental|yaourt|skyr|fromage blanc|ricotta|mascarpone|feta|chevre)/],
  ['Fruits et légumes', /\b(pomme|poire|banane|citron|orange|fraise|framboise|myrtille|fruit|tomate|courgette|aubergine|poivron|carotte|oignon|echalote|ail|pomme de terre|patate|salade|epinard|champignon|poireau|celeri|navet|chou|brocoli|haricot vert|petit pois|concombre|avocat|persil|coriandre|basilic|ciboulette|menthe|thym|romarin|laurier|gingembre|legume|courge|potiron|radis|fenouil|mangue|ananas|raisin)/],
  ['Boulangerie', /\b(pain|baguette|brioche|pate feuilletee|pate brisee|pate sablee|tortilla|pita)/],
  ['Épicerie sucrée', /\b(sucre|chocolat|cacao|miel|confiture|sirop|farine|maizena|fecule|amande en poudre|poudre d amande|levure chimique|biscuit|flocons d avoine|avoine|cassonade|pepites|noisette|noix|amande|whey|proteine)/],
  ['Épicerie salée', /\b(huile|riz|pate|pates|spaghetti|lentille|pois chiche|semoule|quinoa|conserve|concentre|coulis|olive|chapelure|vin|biere)/],
  ['Boissons', /\b(eau|jus|soda|cafe|the|lait vegetal|boisson)/],
  ['Surgelés', /\b(surgele|glace)/],
]

export function categorize(name: string): ShopCategory {
  const n = ` ${normalize(name)}`
  for (const [cat, re] of RAYONS) if (re.test(n)) return cat
  return 'Autres'
}

// ---------------------------------------------------------------------------
// Partage texte
// ---------------------------------------------------------------------------

export function formatLine(l: { name: string; quantity: number | null; unit: string; extra: string }): string {
  const parts: string[] = []
  if (l.quantity != null) {
    const d = displayQuantity(l.quantity, l.unit, { rounding: 'practical', name: l.name })
    parts.push(`${d.value}${d.unit ? ` ${d.unit}` : ''}`)
  }
  if (l.extra) parts.push(l.extra)
  return parts.length ? `${l.name} — ${parts.join(' + ')}` : l.name
}

export function shoppingText(
  items: Array<{ name: string; quantity: number | null; unit: string; extra: string; category: ShopCategory; checked: boolean }>,
): string {
  const remaining = items.filter((i) => !i.checked)
  const byCat = new Map<string, string[]>()
  for (const i of remaining) {
    const list = byCat.get(i.category) ?? []
    list.push(`☐ ${formatLine(i)}`)
    byCat.set(i.category, list)
  }
  const blocks = [...byCat.entries()].map(([cat, lines]) => `${cat.toUpperCase()}\n${lines.join('\n')}`)
  return `Liste de courses — Mon Carnet\n\n${blocks.join('\n\n')}`
}
