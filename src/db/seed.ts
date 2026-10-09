/**
 * Recettes de démonstration. Toutes portent `isDemo: true` et peuvent être
 * supprimées en un geste depuis Réglages → Données de démonstration.
 */
import { newId } from '@/lib/id'
import { suggestNonScalable } from '@/lib/scaling'
import type { Collection, Ingredient, JournalEntry, Recipe, Step } from '@/models/types'
import { FoodLinkSchema, RecipeSchema } from '@/models/types'
import { ciqualToFood, getCiqualFood } from '@/nutrition/ciqual'
import { offToFood } from '@/nutrition/off'
import { db } from './db'
import { DEMO_OFF_PRODUCTS } from './demoFoods'
import { type DemoKey, demoIllustration } from './illustrations'

const DAY = 86_400_000

/** Référence nutritionnelle réelle d'un ingrédient de démonstration (résolue à l'installation). */
interface NutriSpec {
  ciqual?: string
  off?: keyof typeof DEMO_OFF_PRODUCTS
  gramsPerUnit?: number
  density?: number
}
type IngSpec = [quantity: number | null, unit: string, name: string, extra?: Partial<Ingredient>, nutri?: NutriSpec]
const nutriSpecs = new Map<string, NutriSpec>()

function ings(group: string, list: IngSpec[]): Ingredient[] {
  return list.map(([quantity, unit, name, extra, nutri]) => {
    const id = newId('i_')
    if (nutri) nutriSpecs.set(id, nutri)
    return {
    id,
    name,
    quantity,
    unit,
    quantityText: '',
    note: '',
    group,
    scalable: !suggestNonScalable(name),
    toTaste: false,
    nutrition: null,
    nutritionExcluded: false,
    ...extra,
  }
  })
}

/** Associe les vraies références (CIQUAL 2025, fiches Open Food Facts) aux ingrédients de démonstration. */
async function resolveNutrition(ingredients: Ingredient[]): Promise<Ingredient[]> {
  return Promise.all(
    ingredients.map(async (ing) => {
      const spec = nutriSpecs.get(ing.id)
      if (!spec) return ing
      const food = spec.ciqual ? ciqualToFood((await getCiqualFood(spec.ciqual))!) : offToFood(DEMO_OFF_PRODUCTS[spec.off!])!
      return { ...ing, nutrition: FoodLinkSchema.parse({ food, gramsPerUnit: spec.gramsPerUnit ?? null, density: spec.density ?? null, linkedAt: Date.now() }) }
    }),
  )
}

function steps(list: Array<string | [string, Partial<Step>]>): Step[] {
  return list.map((s) => {
    const [text, extra] = typeof s === 'string' ? [s, {}] : s
    return { id: newId('s_'), text, durationMin: null, temperatureC: null, photoId: null, timerMin: null, ...extra }
  })
}

interface DemoSpec {
  key: DemoKey
  recipe: Partial<Recipe> & Pick<Recipe, 'title'>
  journal: Array<Partial<JournalEntry> & { daysAgo: number }>
}

const notes = (n: Partial<Recipe['notes']>): Recipe['notes'] => ({
  tips: '',
  modifications: '',
  mistakes: '',
  ideas: '',
  storage: '',
  reheating: '',
  ...n,
})

