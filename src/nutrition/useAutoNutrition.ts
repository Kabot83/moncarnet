/**
 * Calcul nutritionnel automatique côté interface : table CIQUAL (chargée une fois, hors ligne)
 * + préférences mémorisées (IndexedDB) → correspondances pour chaque ingrédient.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { useEffect, useMemo, useState } from 'react'
import { db } from '@/db/db'
import type { Food, Ingredient } from '@/models/types'
import { type AutoMap, type MemoryPreference, resolveAll } from './auto'
import { type CiqualFood, ciqualToFood, loadCiqual } from './ciqual'
import { nameKey } from './foods'

export function useCiqualCatalog(): CiqualFood[] | null {
  const [catalog, setCatalog] = useState<CiqualFood[] | null>(null)
  useEffect(() => {
    let alive = true
    void loadCiqual().then((c) => alive && setCatalog(c))
    return () => {
      alive = false
    }
  }, [])
  return catalog
}

interface StoredPreference {
  foodKey: string
  food: Food | null
  gramsPerUnit: number | null
  density: number | null
}

/** Correspondances automatiques des ingrédients (null pendant le chargement de la table). */
export function useAutoMatches(ingredients: readonly Ingredient[]): AutoMap | null {
  const catalog = useCiqualCatalog()
  const keys = useMemo(() => [...new Set(ingredients.map((i) => nameKey(i.name)).filter(Boolean))], [ingredients])
  const prefs = useLiveQuery(
    async () => {
      const out = new Map<string, StoredPreference>()
      const mems = await db.foodMemory.bulkGet(keys)
      for (const m of mems) {
        if (!m) continue
        const entry = await db.foods.get(m.foodKey)
        out.set(m.nameKey, { foodKey: m.foodKey, food: entry?.food ?? null, gramsPerUnit: m.gramsPerUnit, density: m.density })
      }
      return out
    },
    [keys.join('|')],
  )
  return useMemo(() => {
    if (!catalog || !prefs) return null
    const memory = (name: string): MemoryPreference | null => {
      const p = prefs.get(nameKey(name))
      if (!p) return null
      let food = p.food
      if (!food && p.foodKey.startsWith('ciqual:')) {
        const f = catalog.find((c) => c.code === p.foodKey.slice(7))
        food = f ? ciqualToFood(f) : null
      }
      return food ? { food, gramsPerUnit: p.gramsPerUnit, density: p.density } : null
    }
    return resolveAll(ingredients, catalog, memory)
  }, [catalog, prefs, ingredients])
}
