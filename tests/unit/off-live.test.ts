/**
 * Vérification réelle de l'API Open Food Facts (réseau). Désactivée par défaut pour
 * respecter les limites de l'API : `LIVE_OFF=1 npx vitest run tests/unit/off-live.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { getOffProduct, isComplete, searchOff } from '@/nutrition/off'

describe.skipIf(!process.env.LIVE_OFF)('Open Food Facts en direct', () => {
  it('recherche par nom et marque', async () => {
    const r = await searchOff('whey isolate nutripure')
    expect(r.foods.length).toBeGreaterThan(0)
    expect(r.foods.some((f) => /nutripure/i.test(f.brand))).toBe(true)
  }, 30_000)

  it('fiche par code-barres, valeurs pour 100 ml', async () => {
    const f = await getOffProduct('3229820787015')
    expect(f).toMatchObject({ source: 'off', brand: 'Bjorg', basis: '100ml' })
    expect(isComplete(f)).toBe(true)
  }, 30_000)

  it('produit inexistant', async () => {
    await expect(getOffProduct('0000000000017')).rejects.toMatchObject({ kind: 'not-found' })
  }, 30_000)
})
