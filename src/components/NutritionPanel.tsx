import { Calculator, PenLine, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { estimateNutrition } from '@/ai/chef'
import { type AiError, toAiError } from '@/ai/errors'
import { NUTRIENTS, SOURCE_LABELS, computeNutrition, computeScaled, perServing, scaledNutrition } from '@/lib/nutrition'
import { isAdjusted, scaledServings } from '@/lib/scaling'
import { formatNumber } from '@/lib/units'
import type { NutritionValues, Recipe, ScaleState } from '@/models/types'
import { patchRecipe } from '@/services/recipes'
import { AiErrorBox } from './AiErrorBox'
import { Button } from './ui/Button'
import { NumberInput } from './ui/Fields'
import { useToast } from './ui/Feedback'
import { Sheet } from './ui/Sheet'

/** Valeurs nutritionnelles (facultatives), qui suivent les quantités ajustées. */
export function NutritionPanel({ recipe, scale }: { recipe: Recipe; scale: ScaleState }) {
  const toast = useToast()
  const [manualOpen, setManualOpen] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState<AiError | null>(null)
  const [preview, setPreview] = useState<ReturnType<typeof computeNutrition> | null>(null)
  const n = recipe.nutrition
  const servings = scaledServings(scale, recipe.servings)

  const total: NutritionValues | null = n
    ? n.source === 'database'
      ? computeScaled(recipe.ingredients, scale).total
      : scaledNutrition(n.total, scale)
    : null
  const portion = total ? perServing(total, servings) : null

  const runAi = async () => {
    setAiLoading(true)
    setAiError(null)
    try {
      const est = await estimateNutrition(recipe)
      await patchRecipe(recipe.id, {
        nutrition: { total: { kcal: est.kcal, protein: est.protein, carbs: est.carbs, fat: est.fat, fiber: est.fiber }, source: 'ai-estimate', updatedAt: Date.now() },
      })
      toast.success('Estimation enregistrée')
    } catch (e) {
      setAiError(toAiError(e))
    } finally {
      setAiLoading(false)
    }
  }

  return (
    <div>
      {total ? (
        <div className="rounded-2xl bg-paper p-4 shadow-[var(--shadow-card)]">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-5 gap-y-2 text-[15px]">
            <span className="text-xs font-semibold tracking-wide text-muted uppercase">Nutriment</span>
            <span className="text-right text-xs font-semibold tracking-wide text-muted uppercase">Par portion</span>
            <span className="text-right text-xs font-semibold tracking-wide text-muted uppercase">Recette</span>
            {NUTRIENTS.map((x) => (
              <Row key={x.id} label={x.label} unit={x.unit} portion={portion?.[x.id] ?? null} total={total[x.id]} />
            ))}
          </div>
          <p className={`mt-3 text-xs ${n?.source === 'ai-estimate' ? 'font-semibold text-terra-strong' : 'text-muted'}`}>
            {SOURCE_LABELS[n!.source]}
            {isAdjusted(scale) ? ' · calculé pour les quantités ajustées' : ''}
            {!servings ? ' · indiquez le nombre de portions pour le détail par portion' : ''}
          </p>
        </div>
      ) : (
        <p className="text-[15px] text-muted">Aucune information nutritionnelle. Ce module est facultatif.</p>
      )}

      {preview && (
        <div className="mt-3 rounded-2xl bg-sage-soft p-4 text-sm">
          <p>
            Calcul à partir de la table indicative : {preview.total.kcal} kcal pour la recette.
            {preview.unmatched.length > 0 && ` Non reconnus (non comptés) : ${preview.unmatched.join(', ')}.`}
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              variant="sage"
              onClick={() => {
                void patchRecipe(recipe.id, { nutrition: { total: computeNutrition(recipe.ingredients).total, source: 'database', updatedAt: Date.now() } })
                setPreview(null)
              }}
            >
              Utiliser ce calcul
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              Annuler
            </Button>
          </div>
        </div>
      )}
      {aiError && <AiErrorBox error={aiError} onRetry={() => void runAi()} />}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={<PenLine size={15} />} onClick={() => setManualOpen(true)}>
          Saisir
        </Button>
        <Button size="sm" variant="secondary" icon={<Calculator size={15} />} onClick={() => setPreview(computeNutrition(recipe.ingredients))}>
          Calculer
        </Button>
        <Button size="sm" variant="secondary" icon={<Sparkles size={15} />} loading={aiLoading} onClick={() => void runAi()}>
          Estimer (IA)
        </Button>
      </div>
      <ManualNutritionSheet open={manualOpen} onClose={() => setManualOpen(false)} recipe={recipe} />
    </div>
  )
}

function Row({ label, unit, portion, total }: { label: string; unit: string; portion: number | null; total: number | null }) {
  const f = (v: number | null) => (v == null ? '–' : `${formatNumber(v, unit === 'kcal' ? 0 : 1)} ${unit}`)
  return (
    <>
      <span>{label}</span>
      <span className="text-right font-semibold tabular-nums">{f(portion)}</span>
      <span className="text-right text-muted tabular-nums">{f(total)}</span>
    </>
  )
}

function ManualNutritionSheet({ open, onClose, recipe }: { open: boolean; onClose: () => void; recipe: Recipe }) {
  const [mode, setMode] = useState<'portion' | 'total'>(recipe.servings ? 'portion' : 'total')
  const [values, setValues] = useState<NutritionValues>(() => {
    const empty = { kcal: null, protein: null, carbs: null, fat: null, fiber: null }
    if (!recipe.nutrition) return empty
    const per = perServing(recipe.nutrition.total, recipe.servings)
    const round = (v: NutritionValues) => Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x == null ? null : Math.round(x * 10) / 10])) as NutritionValues
    return round(per ?? recipe.nutrition.total)
  })
  const save = async () => {
    const mult = mode === 'portion' ? (recipe.servings ?? 1) : 1
    const total = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v == null ? null : v * mult])) as NutritionValues
    await patchRecipe(recipe.id, { nutrition: { total, source: 'manual', updatedAt: Date.now() } })
    onClose()
  }
  return (
    <Sheet open={open} onClose={onClose} title="Valeurs nutritionnelles" footer={<Button block onClick={() => void save()}>Enregistrer</Button>}>
      <div className="mb-4 flex gap-2">
        {(['portion', 'total'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            aria-pressed={mode === m}
            className={`h-9 rounded-full px-4 text-sm font-medium ${mode === m ? 'bg-terra text-white' : 'bg-sunken'}`}
          >
            {m === 'portion' ? 'Par portion' : 'Recette entière'}
          </button>
        ))}
      </div>
      {mode === 'portion' && !recipe.servings && <p className="mb-3 text-sm text-danger">Indiquez d’abord le nombre de portions de la recette.</p>}
      <div className="grid grid-cols-2 gap-3 pb-2">
        {NUTRIENTS.map((x) => (
          <NumberInput key={x.id} label={x.label} suffix={x.unit} value={values[x.id]} onChange={(v) => setValues((s) => ({ ...s, [x.id]: v }))} />
        ))}
      </div>
    </Sheet>
  )
}
