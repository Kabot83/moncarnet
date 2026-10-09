import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mentionedRecipes, selectCatalogContext } from '@/ai/catalog'
import { aiRecipeToRecipe, recipeToContext } from '@/ai/convert'
import { AiError, toAiError } from '@/ai/errors'
import { consumeCall, usedToday } from '@/ai/quota'
import { sortModels, suggestModels } from '@/ai/client'
import { ChatResponseSchema, validateRecipes } from '@/ai/schemas'
import { db } from '@/db/db'
import { emptyIngredient, emptyRecipe } from '@/services/recipes'
import { updateSettings } from '@/services/settings'

describe('validation des réponses IA', () => {
  it('écarte les propositions invalides et corrige les écarts courants', () => {
    const { recipes, rejected } = validateRecipes([
      {
        title: 'Poulet au four',
        prepTime: '15',
        servings: 4,
        difficulty: 7,
        ingredients: [
          { name: 'poulet', quantity: 800, unit: 'g' },
          { name: 'sel', quantity: null, unit: '' },
          { name: '', quantity: 3 },
          { name: 'courgette', quantity: -5, unit: '' },
        ],
        steps: ['Préchauffer le four.', { text: 'Cuire 45 min', temperatureC: 900 }, { text: '' }],
      },
      { title: 'Sans ingrédients', ingredients: [], steps: [] },
      { foo: 'bar' },
      'texte',
    ])
    expect(rejected).toBe(3)
    expect(recipes).toHaveLength(1)
    const r = recipes[0]
    expect(r.prepTime).toBe(15)
    expect(r.difficulty).toBe(3)
    expect(r.ingredients).toHaveLength(3)
    expect(r.ingredients[2].quantity).toBeNull()
    expect(r.steps).toHaveLength(2)
    expect(r.steps[1].temperatureC).toBeNull()
  })

  it('réponse de conversation incomplète → rejet', () => {
    expect(ChatResponseSchema.safeParse({ recipes: [] }).success).toBe(false)
    expect(ChatResponseSchema.safeParse({ reply: 'Bonjour', recipes: [] }).success).toBe(true)
  })

  it('conversion en fiche éditable avec points à vérifier', () => {
    const { recipe, warnings } = aiRecipeToRecipe({
      title: 'Test',
      category: 'Dessert',
      ingredients: [
        { name: 'farine', quantity: 200, unit: 'grammes' },
        { name: 'sucre', quantity: null, unit: null, note: 'selon le goût' },
        { name: 'beurre', quantity: null, unit: null },
        { name: 'vanille', quantity: 1, unit: 'gousse' },
        { name: 'rhum', quantity: 1, unit: 'trait' },
      ],
      steps: [{ text: 'Cuire au four', temperatureC: 320, durationMin: 30 }],
    })
    expect(recipe.category).toBe('dessert')
    expect(recipe.ingredients[0].unit).toBe('g')
    expect(recipe.ingredients[1].toTaste).toBe(true)
    expect(recipe.steps[0].timerMin).toBe(30)
    expect(warnings.join(' ')).toMatch(/320/)
    expect(warnings.join(' ')).toMatch(/sans quantité/)
    expect(warnings.join(' ')).toMatch(/trait/)
  })
})

describe('erreurs et quotas', () => {
  beforeEach(async () => {
    await db.aiUsage.clear()
    await db.settings.clear()
  })

  it('traduit les erreurs de l’API', () => {
    expect(toAiError({ status: 429, message: 'RESOURCE_EXHAUSTED retryDelay: "23s"' })).toMatchObject({ kind: 'quota', retryAfterSec: 23 })
    expect(toAiError({ status: 403, message: 'API key not valid' }).kind).toBe('auth')
    expect(toAiError({ status: 404, message: 'models/x is not found' }).kind).toBe('model')
    expect(toAiError({ status: 503, message: 'overloaded' }).kind).toBe('server')
    expect(toAiError(new TypeError('Failed to fetch')).kind).toBe('network')
    expect(toAiError({ status: 429, message: 'quota' }).message).toMatch(/jamais vers une offre payante/)
  })

  it('applique la limite locale quotidienne', async () => {
    await updateSettings({ aiDailyLimit: 2 })
    await consumeCall()
    await consumeCall()
    await expect(consumeCall()).rejects.toMatchObject({ kind: 'local-limit' })
    expect(await usedToday()).toBe(2)
    await updateSettings({ aiDailyLimit: 0 })
    await consumeCall()
    expect(await usedToday()).toBe(3)
  })

  it('aucun appel réseau quand l’IA est désactivée', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { generate } = await import('@/ai/client')
    await updateSettings({ aiMode: 'off', aiModel: 'gemini-x' })
    await expect(generate({ contents: 'test' })).rejects.toBeInstanceOf(AiError)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await usedToday()).toBe(0)
    fetchSpy.mockRestore()
  })
})

describe('choix des modèles', () => {
  const models = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.7-flash', 'gemini-3.7-flash-preview-09'].map((id) => ({ id, label: id }))
  it('préfère gemini-3.7-flash s’il est accessible, propose un repli flash-lite', () => {
    expect(suggestModels(models)).toEqual({ main: 'gemini-3.7-flash', fallback: 'gemini-2.5-flash-lite' })
    expect(suggestModels(models.filter((m) => m.id !== 'gemini-3.7-flash')).main).toBe('gemini-2.5-flash')
    expect(sortModels(models)[0].id).toBe('gemini-3.7-flash')
  })
})

describe('exploitation du catalogue (sélection locale)', () => {
  const recipes = [
    emptyRecipe({ title: 'Jarret de bœuf mijoté au four', favorite: true, ingredients: [emptyIngredient({ name: 'jarret', quantity: 1, unit: 'kg' })] }),
    emptyRecipe({ title: 'Pancakes protéinés', favorite: true, prepTime: 10, cookTime: 15 }),
    ...Array.from({ length: 200 }, (_, i) => emptyRecipe({ title: `Plat ${i}`, lastCookedAt: Date.now() - (i + 40) * 86_400_000, cookCount: 1 })),
  ]

  it('détecte la recette nommée et la joint en détail', () => {
    expect(mentionedRecipes('Fais-moi une variante de mon jarret de bœuf', recipes)[0].title).toBe('Jarret de bœuf mijoté au four')
    const ctx = selectCatalogContext('Fais-moi une variante de mon jarret de bœuf', recipes, 'auto')
    expect(ctx.detailed).toHaveLength(1)
    expect(ctx.summaries).toHaveLength(0)
  })

  it('n’envoie jamais tout le catalogue', () => {
    const ctx = selectCatalogContext('Propose-moi un repas parmi les recettes que je n’ai pas cuisinées depuis longtemps', recipes, 'auto')
    expect(ctx.summaries.length).toBeGreaterThan(0)
    expect(ctx.summaries.length).toBeLessThanOrEqual(12)
    expect(selectCatalogContext('Trouve quelque chose de rapide parmi mes recettes favorites', recipes, 'auto').summaries.map((r) => r.title)).toContain('Pancakes protéinés')
    expect(selectCatalogContext('n’importe quoi', recipes, 'none')).toEqual({ detailed: [], summaries: [] })
  })

  it('contexte compact sans identifiant ni photo', () => {
    const text = recipeToContext(recipes[0], 'full')
    expect(text).toContain('jarret')
    expect(text).not.toContain(recipes[0].id)
  })
})
