/** Synchronisation familiale : règles locales (sans serveur), exécutées à chaque compilation. */
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { normalizeServerUrl } from '@/platform/carnetSync'
import { securityDir } from '@/services/integrity'
import { NEW_RECIPE_SPACE_KEY, duplicateRecipe, emptyIngredient, emptyRecipe, rebaseEdit, saveRecipe } from '@/services/recipes'
import { type DeviceBinding, PRIMARY_DB, SIGNED_OUT_DB, localDbName, signIn, signOut } from '@/sync/binding'
import { applyChoice, applyChoices, describePath, describeValue } from '@/sync/conflicts'

describe('comptes sur le téléphone : une base par compte, aucune fuite', () => {
  it('le premier compte reprend le carnet existant, les autres ont le leur, la déconnexion masque tout', () => {
    let b: DeviceBinding = { primaryUserId: null, currentUserId: null, everSignedIn: false }
    expect(localDbName(b)).toBe(PRIMARY_DB) // sans compte : comme en 1.4.1
    b = signIn(b, 'u_alice')
    expect(localDbName(b)).toBe(PRIMARY_DB)
    b = signOut(b)
    expect(localDbName(b)).toBe(SIGNED_OUT_DB) // la personne suivante ne voit pas le carnet d'Alice
    b = signIn(b, 'u_carol')
    expect(localDbName(b)).toBe('mon-carnet@u_carol')
    expect(localDbName(signIn(signOut(b), 'u_alice'))).toBe(PRIMARY_DB) // Alice retrouve son carnet
  })

  it('copie de sécurité automatique : un dossier par carnet (aucune restauration croisée)', () => {
    expect(securityDir('mon-carnet')).toBe('securite') // inchangé depuis 1.4.1
    expect(securityDir('mon-carnet@u_carol')).toBe('securite/base-mon-carnet_u_carol')
    expect(securityDir(SIGNED_OUT_DB)).not.toBe('securite')
  })

  it('adresse du serveur : HTTPS obligatoire', () => {
    expect(normalizeServerUrl(' https://carnetmedia.synology.me:8445/ ')).toBe('https://carnetmedia.synology.me:8445')
    expect(normalizeServerUrl('http://carnetmedia.synology.me:8445')).toBeNull()
    expect(normalizeServerUrl('https://exemple.fr/chemin')).toBeNull()
  })
})

describe('nouvelles recettes', () => {
  beforeEach(async () => {
    await db.recipes.clear()
    await db.settings.delete(NEW_RECIPE_SPACE_KEY)
  })

  it('sans synchronisation : rien ne change (aucun espace)', async () => {
    expect((await saveRecipe(emptyRecipe({ title: 'Locale' }))).space).toBeUndefined()
  })

  it('synchronisation active : familiale par défaut, « Garder privée » respecté, modification inchangée', async () => {
    await db.settings.put({ key: NEW_RECIPE_SPACE_KEY, value: 'family' })
    const f = await saveRecipe(emptyRecipe({ title: 'Familiale' }))
    expect(f.space).toBe('family')
    expect((await saveRecipe({ ...emptyRecipe({ title: 'Privée' }), space: 'personal' })).space).toBe('personal')
    // Une recette existante n'est jamais déplacée par une modification.
    await db.recipes.update(f.id, { space: 'personal' })
    expect((await saveRecipe({ ...(await db.recipes.get(f.id))!, title: 'Modifiée' })).space).toBe('personal')
  })

  it('copie d’une recette familiale : nouvelle fiche sans l’auteur ni la provenance de l’originale', async () => {
    await db.settings.put({ key: NEW_RECIPE_SPACE_KEY, value: 'family' })
    const src = await saveRecipe({ ...emptyRecipe({ title: 'Originale' }), space: 'family' })
    await db.recipes.update(src.id, { familyInfo: { createdBy: { login: 'carol', name: 'Carol' } }, receivedFrom: { login: 'bob', name: 'Bob', at: 1, transferId: 't' } })
    const copy = await duplicateRecipe((await db.recipes.get(src.id))!)
    expect(copy.familyInfo).toBeUndefined()
    expect(copy.receivedFrom).toBeUndefined()
    expect(copy.space).toBe('family')
  })
})

