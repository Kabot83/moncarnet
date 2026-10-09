// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { extractRecipeFromHtml, parseIsoDuration } from '@/importers/schemaOrg'
import { UrlImportError, findUrl, validateRecipeUrl } from '@/importers/url'

const page = (jsonld: unknown) => `<!doctype html><html><head><title>Ma recette</title>
<script type="application/ld+json">${JSON.stringify(jsonld)}</script></head><body><article>Bla</article></body></html>`

describe('import Schema.org/Recipe', () => {
  it('lit un JSON-LD dans un @graph', () => {
    const html = page({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'Page' },
        {
          '@type': ['Recipe'],
          name: 'Quiche lorraine',
          description: 'La vraie &amp; la seule',
          image: [{ '@type': 'ImageObject', url: '/img/quiche.jpg' }],
          recipeYield: '6 personnes',
          prepTime: 'PT20M',
          cookTime: 'PT45M',
          recipeCategory: 'Plat principal',
          keywords: 'tarte, lardons',
          author: { '@type': 'Person', name: 'Marie' },
          recipeIngredient: ['1 pâte brisée', '200 g de lardons', '3 œufs', '20 cl de crème fraîche', '1/2 c. à café de muscade', 'Sel, poivre'],
          recipeInstructions: [
            { '@type': 'HowToSection', name: 'Préparation', itemListElement: [{ '@type': 'HowToStep', text: 'Préchauffer le four à 180 °C.' }, { '@type': 'HowToStep', text: 'Faire revenir les lardons.' }] },
            { '@type': 'HowToSection', name: 'Cuisson', itemListElement: [{ '@type': 'HowToStep', text: 'Cuire 45 minutes.' }] },
          ],
        },
      ],
    })
    const r = extractRecipeFromHtml(html, 'https://cuisine.exemple.fr/quiche')!
    expect(r.method).toBe('json-ld')
    expect(r.recipe.title).toBe('Quiche lorraine')
    expect(r.recipe.description).toBe('La vraie & la seule')
    expect(r.recipe.servings).toBe(6)
    expect(r.recipe.prepTime).toBe(20)
    expect(r.recipe.cookTime).toBe(45)
    expect(r.recipe.category).toBe('plat')
    expect(r.recipe.tags).toEqual(['tarte', 'lardons'])
    expect(r.recipe.source).toBe('Marie')
    expect(r.recipe.sourceUrl).toBe('https://cuisine.exemple.fr/quiche')
    expect(r.imageUrl).toBe('https://cuisine.exemple.fr/img/quiche.jpg')
    expect(r.recipe.ingredients).toHaveLength(6)
    expect(r.recipe.ingredients[1]).toMatchObject({ quantity: 200, unit: 'g', name: 'lardons' })
    expect(r.recipe.ingredients[3]).toMatchObject({ quantity: 20, unit: 'cl' })
    expect(r.recipe.ingredients[4]).toMatchObject({ quantity: 0.5, unit: 'c. à café' })
    expect(r.recipe.steps).toHaveLength(3)
    expect(r.recipe.steps[0].text).toBe('Préparation — Préchauffer le four à 180 °C.')
  })

  it('accepte des instructions en texte brut et les microdonnées', () => {
    const r = extractRecipeFromHtml(
      page({ '@type': 'Recipe', name: 'Soupe', recipeIngredient: ['1 l d’eau'], recipeInstructions: '1. Chauffer.<br>2. Servir.' }),
      'https://a.fr/s',
    )!
    expect(r.recipe.steps.map((s) => s.text)).toEqual(['Chauffer.', 'Servir.'])
    const micro = `<div itemscope itemtype="http://schema.org/Recipe"><h1 itemprop="name">Salade</h1>
      <li itemprop="recipeIngredient">2 tomates</li><li itemprop="recipeIngredient">1 c. à soupe d'huile</li>
      <div itemprop="recipeInstructions">Couper. Assaisonner.</div><meta itemprop="cookTime" content="PT0M"></div>`
    const m = extractRecipeFromHtml(micro, 'https://b.fr/salade')!
    expect(m.method).toBe('microdata')
    expect(m.recipe.ingredients).toHaveLength(2)
  })

  it('renvoie null sans données de recette', () => {
    expect(extractRecipeFromHtml('<html><body>Rien</body></html>', 'https://c.fr')).toBeNull()
  })

  it('durées ISO 8601', () => {
    expect(parseIsoDuration('PT1H30M')).toBe(90)
    expect(parseIsoDuration('P1DT2H')).toBe(1560)
    expect(parseIsoDuration('PT0M')).toBeNull()
    expect(parseIsoDuration(undefined)).toBeNull()
  })
})

describe('sécurité des URL', () => {
  it.each(['http://localhost/x', 'http://127.0.0.1:8080', 'http://192.168.1.1', 'http://10.0.0.3/admin', 'http://[::1]/', 'file:///etc/passwd', 'ftp://a.fr', 'https://user:pass@a.fr', 'pas une url'])(
    'refuse %s',
    (u) => {
      expect(() => validateRecipeUrl(u)).toThrow(UrlImportError)
    },
  )
  it('accepte une URL publique et extrait un lien partagé', () => {
    expect(validateRecipeUrl('https://www.marmiton.org/recettes/x.aspx').hostname).toBe('www.marmiton.org')
    expect(findUrl('Regarde ça https://cuisine.fr/tarte?x=1 !')).toBe('https://cuisine.fr/tarte?x=1')
  })
})
