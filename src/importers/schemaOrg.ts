/**
 * Extraction d'une recette depuis une page HTML, en privilégiant les données
 * structurées Schema.org/Recipe (JSON-LD, puis microdonnées).
 * Module pur : reçoit du HTML, renvoie une proposition à vérifier.
 */
import { parseIngredientLine, parseQuantity } from '@/lib/units'
import type { Recipe } from '@/models/types'
import { emptyIngredient, emptyRecipe, emptyStep } from '@/services/recipes'
import { guessCategory } from '@/ai/convert'

export interface ExtractedRecipe {
  recipe: Recipe
  imageUrl: string | null
  method: 'json-ld' | 'microdata' | 'meta'
  warnings: string[]
}

/** « PT1H30M » → 90 ; « P1DT2H » → 1560. */
export function parseIsoDuration(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i)
  if (!m) {
    const n = parseInt(v, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const total = (parseFloat(m[1] ?? '0') * 24 + parseFloat(m[2] ?? '0')) * 60 + parseFloat(m[3] ?? '0') + parseFloat(m[4] ?? '0') / 60
  return total > 0 ? Math.round(total) : null
}

function decodeEntities(s: string): string {
  if (typeof document === 'undefined') return s.replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  const t = document.createElement('textarea')
  t.innerHTML = s
  return t.value
}

const text = (v: unknown): string => {
  if (v == null) return ''
  if (typeof v === 'string') return decodeEntities(v.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
  if (typeof v === 'number') return String(v)
  if (Array.isArray(v)) return text(v[0])
  if (typeof v === 'object' && 'text' in (v as object)) return text((v as { text: unknown }).text)
  if (typeof v === 'object' && 'name' in (v as object)) return text((v as { name: unknown }).name)
  return ''
}

function isRecipeType(t: unknown): boolean {
  if (typeof t === 'string') return /(^|\/)Recipe$/i.test(t)
  if (Array.isArray(t)) return t.some(isRecipeType)
  return false
}

/** Cherche un objet Recipe dans un JSON-LD arbitraire (@graph, tableaux…). */
export function findRecipeNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || depth > 6) return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipeNode(n, depth + 1)
      if (r) return r
    }
    return null
  }
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>
    if (isRecipeType(o['@type'])) return o
    for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
      const r = findRecipeNode(o[k], depth + 1)
      if (r) return r
    }
  }
  return null
}

function instructionsToSteps(v: unknown): string[] {
  if (!v) return []
  if (typeof v === 'string') {
    const t = decodeEntities(v.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li)>/gi, '\n').replace(/<[^>]+>/g, ''))
    return t
      .split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/)
      .map((s) => s.replace(/^\s*\d+[.)]\s*/, '').trim())
      .filter((s) => s.length > 2)
  }
  if (Array.isArray(v)) return v.flatMap(instructionsToSteps)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.itemListElement) return instructionsToSteps(o.itemListElement)
    const t = text(o.text ?? o.name)
    return t ? [t] : []
  }
  return []
}

function sectionsOf(v: unknown): Array<{ name: string; steps: string[] }> | null {
  if (!Array.isArray(v) || !v.some((x) => x && typeof x === 'object' && /HowToSection/i.test(String((x as { '@type'?: unknown })['@type'])))) return null
  return v.map((x) => ({ name: text((x as { name?: unknown }).name), steps: instructionsToSteps(x) }))
}

function imageUrlOf(v: unknown, base: string): string | null {
  let url: string | null = null
  if (typeof v === 'string') url = v
  else if (Array.isArray(v)) return imageUrlOf(v[0], base)
  else if (v && typeof v === 'object') url = text((v as { url?: unknown }).url ?? (v as { contentUrl?: unknown }).contentUrl) || null
  if (!url) return null
  try {
    return new URL(url, base).href
  } catch {
    return null
  }
}

function yieldToServings(v: unknown): number | null {
  const s = Array.isArray(v) ? v.map(text).join(' ') : text(v)
  const m = s.match(/(\d+(?:[.,]\d+)?)/)
  return m ? parseQuantity(m[1]) : null
}

