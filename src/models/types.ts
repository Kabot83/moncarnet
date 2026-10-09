/**
 * Modèle de données de Mon Carnet.
 *
 * Les schémas Zod servent à la fois à typer l'application et à valider tout ce
 * qui vient de l'extérieur : sauvegardes ZIP, imports URL, réponses de Gemini.
 * Rien d'externe n'est enregistré sans être passé par ces schémas.
 */
import { z } from 'zod'

export const CATEGORIES = [
  { id: 'entree', label: 'Entrées' },
  { id: 'plat', label: 'Plats' },
  { id: 'dessert', label: 'Desserts' },
  { id: 'petit-dejeuner', label: 'Petits-déjeuners' },
  { id: 'collation', label: 'Collations' },
  { id: 'autre', label: 'Autres' },
] as const
export type CategoryId = (typeof CATEGORIES)[number]['id']
export const categoryIds = CATEGORIES.map((c) => c.id) as [CategoryId, ...CategoryId[]]
export const categoryLabel = (id: CategoryId) =>
  CATEGORIES.find((c) => c.id === id)?.label.replace(/s$/, '').replace('Petits-déjeuner', 'Petit-déjeuner') ?? 'Autre'

export const DIFFICULTIES = [
  { id: 1, label: 'Facile' },
  { id: 2, label: 'Intermédiaire' },
  { id: 3, label: 'Exigeante' },
] as const
export type Difficulty = 1 | 2 | 3
export const difficultyLabel = (d: Difficulty) => DIFFICULTIES.find((x) => x.id === d)?.label ?? 'Facile'

const id = z.string().min(1).max(64)
const minutes = z.number().min(0).max(60 * 24 * 7).nullable()

// ---------------------------------------------------------------------------
// Nutrition : référence d'un ingrédient vers un aliment CIQUAL / Open Food Facts / personnel
// ---------------------------------------------------------------------------

export const NUTRIENT_KEYS = ['kcal', 'kj', 'protein', 'carbs', 'fat', 'fiber', 'sugars', 'satFat', 'salt'] as const
export type NutrientKey = (typeof NUTRIENT_KEYS)[number]
/** Les quatre indicateurs principaux. */
export const MAIN_NUTRIENTS = ['kcal', 'protein', 'carbs', 'fat'] as const satisfies readonly NutrientKey[]

/**
 * Teneur pour 100 g (ou 100 ml) : nombre, `null` = inconnue (jamais zéro),
 * `"t"` = traces, `"<x"` = inférieure au seuil x (conventions CIQUAL).
 */
export const NutrientValueSchema = z.union([z.number().min(0).max(100000), z.null(), z.literal('t'), z.string().regex(/^<\d+(\.\d+)?$/)])
export type NutrientValue = z.infer<typeof NutrientValueSchema>

export const FoodSourceSchema = z.enum(['ciqual', 'off', 'custom'])
export type FoodSource = z.infer<typeof FoodSourceSchema>

const nv = () => NutrientValueSchema.default(null)
export const Per100Schema = z.object({
  kcal: nv(),
  kj: nv(),
  protein: nv(),
  carbs: nv(),
  fat: nv(),
  fiber: nv(),
  sugars: nv(),
  satFat: nv(),
  salt: nv(),
})
export type Per100 = z.infer<typeof Per100Schema>

/** Aliment nutritionnel (référence copiée dans la recette : elle reste autonome hors ligne). */
export const FoodSchema = z.object({
  source: FoodSourceSchema,
  /** Code CIQUAL (alim_code), code-barres Open Food Facts, ou identifiant personnel. */
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(300),
  brand: z.string().max(200).default(''),
  /** Les valeurs sont pour 100 g ou pour 100 ml. */
  basis: z.enum(['100g', '100ml']).default('100g'),
  per100: Per100Schema,
  /** Édition / date de la donnée (« Ciqual 2025 », date de modification OFF…). */
  version: z.string().max(80).default(''),
  /** Remarques de provenance (énergie convertie depuis les kJ, produit incomplet…). */
  notes: z.array(z.string().max(200)).max(10).default([]),
  fetchedAt: z.number().default(0),
})
export type Food = z.infer<typeof FoodSchema>

export const FoodLinkSchema = z.object({
  food: FoodSchema,
  /** Poids comestible d'une pièce (œuf, banane…), renseigné ou validé par l'utilisateur. */
  gramsPerUnit: z.number().positive().max(100000).nullable().default(null),
  /** Masse volumique (g/ml) renseignée par l'utilisateur, pour passer des ml aux g. */
  density: z.number().positive().max(30).nullable().default(null),
  /** Corrections manuelles, prioritaires sur la source (pour 100 g/ml). */
  overrides: z.partialRecord(z.enum(NUTRIENT_KEYS), z.number().min(0).max(100000)).default({}),
  linkedAt: z.number().default(0),
})
export type FoodLink = z.infer<typeof FoodLinkSchema>

