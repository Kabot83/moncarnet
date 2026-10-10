/**
 * Extraction locale (sans IA) des ingrédients et étapes d'une légende de publication.
 * Ne reprend QUE ce qui est écrit : aucune quantité ni aucun ingrédient n'est ajouté.
 * Ce qui manque est signalé, pour être complété dans l'éditeur.
 */
import { parseIngredientLine } from '@/lib/units'
import type { Ingredient, Recipe, SocialPost, Step } from '@/models/types'
import { emptyIngredient, emptyRecipe, emptyStep } from '@/services/recipes'
import { PLATFORM_LABEL } from './links'

export interface LocalExtraction {
  ingredients: Ingredient[]
  steps: Step[]
  warnings: string[]
}

const BULLET = /^[\s\-–—•*·▪▫◦●○►▶➡→✔✓✅☑️🔸🔹👉📌🍴🥄🥣🧂]+/u
const ING_HEADER = /^(?:les\s+)?ingr[ée]dients?\b.*?:?\s*$|^(?:il (?:vous )?faut|liste des courses)\s*:?\s*$/i
const STEP_HEADER = /^(?:la\s+)?(?:pr[ée]paration|[ée]tapes?|instructions?|recette|m[ée]thode|d[ée]roul[ée])\s*:?\s*$/i
const NUMBERED = /^(?:[ée]tape\s*)?(\d{1,2})\s*[.):\-–]\s*(.+)$/i
const HASHTAGS_ONLY = /^(?:\s*#[\p{L}\p{N}_]+)+\s*$/u

function clean(line: string): string {
  return line
    .replace(BULLET, '')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractFromCaption(text: string): LocalExtraction {
  const lines = text
    .split(/\n|(?<=\S)\s+(?=[•▪►✅👉🔸🔹]\s)/u)
    .map((l) => l.trim())
    .filter((l) => l && !HASHTAGS_ONLY.test(l))
  const ingredients: Ingredient[] = []
  const steps: Step[] = []
  let mode: 'none' | 'ing' | 'step' = 'none'
  for (const raw of lines) {
    const line = clean(raw)
    if (!line) continue
    if (ING_HEADER.test(line)) {
      mode = 'ing'
      continue
    }
    if (STEP_HEADER.test(line)) {
      mode = 'step'
      continue
    }
    const numbered = NUMBERED.exec(line)
    if (numbered && numbered[2].length > 12 && mode !== 'ing') {
      steps.push(emptyStep({ text: numbered[2].trim() }))
      mode = 'step'
      continue
    }
    if (mode === 'step') {
      if (line.length > 3) steps.push(emptyStep({ text: line }))
      continue
    }
    const p = parseIngredientLine(line)
    const looksLikeIngredient = line.length <= 80 && (p.quantity != null || mode === 'ing')
    if (looksLikeIngredient && p.name) {
      ingredients.push(emptyIngredient({ name: p.name.slice(0, 200), quantity: p.quantity, unit: p.unit, quantityText: p.quantityText }))
    }
  }
  const warnings: string[] = []
  if (!ingredients.length) warnings.push('Aucun ingrédient n’a été trouvé dans le texte de la publication : ajoutez-les (la vidéo elle-même n’est pas analysée).')
  else {
    const noQty = ingredients.filter((i) => i.quantity == null).length
    if (noQty) warnings.push(`${noQty} ingrédient${noQty > 1 ? 's' : ''} sans quantité dans le texte : à compléter.`)
  }
  if (!steps.length) warnings.push('Aucune étape n’a été trouvée dans le texte : ajoutez-les si besoin.')
  return { ingredients, steps, warnings }
}

/** Texte de la publication disponible pour l'extraction (légende, texte partagé, titre). */
export function postSourceText(post: Pick<SocialPost, 'title' | 'description' | 'sharedText'>): string {
  const parts = [post.description, post.sharedText].map((t) => t.trim()).filter(Boolean)
  const unique = parts.filter((p, i) => !parts.slice(0, i).some((q) => q.includes(p)))
  return unique.join('\n\n')
}

/** Champs communs à toute fiche créée depuis une publication. */
export function recipeBaseFromPost(post: SocialPost): Partial<Recipe> {
  return {
    title: post.title.trim() || 'Recette à essayer',
    source: [PLATFORM_LABEL[post.platform], post.author || (post.authorHandle ? `@${post.authorHandle}` : '')].filter(Boolean).join(' · '),
    sourceUrl: post.url,
    sourcePostId: post.id,
    mainPhotoId: post.thumbnailPhotoId,
    tags: post.tags,
    toTry: true,
  }
}

/** Fiche brouillon sans IA : texte de la publication + éléments repérés localement. */
export function recipeFromPostLocally(post: SocialPost, text = postSourceText(post)): { recipe: Recipe; warnings: string[] } {
  const ex = extractFromCaption(text)
  const recipe = emptyRecipe({
    ...recipeBaseFromPost(post),
    description: ex.ingredients.length || ex.steps.length ? '' : clean(text.replace(/\n+/g, ' ')).slice(0, 3000),
    ingredients: ex.ingredients.length ? ex.ingredients : [emptyIngredient()],
    steps: ex.steps.length ? ex.steps : [emptyStep()],
    servings: null,
  })
  const warnings = [...ex.warnings]
  warnings.push('Portions, temps et température ne sont repris que s’ils figurent dans le texte : vérifiez-les.')
  return { recipe, warnings }
}
