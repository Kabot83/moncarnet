/**
 * Section « Nutrition » de la fiche recette.
 * Calcul à partir des ingrédients associés (CIQUAL / Open Food Facts / saisie), en suivant
 * les quantités ajustées. Fiabilité affichée : complet, estimatif ou incomplet.
 */
import { AlertTriangle, CheckCircle2, ChevronRight, CircleHelp, Link2, Scale, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { estimateNutrition } from '@/ai/chef'
import { type AiError, toAiError } from '@/ai/errors'
import { scaledServings } from '@/lib/scaling'
import { formatNumber } from '@/lib/units'
import { type Ingredient, MAIN_NUTRIENTS, type Recipe, type ScaleState } from '@/models/types'
import { CIQUAL_CITATION } from '@/nutrition/ciqual'
import { LABELS, type MainKey, type NutritionMode, type Reliability, UNITS, computeNutrition, cookedWeightNeedsReview, formatNutrient, nutritionView, rawOriginalGrams } from '@/nutrition/engine'
import { setCookedWeight } from '@/nutrition/foods'
import { OFF_ATTRIBUTION } from '@/nutrition/off'
import { patchRecipe } from '@/services/recipes'
import { AiErrorBox } from './AiErrorBox'
import { FoodLinkSheet } from './nutrition/FoodLinkSheet'
import { Button } from './ui/Button'
import { useToast } from './ui/Feedback'
import { NumberInput, Segmented } from './ui/Fields'
import { Sheet } from './ui/Sheet'

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
  complete: { label: 'Calcul complet', className: 'bg-sage-soft text-sage', icon: CheckCircle2 },
  estimate: { label: 'Calcul estimatif', className: 'bg-[color-mix(in_oklab,var(--c-gold)_18%,transparent)] text-gold', icon: CircleHelp },
  incomplete: { label: 'Données incomplètes', className: 'bg-danger-soft text-danger', icon: AlertTriangle },
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

  const result = useMemo(() => computeNutrition(recipe.ingredients, scale), [recipe.ingredients, scale])
  const rawOriginal = useMemo(() => rawOriginalGrams(recipe.ingredients), [recipe.ingredients])
  const view = nutritionView(result, mode, recipe, scale, rawOriginal)
  const linked = recipe.ingredients.some((i) => i.nutrition)
  const servings = scaledServings(scale, recipe.servings)
  const rel = RELIABILITY[view.reliability]
  const sources = new Set(recipe.ingredients.map((i) => i.nutrition?.food.source).filter(Boolean))
  const needsReview = cookedWeightNeedsReview(recipe, rawOriginal)

  if (!linked)
    return (
      <>
        <div className="rounded-[var(--radius-card)] bg-paper p-4 shadow-[var(--shadow-card)]">
          <p className="text-[15px]">Associez les ingrédients aux tables nutritionnelles pour calculer calories, protéines, glucides et lipides.</p>
          <p className="mt-1 text-sm text-muted">Table CIQUAL de l’ANSES (hors ligne) et produits de marque d’Open Food Facts.</p>
          <Button className="mt-3" icon={<Link2 size={16} />} onClick={() => setDetailOpen(true)}>
            Associer les ingrédients
          </Button>
          <LegacyNutrition recipe={recipe} />
        </div>
        <DetailSheet open={detailOpen} onClose={() => setDetailOpen(false)} recipe={recipe} scale={scale} onLink={setLinkFor} />
        <FoodLinkSheet open={!!linkFor} onClose={() => setLinkFor(null)} recipeId={recipe.id} ingredient={linkFor} />
      </>
    )

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

        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button size="sm" variant="secondary" onClick={() => setDetailOpen(true)}>
            Détail par ingrédient
          </Button>
          <Button size="sm" variant={needsReview ? 'soft' : 'secondary'} icon={<Scale size={15} />} onClick={() => setWeightOpen(true)}>
            {recipe.cookedWeightG ? `Cuit : ${formatNumber(recipe.cookedWeightG, 0)} g${needsReview ? ' (à revoir)' : ''}` : 'Poids après cuisson'}
          </Button>
        </div>
        <Attribution sources={sources} />
      </div>

      <DetailSheet open={detailOpen} onClose={() => setDetailOpen(false)} recipe={recipe} scale={scale} onLink={setLinkFor} />
      <CookedWeightSheet open={weightOpen} onClose={() => setWeightOpen(false)} recipe={recipe} rawOriginal={rawOriginal} rawComplete={result.rawGramsComplete} />
      <FoodLinkSheet open={!!linkFor} onClose={() => setLinkFor(null)} recipeId={recipe.id} ingredient={linkFor} />
    </>
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
  unlinked: 'Aliment à associer',
  noQuantity: 'Quantité non chiffrée',
  noConversion: 'Poids à renseigner',
  excluded: 'Non compté',
  toTaste: 'Selon le goût (non compté)',
}

function DetailSheet({ open, onClose, recipe, scale, onLink }: { open: boolean; onClose: () => void; recipe: Recipe; scale: ScaleState; onLink: (i: Ingredient) => void }) {
  const result = useMemo(() => computeNutrition(recipe.ingredients, scale), [recipe.ingredients, scale])
  const sources = new Set(recipe.ingredients.map((i) => i.nutrition?.food.source).filter(Boolean))
  return (
    <Sheet open={open} onClose={onClose} size="tall" title="Détail par ingrédient" description="Touchez un ingrédient pour choisir ou corriger son aliment.">
      <ul className="space-y-2 pb-2">
        {result.rows.map((r) => {
          const ok = r.status === 'ok'
          const blocking = r.status === 'unlinked' || r.status === 'noConversion' || r.status === 'noQuantity'
          return (
            <li key={r.ingredient.id}>
              <button
                type="button"
                onClick={() => onLink(r.ingredient)}
                className={`w-full rounded-2xl p-3 text-left shadow-[var(--shadow-card)] active:scale-[.99] ${blocking ? 'border border-danger/30 bg-danger-soft' : 'bg-paper'}`}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{r.ingredient.name}</span>
                  <span className="shrink-0 text-sm tabular-nums text-muted">{r.grams != null ? `${formatNumber(r.grams, r.grams < 10 ? 1 : 0)} g` : ''}</span>
                </span>
                {ok ? (
                  <>
                    <span className="mt-0.5 block text-xs text-faint">
                      {r.ingredient.nutrition!.food.source === 'ciqual' ? 'CIQUAL' : r.ingredient.nutrition!.food.source === 'off' ? 'Open Food Facts' : 'Personnel'} · {r.ingredient.nutrition!.food.name}
                    </span>
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
                  <span className={`mt-0.5 block text-sm ${blocking ? 'font-semibold text-danger' : 'text-muted'}`}>{r.message ?? STATUS_TEXT[r.status]}</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
      <div className="mt-2 rounded-2xl bg-sunken p-3 text-sm">
        <p className="font-semibold">Total{result.blocking.length ? ' partiel' : ''}</p>
        <p className="tabular-nums">
          {MAIN_NUTRIENTS.map((k) => `${LABELS[k]} ${formatNutrient(k, result.totals[k].value)} ${UNITS[k]}`).join(' · ')}
        </p>
      </div>
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
                await setCookedWeight(recipe, null)
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
              await setCookedWeight(recipe, value)
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