export const IngredientSchema = z.object({
  id,
  name: z.string().max(200),
  /** Quantité numérique d'origine. `null` = quantité non numérique ou absente. */
  quantity: z.number().min(0).max(1e6).nullable(),
  unit: z.string().max(40).default(''),
  /** Texte libre utilisé lorsque la quantité n'est pas numérique (« une poignée »). */
  quantityText: z.string().max(80).default(''),
  note: z.string().max(300).default(''),
  /** Groupe facultatif : « Pâte », « Sauce »… Chaîne vide = groupe principal. */
  group: z.string().max(80).default(''),
  /** `false` : l'ingrédient n'est jamais recalculé (sel, épices, levure…). */
  scalable: z.boolean().default(true),
  /** « Selon le goût » : jamais recalculé. */
  toTaste: z.boolean().default(false),
  /** Référence nutritionnelle choisie par l'utilisateur (jamais associée automatiquement). */
  nutrition: FoodLinkSchema.nullable().default(null),
  /** Exclu volontairement du calcul nutritionnel (eau de cuisson…). */
  nutritionExcluded: z.boolean().default(false),
})
export type Ingredient = z.infer<typeof IngredientSchema>

export const StepSchema = z.object({
  id,
  text: z.string().max(4000),
  durationMin: minutes.default(null),
  temperatureC: z.number().min(-40).max(400).nullable().default(null),
  photoId: z.string().nullable().default(null),
  /** Minuterie proposée pour l'étape (en minutes). */
  timerMin: minutes.default(null),
})
export type Step = z.infer<typeof StepSchema>

export const NOTE_FIELDS = [
  { id: 'tips', label: 'Mes astuces' },
  { id: 'modifications', label: 'Mes modifications' },
  { id: 'mistakes', label: 'Erreurs à éviter' },
  { id: 'ideas', label: "Idées d'amélioration" },
  { id: 'storage', label: 'Conservation' },
  { id: 'reheating', label: 'Réchauffage' },
] as const
export type NoteField = (typeof NOTE_FIELDS)[number]['id']

export const NotesSchema = z.object({
  tips: z.string().max(5000).default(''),
  modifications: z.string().max(5000).default(''),
  mistakes: z.string().max(5000).default(''),
  ideas: z.string().max(5000).default(''),
  storage: z.string().max(5000).default(''),
  reheating: z.string().max(5000).default(''),
})
export type Notes = z.infer<typeof NotesSchema>

export const NutritionValuesSchema = z.object({
  kcal: z.number().min(0).max(100000).nullable(),
  protein: z.number().min(0).max(10000).nullable(),
  carbs: z.number().min(0).max(10000).nullable(),
  fat: z.number().min(0).max(10000).nullable(),
  fiber: z.number().min(0).max(10000).nullable(),
})
export type NutritionValues = z.infer<typeof NutritionValuesSchema>

export const NutritionSchema = z.object({
  /** Valeurs pour la recette entière, aux quantités d'origine. */
  total: NutritionValuesSchema,
  /** `manual` : saisi ; `database` : calculé (CIQUAL/OFF) ; `ai-estimate` : estimation IA. */
  source: z.enum(['manual', 'database', 'ai-estimate']),
  updatedAt: z.number(),
})
export type Nutrition = z.infer<typeof NutritionSchema>

export const RecipeSchema = z.object({
  id,
  title: z.string().min(1).max(200),
  description: z.string().max(3000).default(''),
  mainPhotoId: z.string().nullable().default(null),
  galleryPhotoIds: z.array(z.string()).default([]),
  category: z.enum(categoryIds).default('plat'),
  tags: z.array(z.string().max(40)).max(40).default([]),
  prepTime: minutes.default(null),
  cookTime: minutes.default(null),
  restTime: minutes.default(null),
  servings: z.number().min(0).max(1000).nullable().default(4),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
  source: z.string().max(300).default(''),
  sourceUrl: z.string().max(2000).default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
  favorite: z.boolean().default(false),
  toTry: z.boolean().default(false),
  /** Note personnelle sur 5 (0 = non notée). */
  rating: z.number().min(0).max(5).default(0),
  ingredients: z.array(IngredientSchema).max(300).default([]),
  steps: z.array(StepSchema).max(200).default([]),
  notes: NotesSchema.default({ tips: '', modifications: '', mistakes: '', ideas: '', storage: '', reheating: '' }),
  nutrition: NutritionSchema.nullable().default(null),
  /** Recette créée à partir d'une autre (variante). */
  variantOf: z.string().nullable().default(null),
  /** Données de démonstration, supprimables en un geste. */
  isDemo: z.boolean().default(false),
  /** Champs dénormalisés depuis le journal, pour trier et filtrer vite. */
  cookCount: z.number().int().min(0).default(0),
  lastCookedAt: z.number().nullable().default(null),
  /** Poids de la préparation après cuisson (g), pesé par l'utilisateur. */
  cookedWeightG: z.number().positive().max(1e6).nullable().default(null),
  /** Poids total des ingrédients au moment de la pesée : sert à détecter qu'il faut la refaire. */
  cookedWeightRawG: z.number().positive().max(1e6).nullable().default(null),
})
export type Recipe = z.infer<typeof RecipeSchema>

