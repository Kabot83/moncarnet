import { describe, expect, it } from 'vitest'
import {
  IDENTITY_SCALE,
  applyScale,
  isAdjusted,
  isScalable,
  resetScale,
  scaleByServings,
  scaleFromIngredient,
  scaledQuantity,
  scaledServings,
} from '@/lib/scaling'
import { displayQuantity, nextOnGrid, stepFor } from '@/lib/units'
import type { Ingredient, ScaleState } from '@/models/types'

const ing = (id: string, name: string, quantity: number | null, unit = '', extra: Partial<Ingredient> = {}): Ingredient => ({
  id,
  name,
  quantity,
  unit,
  quantityText: '',
  note: '',
  group: '',
  scalable: true,
  toTaste: false,
  ...extra,
})

const crepes = [
  ing('oeufs', 'œufs', 3),
  ing('farine', 'farine', 100, 'g'),
  ing('lait', 'lait', 300, 'ml'),
  ing('beurre', 'beurre fondu', 30, 'g'),
  ing('sel', 'sel', 1, 'pincée', { scalable: false }),
  ing('sucre', 'sucre', null, '', { toTaste: true, quantityText: 'selon le goût' }),
]
const q = (s: ScaleState, id: string) => scaledQuantity(crepes.find((i) => i.id === id)!, s)

describe('ajustement proportionnel — exemple des crêpes', () => {
  it('4 œufs au lieu de 3 : tout suit avec le coefficient 4/3', () => {
    const s = scaleFromIngredient(crepes, IDENTITY_SCALE, 'oeufs', 4)
    expect(s.global).toBeCloseTo(4 / 3, 12)
    expect(q(s, 'oeufs')).toBeCloseTo(4, 12)
    expect(q(s, 'farine')).toBeCloseTo(133.3333, 3)
    expect(q(s, 'lait')).toBeCloseTo(400, 10)
    expect(q(s, 'beurre')).toBeCloseTo(40, 10)
  })

  it("n'altère jamais la recette d'origine", () => {
    const before = JSON.stringify(crepes)
    const s = scaleFromIngredient(crepes, IDENTITY_SCALE, 'oeufs', 4)
    applyScale(crepes, s)
    expect(JSON.stringify(crepes)).toBe(before)
  })

  it('les ingrédients exclus et « selon le goût » ne bougent pas', () => {
    const s = scaleFromIngredient(crepes, IDENTITY_SCALE, 'oeufs', 6)
    expect(q(s, 'sel')).toBe(1)
    expect(q(s, 'sucre')).toBeNull()
    expect(isScalable(crepes[4])).toBe(false)
  })

  it('les calculs successifs repartent des quantités d’origine (pas d’accumulation d’erreurs)', () => {
    let s = scaleFromIngredient(crepes, IDENTITY_SCALE, 'oeufs', 4)
    // L'utilisateur voit « 135 g » de farine (arrondi pratique) puis tape 135.
    s = scaleFromIngredient(crepes, s, 'farine', 135)
    expect(s.global).toBeCloseTo(1.35, 12)
    expect(q(s, 'oeufs')).toBeCloseTo(4.05, 12)
    // Mille allers-retours ne doivent créer aucune dérive.
    for (let k = 0; k < 1000; k++) {
      s = scaleFromIngredient(crepes, s, 'oeufs', 7)
      s = scaleFromIngredient(crepes, s, 'lait', 300)
    }
    expect(s.global).toBe(1)
    expect(q(s, 'farine')).toBe(100)
  })

  it('choisit n’importe quel ingrédient comme référence', () => {
    const s = scaleFromIngredient(crepes, IDENTITY_SCALE, 'lait', 500)
    expect(q(s, 'oeufs')).toBeCloseTo(5, 12)
    expect(s.referenceId).toBe('lait')
  })

  it('refuse les divisions par zéro et les valeurs invalides', () => {
    const withZero = [...crepes, ing('zero', 'eau', 0, 'ml')]
    expect(scaleFromIngredient(withZero, IDENTITY_SCALE, 'zero', 10)).toBe(IDENTITY_SCALE)
    expect(scaleFromIngredient(crepes, IDENTITY_SCALE, 'sucre', 10)).toBe(IDENTITY_SCALE)
    expect(scaleFromIngredient(crepes, IDENTITY_SCALE, 'farine', 0)).toBe(IDENTITY_SCALE)
    expect(scaleFromIngredient(crepes, IDENTITY_SCALE, 'farine', Number.NaN)).toBe(IDENTITY_SCALE)
    expect(scaleFromIngredient(crepes, IDENTITY_SCALE, 'inconnu', 10)).toBe(IDENTITY_SCALE)
  })

  it('réinitialise', () => {
    const s = scaleFromIngredient(crepes, IDENTITY_SCALE, 'oeufs', 4)
    expect(isAdjusted(s)).toBe(true)
    expect(isAdjusted(resetScale())).toBe(false)
  })

  it('crée une variante avec des quantités stockées propres', () => {
    const s = scaleFromIngredient(crepes, IDENTITY_SCALE, 'oeufs', 4)
    const variant = applyScale(crepes, s)
    expect(variant.find((i) => i.id === 'farine')!.quantity).toBe(133.33)
    expect(variant.find((i) => i.id === 'sel')!.quantity).toBe(1)
  })
})

