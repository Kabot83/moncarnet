import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { emptyIngredient, emptyRecipe, emptyStep, saveCollection, saveJournalEntry } from '@/services/recipes'
import { putPhoto } from '@/services/photos'
import { BackupError, applyRestore, exportBackup, previewRestore, readBackup } from '@/services/backup'
import { saveProfile, saveSecrets } from '@/services/settings'
import { emptyProfile } from '@/models/types'

async function reset() {
  await Promise.all(db.tables.map((t) => t.clear()))
}

/** Remplit le carnet : `n` recettes, une photo sur deux, journal et collections. */
async function fill(n: number) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const bytes = new Uint8Array(2048).map((_, k) => (k * 31 + i) % 256)
    const photoId = i % 2 === 0 ? await putPhoto({ blob: new Blob([bytes], { type: 'image/jpeg' }), thumb: new Blob([bytes.slice(0, 512)], { type: 'image/jpeg' }) }) : null
    const r = emptyRecipe({
      title: `Recette ${i}`,
      mainPhotoId: photoId,
      ingredients: [emptyIngredient({ name: 'farine', quantity: 100 + i, unit: 'g' }), emptyIngredient({ name: 'œufs', quantity: 2 })],
      steps: [emptyStep({ text: `Étape de la recette ${i}` })],
    })
    await db.recipes.put(r)
    ids.push(r.id)
    if (i % 5 === 0)
      await saveJournalEntry({ recipeId: r.id, date: Date.now() - i * 1000, rating: 4, photoId: null, comment: 'Très bon', modifications: '', quantitiesUsed: [], factor: null, actualCookTime: null, temperatureC: null, isDemo: false })
  }
  await saveCollection({ name: 'Mes classiques', recipeIds: ids.slice(0, 10) })
  return ids
}

describe('sauvegarde et restauration', () => {
  beforeEach(reset)

  it('aller-retour complet avec 300 recettes et 150 photos', async () => {
    await fill(300)
    await saveProfile({ ...emptyProfile(), allergens: 'arachides' })
    await saveSecrets({ apiKey: 'AIza-SECRET-NE-PAS-EXPORTER', proxyToken: 'jeton-secret' })
    const blob = await exportBackup()

    // Aucun secret dans l'archive.
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const json = await zip.file('data.json')!.async('string')
    expect(json).not.toContain('AIza-SECRET')
    expect(json).not.toContain('jeton-secret')
    expect(Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('photos/')).length).toBe(300) // 150 pleines + 150 miniatures

    // Nouveau téléphone : carnet vide, clé déjà saisie.
    await reset()
    await saveSecrets({ apiKey: 'AIza-cle-du-nouveau-telephone' })
    const parsed = await readBackup(blob)
    expect(parsed.recipes).toHaveLength(300)
    expect(parsed.photos).toHaveLength(150)
    expect(parsed.warnings).toEqual([])
    await applyRestore(parsed, 'replace')
    expect(await db.recipes.count()).toBe(300)
    expect(await db.photos.count()).toBe(150)
    expect(await db.journal.count()).toBe(60)
    expect((await db.collections.toArray())[0].recipeIds).toHaveLength(10)
    const r0 = (await db.recipes.where('title').equals('Recette 0').first())!
    expect(r0.cookCount).toBe(1)
    const p = await db.photos.get(r0.mainPhotoId!)
    expect(p?.blob.size).toBe(2048)
    // Les secrets ne sont pas écrasés par une restauration.
    expect(JSON.stringify(await db.secrets.toArray())).toContain('AIza-cle-du-nouveau-telephone')
  }, 60_000)

  it('fusion : ajoute les nouvelles, garde la version la plus récente des doublons', async () => {
    const ids = await fill(5)
    const blob = await exportBackup()
    // Après la sauvegarde : une recette modifiée localement, une supprimée.
    await db.recipes.update(ids[0], { title: 'Modifiée après', updatedAt: Date.now() + 10_000 })
    await db.recipes.delete(ids[1])
    const preview = await previewRestore(await readBackup(blob))
    expect(preview.duplicates).toBe(4)
    expect(preview.newRecipes).toBe(1)
    await applyRestore(preview.backup, 'merge')
    expect(await db.recipes.count()).toBe(5)
    expect((await db.recipes.get(ids[0]))?.title).toBe('Modifiée après')
  })

  it('détecte une photo corrompue et nettoie les références', async () => {
    await fill(2)
    const blob = await exportBackup()
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const photo = Object.values(zip.files).find((f) => !f.dir && f.name.startsWith('photos/') && !f.name.includes('.thumb.'))!.name
    zip.file(photo, new Uint8Array([1, 2, 3]))
    const tampered = new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart])
    const parsed = await readBackup(tampered)
    expect(parsed.photos).toHaveLength(0)
    expect(parsed.invalid.photos).toBe(1)
    expect(parsed.recipes.every((r) => r.mainPhotoId === null)).toBe(true)
    expect(parsed.warnings.join(' ')).toMatch(/corrompue/)
  })

  it('écarte les recettes corrompues sans bloquer le reste', async () => {
    await fill(3)
    const zip = await JSZip.loadAsync(await (await exportBackup()).arrayBuffer())
    const data = JSON.parse(await zip.file('data.json')!.async('string'))
    data.recipes[1].title = ''
    data.recipes[2].ingredients = 'pas une liste'
    zip.file('data.json', JSON.stringify(data))
    const parsed = await readBackup(new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart]))
    expect(parsed.recipes).toHaveLength(1)
    expect(parsed.invalid.recipes).toBe(2)
  })

  it('refuse les fichiers qui ne sont pas des sauvegardes', async () => {
    await expect(readBackup(new Blob(['bonjour']))).rejects.toBeInstanceOf(BackupError)
    const zip = new JSZip()
    zip.file('data.json', JSON.stringify({ format: 'autre', version: 1 }))
    await expect(readBackup(new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart]))).rejects.toThrow(/pas une sauvegarde/)
    const future = new JSZip()
    future.file('data.json', JSON.stringify({ format: 'mon-carnet-backup', version: 99 }))
    await expect(readBackup(new Blob([(await future.generateAsync({ type: 'uint8array' })) as BlobPart]))).rejects.toThrow(/plus récente/)
  })
})