export const QuantityUsedSchema = z.object({
  ingredientId: z.string(),
  name: z.string(),
  quantity: z.number().nullable(),
  unit: z.string(),
})

export const JournalEntrySchema = z.object({
  id,
  recipeId: id,
  date: z.number(),
  rating: z.number().min(0).max(5).default(0),
  photoId: z.string().nullable().default(null),
  comment: z.string().max(5000).default(''),
  modifications: z.string().max(5000).default(''),
  /** Quantités réellement utilisées (ajustements temporaires inclus). */
  quantitiesUsed: z.array(QuantityUsedSchema).default([]),
  /** Coefficient global appliqué (1 = proportions d'origine). */
  factor: z.number().nullable().default(null),
  actualCookTime: minutes.default(null),
  temperatureC: z.number().nullable().default(null),
  isDemo: z.boolean().default(false),
})
export type JournalEntry = z.infer<typeof JournalEntrySchema>

export const CollectionSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(''),
  coverPhotoId: z.string().nullable().default(null),
  /** Ordre personnalisé des recettes dans la collection. */
  recipeIds: z.array(z.string()).default([]),
  /** Position de la collection dans la liste. */
  order: z.number().default(0),
  createdAt: z.number(),
  updatedAt: z.number(),
  isDemo: z.boolean().default(false),
})
export type Collection = z.infer<typeof CollectionSchema>

export const SHOP_CATEGORIES = [
  'Fruits et légumes',
  'Boucherie et poissonnerie',
  'Crèmerie et œufs',
  'Boulangerie',
  'Épicerie salée',
  'Épicerie sucrée',
  'Épices et condiments',
  'Boissons',
  'Surgelés',
  'Autres',
] as const
export type ShopCategory = (typeof SHOP_CATEGORIES)[number]

export const ShoppingItemSchema = z.object({
  id,
  name: z.string().min(1).max(200),
  quantity: z.number().nullable(),
  unit: z.string().default(''),
  /** Pour les lignes non additionnables (« 1 pincée + selon le goût »). */
  extra: z.string().default(''),
  category: z.enum(SHOP_CATEGORIES),
  checked: z.boolean().default(false),
  manual: z.boolean().default(false),
  recipeTitles: z.array(z.string()).default([]),
  createdAt: z.number(),
})
export type ShoppingItem = z.infer<typeof ShoppingItemSchema>

export const PhotoMetaSchema = z.object({
  id,
  mime: z.string(),
  width: z.number(),
  height: z.number(),
  size: z.number(),
  createdAt: z.number(),
  isDemo: z.boolean().default(false),
})
export interface Photo extends z.infer<typeof PhotoMetaSchema> {
  blob: Blob
  thumb: Blob
}

/** Ajustement temporaire : un coefficient par groupe, toujours relatif aux quantités d'origine. */
export const ScaleStateSchema = z.object({
  /** Coefficient global (s'applique aux groupes sans coefficient propre). */
  global: z.number().positive(),
  /** Coefficients propres à un groupe (« Sauce » : 1,5). */
  groups: z.record(z.string(), z.number().positive()).default({}),
  /** Dernier ingrédient utilisé comme référence (affichage seulement). */
  referenceId: z.string().nullable().default(null),
})
export type ScaleState = z.infer<typeof ScaleStateSchema>

export const TimerSchema = z.object({
  id,
  label: z.string(),
  recipeId: z.string().nullable(),
  durationMs: z.number().positive(),
  /** Horodatage de fin si la minuterie tourne. */
  endsAt: z.number().nullable(),
  /** Temps restant si la minuterie est en pause. */
  remainingMs: z.number().nullable(),
  done: z.boolean().default(false),
  createdAt: z.number(),
})
export type Timer = z.infer<typeof TimerSchema>

/** Préparation en cours d'une recette. Une seule par recette. */
export const CookingSessionSchema = z.object({
  recipeId: id,
  scale: ScaleStateSchema,
  /** Coefficient choisi via le nombre de portions (inclus dans scale.global). */
  checkedIngredientIds: z.array(z.string()).default([]),
  currentStep: z.number().int().min(0).default(0),
  /** `true` lorsque l'utilisateur a validé « Utiliser pour cette préparation ». */
  started: z.boolean().default(false),
  startedAt: z.number(),
  updatedAt: z.number(),
})
export type CookingSession = z.infer<typeof CookingSessionSchema>