function specs(): DemoSpec[] {
  return [
    {
      key: 'jarret',
      recipe: {
        title: 'Jarret de bœuf mijoté au four',
        description: 'Un jarret fondant, cuit lentement au vin rouge avec carottes et oignons. Le plat du dimanche par excellence.',
        category: 'plat',
        tags: ['mijoté', 'hiver', 'dimanche'],
        prepTime: 25,
        cookTime: 180,
        restTime: 0,
        servings: 4,
        difficulty: 2,
        rating: 5,
        favorite: true,
        ingredients: [
          ...ings('', [
            [1.4, 'kg', 'jarret de bœuf en tranches épaisses'],
            [3, '', 'carottes'],
            [2, '', 'oignons'],
            [3, 'gousse', 'ail'],
            [50, 'cl', 'vin rouge corsé'],
            [30, 'cl', 'bouillon de bœuf'],
            [2, 'c. à soupe', 'concentré de tomate'],
            [2, 'c. à soupe', "huile d'olive"],
            [1, 'c. à soupe', 'farine'],
            [1, '', 'bouquet garni', { scalable: false }],
            [null, '', 'sel et poivre', { toTaste: true, scalable: false }],
          ]),
        ],
        steps: steps([
          ['Préchauffer le four à 160 °C. Sortir la viande du réfrigérateur 30 minutes avant.', { temperatureC: 160 }],
          ['Saler les tranches de jarret, les fariner légèrement, puis les saisir 4 minutes par face dans la cocotte avec l’huile. Réserver.', { durationMin: 8, timerMin: 4 }],
          'Faire revenir oignons émincés et carottes en rondelles 5 minutes. Ajouter l’ail écrasé et le concentré de tomate.',
          ['Déglacer au vin rouge, gratter les sucs, laisser réduire 5 minutes.', { durationMin: 5, timerMin: 5 }],
          ['Remettre la viande, ajouter le bouillon et le bouquet garni. Couvrir et enfourner 2 h 45 à 160 °C.', { durationMin: 165, temperatureC: 160, timerMin: 165 }],
          'Vérifier la tendreté : la viande doit se détacher à la fourchette. Rectifier l’assaisonnement.',
        ]),
        notes: notes({
          tips: 'Le faire la veille : c’est encore meilleur réchauffé.',
          modifications: 'J’ajoute un carré de chocolat noir dans la sauce en fin de cuisson.',
          mistakes: 'Ne pas faire bouillir : le four ne doit pas dépasser 160 °C, sinon la viande sèche.',
          ideas: 'Essayer avec de la bière brune à la place du vin.',
          storage: '3 jours au réfrigérateur dans sa sauce, ou 3 mois au congélateur.',
          reheating: 'À couvert, 25 minutes à 150 °C, ou à feu doux en cocotte.',
        }),
      },
      journal: [
        { daysAgo: 95, rating: 5, comment: 'Cuisson 2 h 45 à 160 °C. Résultat excellent. La prochaine fois, mettre moins de vin.', actualCookTime: 165, temperatureC: 160 },
        { daysAgo: 160, rating: 4, comment: 'Un peu trop de sauce, réduire davantage avant d’enfourner.', modifications: '40 cl de vin seulement' },
      ],
    },
    {
      key: 'cottage',
      recipe: {
        title: 'Cottage pie',
        description: 'Le hachis anglais : bœuf mijoté aux légumes sous une purée gratinée au cheddar.',
        category: 'plat',
        tags: ['gratin', 'familial', 'batch cooking'],
        prepTime: 30,
        cookTime: 35,
        servings: 6,
        difficulty: 1,
        rating: 4,
        ingredients: [
          ...ings('Garniture', [
            [600, 'g', 'bœuf haché 15 %'],
            [1, '', 'oignon'],
            [2, '', 'carottes'],
            [150, 'g', 'petits pois'],
            [2, 'c. à soupe', 'concentré de tomate'],
            [1, 'c. à soupe', 'sauce Worcestershire'],
            [25, 'cl', 'bouillon de bœuf'],
            [1, 'c. à café', 'thym séché'],
          ]),
          ...ings('Purée', [
            [1.2, 'kg', 'pommes de terre farineuses'],
            [60, 'g', 'beurre'],
            [15, 'cl', 'lait'],
            [80, 'g', 'cheddar râpé'],
            [null, '', 'sel, poivre, muscade', { toTaste: true, scalable: false }],
          ]),
        ],
        steps: steps([
          ['Cuire les pommes de terre épluchées 20 minutes à l’eau salée.', { durationMin: 20, timerMin: 20 }],
          'Pendant ce temps, faire revenir oignon et carottes en dés, puis le bœuf haché jusqu’à coloration.',
          ['Ajouter concentré de tomate, Worcestershire, thym et bouillon. Mijoter 15 minutes, puis ajouter les petits pois.', { durationMin: 15, timerMin: 15 }],
          'Écraser les pommes de terre avec le beurre et le lait chaud. Assaisonner.',
          ['Verser la viande dans un plat, couvrir de purée, strier à la fourchette, parsemer de cheddar. Enfourner 20 minutes à 200 °C.', { durationMin: 20, temperatureC: 200, timerMin: 20 }],
        ]),
        notes: notes({
          tips: 'Strier la purée à la fourchette pour obtenir une croûte bien dorée.',
          storage: '3 jours au réfrigérateur. Se congèle très bien en portions.',
          reheating: '20 minutes à 180 °C, couvert d’aluminium les 10 premières minutes.',
        }),
      },
      journal: [{ daysAgo: 12, rating: 4, comment: 'Les enfants ont adoré. Doubler le cheddar la prochaine fois.' }],
    },
    {
      key: 'pancakes',
      recipe: {
        title: 'Pancakes protéinés',
        description: 'Des pancakes moelleux et rassasiants, riches en protéines grâce au skyr et à la whey.',
        category: 'petit-dejeuner',
        tags: ['protéiné', 'rapide', 'sport'],
        prepTime: 10,
        cookTime: 15,
        servings: 2,
        difficulty: 1,
        rating: 5,
        favorite: true,
        ingredients: ings('', [
          [2, '', 'œufs', { note: 'environ 50 g chacun sans coquille' }, { ciqual: '22000', gramsPerUnit: 50 }],
          [150, 'g', 'skyr nature 0 %', {}, { off: 'skyr' }],
          [40, 'g', "flocons d'avoine mixés", {}, { ciqual: '32140' }],
          [20, 'g', 'farine de sarrasin', {}, { ciqual: '9540' }],
          [30, 'g', 'whey isolate', {}, { off: 'wheyIsolate' }],
          [80, 'ml', 'lait demi-écrémé', { note: 'masse volumique 1,03 g/ml' }, { ciqual: '19041', density: 1.03 }],
          [5, 'g', 'levure chimique', { scalable: false }, { ciqual: '11046' }],
          [1, 'pincée', 'sel', { scalable: false, nutritionExcluded: true }],
          [null, '', 'myrtilles pour servir', { toTaste: true }],
        ]),
        steps: steps([
          'Mixer les flocons d’avoine en farine fine.',
          'Fouetter les œufs avec le skyr et le lait, puis ajouter avoine, farine de sarrasin, whey, levure et sel. Laisser reposer 5 minutes.',
          ['Cuire des petites louches de pâte dans une poêle légèrement huilée, 2 minutes par face à feu moyen.', { durationMin: 15, timerMin: 2 }],
          'Servir avec des myrtilles et un filet de miel.',
        ]),
        notes: notes({
          tips: 'Pâte un peu épaisse = pancakes plus épais. Ajuster avec un trait de lait.',
          mistakes: 'Feu trop fort : l’extérieur brûle avant que le cœur soit cuit.',
          storage: '2 jours au réfrigérateur, se congèlent séparés par du papier cuisson.',
          reheating: 'Grille-pain ou 30 secondes au micro-ondes.',
        }),
      },
      journal: [
        { daysAgo: 3, rating: 5, comment: 'Version 3 œufs : plus aérien.', modifications: 'Passé à 3 œufs, tout ajusté' },
        { daysAgo: 10, rating: 4, comment: 'Bon, un peu sec. Plus de lait.' },
      ],
    },
    {
      key: 'poulet',
      recipe: {
        title: 'Poulet rôti aux légumes',
        description: 'Un poulet doré à la peau croustillante, rôti sur un lit de légumes qui confisent dans les sucs.',
        category: 'plat',
        tags: ['four', 'dimanche', 'familial'],
        prepTime: 20,
        cookTime: 75,
        restTime: 10,
        servings: 4,
        difficulty: 1,
        rating: 4,
        toTry: false,
        ingredients: ings('', [
          [1.6, 'kg', 'poulet fermier'],
          [600, 'g', 'pommes de terre grenaille'],
          [3, '', 'carottes'],
          [2, '', 'oignons rouges'],
          [1, '', 'tête d’ail', { scalable: false }],
          [40, 'g', 'beurre mou'],
          [3, 'c. à soupe', "huile d'olive"],
          [1, '', 'citron'],
          [4, 'brin', 'thym'],
          [null, '', 'fleur de sel, poivre', { toTaste: true, scalable: false }],
        ]),
        steps: steps([
          ['Préchauffer le four à 210 °C. Sortir le poulet 30 minutes avant.', { temperatureC: 210 }],
          'Couper les légumes, les mélanger avec l’huile, le sel et le thym, les étaler dans le plat.',
          'Badigeonner le poulet de beurre, saler, glisser le citron coupé en deux et l’ail dans la cavité.',
          ['Enfourner 1 h 15 en arrosant toutes les 20 minutes.', { durationMin: 75, temperatureC: 210, timerMin: 75 }],
          ['Laisser reposer 10 minutes sous une feuille d’aluminium avant de découper.', { durationMin: 10, timerMin: 10 }],
        ]),
        notes: notes({
          tips: 'Poser le poulet sur le côté 20 minutes, puis l’autre côté, puis sur le dos : cuisson plus homogène.',
          storage: 'Les restes : 2 jours au réfrigérateur. Parfaits en salade ou en sandwich.',
        }),
      },
      journal: [{ daysAgo: 70, rating: 4, comment: 'Peau parfaite. Légumes un peu trop cuits, les ajouter après 20 minutes.' }],
    },
    {
      key: 'chocolat',
      recipe: {
        title: 'Gâteau au chocolat fondant',
        description: 'Cœur coulant, croûte fine : le fondant incontournable, prêt en 35 minutes.',
        category: 'dessert',
        tags: ['chocolat', 'gourmand', 'anniversaire'],
        prepTime: 15,
        cookTime: 22,
        restTime: 30,
        servings: 8,
        difficulty: 1,
        rating: 5,
        favorite: true,
        ingredients: ings('', [
          [200, 'g', 'chocolat noir 70 %'],
          [150, 'g', 'beurre'],
          [4, '', 'œufs'],
          [120, 'g', 'sucre'],
          [50, 'g', 'farine'],
          [1, 'pincée', 'fleur de sel'],
        ]),
        steps: steps([
          ['Préchauffer le four à 180 °C. Beurrer et fariner un moule de 22 cm.', { temperatureC: 180 }],
          'Faire fondre le chocolat et le beurre au bain-marie. Laisser tiédir.',
          'Fouetter les œufs et le sucre jusqu’à ce que le mélange blanchisse.',
          'Incorporer le chocolat, puis la farine et la fleur de sel.',
          ['Enfourner 22 minutes : le centre doit rester tremblotant.', { durationMin: 22, temperatureC: 180, timerMin: 22 }],
          ['Laisser refroidir 30 minutes avant de démouler.', { durationMin: 30, timerMin: 30 }],
        ]),
        notes: notes({
          tips: 'Meilleur le lendemain, à température ambiante.',
          mistakes: 'Au-delà de 25 minutes, il n’est plus fondant.',
          ideas: 'Ajouter un trait de café serré ou des noisettes torréfiées.',
          storage: '3 jours sous cloche.',
        }),
      },
      journal: [
        { daysAgo: 40, rating: 5, comment: 'Anniversaire de Léa. 21 minutes, parfait.', actualCookTime: 21, temperatureC: 180 },
        { daysAgo: 120, rating: 4, comment: 'Un peu trop cuit (25 min).' },
      ],
    },
    {
      key: 'crepes',
      recipe: {
        title: 'Crêpes de base',
        description: 'La pâte à crêpes de tous les jours, sucrée ou salée. Idéale pour tester l’ajustement des quantités.',
        category: 'dessert',
        tags: ['classique', 'chandeleur', 'rapide'],
        prepTime: 10,
        cookTime: 20,
        restTime: 60,
        servings: 4,
        difficulty: 1,
        rating: 4,
        toTry: false,
        ingredients: ings('', [
          [3, '', 'œufs', { note: 'environ 50 g chacun sans coquille' }, { ciqual: '22000', gramsPerUnit: 50 }],
          [100, 'g', 'farine', { note: 'type T45' }, { ciqual: '9440' }],
          [300, 'ml', 'lait', { note: 'demi-écrémé' }, { ciqual: '19033', density: 1.03 }],
          [30, 'g', 'beurre fondu', {}, { ciqual: '16400' }],
          [1, 'pincée', 'sel', { nutritionExcluded: true }],
          [null, '', 'sucre', { toTaste: true, quantityText: '' }],
        ]),
        steps: steps([
          'Verser la farine dans un saladier, creuser un puits, ajouter les œufs et le sel.',
          'Incorporer le lait petit à petit en fouettant pour éviter les grumeaux, puis le beurre fondu.',
          ['Laisser reposer la pâte 1 heure.', { durationMin: 60, timerMin: 60 }],
          'Cuire dans une poêle chaude légèrement beurrée, 1 minute par face.',
        ]),
        notes: notes({
          tips: 'Une cuillère de rhum ou de fleur d’oranger dans la pâte.',
          mistakes: 'Ne pas verser tout le lait d’un coup.',
        }),
      },
      journal: [],
    },
  ]
}