describe('résolution manuelle d’un conflit familial', () => {
  const current = {
    title: 'Gratin',
    notes: { tips: 'Ail' },
    ingredients: [{ id: 'i1', name: 'pommes de terre', quantity: 800, unit: 'g' }, { id: 'i2', name: 'crème', quantity: 30, unit: 'cl' }],
  }
  const items = [
    { path: 'ingredients[i1]', theirs: current.ingredients[0], mine: { ...current.ingredients[0], quantity: 1200 } },
    { path: 'notes.tips', theirs: 'Ail', mine: 'Ail et muscade' },
    { path: 'ingredients[i2]', theirs: current.ingredients[1], mine: null },
  ]

  it('chaque désaccord est choisi séparément ; le reste de la recette n’est pas touché', () => {
    const r = applyChoices(current, items, [true, false, false])
    expect((r.ingredients as { quantity: number }[]).map((i) => i.quantity)).toEqual([1200, 30])
    expect(r.notes).toEqual({ tips: 'Ail' })
    expect(r.title).toBe('Gratin')
    const all = applyChoices(current, items, [true, true, true])
    expect((all.ingredients as { id: string }[]).map((i) => i.id)).toEqual(['i1']) // suppression proposée retenue
    expect(all.notes).toEqual({ tips: 'Ail et muscade' })
    expect(current.ingredients).toHaveLength(2) // version actuelle intacte (aucune mutation)
  })

  it('ajout d’un élément absent et libellés lisibles', () => {
    expect((applyChoice({ steps: [] }, 'steps[s9]', { id: 's9', text: 'Gratiner' }).steps as unknown[]).length).toBe(1)
    expect(describePath('ingredients[i1]', items[0])).toBe('Ingrédient « pommes de terre »')
    expect(describeValue('ingredients[i1]', items[0].mine)).toBe('1200 g pommes de terre')
    expect(describeValue('ingredients[i2]', null)).toBe('(supprimé)')
    expect(describePath('notes.tips', items[1])).toBe('Astuces')
  })
})

describe('éditeur ouvert pendant une synchronisation', () => {
  const base = emptyRecipe({
    id: 'r_1', title: 'Soupe', description: 'Simple',
    ingredients: [emptyIngredient({ id: 'i1', name: 'oignons', quantity: 4 }), emptyIngredient({ id: 'i2', name: 'beurre', quantity: 30 })],
  })

  it('seules mes modifications s’appliquent : ce qui a été reçu entre-temps n’est pas écrasé', () => {
    // Pendant l'édition, Jona a changé le titre, une quantité, ajouté et retiré des ingrédients.
    const current = { ...base, title: 'Soupe de Jona', ingredients: [{ ...base.ingredients[0], quantity: 6 }, emptyIngredient({ id: 'i3', name: 'gruyère', quantity: 100 })] }
    // Moi : la description et le nom du premier ingrédient… et rien d'autre.
    const edited = { ...base, description: 'Réconfortante', ingredients: [{ ...base.ingredients[0], name: 'oignons doux' }, base.ingredients[1]] }
    const r = rebaseEdit(base, edited, current)
    expect(r.title).toBe('Soupe de Jona') // reçu : conservé
    expect(r.description).toBe('Réconfortante') // ma modification : appliquée
    expect(r.ingredients.map((i) => [i.id, i.name, i.quantity])).toEqual([
      ['i1', 'oignons doux', 4], // je l'ai modifié : ma version de l'élément
      ['i3', 'gruyère', 100], // ajouté par Jona : conservé ; i2, retiré par Jona et inchangé ici : reste retiré
    ])
  })

  it('aucune synchronisation entre-temps : la fiche enregistrée est exactement celle de l’éditeur', () => {
    const edited = { ...base, description: 'Réconfortante' }
    expect(rebaseEdit(base, edited, base)).toEqual(edited)
  })
})