function fromSchemaNode(o: Record<string, unknown>, pageUrl: string, method: ExtractedRecipe['method']): ExtractedRecipe {
  const warnings: string[] = []
  const lines = (Array.isArray(o.recipeIngredient) ? o.recipeIngredient : Array.isArray(o.ingredients) ? o.ingredients : [])
    .map(text)
    .filter(Boolean)
  const ingredients = lines.map((l) => {
    const p = parseIngredientLine(l)
    return emptyIngredient({ name: p.name, quantity: p.quantity, unit: p.unit, quantityText: p.quantityText })
  })
  const sections = sectionsOf(o.recipeInstructions)
  const steps = sections
    ? sections.flatMap((s) => s.steps.map((t, k) => emptyStep({ text: k === 0 && s.name ? `${s.name} — ${t}` : t })))
    : instructionsToSteps(o.recipeInstructions).map((t) => emptyStep({ text: t }))
  if (!ingredients.length) warnings.push('Aucun ingrédient trouvé dans les données de la page.')
  if (!steps.length) warnings.push('Aucune étape trouvée dans les données de la page.')
  const unparsed = ingredients.filter((i) => i.quantity == null).length
  if (unparsed) warnings.push(`${unparsed} ingrédient(s) sans quantité reconnue : à vérifier.`)
  const keywords = text(o.keywords)
  const recipe = emptyRecipe({
    title: text(o.name).slice(0, 200) || 'Recette importée',
    description: text(o.description).slice(0, 3000),
    prepTime: parseIsoDuration(o.prepTime),
    cookTime: parseIsoDuration(o.cookTime),
    restTime: null,
    servings: yieldToServings(o.recipeYield),
    category: guessCategory(text(o.recipeCategory)),
    tags: keywords
      ? keywords
          .split(',')
          .map((k) => k.trim())
          .filter((k) => k && k.length <= 40)
          .slice(0, 8)
      : [],
    ingredients,
    steps,
    source: text((o.author as { name?: unknown })?.name ?? o.author) || new URL(pageUrl).hostname,
    sourceUrl: pageUrl,
  })
  const total = parseIsoDuration(o.totalTime)
  if (total && !recipe.prepTime && !recipe.cookTime) recipe.prepTime = total
  return { recipe, imageUrl: imageUrlOf(o.image, pageUrl), method, warnings }
}

/** Microdonnées itemprop (sites plus anciens). */
function fromMicrodata(doc: Document, pageUrl: string): ExtractedRecipe | null {
  const root = doc.querySelector('[itemtype*="schema.org/Recipe" i]')
  if (!root) return null
  const prop = (name: string) => [...root.querySelectorAll(`[itemprop="${name}"]`)]
  const val = (el: Element) => el.getAttribute('content') ?? el.getAttribute('datetime') ?? el.getAttribute('src') ?? el.textContent ?? ''
  const o: Record<string, unknown> = {
    name: prop('name')[0] ? val(prop('name')[0]) : '',
    description: prop('description')[0] ? val(prop('description')[0]) : '',
    recipeIngredient: [...prop('recipeIngredient'), ...prop('ingredients')].map(val),
    recipeInstructions: prop('recipeInstructions').map(val).join('\n'),
    prepTime: prop('prepTime')[0] ? val(prop('prepTime')[0]) : null,
    cookTime: prop('cookTime')[0] ? val(prop('cookTime')[0]) : null,
    totalTime: prop('totalTime')[0] ? val(prop('totalTime')[0]) : null,
    recipeYield: prop('recipeYield')[0] ? val(prop('recipeYield')[0]) : null,
    image: prop('image')[0] ? val(prop('image')[0]) : null,
  }
  return fromSchemaNode(o, pageUrl, 'microdata')
}

export function extractRecipeFromHtml(html: string, pageUrl: string): ExtractedRecipe | null {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const s of doc.querySelectorAll('script[type="application/ld+json" i]')) {
    try {
      const node = findRecipeNode(JSON.parse(s.textContent ?? ''))
      if (node) return fromSchemaNode(node, pageUrl, 'json-ld')
    } catch {
      /* JSON-LD invalide : on essaie le suivant */
    }
  }
  const micro = fromMicrodata(doc, pageUrl)
  if (micro) return micro
  return null
}

/** Texte lisible d'une page (repli : import IA par texte). */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,style,noscript,nav,footer,header,aside,form,iframe,svg').forEach((n) => n.remove())
  const main = doc.querySelector('article, main, [role="main"]') ?? doc.body
  return (main?.textContent ?? '').replace(/\n\s*\n+/g, '\n').replace(/[ \t]+/g, ' ').trim()
}

export function pageTitle(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? doc.title ?? ''
}
