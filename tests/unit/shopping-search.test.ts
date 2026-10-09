import { describe, expect, it } from 'vitest'
import { IDENTITY_SCALE, scaleByServings } from '@/lib/scaling'
import { emptyFilters, filterRecipes, rediscover } from '@/lib/search'
import { buildShoppingLines, categorize, shoppingText } from '@/lib/shopping'
import { emptyIngredient, emptyRecipe } from '@/services/recipes'

describe('liste de courses', () => {
  const a = emptyRecipe({
    title: 'Crêpes',
    servings: 4,
    ingredients: [
      emptyIngredient({ name: 'Farine', quantity: 250, unit: 'g' }),
      emptyIngredient({ name: 'œufs', quantity: 3 }),
      emptyIngredient({ name: 'lait', quantity: 50, unit: 'cl' }),
      emptyIngredient({ name: 'sel', quantity: null, toTaste: true }),
    ],
  })
  const b = emptyRecipe({
    title: 'Gâteau',
    servings: 8,
    ingredients: [
      emptyIngredient({ name: 'farine', quantity: 1, unit: 'kg' }),
      emptyIngredient({ name: 'oeufs', quantity: 4 }),
      emptyIngredient({ name: 'lait', quantity: 2, unit: 'c. à soupe' }),
    ],
  })

  it('regroupe les ingrédients identiques et additionne les unités compatibles', () => {
    const lines = buildShoppingLines([
      { recipe: a, scale: IDENTITY_SCALE },
      { recipe: b, scale: IDENTITY_SCALE },
    ])
    const farine = lines.filter((l) => l.key.startsWith('farine'))
    expect(farine).toHaveLength(1)
    expect(farine[0]).toMatchObject({ quantity: 1.25, unit: 'kg' })
    const oeufs = lines.find((l) => l.key.startsWith('oeuf'))
    expect(oeufs?.quantity).toBe(7)
    // Lait : 50 cl et 2 c. à soupe ne sont pas additionnés (unités incompatibles).
    expect(lines.filter((l) => l.key === 'lait')).toHaveLength(2)
    expect(lines.find((l) => l.key === 'sel')?.extra).toBe('selon le goût')
    expect(oeufs?.recipeTitles).toEqual(['Crêpes', 'Gâteau'])
  })

  it('adapte au nombre de portions', () => {
    const lines = buildShoppingLines([{ recipe: a, scale: scaleByServings(IDENTITY_SCALE, 4, 8) }])
    expect(lines.find((l) => l.key.startsWith('farine'))).toMatchObject({ quantity: 500, unit: 'g' })
    expect(lines.find((l) => l.key === 'lait')).toMatchObject({ quantity: 1, unit: 'l' })
  })

  it('classe par rayon et produit un texte partageable', () => {
    expect(categorize('Farine T55')).toBe('Épicerie sucrée')
    expect(categorize('jarret de bœuf')).toBe('Boucherie et poissonnerie')
    expect(categorize('Courgettes')).toBe('Fruits et légumes')
    expect(categorize('beurre doux')).toBe('Crèmerie et œufs')
    const text = shoppingText([{ name: 'Farine', quantity: 1250, unit: 'g', extra: '', category: 'Épicerie sucrée', checked: false }])
    expect(text).toContain('ÉPICERIE SUCRÉE')
    expect(text).toContain('Farine — 1,25 kg')
  })
})

describe('recherche et filtres sur plusieurs centaines de recettes', () => {
  const recipes = Array.from({ length: 800 }, (_, i) =>
    emptyRecipe({
      title: i === 42 ? 'Jarret de bœuf mijoté' : `Recette n°${i}`,
      category: i % 3 === 0 ? 'dessert' : 'plat',
      prepTime: (i % 6) * 10,
      favorite: i % 10 === 0,
      tags: i % 7 === 0 ? ['hiver'] : [],
      ingredients: [emptyIngredient({ name: i % 4 === 0 ? 'chocolat noir' : 'courgette', quantity: 100, unit: 'g' })],
      notes: { tips: i === 7 ? 'astuce secrète : un zeste de citron' : '', modifications: '', mistakes: '', ideas: '', storage: '', reheating: '' },
      cookCount: i % 2,
      lastCookedAt: i % 2 ? Date.now() - i * 86_400_000 : null,
    }),
  )

  it('recherche dans les titres, ingrédients, notes, tags, catégories — sans accents', () => {
    expect(filterRecipes(recipes, { ...emptyFilters(), query: 'jarret boeuf' })[0].title).toBe('Jarret de bœuf mijoté')
    expect(filterRecipes(recipes, { ...emptyFilters(), query: 'chocolat' })).toHaveLength(200)
    expect(filterRecipes(recipes, { ...emptyFilters(), query: 'zeste' })).toHaveLength(1)
    expect(filterRecipes(recipes, { ...emptyFilters(), query: 'hiver' }).length).toBe(115)
    expect(filterRecipes(recipes, { ...emptyFilters(), query: 'desserts' }).length).toBeGreaterThan(0)
  })

  it('combine les filtres', () => {
    const res = filterRecipes(recipes, { ...emptyFilters(), categories: ['dessert'], maxTime: 30 })
    expect(res.every((r) => r.category === 'dessert' && (r.prepTime ?? 0) <= 30 && (r.prepTime ?? 0) > 0)).toBe(true)
    expect(res.length).toBeGreaterThan(0)
    const favs = filterRecipes(recipes, { ...emptyFilters(), categories: ['dessert'], favorite: true })
    expect(favs.length).toBeGreaterThan(0)
    expect(favs.every((r) => r.favorite && r.category === 'dessert')).toBe(true)
    expect(filterRecipes(recipes, { ...emptyFilters(), cooked: true })).toHaveLength(400)
    expect(filterRecipes(recipes, { ...emptyFilters(), tags: ['HIVER'] })).toHaveLength(115)
  })

  it('reste rapide', () => {
    const t0 = performance.now()
    for (let k = 0; k < 50; k++) filterRecipes(recipes, { ...emptyFilters(), query: `cho${k % 3 ? 'c' : ''}` }, 'alpha')
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it('« À redécouvrir » propose des recettes anciennes, stables dans la journée', () => {
    const r1 = rediscover(recipes, 6)
    expect(r1).toHaveLength(6)
    expect(r1.every((r) => r.lastCookedAt && Date.now() - r.lastCookedAt > 30 * 86_400_000)).toBe(true)
    expect(rediscover(recipes, 6).map((r) => r.id)).toEqual(r1.map((r) => r.id))
  })
})
