import Dexie from 'dexie'
import { describe, expect, it } from 'vitest'
import { CarnetDB, DB_VERSION } from '@/db/db'
import { computeNutrition } from '@/nutrition/engine'

describe('migration de la base locale v2 → v3 (nutrition)', () => {
  it('conserve les recettes existantes et ajoute les champs vides, sans association automatique', async () => {
    const name = 'migration-test'
    // Base telle qu'installée par la version précédente (v2), avec une recette.
    const old = new Dexie(name)
    old.version(2).stores({
      recipes: 'id, title, category, updatedAt, createdAt, favorite, toTry, lastCookedAt, isDemo, rating, cookCount, *tags',
      settings: 'key',
    })
    await old.open()
    await old.table('recipes').put({
      id: 'r1',
      title: 'Blanquette',
      category: 'plat',
      servings: 6,
      ingredients: [{ id: 'i1', name: 'veau', quantity: 1.2, unit: 'kg', quantityText: '', note: '', group: '', scalable: true, toTaste: false }],
      steps: [],
      tags: [],
      createdAt: 1,
      updatedAt: 2,
      rating: 4,
      cookCount: 3,
    })
    old.close()

    const db = new CarnetDB(name)
    await db.open()
    expect(db.verno).toBe(DB_VERSION)
    const r = (await db.recipes.get('r1'))!
    expect(r).toMatchObject({ title: 'Blanquette', rating: 4, cookCount: 3, cookedWeightG: null, cookedWeightRawG: null })
    expect(r.ingredients[0]).toMatchObject({ name: 'veau', quantity: 1.2, nutrition: null, nutritionExcluded: false })
    expect(await db.foods.count()).toBe(0)
    // La recette est simplement « à associer » : aucun chiffre inventé.
    expect(computeNutrition(r.ingredients).blocking[0].status).toBe('unlinked')
    db.close()
    await Dexie.delete(name)
  })
})

describe('migration de la base locale v3 → v4 (« À essayer »)', () => {
  it('conserve recettes, associations nutritionnelles et aliments ; ajoute la bibliothèque vide', async () => {
    const name = 'migration-test-v4'
    const old = new Dexie(name)
    old.version(3).stores({
      recipes: 'id, title, category, updatedAt, createdAt, favorite, toTry, lastCookedAt, isDemo, rating, cookCount, *tags',
      foods: 'key, favorite, lastUsedAt, updatedAt',
      foodMemory: 'nameKey, updatedAt',
      settings: 'key',
    })
    await old.open()
    const link = { food: { source: 'ciqual', id: '20034', name: 'Oignon, cru', brand: '', basis: '100g', per100: { kcal: 39 }, version: 'Ciqual 2025', notes: [], fetchedAt: 1 }, gramsPerUnit: 150, density: null, overrides: {}, linkedAt: 1 }
    await old.table('recipes').put({
      id: 'r1',
      title: 'Soupe',
      category: 'plat',
      ingredients: [{ id: 'i1', name: 'oignon', quantity: 1, unit: '', quantityText: '', note: '', group: '', scalable: true, toTaste: false, nutrition: link, nutritionExcluded: false }],
      steps: [],
      tags: ['hiver'],
      createdAt: 1,
      updatedAt: 2,
      rating: 0,
      cookCount: 0,
      cookedWeightG: 900,
      cookedWeightRawG: 1000,
    })
    await old.table('foodMemory').put({ nameKey: 'oignon', foodKey: 'ciqual:20034', gramsPerUnit: 150, density: null, updatedAt: 1 })
    old.close()

    const db = new CarnetDB(name)
    await db.open()
    expect(db.verno).toBe(4)
    const r = (await db.recipes.get('r1'))!
    expect(r).toMatchObject({ title: 'Soupe', cookedWeightG: 900, sourcePostId: null, tags: ['hiver'] })
    expect(r.ingredients[0].nutrition).toMatchObject({ gramsPerUnit: 150 })
    expect(await db.foodMemory.get('oignon')).toMatchObject({ gramsPerUnit: 150 })
    expect(await db.posts.count()).toBe(0)
    db.close()
    await Dexie.delete(name)
  })
})