describe('portions et groupes', () => {
  it('ajuste par portions', () => {
    const s = scaleByServings(IDENTITY_SCALE, 4, 6)
    expect(s.global).toBe(1.5)
    expect(scaledServings(s, 4)).toBe(6)
    expect(scaleByServings(IDENTITY_SCALE, 0, 6)).toBe(IDENTITY_SCALE)
  })

  it('ajuste un seul groupe sans toucher aux autres', () => {
    const list = [
      ing('p1', 'farine', 250, 'g', { group: 'Pâte' }),
      ing('p2', 'beurre', 125, 'g', { group: 'Pâte' }),
      ing('s1', 'crème', 200, 'ml', { group: 'Garniture' }),
      ing('s2', 'œufs', 3, '', { group: 'Garniture' }),
    ]
    const s = scaleFromIngredient(list, IDENTITY_SCALE, 's2', 4, 'group')
    expect(scaledQuantity(list[0], s)).toBe(250)
    expect(scaledQuantity(list[2], s)).toBeCloseTo(266.667, 2)
    // Un ajustement global efface les exceptions par groupe.
    const g = scaleFromIngredient(list, s, 'p1', 500, 'all')
    expect(scaledQuantity(list[2], g)).toBe(400)
  })
})

describe('affichage et incréments', () => {
  it('arrondis pratiques et précis', () => {
    expect(displayQuantity(133.3333, 'g', { rounding: 'practical' }).value).toBe('135')
    expect(displayQuantity(133.3333, 'g', { rounding: 'precise' }).value).toBe('133')
    expect(displayQuantity(1240, 'g', { rounding: 'practical' })).toMatchObject({ value: '1,25', unit: 'kg' })
    expect(displayQuantity(7.3, 'g', { rounding: 'practical' }).value).toBe('7,5')
    expect(displayQuantity(0.5, 'c. à soupe', { rounding: 'practical' }).value).toBe('½')
    expect(displayQuantity(1.5, 'c. à café', { rounding: 'practical' }).value).toBe('1 ½')
  })

  it('œufs : demi-œufs facultatifs, jamais zéro', () => {
    expect(displayQuantity(2.6, '', { rounding: 'practical', name: 'œufs' }).value).toBe('2 ½')
    expect(displayQuantity(2.6, '', { rounding: 'practical', name: 'œufs', allowHalfEggs: false }).value).toBe('3')
    expect(displayQuantity(0.2, '', { rounding: 'practical', name: 'oeuf', allowHalfEggs: false }).value).toBe('1')
  })

  it('incréments cohérents', () => {
    expect(stepFor(3, '', 'œufs')).toBe(1)
    expect(stepFor(133.33, 'g')).toBe(10)
    expect(stepFor(30, 'g')).toBe(5)
    expect(nextOnGrid(133.333, 10, 1)).toBe(140)
    expect(nextOnGrid(133.333, 10, -1)).toBe(130)
    expect(nextOnGrid(3, 1, 1)).toBe(4)
    expect(nextOnGrid(1, 1, -1)).toBe(0.5)
    expect(nextOnGrid(0.5, 1, -1)).toBeNull()
  })
})
