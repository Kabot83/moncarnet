/**
 * Calcul nutritionnel automatique : reconnaissance des ingrédients, poids usuels, fiabilité.
 * Données réelles : table CIQUAL 2025 embarquée.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { IDENTITY_SCALE, scaleByServings } from '@/lib/scaling'
import { parseIngredientLine } from '@/lib/units'
import type { Ingredient } from '@/models/types'
import { type AutoMap, type MemoryPreference, matchDictionary, resolveAll, resolveIngredient } from '@/nutrition/auto'
import { type CiqualFood, ciqualToFood, loadCiqual } from '@/nutrition/ciqual'
import { DICTIONARY } from '@/nutrition/dictionary'
import { computeNutrition, nutritionView } from '@/nutrition/engine'
import { nameKey, rememberFood } from '@/nutrition/foods'
import { emptyIngredient } from '@/services/recipes'

let catalog: CiqualFood[]
beforeAll(async () => {
  catalog = await loadCiqual()
})

const ing = (line: string, extra: Partial<Ingredient> = {}) => {
  const p = parseIngredientLine(line)
  return emptyIngredient({ name: p.name, quantity: p.quantity, unit: p.unit, ...extra })
}
const per100 = (code: string) => catalog.find((f) => f.code === code)!.per100
const resolve = (line: string, memory: MemoryPreference | null = null) => resolveIngredient(ing(line), catalog, memory)
const auto = (list: Ingredient[], memory: (n: string) => MemoryPreference | null = () => null): AutoMap => resolveAll(list, catalog, memory)

describe('dictionnaire', () => {
  it('chaque code CIQUAL existe dans la table 2025', () => {
    const codes = new Set(catalog.map((f) => f.code))
    const unknown = DICTIONARY.filter((e) => !codes.has(e.ciqual)).map((e) => `${e.label} (${e.ciqual})`)
    expect(unknown).toEqual([])
  })

  it('poids usuels plausibles et sourcés', () => {
    for (const e of DICTIONARY) {
      for (const w of [e.piece, e.density, ...Object.values(e.units ?? {})]) {
        if (!w) continue
        expect(w.grams, e.label).toBeGreaterThan(0)
        expect(['usda', 'usage', 'estimate']).toContain(w.source)
      }
    }
  })
})

describe('reconnaissance des ingrédients', () => {
  it.each([
    ['2 œufs', '22000'],
    ['1 oignon', '20034'],
    ['100 g farine', '9436'],
    ['1 cs huile olive', '17270'],
    ['2 bananes', '13005'],
    ['1 cuillère à soupe d’huile d’olive', '17270'],
    ['3 OIGNONS', '20034'],
    ['2 Œufs bio', '22000'],
    ['1 gros oignon émincé', '20034'],
    ['3 jaunes d’œufs', '22002'],
    ['200 g de lardons fumés', '28720'],
    ['3 gousses d’ail', '11000'],
    ['1 sachet de levure chimique', '11046'],
    ['2 cubes de bouillon de volaille', '11174'],
    ['20 cl de crème liquide', '19417'],
    ['50 g de cassonade', '31017'],
    ['100 g de poudre d’amande', '15041'],
  ])('« %s » → CIQUAL %s, sans association manuelle', (line, code) => {
    const m = resolve(line)
    expect(m.link?.food.id).toBe(code)
    expect(m.link?.food.source).toBe('ciqual')
    expect(['sure', 'assumed']).toContain(m.confidence)
  })

  it('variante courante supposée : comptée mais signalée', () => {
    const m = resolve('200 ml de lait')
    expect(m.link?.food.id).toBe('19033')
    expect(m.confidence).toBe('assumed')
    expect(m.note).toMatch(/Variante courante supposée/)
  })

  it('état cru / cuit : « carottes cuites » n’est pas une carotte crue', () => {
    expect(resolve('2 carottes râpées').link?.food.id).toBe('20009')
    const cooked = resolve('2 carottes cuites')
    expect(cooked.link?.food.name).toMatch(/^Carotte, .*cuite/)
    expect(cooked.confidence).toBe('approx')
  })

  it('jamais une référence nutritionnellement différente choisie au hasard', () => {
    // Un mot de plus qui change l'aliment : pas de raccourci vers le dictionnaire.
    expect(matchDictionary('farine de châtaigne')).toBeNull()
    expect(matchDictionary('pâte brisée')?.entry.ciqual).not.toBe('9810')
    expect(resolve('100 g de farine de châtaigne').link?.food.name).toMatch(/châtaigne/i)
    // Nom vague, candidats très différents : à confirmer, non compté.
    const vague = resolve('100 g de fromage')
    expect(vague.confidence).toBe('ambiguous')
    expect(vague.link).toBeNull()
    expect(vague.candidates.length).toBeGreaterThan(1)
  })

  it('préférence mémorisée prioritaire sur le dictionnaire ; choix de la recette prioritaire sur tout', () => {
    const red: MemoryPreference = { food: ciqualToFood(catalog.find((f) => f.code === '20238')!), gramsPerUnit: 150, density: null }
    const m = resolve('1 oignon', red)
    expect(m.origin).toBe('memory')
    expect(m.link?.food.id).toBe('20238')
    expect(m.usual.gramsPerUnit).toMatchObject({ grams: 150, user: true })
    const chosen = ing('1 oignon', { nutrition: { food: ciqualToFood(catalog.find((f) => f.code === '20034')!), gramsPerUnit: 120, density: null, overrides: {}, linkedAt: 1 } })
    expect(resolveIngredient(chosen, catalog, red).origin).toBe('user')
  })
})

describe('recette saisie normalement, sans aucune association', () => {
  const recipe = () => [ing('1 oignon'), ing('2 œufs'), ing('150 g de farine'), ing('1 cuillère à soupe d’huile d’olive')]

  it('calcule tout seul, avec des poids usuels signalés', () => {
    const list = recipe()
    const r = computeNutrition(list, undefined, auto(list))
    expect(r.blocking).toEqual([])
    expect(r.coverage).toEqual({ done: 4, expected: 4 })
    const [onion, eggs, flour, oil] = r.rows
    expect(onion.grams).toBe(110)
    expect(eggs.grams).toBe(100)
    expect(flour.grams).toBe(150)
    expect(oil.grams).toBeCloseTo(15 * 0.91, 9)
    expect(onion.quality).toBe('estimated')
    expect(eggs.quality).toBe('estimated')
    expect(flour.quality).toBe('verified')
    expect(oil.quality).toBe('estimated')
    expect(onion.approx).toContain('Poids usuel estimé : 1 oignon ≈ 110 g (portion de référence USDA)')

    // Valeurs officielles CIQUAL, sans modification : 39 / 140 / 350 / 899 kcal pour 100 g.
    const kcal = (110 * 39 + 100 * 140 + 150 * 350 + 13.65 * 899) / 100
    expect(r.totals.kcal.value).toBeCloseTo(kcal, 9)
    expect(r.totals.kcal.value).toBeCloseTo(830.6135, 4)
    const p = (code: string) => {
      const v = per100(code).protein
      return typeof v === 'number' ? v : 0 // « traces » / « < x » comptés 0 (signalé)
    }
    expect(r.totals.protein.value).toBeCloseTo((110 * p('20034') + 100 * p('22000') + 150 * p('9436') + 13.65 * p('17270')) / 100, 9)

    const view = nutritionView(r, 'total', { servings: 2, cookedWeightG: null, cookedWeightRawG: null })
    expect(view.reliability).toBe('estimate') // jamais présenté comme exact
    const per100g = nutritionView(r, 'per100', { servings: 2, cookedWeightG: null, cookedWeightRawG: null })
    expect(per100g.weight?.kind).toBe('raw')
    expect(per100g.reasons.join(' ')).toMatch(/Poids après cuisson non renseigné/)
  })

  it('suit l’ajustement des portions (poids usuels compris)', () => {
    const list = recipe()
    const a = auto(list)
    const base = computeNutrition(list, undefined, a).totals.kcal.value
    const doubled = computeNutrition(list, scaleByServings(IDENTITY_SCALE, 2, 4), a)
    expect(doubled.totals.kcal.value).toBeCloseTo(base * 2, 9)
    expect(doubled.rows[0].grams).toBe(220)
  })

  it('pièces, grammes, cuillères et millilitres mélangés', () => {
    const list = [ing('2 bananes'), ing('200 ml de lait'), ing('2 c. à soupe de miel'), ing('100 g de flocons d’avoine'), ing('1 pincée de cannelle'), ing('1 c. à café de levure chimique')]
    const r = computeNutrition(list, undefined, auto(list))
    expect(r.blocking).toEqual([])
    expect(r.rows.map((x) => Math.round(x.grams! * 10) / 10)).toEqual([236, 206, 42.6, 100, 0.4, 4.7])
  })

  it('ingrédient inconnu : le reste est calculé, total partiel (≥), jamais compté pour zéro en silence', () => {
    const list = [ing('1 oignon'), ing('100 g de zorglub magique')]
    const r = computeNutrition(list, undefined, auto(list))
    expect(r.rows[1].status).toBe('unlinked')
    expect(r.coverage).toEqual({ done: 1, expected: 2 })
    expect(nutritionView(r, 'total', { servings: 1, cookedWeightG: null, cookedWeightRawG: null }).reliability).toBe('incomplete')
  })

  it('ambigu : à confirmer, non compté', () => {
    const list = [ing('100 g de fromage')]
    const r = computeNutrition(list, undefined, auto(list))
    expect(r.rows[0].status).toBe('toConfirm')
    expect(r.blocking).toHaveLength(1)
  })

  it('assaisonnements sans quantité ou sans poids : négligeables, sans bloquer', () => {
    const list = [ing('150 g de farine'), ing('sel'), ing('poivre'), ing('1 botte de persil')]
    const r = computeNutrition(list, undefined, auto(list))
    expect(r.blocking).toEqual([])
    expect(r.rows.map((x) => x.status)).toEqual(['ok', 'toTaste', 'toTaste', 'negligible'])
    expect(r.approximations).toContain('persil : apport négligeable, non compté')
  })

  it('poids usuel inconnu : signalé, sans bloquer le reste', () => {
    const list = [ing('150 g de farine'), ing('2 pommes de reinette du Canada')]
    const r = computeNutrition(list, undefined, auto(list))
    expect(r.rows[0].status).toBe('ok')
    expect(r.blocking.length).toBe(1)
  })

  it('sans correspondances automatiques : seules les références choisies comptent (compatibilité)', () => {
    const r = computeNutrition(recipe())
    expect(r.coverage.done).toBe(0)
    expect(r.rows[0].message).toBe('Aliment non associé')
  })
})

describe('apprentissage', () => {
  it('« retenir » écrit la préférence ; sinon, seulement les aliments récents', async () => {
    await db.foodMemory.clear()
    const food = ciqualToFood(catalog.find((f) => f.code === '20238')!)
    await rememberFood(food, 'oignons', { gramsPerUnit: 150, density: null }, false)
    expect(await db.foodMemory.get(nameKey('oignon'))).toBeUndefined()
    expect(await db.foods.get('ciqual:20238')).toBeTruthy()
    await rememberFood(food, 'oignons', { gramsPerUnit: 150, density: null }, true)
    expect(await db.foodMemory.get(nameKey('oignon'))).toMatchObject({ foodKey: 'ciqual:20238', gramsPerUnit: 150 })
  })
})