describe('sauvegarde des données nutritionnelles', () => {
  beforeEach(reset)

  it('restaure associations, corrections, poids cuit, favoris et mémoire', async () => {
    const { seedDemoData } = await import('@/db/seed')
    const { rememberFood, toggleFoodFavorite, setCookedWeight, setIngredientNutrition } = await import('@/nutrition/foods')
    await seedDemoData()
    const pancakes = (await db.recipes.where('title').equals('Pancakes protéinés').first())!
    const whey = pancakes.ingredients.find((i) => i.name === 'whey isolate')!
    await setIngredientNutrition(pancakes.id, whey.id, { nutrition: { ...whey.nutrition!, overrides: { protein: 90 } } })
    await setCookedWeight((await db.recipes.get(pancakes.id))!, 380)
    await rememberFood(whey.nutrition!.food, 'whey isolate', whey.nutrition!)
    await toggleFoodFavorite(whey.nutrition!.food)
    const before = await db.recipes.get(pancakes.id)
    const foods = await db.foods.toArray()
    const memory = await db.foodMemory.toArray()
    const blob = await exportBackup()

    await reset()
    await applyRestore(await readBackup(blob), 'replace')
    const after = await db.recipes.get(pancakes.id)
    expect(after).toEqual(before)
    expect(after!.cookedWeightG).toBe(380)
    expect(after!.ingredients.find((i) => i.name === 'whey isolate')!.nutrition!.overrides).toEqual({ protein: 90 })
    expect(await db.foods.toArray()).toEqual(foods)
    expect(await db.foodMemory.toArray()).toEqual(memory)
    expect((await db.foods.toArray())[0].favorite).toBe(true)
  })

  it('reste compatible avec les anciennes sauvegardes (format v1, sans nutrition)', async () => {
    await fill(3)
    const zip = await JSZip.loadAsync(await (await exportBackup()).arrayBuffer())
    const data = JSON.parse(await zip.file('data.json')!.async('string'))
    data.version = 1
    delete data.foods
    delete data.foodMemory
    for (const r of data.recipes) {
      delete r.cookedWeightG
      delete r.cookedWeightRawG
      for (const i of r.ingredients) {
        delete i.nutrition
        delete i.nutritionExcluded
      }
    }
    zip.file('data.json', JSON.stringify(data))
    await reset()
    const parsed = await readBackup(new Blob([(await zip.generateAsync({ type: 'uint8array' })) as BlobPart]))
    expect(parsed.recipes).toHaveLength(3)
    expect(parsed.foods).toEqual([])
    expect(parsed.recipes[0].ingredients[0]).toMatchObject({ nutrition: null, nutritionExcluded: false })
    expect(parsed.recipes[0].cookedWeightG).toBeNull()
    await applyRestore(parsed, 'replace')
    expect(await db.recipes.count()).toBe(3)
  })
})
