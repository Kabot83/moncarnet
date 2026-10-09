/**
 * Migration PWA → application Android : la sauvegarde ZIP exportée depuis la PWA
 * doit être restaurée sans aucune perte dans l'APK (stockage séparé, vierge au départ).
 */
import { describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { seedDemoData } from '@/db/seed'
import { IDENTITY_SCALE, scaleFromIngredient } from '@/lib/scaling'
import { emptyProfile } from '@/models/types'
import { applyRestore, exportBackup, previewRestore, readBackup } from '@/services/backup'
import { putPhoto } from '@/services/photos'
import { emptyIngredient, emptyRecipe, emptyStep, saveCollection, saveJournalEntry, saveRecipe, saveVariant } from '@/services/recipes'
import { addManualItem } from '@/services/shopping'
import { getProfile, saveProfile, saveSecrets, updateSettings } from '@/services/settings'

const reset = () => Promise.all(db.tables.map((t) => t.clear()))

/** Instantané comparable des tables migrées (photos : octets compris). */
async function snapshot() {
  const photos = await Promise.all(
    (await db.photos.orderBy('id').toArray()).map(async (p) => ({
      ...p,
      blob: Array.from(new Uint8Array(await p.blob.arrayBuffer())),
      thumb: Array.from(new Uint8Array(await p.thumb.arrayBuffer())),
    })),
  )
  return {
    recipes: await db.recipes.orderBy('id').toArray(),
    journal: await db.journal.orderBy('id').toArray(),
    collections: await db.collections.orderBy('id').toArray(),
    shopping: await db.shopping.orderBy('id').toArray(),
    conversations: await db.conversations.orderBy('id').toArray(),
    profile: await getProfile(),
    photos,
    foods: await db.foods.orderBy('key').toArray(),
    foodMemory: await db.foodMemory.orderBy('nameKey').toArray(),
  }
}

describe('migration PWA → APK par sauvegarde ZIP', () => {
  it('restaure à l’identique recettes, ingrédients, photos, notes, journal, collections', async () => {
    // --- Carnet de la PWA ---
    await reset()
    await seedDemoData()
    const photo = await putPhoto({
      blob: new Blob([new Uint8Array(4096).map((_, i) => (i * 7) % 256)], { type: 'image/webp' }),
      thumb: new Blob([new Uint8Array(900).map((_, i) => (i * 3) % 256)], { type: 'image/webp' }),
      width: 1600,
      height: 1200,
    })
    const mine = await saveRecipe(
      emptyRecipe({
        title: 'Blanquette de veau de mamie',
        mainPhotoId: photo,
        galleryPhotoIds: [photo],
        servings: 6,
        tags: ['famille', 'mijoté'],
        favorite: true,
        rating: 5,
        ingredients: [
          emptyIngredient({ name: 'veau', quantity: 1.2, unit: 'kg', group: 'Viande' }),
          emptyIngredient({ name: 'crème fraîche', quantity: 20, unit: 'cl', group: 'Sauce', note: 'épaisse' }),
          emptyIngredient({ name: 'sel', quantity: 1, unit: 'pincée', scalable: false }),
          emptyIngredient({ name: 'muscade', quantity: null, toTaste: true }),
        ],
        steps: [emptyStep({ text: 'Blanchir la viande.', durationMin: 5, timerMin: 5, photoId: photo }), emptyStep({ text: 'Mijoter 1 h 30.', temperatureC: 90 })],
        notes: { tips: 'Ne pas faire bouillir.', modifications: 'Plus de champignons', mistakes: '', ideas: 'Essayer avec du riz noir', storage: '3 jours', reheating: 'Feu doux' },
        nutrition: { total: { kcal: 2400, protein: 210, carbs: 30, fat: 150, fiber: 4 }, source: 'manual', updatedAt: 1 },
      }),
    )
    const variant = await saveVariant(mine, scaleFromIngredient(mine.ingredients, IDENTITY_SCALE, mine.ingredients[0].id, 1.5))
    await saveJournalEntry({
      recipeId: mine.id,
      date: Date.UTC(2026, 9, 9),
      rating: 5,
      photoId: photo,
      comment: '9 octobre : parfait.',
      modifications: 'Moins de crème',
      quantitiesUsed: [{ ingredientId: mine.ingredients[0].id, name: 'veau', quantity: 1.5, unit: 'kg' }],
      factor: 1.25,
      actualCookTime: 95,
      temperatureC: 90,
      isDemo: false,
    })
    await saveCollection({ name: 'Recettes familiales', coverPhotoId: photo, recipeIds: [mine.id, variant.id] })
    await addManualItem('2 kg de pommes')
    await db.conversations.put({ id: 'cv1', title: 'Idée', messages: [{ id: 'm1', role: 'user', text: 'Une idée ?', createdAt: 1 }], recipeId: null, createdAt: 1, updatedAt: 1 })
    await saveProfile({ ...emptyProfile(), allergens: 'arachides', equipment: 'cocotte' })
    await updateSettings({ rounding: 'precise', allowHalfEggs: false })
    await saveSecrets({ apiKey: 'AIza-cle-de-la-pwa' })
    const before = await snapshot()
    const zip = await exportBackup()

    // --- APK fraîchement installée : stockage vierge + recettes de démonstration ---
    await reset()
    await seedDemoData()
    const backup = await readBackup(zip)
    expect(backup.warnings).toEqual([])
    const preview = await previewRestore(backup)
    expect(preview.backup.recipes.length).toBe(before.recipes.length)
    await applyRestore(backup, 'replace')

    const after = await snapshot()
    expect(after.recipes).toEqual(before.recipes)
    expect(after.journal).toEqual(before.journal)
    expect(after.collections).toEqual(before.collections)
    expect(after.shopping).toEqual(before.shopping)
    expect(after.conversations).toEqual(before.conversations)
    expect(after.profile).toEqual(before.profile)
    expect(after.photos).toEqual(before.photos)
    expect(after.foods).toEqual(before.foods)
    expect(after.foodMemory).toEqual(before.foodMemory)
    // Préférences non sensibles reprises, clé API jamais transférée.
    const settings = (await db.settings.get('app'))?.value as { rounding: string; allowHalfEggs: boolean }
    expect(settings.rounding).toBe('precise')
    expect(settings.allowHalfEggs).toBe(false)
    expect(await db.secrets.count()).toBe(0)
  })

  it('le carnet de la PWA n’est jamais modifié par l’export', async () => {
    await reset()
    await seedDemoData()
    const before = await snapshot()
    await exportBackup()
    const after = await snapshot()
    expect(after).toEqual(before)
  })
})
