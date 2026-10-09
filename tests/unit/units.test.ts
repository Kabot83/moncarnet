import { describe, expect, it } from 'vitest'
import { compatibleUnits, normalizeUnit, parseIngredientLine, parseQuantity } from '@/lib/units'

describe('analyse des quantités', () => {
  it.each([
    ['3', 3],
    ['1,5', 1.5],
    ['1.5', 1.5],
    ['1/2', 0.5],
    ['1 1/2', 1.5],
    ['½', 0.5],
    ['1½', 1.5],
    ['2 ¾', 2.75],
    ['quelques', null],
    ['', null],
    ['1/0', null],
    ['2 à 3', null],
  ])('%s → %s', (input, expected) => {
    expect(parseQuantity(input)).toBe(expected)
  })

  it('lignes d’ingrédients', () => {
    expect(parseIngredientLine('200 g de farine T55')).toMatchObject({ quantity: 200, unit: 'g', name: 'farine T55' })
    expect(parseIngredientLine('3 œufs')).toMatchObject({ quantity: 3, unit: '', name: 'œufs' })
    expect(parseIngredientLine("2 c. à soupe d'huile d'olive")).toMatchObject({
      quantity: 2,
      unit: 'c. à soupe',
      name: "huile d'olive",
    })
    expect(parseIngredientLine("2 gousses d'ail")).toMatchObject({ quantity: 2, unit: 'gousse', name: 'ail' })
    expect(parseIngredientLine('Sel, poivre')).toMatchObject({ quantity: null, name: 'Sel, poivre' })
    expect(parseIngredientLine('1/2 l de lait')).toMatchObject({ quantity: 0.5, unit: 'l', name: 'lait' })
  })

  it('unités compatibles uniquement dans une même dimension', () => {
    expect(compatibleUnits('g', 'kg')).toBe(true)
    expect(compatibleUnits('ml', 'cl')).toBe(true)
    expect(compatibleUnits('g', 'ml')).toBe(false)
    expect(compatibleUnits('c. à soupe', 'cas')).toBe(true)
    expect(normalizeUnit('Grammes').canonical).toBe('g')
  })
})
