/**
 * Section « Nutrition » de la fiche recette.
 * Calcul automatique : chaque ingrédient est reconnu (choix de l'utilisateur, préférence
 * mémorisée, dictionnaire CIQUAL, recherche approchée) et converti en poids (poids usuels
 * signalés). Fiabilité affichée : vérifié, estimation ou partiel. Un geste pour corriger.
 */
import { AlertTriangle, CheckCircle2, ChevronRight, CircleHelp, Scale, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { estimateNutrition } from '@/ai/chef'
import { type AiError, toAiError } from '@/ai/errors'
import { IDENTITY_SCALE, scaledServings } from '@/lib/scaling'
import { formatNumber } from '@/lib/units'
import { type Ingredient, MAIN_NUTRIENTS, type Recipe, type ScaleState } from '@/models/types'
import { CIQUAL_CITATION } from '@/nutrition/ciqual'
import { type IngredientRow, LABELS, type MainKey, type NutritionMode, type NutritionResult, type Reliability, type RowQuality, UNITS, computeNutrition, cookedWeightNeedsReview, formatNutrient, nutritionView, rawOriginalGrams } from '@/nutrition/engine'
import { setCookedWeight } from '@/nutrition/foods'
import { OFF_ATTRIBUTION } from '@/nutrition/off'
import { useAutoMatches } from '@/nutrition/useAutoNutrition'
import { patchRecipe } from '@/services/recipes'
import { AiErrorBox } from './AiErrorBox'
import { FoodLinkSheet } from './nutrition/FoodLinkSheet'
import { Button } from './ui/Button'
import { useToast } from './ui/Feedback'
import { NumberInput, Segmented } from './ui/Fields'
import { Sheet } from './ui/Sheet'
import { Spinner } from './ui/Spinner'

const MODE_KEY = 'mc-nutrition-mode'
const readMode = (): NutritionMode => {
  try {
    const m = localStorage.getItem(MODE_KEY)
    return m === 'per100' || m === 'portion' || m === 'total' ? m : 'portion'
  } catch {
    return 'portion'
  }
}

const RELIABILITY: Record<Reliability, { label: string; className: string; icon: typeof CheckCircle2 }> = {
  complete: { label: 'Calcul vérifié', className: 'bg-sage-soft text-sage', icon: CheckCircle2 },
  estimate: { label: 'Estimation', className: 'bg-[color-mix(in_oklab,var(--c-gold)_18%,transparent)] text-gold', icon: CircleHelp },
  incomplete: { label: 'Partiel', className: 'bg-danger-soft text-danger', icon: AlertTriangle },
}

/** Fiabilité de chaque ingrédient, telle qu'affichée. */
export const QUALITY: Record<RowQuality, { label: string; dot: string }> = {
  verified: { label: 'Vérifié', dot: 'bg-sage' },
  estimated: { label: 'Estimé', dot: 'bg-gold' },
  uncertain: { label: 'Incertain', dot: 'bg-terra' },
  missing: { label: 'Manquant', dot: 'bg-danger' },
  ignored: { label: 'Non compté', dot: 'bg-line' },
}

/** Résumé discret : « 4 estimés · 1 à confirmer ». */
function qualityCounts(result: NutritionResult) {
  const c: Record<RowQuality, number> = { verified: 0, estimated: 0, uncertain: 0, missing: 0, ignored: 0 }
  for (const r of result.rows) if (r.ingredient.name.trim()) c[r.quality]++
  return c
}

/** Calcul complet d'une recette, avec reconnaissance automatique (null pendant le chargement). */
export function useRecipeNutrition(ingredients: Recipe['ingredients'], scale: ScaleState) {
  const auto = useAutoMatches(ingredients)
  const result = useMemo(() => (auto ? computeNutrition(ingredients, scale, auto) : null), [ingredients, scale, auto])
  const rawOriginal = useMemo(() => (auto ? rawOriginalGrams(ingredients, auto) : 0), [ingredients, auto])
  return { auto, result, rawOriginal }
}

const SHORT: Record<MainKey, string> = { kcal: 'Calories', protein: 'Protéines', carbs: 'Glucides', fat: 'Lipides' }

export function NutritionPanel({ recipe, scale }: { recipe: Recipe; scale: ScaleState }) {
  const [mode, setModeState] = useState<NutritionMode>(readMode)
  const [detailOpen, setDetailOpen] = useState(false)
  const [weightOpen, setWeightOpen] = useState(false)
  const [linkFor, setLinkFor] = useState<Ingredient | null>(null)
  const [whyOpen, setWhyOpen] = useState(false)
  const setMode = (m: NutritionMode) => {
    setModeState(m)
    try {
      localStorage.setItem(MODE_KEY, m)
    } catch {
      /* préférence non mémorisée */
    }
  }

  const { auto, result, rawOriginal } = useRecipeNutrition(recipe.ingredients, scale)

  if (!result || !auto)
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-card)] bg-paper p-4 text-sm text-muted shadow-[var(--shadow-card)]" role="status">
        <Spinner size={16} /> Calcul des valeurs nutritionnelles…
      </div>
    )

  const view = nutritionView(result, mode, recipe, scale, rawOriginal)
  const servings = scaledServings(scale, recipe.servings)
  const rel = RELIABILITY[view.reliability]
  const sources = new Set(result.rows.filter((r) => r.status === 'ok').map((r) => r.link?.food.source))
  const needsReview = cookedWeightNeedsReview(recipe, rawOriginal)
  const counts = qualityCounts(result)
  const toFix = counts.missing + counts.uncertain

  const caption =
    mode === 'total'
      ? 'Recette entière'
      : mode === 'portion'
        ? servings
          ? `Pour 1 portion (sur ${formatNumber(servings, 1)})`
          : ''
        : view.weight
          ? view.weight.kind === 'raw'
            ? `Pour 100 g · base ${formatNumber(view.weight.grams, 0)} g d’ingrédients (avant cuisson)`
            : `Pour 100 g de préparation cuite · ${formatNumber(view.weight.grams, 0)} g${view.weight.kind === 'cooked-extrapolated' ? ' (extrapolé)' : ''}`
          : ''

  return (
    <>
      <div className="rounded-[var(--radius-card)] bg-paper p-4 shadow-[var(--shadow-card)]">
        <div className="flex justify-center">
          <Segmented
            label="Base de calcul"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'per100', label: '100 g' },
              { value: 'portion', label: 'Portion' },
              { value: 'total', label: 'Total' },
            ]}
          />
        </div>

        {view.available ? (
          <>
            <dl className="mt-4 grid grid-cols-4 gap-2" aria-label="Valeurs nutritionnelles">
              {MAIN_NUTRIENTS.map((k) => (
                <div key={k} className="rounded-2xl bg-sunken px-1 py-3 text-center">
                  <dd className="font-serif text-[1.35rem] leading-none font-semibold tabular-nums">
                    {view.reliability === 'incomplete' && <span className="text-sm font-normal text-muted">≥ </span>}
                    {formatNutrient(k, view.values[k])}
                  </dd>
                  <dt className="mt-1.5 text-[11px] leading-tight text-muted">
                    {UNITS[k] === 'kcal' ? 'kcal' : `g ${SHORT[k].toLowerCase()}`}
                  </dt>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-center text-xs text-muted">{caption}</p>
          </>
        ) : (
          <p className="mt-4 rounded-2xl bg-sunken p-3 text-center text-sm text-muted">{view.unavailableReason}</p>
        )}

        <button type="button" onClick={() => setWhyOpen((v) => !v)} aria-expanded={whyOpen} className={`mt-3 flex w-full items-center gap-2 rounded-full px-3 py-2 text-left text-sm font-semibold ${rel.className}`}>
          <rel.icon size={16} className="shrink-0" />
          <span className="flex-1">
            {rel.label}
            {result.coverage.expected > 0 && (
              <span className="font-normal opacity-80">
                {' '}
                · {result.coverage.done}/{result.coverage.expected} ingrédients
              </span>
            )}
          </span>
          {view.reasons.length > 0 && <ChevronRight size={16} className={`transition-transform ${whyOpen ? 'rotate-90' : ''}`} />}
        </button>
        {whyOpen && view.reasons.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-muted">
            {view.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}

        <button type="button" onClick={() => setDetailOpen(true)} className="mt-2 flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs text-muted" aria-label="Fiabilité par ingrédient">
          {(['verified', 'estimated', 'uncertain', 'missing'] as const)
            .filter((q) => counts[q] > 0)
            .map((q) => (
              <span key={q} className="inline-flex items-center gap-1">
                <span className={`size-2 rounded-full ${QUALITY[q].dot}`} aria-hidden />
                {counts[q]} {QUALITY[q].label.toLowerCase()}
                {counts[q] > 1 ? 's' : ''}
              </span>
            ))}
          {toFix > 0 && <span className="font-semibold text-terra">· Corriger</span>}
        </button>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="sm" variant="secondary" aria-label="Détail par ingrédient" onClick={() => setDetailOpen(true)}>
            Détail
          </Button>
          <Button
            size="sm"
            variant={needsReview ? 'soft' : 'secondary'}
            icon={<Scale size={15} />}
            aria-label={recipe.cookedWeightG ? undefined : 'Poids après cuisson'}
            onClick={() => setWeightOpen(true)}
          >
            {recipe.cookedWeightG ? `Cuit : ${formatNumber(recipe.cookedWeightG, 0)} g${needsReview ? ' (à revoir)' : ''}` : 'Poids cuit'}
          </Button>
        </div>
        <Attribution sources={sources} />
        {result.coverage.done === 0 && <LegacyNutrition recipe={recipe} />}
      </div>

      <DetailSheet open={detailOpen} onClose={() => setDetailOpen(false)} result={result} onLink={setLinkFor} />
      <CookedWeightSheet open={weightOpen} onClose={() => setWeightOpen(false)} recipe={recipe} rawOriginal={rawOriginal} rawComplete={result.rawGramsComplete} />
      <FoodLinkSheet open={!!linkFor} onClose={() => setLinkFor(null)} recipeId={recipe.id} ingredient={linkFor} />
    </>
  )
}

/** Aperçu en direct dans l'éditeur : calculé pendant la saisie, sans aucune action. */
export function NutritionLive({ ingredients, servings }: { ingredients: Recipe['ingredients']; servings: number | null }) {
  const { result } = useRecipeNutrition(ingredients, IDENTITY_SCALE)
  if (!result || result.coverage.expected === 0) return null
  const view = nutritionView(result, 'total', { servings, cookedWeightG: null, cookedWeightRawG: null })
  const partial = view.reliability === 'incomplete'
  const per = servings && servings > 0 ? servings : null
  const line = (d: number) => MAIN_NUTRIENTS.map((k) => `${k === 'kcal' ? '' : `${SHORT[k][0]} `}${partial ? '≥ ' : ''}${formatNutrient(k, (view.values[k] ?? 0) / d)} ${UNITS[k]}`).join(' · ')
  return (
    <div className="mt-3 rounded-2xl bg-sunken p-3 text-sm" aria-live="polite" aria-label="Aperçu nutritionnel">
      <p className="tabular-nums">
        <span className="font-semibold">Recette entière : </span>
        {line(1)}
      </p>
      {per && (
        <p className="tabular-nums">
          <span className="font-semibold">Par portion ({formatNumber(per, 1)}) : </span>
          {line(per)}
        </p>
      )}
      <p className="mt-0.5 text-xs text-muted">
        {RELIABILITY[view.reliability].label} · {result.coverage.done}/{result.coverage.expected} ingrédients calculés automatiquement
        {result.blocking.length > 0 && ` · à préciser : ${result.blocking.map((r) => r.ingredient.name).join(', ')}`}
      </p>
    </div>
  )
}

function Attribution({ sources }: { sources: Set<string | undefined> }) {
  if (!sources.size) return null
  return (
    <p className="mt-3 text-[11px] leading-snug text-faint">
      Sources : {[sources.has('ciqual') && CIQUAL_CITATION, sources.has('off') && OFF_ATTRIBUTION, sources.has('custom') && 'saisies personnelles'].filter(Boolean).join(' · ')}.
    </p>
  )
}

const STATUS_TEXT: Record<string, string> = {
  unlinked: 'Ingrédient non reconnu : touchez pour choisir l’aliment',
  toConfirm: 'Plusieurs aliments possibles : touchez pour choisir',
  noQuantity: 'Quantité non chiffrée',
  noConversion: 'Poids à préciser',
  excluded: 'Non compté',
  toTaste: 'Selon le goût (non compté)',
}

const SOURCE_NAME = { ciqual: 'CIQUAL', off: 'Open Food Facts', custom: 'Personnel' } as const

function originText(r: IngredientRow): string {
  if (r.ingredient.nutrition) return 'votre choix'
  switch (r.match?.origin) {
    case 'memory':
      return 'votre choix habituel'
    case 'dictionary':
      return r.match.confidence === 'assumed' ? 'variante supposée' : 'reconnu'
    case 'search':
      return 'correspondance approchée'
    default:
      return ''
  }
}

function DetailSheet({ open, onClose, result, onLink }: { open: boolean; onClose: () => void; result: NutritionResult; onLink: (i: Ingredient) => void }) {
  const sources = new Set(result.rows.filter((r) => r.status === 'ok').map((r) => r.link?.food.source))
  return (
    <Sheet open={open} onClose={onClose} size="tall" title="Détail par ingrédient" description="Touchez un ingrédient pour changer l’aliment ou préciser son poids.">
      <ul className="space-y-2 pb-2">
        {result.rows
          .filter((r) => r.ingredient.name.trim())
          .map((r) => {
            const ok = r.status === 'ok'
            const q = QUALITY[r.quality]
            const missing = r.quality === 'missing'
            return (
              <li key={r.ingredient.id}>
                <button
                  type="button"
                  onClick={() => onLink(r.ingredient)}
                  className={`w-full rounded-2xl p-3 text-left shadow-[var(--shadow-card)] active:scale-[.99] ${missing ? 'border border-danger/30 bg-danger-soft' : 'bg-paper'}`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate font-medium">{r.ingredient.name}</span>
                    <span className="shrink-0 text-sm tabular-nums text-muted">{r.grams != null ? `${formatNumber(r.grams, r.grams < 10 ? 1 : 0)} g` : ''}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-faint">
                    <span className={`size-2 shrink-0 rounded-full ${q.dot}`} aria-hidden />
                    <span className="font-semibold text-muted">{q.label}</span>
                    {r.link && (
                      <span className="min-w-0 truncate">
                        · {SOURCE_NAME[r.link.food.source]} · {r.link.food.name}
                        {originText(r) ? ` (${originText(r)})` : ''}
                      </span>
                    )}
                  </span>
                  {ok ? (
                    <>
                      <span className="mt-1 block text-sm tabular-nums">
                        {MAIN_NUTRIENTS.map((k) => {
                          const c = r.cells[k]
                          const txt = c?.value == null ? 'inconnu' : `${c.kind === 'trace' ? 'traces' : c.kind === 'below' ? '≈ 0' : formatNutrient(k, c.value)}`
                          return `${k === 'kcal' ? '' : `${LABELS[k][0]} `}${txt}${c?.value == null || c.kind === 'trace' || c.kind === 'below' ? '' : ` ${UNITS[k]}`}`
                        }).join(' · ')}
                      </span>
                      {r.approx.map((a) => (
                        <span key={a} className="mt-0.5 block text-xs text-terra-strong">
                          {a}
                        </span>
                      ))}
                    </>
                  ) : (
                    <span className={`mt-0.5 block text-sm ${missing ? 'font-semibold text-danger' : 'text-muted'}`}>{r.message ?? STATUS_TEXT[r.status]}</span>
                  )}
                </button>
              </li>
            )
          })}
      </ul>
      <div className="mt-2 rounded-2xl bg-sunken p-3 text-sm">
        <p className="font-semibold">Total{result.blocking.length ? ' partiel (ingrédients manquants non comptés)' : ''}</p>
        <p className="tabular-nums">
          {MAIN_NUTRIENTS.map((k) => `${LABELS[k]} ${result.blocking.length ? '≥ ' : ''}${formatNutrient(k, result.totals[k].value)} ${UNITS[k]}`).join(' · ')}
        </p>
      </div>
      <p className="mt-3 text-xs text-muted">
        <strong>Vérifié</strong> : aliment et poids connus. <strong>Estimé</strong> : poids usuel (ex. 1 oignon ≈ 110 g) ou variante courante supposée. <strong>Incertain</strong> : correspondance approchée. <strong>Manquant</strong> : non compté.
      </p>
      <Attribution sources={sources} />
    </Sheet>
  )
}


function CookedWeightSheet({ open, onClose, recipe, rawOriginal, rawComplete }: { open: boolean; onClose: () => void; recipe: Recipe; rawOriginal: number; rawComplete: boolean }) {
  const toast = useToast()
  const [value, setValue] = useState<number | null>(recipe.cookedWeightG)
  useEffect(() => {
    if (open) setValue(recipe.cookedWeightG)
  }, [open, recipe.cookedWeightG])
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Poids après cuisson"
      description="Pesez la préparation entière une fois cuite (sans le plat)."
      footer={
        <div className="flex gap-3">
          {recipe.cookedWeightG && (
            <Button
              variant="secondary"
              onClick={async () => {
                await setCookedWeight(recipe, null, rawOriginal)
                toast.success('Poids après cuisson effacé')
                onClose()
              }}
            >
              Effacer
            </Button>
          )}
          <Button
            block
            disabled={!value || value <= 0}
            onClick={async () => {
              await setCookedWeight(recipe, value, rawOriginal)
              toast.success('Poids après cuisson enregistré')
              onClose()
            }}
          >
            Enregistrer
          </Button>
        </div>
      }
    >
      <div className="space-y-3 pt-1 pb-2">
        <NumberInput label="Poids de la préparation cuite" suffix="g" value={value} onChange={setValue} step={1} />
        <p className="text-sm text-muted">
          Ingrédients avant cuisson : <strong className="text-ink">{rawOriginal > 0 ? `${formatNumber(rawOriginal, 0)} g` : 'inconnu'}</strong>
          {!rawComplete && ' (certains poids ne sont pas encore connus)'}.
        </p>
        <p className="text-sm text-muted">
          Les valeurs « pour 100 g » utilisent ce poids cuit : les apports des ingrédients sont conservés, seule l’eau évaporée (ou absorbée) change le poids. Si vous modifiez ensuite les ingrédients, la pesée sera signalée « à revoir ».
        </p>
      </div>
    </Sheet>
  )
}

/** Valeurs saisies ou estimées par IA avant le calcul par ingrédient (anciennes fiches). */
function LegacyNutrition({ recipe }: { recipe: Recipe }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<AiError | null>(null)
  const n = recipe.nutrition
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const est = await estimateNutrition(recipe)
      await patchRecipe(recipe.id, { nutrition: { total: { kcal: est.kcal, protein: est.protein, carbs: est.carbs, fat: est.fat, fiber: est.fiber }, source: 'ai-estimate', updatedAt: Date.now() } })
      toast.success('Estimation enregistrée')
    } catch (e) {
      setError(toAiError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-4 border-t border-line pt-3">
      {n ? (
        <p className="text-sm text-muted">
          <strong className={n.source === 'ai-estimate' ? 'text-terra-strong' : 'text-ink'}>{n.source === 'ai-estimate' ? 'Estimation du Chef IA (approximative)' : 'Valeurs saisies'}</strong> · recette entière :{' '}
          {MAIN_NUTRIENTS.map((k) => `${LABELS[k]} ${formatNutrient(k, n.total[k] ?? null)} ${UNITS[k]}`).join(' · ')}
        </p>
      ) : (
        <Button size="sm" variant="ghost" icon={<Sparkles size={15} />} loading={busy} onClick={() => void run()}>
          Estimation rapide par le Chef IA (approximative)
        </Button>
      )}
      {error && <AiErrorBox error={error} onRetry={() => void run()} />}
    </div>
  )
}
