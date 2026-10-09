/**
 * Moteur nutritionnel — testé avec les VRAIES données : table CIQUAL 2025 générée depuis le
 * fichier officiel de l'ANSES, et réponses réelles de l'API Open Food Facts (tests/fixtures).
 */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import catalog from '@/data/ciqual-2025.json'
import { IDENTITY_SCALE, scaleByServings, scaleFromIngredient } from '@/lib/scaling'
import { type FoodLink, FoodLinkSchema, type Ingredient } from '@/models/types'
import { ciqualToFood, getCiqualFood, loadCiqual, searchCiqual } from '@/nutrition/ciqual'
import { computeNutrition, cookedWeightNeedsReview, effectiveValue, interpret, kcalToKj, kjToKcal, nutritionView, toBasisAmount } from '@/nutrition/engine'
import { OffError, checkRate, isComplete, offToFood, resetRate, searchOff } from '@/nutrition/off'
import { emptyIngredient } from '@/services/recipes'

const fixture = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}`, 'utf-8')).product
const link = (food: FoodLink['food'], extra: Partial<FoodLink> = {}): FoodLink => FoodLinkSchema.parse({ food, linkedAt: 1, ...extra })
const ciqual = async (code: string, extra: Partial<FoodLink> = {}) => link(ciqualToFood((await getCiqualFood(code))!), extra)
const off = (file: string, extra: Partial<FoodLink> = {}) => link(offToFood(fixture(file))!, extra)

/** Pancakes protéinés : plusieurs farines, œufs, skyr, lait et whey (CIQUAL + Open Food Facts). */
async function pancakes(): Promise<Ingredient[]> {
  return [
    emptyIngredient({ id: 'oeufs', name: 'œufs', quantity: 2, unit: '', nutrition: await ciqual('22000', { gramsPerUnit: 50 }) }),
    emptyIngredient({ id: 'skyr', name: 'skyr nature 0 %', quantity: 150, unit: 'g', nutrition: off('off-skyr-3329770077003.json') }),
    emptyIngredient({ id: 'avoine', name: "flocons d'avoine mixés", quantity: 40, unit: 'g', nutrition: await ciqual('32140') }),
    emptyIngredient({ id: 'sarrasin', name: 'farine de sarrasin', quantity: 20, unit: 'g', nutrition: await ciqual('9540') }),
    emptyIngredient({ id: 'whey', name: 'whey isolate', quantity: 30, unit: 'g', nutrition: off('off-whey-isolate-3760322501605.json') }),
    emptyIngredient({ id: 'lait', name: 'lait demi-écrémé', quantity: 80, unit: 'ml', nutrition: await ciqual('19041', { density: 1.03 }) }),
    emptyIngredient({ id: 'levure', name: 'levure chimique', quantity: 5, unit: 'g', scalable: false, nutrition: await ciqual('11046') }),
    emptyIngredient({ id: 'myrtilles', name: 'myrtilles pour servir', quantity: null, toTaste: true }),
  ]
}

// Totaux attendus, calculés à la main depuis les valeurs officielles (pour 100 g) :
// œuf cru 22000 : 140 kcal, P 12,8, G 0,06, L 9,83 × 100 g (2 × 50 g)
// skyr Yoplait (OFF) : 57 kcal, P 9,5, G 3,6, L 0,5 × 150 g
// flocons d'avoine 32140 : 369, 11,4, 57,7, 7,82 × 40 g
// farine de sarrasin 9540 : 348, 11,5, 68,4, 2,19 × 20 g
// whey Nutripure (OFF) : 380, 94, 3, 1,9 × 30 g
// lait demi-écrémé UHT 19041 : 47,7, 3,41, 5, 1,56 × 82,4 g (80 ml × 1,03)
// levure chimique 11046 : 108, 0,1, 26,9, 0 × 5 g
const EXPECTED = { kcal: 601.4048, protein: 64.92484, carbs: 48.585, fat: 16.00144, grams: 427.4 }

describe('table CIQUAL 2025 embarquée', () => {
  it('provient du fichier officiel, sans perte', () => {
    expect(catalog.edition).toBe('Ciqual 2025')
    expect(catalog.citation).toBe('Anses. 2025. Table de composition nutritionnelle des aliments Ciqual')
    expect(catalog.license).toBe('Licence Ouverte (Etalab)')
    expect(catalog.foods).toHaveLength(3484)
    if (existsSync('scripts/sources/ciqual2025_FR.xlsx')) {
      expect(createHash('sha256').update(readFileSync('scripts/sources/ciqual2025_FR.xlsx')).digest('hex')).toBe(catalog.sha256)
    }
  })

  it('conserve les conventions officielles (tiret, traces, < seuil) sans les changer en zéro', () => {
    const count = (col: number, pred: (v: unknown) => boolean) => catalog.foods.filter((f) => pred(f[col])).length
    // Colonnes : 0 code, 1 nom, 2 groupe, puis kcal, kj, protein, carbs (6), fat (7)…
    expect(count(6, (v) => v === 't')).toBe(134)
    expect(count(6, (v) => typeof v === 'string' && v.startsWith('<'))).toBe(8)
    expect(count(6, (v) => v === null)).toBe(70)
    expect(count(7, (v) => typeof v === 'string' && v.startsWith('<'))).toBe(166)
    expect(count(7, (v) => v === 't')).toBe(15)
    expect(count(3, (v) => v === null)).toBe(143)
  })

  it('valeurs officielles : farine T65, lait demi-écrémé, fromage blanc 0 %', async () => {
    expect((await getCiqualFood('9435'))?.per100).toMatchObject({ kcal: 346, protein: 11, carbs: 71.5, fat: 1 })
    expect((await getCiqualFood('19041'))?.name).toBe('Lait demi-écrémé, UHT')
    expect((await getCiqualFood('19644'))?.per100.fat).toBe('<0.1')
  })

  it('recherche hors ligne pertinente', async () => {
    await loadCiqual()
    expect((await searchCiqual('farine de sarrasin'))[0].code).toBe('9540')
    expect((await searchCiqual('oeuf'))[0].name).toBe('Oeuf cru')
    expect((await searchCiqual('Œufs'))[0].name).toBe('Oeuf cru')
    expect((await searchCiqual('flocons avoine')).map((f) => f.code)).toContain('32140')
    expect((await searchCiqual('lait demi ecreme')).length).toBeGreaterThan(3)
    expect(await searchCiqual('zzzz introuvable')).toEqual([])
  })
})

describe('Open Food Facts (réponses réelles)', () => {
  beforeEach(() => resetRate())

  it('convertit un produit en aliment, pour 100 g ou 100 ml', () => {
    const whey = offToFood(fixture('off-whey-isolate-3760322501605.json'))!
    expect(whey).toMatchObject({ source: 'off', id: '3760322501605', brand: 'Nutripure', basis: '100g' })
    expect(whey.per100).toMatchObject({ kcal: 380, protein: 94, carbs: 3, fat: 1.9, fiber: null })
    expect(isComplete(whey)).toBe(true)
    const amande = offToFood(fixture('off-lait-amande-3229820787015.json'))!
    expect(amande.basis).toBe('100ml')
    expect(amande.per100.fiber).toBeNull() // absent dans la fiche : jamais 0
  })

  it('ne confond jamais kJ et kcal', () => {
    const f = offToFood({ code: '12345678', product_name: 'Test', nutriments: { energy_100g: 2252, 'energy-kj_100g': 2252, proteins_100g: 6 } })!
    expect(f.per100.kcal).toBeCloseTo(2252 / 4.184, 6) // et non 2252
    expect(f.notes).toContain('Énergie calculée depuis la valeur en kJ')
    expect(f.notes).toContain('Fiche incomplète dans Open Food Facts')
    const g = offToFood({ code: '12345678', product_name: 'Test', nutriments: { energy_100g: 2252 } })!
    expect(g.per100.kcal).toBeNull()
    expect(offToFood({ code: 'abc', product_name: 'x' })).toBeNull()
  })

  describe('recherche', () => {
    afterEach(() => vi.restoreAllMocks())
    const ok = () => new Response(JSON.stringify({ count: 1, products: [fixture('off-whey-isolate-3760322501605.json')] }), { status: 200 })

    it('service saturé (503) : une seule nouvelle tentative, puis résultat', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(ok())
      const p = searchOff('whey isolate')
      await vi.advanceTimersByTimeAsync(2000)
      const r = await p
      expect(spy).toHaveBeenCalledTimes(2)
      expect(r.foods[0].name).toBe('Whey isolate')
      expect(String(spy.mock.calls[0][0])).toContain('/cgi/search.pl?search_terms=whey%20isolate')
      expect(String(spy.mock.calls[0][0])).toContain('app_name=MonCarnet')
      vi.useRealTimers()
    })

    it('toujours saturé : message clair, pas de boucle', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 503 }))
      const p = searchOff('skyr').catch((e) => e)
      await vi.advanceTimersByTimeAsync(2000)
      const err = await p
      expect(err).toMatchObject({ kind: 'busy' })
      expect(spy).toHaveBeenCalledTimes(2)
      vi.useRealTimers()
    })

    it('un code-barres ouvre directement la fiche produit', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ product: fixture('off-lait-amande-3229820787015.json') }), { status: 200 }))
      const r = await searchOff('3229820787015')
      expect(String(spy.mock.calls[0][0])).toContain('/api/v2/product/3229820787015')
      expect(r.foods[0].basis).toBe('100ml')
    })

    it('marques sous forme de liste (nouveau moteur)', () => {
      expect(offToFood({ code: '3662072026073', product_name: 'Native Whey', brands: ['AM NUTRITION', 'am'] as unknown as string, nutriments: {} })!.brand).toBe('AM NUTRITION')
    })
  })

  it('respecte la limite de recherches par minute', () => {
    for (let i = 0; i < 8; i++) checkRate('search', 1000 + i)
    expect(() => checkRate('search', 2000)).toThrow(OffError)
    expect(() => checkRate('search', 1000 + 61_000)).not.toThrow()
  })
})

describe('conversions d’unités', () => {
  const food = (basis: '100g' | '100ml') => link({ source: 'custom', id: 'x', name: 'x', brand: '', basis, per100: { kcal: 100, kj: null, protein: 1, carbs: 1, fat: 1, fiber: null, sugars: null, satFat: null, salt: null }, version: '', notes: [], fetchedAt: 0 })

  it('masses et volumes exacts', () => {
    expect(toBasisAmount(1.2, 'kg', food('100g'))).toEqual({ basisAmount: 1200, grams: 1200, approx: [] })
    expect(toBasisAmount(25, 'cl', food('100ml'))).toMatchObject({ basisAmount: 250, approx: ['Poids estimé avec 1 ml = 1 g'] })
    expect(toBasisAmount(2, 'c. à soupe', { ...food('100g'), density: 0.92 })).toEqual({ basisAmount: 27.6, grams: 27.6, approx: [] })
    expect(toBasisAmount(1, 'c. à café', food('100ml'))).toMatchObject({ basisAmount: 5 })
  })

  it('densité inconnue : approximation signalée', () => {
    const r = toBasisAmount(100, 'ml', food('100g'))
    expect(r).toMatchObject({ basisAmount: 100, approx: ['Masse volumique non renseignée : 1 ml compté pour 1 g'] })
  })

  it('aucun poids inventé pour les pièces, pincées et tasses', () => {
    expect(toBasisAmount(2, '', food('100g'))).toEqual({ error: 'Poids d’une pièce à renseigner' })
    expect(toBasisAmount(1, 'pincée', food('100g'))).toEqual({ error: 'Poids d’une pincée à renseigner' })
    expect(toBasisAmount(1, 'tasse', food('100g'))).toMatchObject({ error: expect.stringContaining('tasse') })
    expect(toBasisAmount(3, '', { ...food('100g'), gramsPerUnit: 55 })).toEqual({ basisAmount: 165, grams: 165, approx: [] })
  })

  it('kcal ↔ kJ', () => {
    expect(kjToKcal(kcalToKj(380))).toBeCloseTo(380, 12)
    expect(kcalToKj(100)).toBeCloseTo(418.4, 12)
  })
})

describe('calcul des macros — pancakes protéinés', () => {
  it('additionne les contributions CIQUAL + Open Food Facts', async () => {
    const r = computeNutrition(await pancakes())
    expect(r.totals.kcal.value).toBeCloseTo(EXPECTED.kcal, 9)
    expect(r.totals.protein.value).toBeCloseTo(EXPECTED.protein, 9)
    expect(r.totals.carbs.value).toBeCloseTo(EXPECTED.carbs, 9)
    expect(r.totals.fat.value).toBeCloseTo(EXPECTED.fat, 9)
    expect(r.rawGrams).toBeCloseTo(EXPECTED.grams, 9)
    expect(r.coverage).toEqual({ done: 7, expected: 7 }) // les myrtilles « selon le goût » ne sont pas comptées
    expect(r.rows.find((x) => x.ingredient.id === 'myrtilles')?.status).toBe('toTaste')
  })

  it('trois modes : total complet, portion, 100 g estimatif sans poids cuit', async () => {
    const ings = await pancakes()
    const r = computeNutrition(ings)
    const recipe = { servings: 2, cookedWeightG: null, cookedWeightRawG: null }
    const total = nutritionView(r, 'total', recipe)
    expect(total.reliability).toBe('complete')
    const portion = nutritionView(r, 'portion', recipe)
    expect(portion.values.kcal).toBeCloseTo(EXPECTED.kcal / 2, 9)
    const per100 = nutritionView(r, 'per100', recipe)
    expect(per100.reliability).toBe('estimate')
    expect(per100.weight).toEqual({ grams: EXPECTED.grams, kind: 'raw' })
    expect(per100.values.protein).toBeCloseTo((EXPECTED.protein / EXPECTED.grams) * 100, 9)
    expect(per100.reasons.join(' ')).toMatch(/Poids après cuisson non renseigné/)
  })

  it('poids après cuisson : dénominateur = poids cuit, contributions conservées', async () => {
    const ings = await pancakes()
    const r = computeNutrition(ings)
    const recipe = { servings: 2, cookedWeightG: 380, cookedWeightRawG: EXPECTED.grams }
    const v = nutritionView(r, 'per100', recipe)
    expect(v.weight).toEqual({ grams: 380, kind: 'cooked' })
    expect(v.reliability).toBe('complete')
    expect(v.values.kcal).toBeCloseTo((EXPECTED.kcal / 380) * 100, 9)
    expect(nutritionView(r, 'total', recipe).values.kcal).toBeCloseTo(EXPECTED.kcal, 9) // la cuisson ne change pas le total
  })

  it('exemple 900 g crus → 720 g cuits', () => {
    const ing = emptyIngredient({ name: 'mélange', quantity: 900, unit: 'g', nutrition: link({ source: 'custom', id: 'm', name: 'm', brand: '', basis: '100g', per100: { kcal: 200, kj: null, protein: 10, carbs: 20, fat: 5, fiber: null, sugars: null, satFat: null, salt: null }, version: '', notes: [], fetchedAt: 0 }) })
    const r = computeNutrition([ing])
    const v = nutritionView(r, 'per100', { servings: 4, cookedWeightG: 720, cookedWeightRawG: 900 })
    expect(v.values.kcal).toBeCloseTo((1800 / 720) * 100, 12) // 250 kcal / 100 g cuits
    expect(nutritionView(r, 'per100', { servings: 4, cookedWeightG: null, cookedWeightRawG: null }).values.kcal).toBeCloseTo(200, 12)
  })

  it('suit l’ajustement des quantités, sans dérive après ajustements successifs', async () => {
    const ings = await pancakes()
    const recipe = { servings: 2, cookedWeightG: 380, cookedWeightRawG: EXPECTED.grams }
    const three = scaleFromIngredient(ings, IDENTITY_SCALE, 'oeufs', 3) // ×1,5 (levure fixe)
    const r = computeNutrition(ings, three)
    expect(r.totals.kcal.value).toBeCloseTo((EXPECTED.kcal - 5.4) * 1.5 + 5.4, 9)
    const rawScaled = (EXPECTED.grams - 5) * 1.5 + 5
    const v = nutritionView(r, 'per100', recipe, three, EXPECTED.grams)
    expect(v.weight?.kind).toBe('cooked-extrapolated')
    expect(v.weight?.grams).toBeCloseTo((380 * rawScaled) / EXPECTED.grams, 9)
    expect(v.reliability).toBe('estimate')
    expect(nutritionView(r, 'portion', recipe, three).values.kcal).toBeCloseTo(r.totals.kcal.value / 3, 9)
    // Mille allers-retours : retour exact aux valeurs d'origine.
    let s = three
    for (let i = 0; i < 1000; i++) {
      s = scaleFromIngredient(ings, s, 'skyr', 237)
      s = scaleFromIngredient(ings, s, 'avoine', 40)
    }
    expect(computeNutrition(ings, s).totals.kcal.value).toBe(computeNutrition(ings).totals.kcal.value)
    const servings = scaleByServings(IDENTITY_SCALE, 2, 4)
    expect(computeNutrition(ings, servings).totals.protein.value).toBeCloseTo((EXPECTED.protein - 0.005) * 2 + 0.005, 9)
  })

  it('signale une pesée à refaire si la recette d’origine a changé', async () => {
    expect(cookedWeightNeedsReview({ servings: 2, cookedWeightG: 380, cookedWeightRawG: 427.4 }, 427.4)).toBe(false)
    expect(cookedWeightNeedsReview({ servings: 2, cookedWeightG: 380, cookedWeightRawG: 427.4 }, 500)).toBe(true)
    const ings = await pancakes()
    ings[2] = { ...ings[2], quantity: 80 } // recette modifiée : 40 g d'avoine de plus
    const r = computeNutrition(ings)
    const v = nutritionView(r, 'per100', { servings: 2, cookedWeightG: 380, cookedWeightRawG: 427.4 })
    expect(v.reliability).toBe('estimate')
    expect(v.reasons.join(' ')).toMatch(/poids après cuisson à revoir/)
  })
})

describe('données manquantes : jamais de faux total complet', () => {
  it('ingrédient non associé, sans quantité ou sans poids : incomplet', async () => {
    const ings = await pancakes()
    ings.push(emptyIngredient({ name: 'beurre de cacahuète', quantity: 15, unit: 'g' }))
    ings.push(emptyIngredient({ name: 'banane', quantity: 1, unit: '', nutrition: await ciqual('13005') }))
    ings.push(emptyIngredient({ name: 'sucre', quantity: null, quantityText: 'un peu', nutrition: await ciqual('31016') }))
    const r = computeNutrition(ings)
    expect(r.blocking.map((x) => x.status).sort()).toEqual(['noConversion', 'noQuantity', 'unlinked'])
    const v = nutritionView(r, 'total', { servings: 2, cookedWeightG: null, cookedWeightRawG: null })
    expect(v.reliability).toBe('incomplete')
    expect(v.reasons[0]).toMatch(/3 ingrédients non calculés/)
    expect(r.totals.kcal.value).toBeCloseTo(EXPECTED.kcal, 9) // partiel, sans zéro inventé
    expect(nutritionView(r, 'per100', { servings: 2, cookedWeightG: null, cookedWeightRawG: null }).available).toBe(false)
  })

  it('teneur inconnue : nutriment incomplet ; traces et < seuil : estimatif', async () => {
    const unknownFat = await ciqual('25505') // Brochette de bœuf crue : lipides inconnus (tiret)
    const r1 = computeNutrition([emptyIngredient({ name: 'brochette', quantity: 200, unit: 'g', nutrition: unknownFat })])
    expect(r1.totals.fat.missing).toEqual(['brochette'])
    expect(nutritionView(r1, 'total', { servings: 1, cookedWeightG: null, cookedWeightRawG: null }).reliability).toBe('incomplete')

    const fb = await ciqual('19644') // Fromage blanc 0 % : lipides « < 0,1 »
    const r2 = computeNutrition([emptyIngredient({ name: 'fromage blanc', quantity: 200, unit: 'g', nutrition: fb })])
    expect(r2.totals.fat.value).toBe(0)
    expect(r2.totals.fat.upperExtra).toBeCloseTo(0.2, 12)
    const v2 = nutritionView(r2, 'total', { servings: 1, cookedWeightG: null, cookedWeightRawG: null })
    expect(v2.reliability).toBe('estimate')
    expect(v2.reasons.join(' ')).toMatch(/inférieure à 0.1/)
    expect(interpret('t')).toEqual({ kind: 'trace', value: 0 })
    expect(interpret(null)).toEqual({ kind: 'missing' })
  })

  it('correction manuelle prioritaire et ingrédient exclu', async () => {
    const l = await ciqual('19644', { overrides: { fat: 0.2 } })
    expect(effectiveValue(l, 'fat')).toEqual({ kind: 'exact', value: 0.2 })
    const r = computeNutrition([
      emptyIngredient({ name: 'fromage blanc', quantity: 100, unit: 'g', nutrition: l }),
      emptyIngredient({ name: 'eau', quantity: 50, unit: 'ml', nutritionExcluded: true }),
    ])
    expect(r.totals.fat.value).toBeCloseTo(0.2, 12)
    expect(r.blocking).toHaveLength(0)
    expect(r.rows[1].status).toBe('excluded')
  })
})
