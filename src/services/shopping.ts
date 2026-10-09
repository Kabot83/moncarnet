import { db } from '@/db/db'
import { newId } from '@/lib/id'
import { type ShoppingSource, buildShoppingLines, canMerge, categorize, mergeQuantities } from '@/lib/shopping'
import { parseIngredientLine } from '@/lib/units'
import type { ShoppingItem } from '@/models/types'

/** Ajoute les ingrédients des recettes choisies à la liste (ou la remplace). */
export async function addRecipesToShopping(sources: ShoppingSource[], mode: 'append' | 'replace'): Promise<number> {
  const lines = buildShoppingLines(sources)
  return db.transaction('rw', db.shopping, async () => {
    if (mode === 'replace') await db.shopping.clear()
    const existing = await db.shopping.toArray()
    const now = Date.now()
    let added = 0
    for (const l of lines) {
      const match = existing.find((e) => !e.checked && !e.manual && canMerge(e, l))
      if (match) {
        const q = mergeQuantities(match, l)
        match.quantity = q.quantity
        match.unit = q.unit
        match.extra = [match.extra, l.extra].filter(Boolean).join(', ')
        match.recipeTitles = [...new Set([...match.recipeTitles, ...l.recipeTitles])]
        await db.shopping.put(match)
      } else {
        const item: ShoppingItem = {
          id: newId('sh_'),
          name: l.name,
          quantity: l.quantity,
          unit: l.unit,
          extra: l.extra,
          category: l.category,
          checked: false,
          manual: false,
          recipeTitles: l.recipeTitles,
          createdAt: now + added,
        }
        await db.shopping.put(item)
        existing.push(item)
        added++
      }
    }
    return lines.length
  })
}

/** Ajout manuel : « 2 kg de pommes » est analysé, sinon la ligne est gardée telle quelle. */
export async function addManualItem(text: string) {
  const t = text.trim()
  if (!t) return
  const p = parseIngredientLine(t)
  await db.shopping.put({
    id: newId('sh_'),
    name: p.name || t,
    quantity: p.quantity,
    unit: p.unit,
    extra: '',
    category: categorize(p.name || t),
    checked: false,
    manual: true,
    recipeTitles: [],
    createdAt: Date.now(),
  })
}

export const toggleShoppingItem = (i: ShoppingItem) => db.shopping.update(i.id, { checked: !i.checked })
export const removeShoppingItem = (id: string) => db.shopping.delete(id)
export const clearChecked = () => db.shopping.filter((i) => i.checked).delete()
export const clearShopping = () => db.shopping.clear()
