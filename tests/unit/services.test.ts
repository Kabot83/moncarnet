import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { seedDemoData } from '@/db/seed'
import { IDENTITY_SCALE, scaleFromIngredient } from '@/lib/scaling'
import {
  ValidationError,
  buildVariant,
  deleteCollection,
  deleteDemoData,
  deleteJournalEntry,
  deleteRecipe,
  emptyIngredient,
  emptyRecipe,
  emptyStep,
  replaceOriginalQuantities,
  saveCollection,
  saveJournalEntry,
  saveRecipe,
  saveVariant,
  setRecipeInCollection,
  toggleFavorite,
} from '@/services/recipes'
import { endSession, setSessionScale, startCooking } from '@/services/sessions'
import { putPhoto } from '@/services/photos'

async function reset() {
  await Promise.all(db.tables.map((t) => t.clear()))
}

const crepes = () =>
  emptyRecipe({
    title: 'Crêpes',
    servings: 4,
    ingredients: [
      emptyIngredient({ name: 'œufs', quantity: 3 }),
      emptyIngredient({ name: 'farine', quantity: 100, unit: 'g' }),
      emptyIngredient({ name: 'lait', quantity: 300, unit: 'ml' }),
      emptyIngredient({ name: 'beurre', quantity: 30, unit: 'g' }),
      emptyIngredient({ name: 'sel', quantity: 1, unit: 'pincée' }),
    ],
    steps: [emptyStep({ text: 'Mélanger.' })],
  })