const DEMO_COLLECTIONS: Array<{ name: string; description: string; keys: DemoKey[] }> = [
  { name: 'Mes classiques', description: 'Les recettes que je refais sans cesse.', keys: ['jarret', 'chocolat', 'crepes', 'poulet'] },
  { name: 'Plats mijotés', description: 'Cuissons longues et réconfortantes.', keys: ['jarret', 'cottage'] },
  { name: 'Protéinées', description: 'Pour les jours de sport.', keys: ['pancakes', 'poulet'] },
]

/** Installe les données de démonstration si elles ne l'ont jamais été. */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const idsByKey = new Map<DemoKey, string>()
  const photoByKey = new Map<DemoKey, string>()
  for (const [index, spec] of specs().entries()) {
    const svg = demoIllustration(spec.key)
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const photoId = newId('ph_')
    await db.photos.put({ id: photoId, blob, thumb: blob, mime: 'image/svg+xml', width: 760, height: 600, size: blob.size, createdAt: now, isDemo: true })
    const created = now - (200 - index * 10) * DAY
    const recipe = RecipeSchema.parse({
      ...spec.recipe,
      ingredients: await resolveNutrition(spec.recipe.ingredients ?? []),
      id: newId('r_'),
      mainPhotoId: photoId,
      isDemo: true,
      createdAt: created,
      updatedAt: created + 5 * DAY,
      source: 'Démonstration Mon Carnet',
    })
    const entries: JournalEntry[] = spec.journal.map(({ daysAgo, ...j }) => ({
      id: newId('j_'),
      recipeId: recipe.id,
      date: now - daysAgo * DAY,
      rating: 0,
      photoId: null,
      comment: '',
      modifications: '',
      quantitiesUsed: [],
      factor: null,
      actualCookTime: null,
      temperatureC: null,
      isDemo: true,
      ...j,
    }))
    recipe.cookCount = entries.length
    recipe.lastCookedAt = entries.length ? Math.max(...entries.map((e) => e.date)) : null
    await db.recipes.put(recipe)
    await db.journal.bulkPut(entries)
    idsByKey.set(spec.key, recipe.id)
    photoByKey.set(spec.key, photoId)
  }
  const cols: Collection[] = DEMO_COLLECTIONS.map((c, order) => ({
    id: newId('c_'),
    name: c.name,
    description: c.description,
    coverPhotoId: photoByKey.get(c.keys[0]) ?? null,
    recipeIds: c.keys.map((k) => idsByKey.get(k)!).filter(Boolean),
    order,
    createdAt: now,
    updatedAt: now,
    isDemo: true,
  }))
  await db.collections.bulkPut(cols)
}