export const PROFILE_FIELDS = [
  { id: 'liked', label: 'Aliments préférés', placeholder: 'Ex. : tomates, poulet, chocolat noir' },
  { id: 'disliked', label: 'Aliments que je n’aime pas', placeholder: 'Ex. : coriandre, abats' },
  { id: 'allergens', label: 'Allergènes à éviter', placeholder: 'Ex. : arachides, fruits à coque' },
  { id: 'diet', label: 'Préférences alimentaires', placeholder: 'Ex. : flexitarien, peu de sucre' },
  { id: 'goals', label: 'Objectifs nutritionnels', placeholder: 'Ex. : plus de protéines' },
  { id: 'usualTime', label: 'Temps de préparation habituel', placeholder: 'Ex. : 30 minutes en semaine' },
  { id: 'equipment', label: 'Matériel disponible', placeholder: 'Ex. : four, cocotte en fonte, robot' },
  { id: 'servings', label: 'Nombre de portions habituel', placeholder: 'Ex. : 4' },
] as const
export type ProfileField = (typeof PROFILE_FIELDS)[number]['id']
export type CulinaryProfile = Record<ProfileField, string>
export const emptyProfile = (): CulinaryProfile =>
  Object.fromEntries(PROFILE_FIELDS.map((f) => [f.id, ''])) as CulinaryProfile

export const AiModeSchema = z.enum(['off', 'direct', 'proxy'])
export type AiMode = z.infer<typeof AiModeSchema>

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  catalogView: 'grid' | 'list'
  /** `precise` : 133 g ; `practical` : 135 g. */
  rounding: 'precise' | 'practical'
  allowHalfEggs: boolean
  aiMode: AiMode
  aiModel: string
  aiFallbackModel: string
  aiDailyLimit: number
  proxyUrl: string
  nutritionEnabled: boolean
  demoSeeded: boolean
  backupReminderDismissedAt: number | null
  lastBackupAt: number | null
}

/** Secrets : jamais exportés dans une sauvegarde. */
export interface AppSecrets {
  apiKey: string
  proxyToken: string
}

export const defaultSettings = (): AppSettings => ({
  theme: 'system',
  catalogView: 'grid',
  rounding: 'practical',
  allowHalfEggs: true,
  aiMode: 'off',
  aiModel: '',
  aiFallbackModel: '',
  aiDailyLimit: 30,
  proxyUrl: '',
  nutritionEnabled: true,
  demoSeeded: false,
  backupReminderDismissedAt: null,
  lastBackupAt: null,
})

export interface ChatMessage {
  id: string
  role: 'user' | 'model'
  text: string
  /** Recettes proposées dans ce message (validées par Zod). */
  recipes?: AiRecipe[]
  /** Pièce jointe : recettes de mon carnet transmises en contexte. */
  contextRecipeIds?: string[]
  /** Message d'erreur affiché à la place d'une réponse. */
  error?: string
  createdAt: number
}

export interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  /** Recette du carnet sur laquelle porte la conversation (amélioration). */
  recipeId: string | null
  createdAt: number
  updatedAt: number
}

export interface Draft {
  id: string
  data: Recipe
  /** Origine du brouillon, pour l'affichage. */
  origin: 'manual' | 'edit' | 'url' | 'photo' | 'text' | 'ai' | 'variant'
  /** Points à vérifier signalés par l'import. */
  warnings?: string[]
  updatedAt: number
}

/** Recette telle que proposée par l'IA, avant conversion en fiche. */
export const AiIngredientSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().min(0).max(100000).nullable().optional(),
  unit: z.string().max(40).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
  group: z.string().max(80).nullable().optional(),
})
export const AiRecipeSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(3000).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
  prepTime: z.number().min(0).max(10080).nullable().optional(),
  cookTime: z.number().min(0).max(10080).nullable().optional(),
  restTime: z.number().min(0).max(10080).nullable().optional(),
  servings: z.number().min(0).max(1000).nullable().optional(),
  difficulty: z.number().min(1).max(3).nullable().optional(),
  ingredients: z.array(AiIngredientSchema).max(150),
  steps: z
    .array(
      z.object({
        text: z.string().min(1).max(4000),
        durationMin: z.number().min(0).max(10080).nullable().optional(),
        temperatureC: z.number().min(-40).max(400).nullable().optional(),
      }),
    )
    .max(100),
  tips: z.string().max(3000).nullable().optional(),
  tags: z.array(z.string().max(40)).max(20).nullable().optional(),
})
export type AiRecipe = z.infer<typeof AiRecipeSchema>