describe('recettes', () => {
  beforeEach(reset)

  it('crée, modifie et supprime une recette', async () => {
    const r = await saveRecipe(crepes())
    expect(await db.recipes.count()).toBe(1)
    await saveRecipe({ ...r, title: 'Crêpes légères' })
    expect((await db.recipes.get(r.id))?.title).toBe('Crêpes légères')
    await toggleFavorite((await db.recipes.get(r.id))!)
    expect((await db.recipes.get(r.id))?.favorite).toBe(true)
    await deleteRecipe(r.id)
    expect(await db.recipes.count()).toBe(0)
  })

  it('refuse une recette sans titre', async () => {
    await expect(saveRecipe({ ...crepes(), title: '   ' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('ignore les lignes vides à l’enregistrement', async () => {
    const r = crepes()
    r.ingredients.push(emptyIngredient())
    r.steps.push(emptyStep())
    const saved = await saveRecipe(r)
    expect(saved.ingredients).toHaveLength(5)
    expect(saved.steps).toHaveLength(1)
  })

  it('le sel est exclu automatiquement de la proportionnalité', () => {
    expect(emptyIngredient({ name: 'sel' }).scalable).toBe(false)
    expect(emptyIngredient({ name: 'farine' }).scalable).toBe(true)
  })

  it('variante : nouvelle recette, original intact', async () => {
    const r = await saveRecipe(crepes())
    const scale = scaleFromIngredient(r.ingredients, IDENTITY_SCALE, r.ingredients[0].id, 4)
    const v = await saveVariant(r, scale, 'Crêpes pour 5')
    const original = await db.recipes.get(r.id)
    expect(original?.ingredients[1].quantity).toBe(100)
    expect(v.ingredients[1].quantity).toBe(133.33)
    expect(v.ingredients[4].quantity).toBe(1) // sel inchangé
    expect(v.servings).toBeCloseTo(5.33, 2)
    expect(v.variantOf).toBe(r.id)
    expect(v.ingredients[0].id).not.toBe(r.ingredients[0].id)
  })

  it('remplacement explicite de l’original', async () => {
    const r = await saveRecipe(crepes())
    const scale = scaleFromIngredient(r.ingredients, IDENTITY_SCALE, r.ingredients[1].id, 200)
    await replaceOriginalQuantities(r, scale)
    const after = await db.recipes.get(r.id)
    expect(after?.ingredients[0].quantity).toBe(6)
    expect(after?.servings).toBe(8)
  })

  it('variante avec nutrition ajustée', () => {
    const r = { ...crepes(), nutrition: { total: { kcal: 1000, protein: 40, carbs: 100, fat: 50, fiber: 4 }, source: 'manual' as const, updatedAt: 0 } }
    const v = buildVariant(r, { global: 2, groups: {}, referenceId: null })
    expect(v.nutrition?.total.kcal).toBe(2000)
  })
})

describe('journal de cuisine', () => {
  beforeEach(reset)

  it('compte les réalisations et garde la plus récente', async () => {
    const r = await saveRecipe(crepes())
    const base = { recipeId: r.id, rating: 5, photoId: null, comment: '', modifications: '', quantitiesUsed: [], factor: null, actualCookTime: null, temperatureC: null, isDemo: false }
    await saveJournalEntry({ ...base, date: 1000 })
    const e2 = await saveJournalEntry({ ...base, date: 5000, comment: '9 octobre : cuisson 2 h 45 à 160 °C.' })
    let rec = await db.recipes.get(r.id)
    expect(rec?.cookCount).toBe(2)
    expect(rec?.lastCookedAt).toBe(5000)
    await deleteJournalEntry(e2)
    rec = await db.recipes.get(r.id)
    expect(rec?.cookCount).toBe(1)
    expect(rec?.lastCookedAt).toBe(1000)
  })

  it('consigne des quantités ajustées sans toucher la recette', async () => {
    const r = await saveRecipe(crepes())
    await saveJournalEntry({
      recipeId: r.id,
      date: Date.now(),
      rating: 4,
      photoId: null,
      comment: '',
      modifications: '4 œufs',
      quantitiesUsed: [{ ingredientId: r.ingredients[0].id, name: 'œufs', quantity: 4, unit: '' }],
      factor: 4 / 3,
      actualCookTime: null,
      temperatureC: null,
      isDemo: false,
    })
    expect((await db.recipes.get(r.id))?.ingredients[0].quantity).toBe(3)
  })
})

describe('collections', () => {
  beforeEach(reset)

  it('une recette peut appartenir à plusieurs collections ; suppression propre', async () => {
    const r = await saveRecipe(crepes())
    const a = await saveCollection({ name: 'Mes classiques' })
    const b = await saveCollection({ name: 'Desserts' })
    await setRecipeInCollection(a.id, r.id, true)
    await setRecipeInCollection(b.id, r.id, true)
    await setRecipeInCollection(b.id, r.id, true) // idempotent
    expect((await db.collections.get(b.id))?.recipeIds).toEqual([r.id])
    expect(await db.collections.where('recipeIds').equals(r.id).count()).toBe(2)
    await deleteRecipe(r.id)
    expect((await db.collections.get(a.id))?.recipeIds).toEqual([])
    await deleteCollection(a.id)
    expect(await db.collections.count()).toBe(1)
  })
})

describe('préparation en cours', () => {
  beforeEach(reset)

  it('conserve l’ajustement, puis repart de l’original pour une nouvelle préparation', async () => {
    const r = await saveRecipe(crepes())
    const scale = scaleFromIngredient(r.ingredients, IDENTITY_SCALE, r.ingredients[0].id, 4)
    await setSessionScale(r.id, scale)
    await startCooking(r.id)
    // « Fermeture de l'application » : on relit depuis la base.
    const s = await db.sessions.get(r.id)
    expect(s?.scale.global).toBeCloseTo(4 / 3, 12)
    expect(s?.started).toBe(true)
    await endSession(r.id)
    expect(await db.sessions.get(r.id)).toBeUndefined()
  })
})

describe('photos et démonstration', () => {
  beforeEach(reset)

  it('supprime les photos d’une recette supprimée', async () => {
    const photoId = await putPhoto({ blob: new Blob(['x'], { type: 'image/jpeg' }) })
    await db.photos.update(photoId, { createdAt: 0 })
    const r = await saveRecipe({ ...crepes(), mainPhotoId: photoId })
    await deleteRecipe(r.id)
    expect(await db.photos.get(photoId)).toBeUndefined()
  })

  it('installe puis supprime les données de démonstration sans toucher aux miennes', async () => {
    await seedDemoData()
    const mine = await saveRecipe(crepes())
    expect(await db.recipes.count()).toBe(7)
    expect(await db.journal.count()).toBeGreaterThan(3)
    await deleteDemoData()
    expect(await db.recipes.count()).toBe(1)
    expect((await db.recipes.toArray())[0].id).toBe(mine.id)
    expect(await db.collections.count()).toBe(0)
    expect(await db.journal.count()).toBe(0)
  })
})
