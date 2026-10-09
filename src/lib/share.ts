import { NOTE_FIELDS, type Recipe, type ScaleState } from '@/models/types'
import { formatDuration } from './format'
import { IDENTITY_SCALE, scaledQuantity, scaledServings } from './scaling'
import { displayQuantity, formatNumber } from './units'

/** Version texte d'une recette (partage, presse-papiers). */
export function recipeToText(r: Recipe, scale: ScaleState = IDENTITY_SCALE): string {
  const servings = scaledServings(scale, r.servings)
  const lines: string[] = [r.title.toUpperCase()]
  if (r.description) lines.push('', r.description)
  const meta = [
    servings ? `${formatNumber(servings, 1)} portions` : '',
    r.prepTime ? `Préparation : ${formatDuration(r.prepTime)}` : '',
    r.cookTime ? `Cuisson : ${formatDuration(r.cookTime)}` : '',
    r.restTime ? `Repos : ${formatDuration(r.restTime)}` : '',
  ].filter(Boolean)
  if (meta.length) lines.push('', meta.join(' · '))
  lines.push('', 'INGRÉDIENTS')
  let group = ''
  for (const i of r.ingredients) {
    if (i.group && i.group !== group) {
      group = i.group
      lines.push(`${group} :`)
    }
    const q = scaledQuantity(i, scale)
    const d = q != null ? displayQuantity(q, i.unit, { rounding: 'practical', name: i.name }) : null
    const qty = d ? `${d.value}${d.unit ? ` ${d.unit}` : ''} ` : ''
    const extra = i.toTaste ? ' (selon le goût)' : !d && i.quantityText ? ` (${i.quantityText})` : ''
    lines.push(`• ${qty}${i.name}${extra}${i.note ? `, ${i.note}` : ''}`)
  }
  lines.push('', 'PRÉPARATION')
  r.steps.forEach((s, k) => lines.push(`${k + 1}. ${s.text}`))
  const notes = NOTE_FIELDS.filter((f) => r.notes[f.id]?.trim())
  if (notes.length) {
    lines.push('', 'MES NOTES')
    notes.forEach((f) => lines.push(`${f.label} : ${r.notes[f.id].trim()}`))
  }
  if (r.sourceUrl) lines.push('', `Source : ${r.sourceUrl}`)
  lines.push('', '— Partagé depuis Mon Carnet')
  return lines.join('\n')
}

/** Partage natif Android, sinon copie dans le presse-papiers. */
export async function shareText(title: string, text: string): Promise<'shared' | 'copied' | 'cancelled'> {
  if (navigator.share) {
    try {
      await navigator.share({ title, text })
      return 'shared'
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return 'cancelled'
    }
  }
  await navigator.clipboard.writeText(text)
  return 'copied'
}
