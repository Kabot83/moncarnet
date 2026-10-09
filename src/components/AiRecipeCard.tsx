import { BookPlus, ChevronDown, Clock, PenLine, Shuffle, Users } from 'lucide-react'
import { useState } from 'react'
import { aiRecipeToRecipe } from '@/ai/convert'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { formatDuration } from '@/lib/format'
import { formatNumber } from '@/lib/units'
import type { AiRecipe, Recipe } from '@/models/types'
import { createDraft } from '@/services/drafts'
import { Button } from './ui/Button'

/** Ouvre l'éditeur prérempli : rien n'est enregistré sans validation. */
export async function openAiRecipeInEditor(navigate: ReturnType<typeof useSafeNavigate>, ai: AiRecipe, extra: Partial<Recipe> = {}) {
  const { recipe, warnings } = aiRecipeToRecipe(ai, extra)
  const id = await createDraft(recipe, 'ai', warnings)
  navigate(`/recettes/nouvelle?draft=${id}`)
}

/** Proposition de recette du Chef IA : consulter, modifier, ajouter, varier. */
export function AiRecipeCard({ recipe, onVariant, variantOf }: { recipe: AiRecipe; onVariant?: (r: AiRecipe) => void; variantOf?: string | null }) {
  const navigate = useSafeNavigate()
  const [open, setOpen] = useState(false)
  const time = (recipe.prepTime ?? 0) + (recipe.cookTime ?? 0)
  const extra: Partial<Recipe> = { source: 'Mon Chef IA', toTry: true, variantOf: variantOf ?? null }
  return (
    <article className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-paper shadow-[var(--shadow-card)]">
      <div className="p-4">
        <p className="eyebrow">Proposition</p>
        <h3 className="mt-1 font-serif text-xl leading-snug font-semibold">{recipe.title}</h3>
        {recipe.description && <p className="mt-1 text-[15px] text-muted">{recipe.description}</p>}
        <p className="mt-2 flex flex-wrap gap-x-3 text-sm text-muted">
          {time > 0 && (
            <span className="inline-flex items-center gap-1">
              <Clock size={14} /> {formatDuration(time)}
            </span>
          )}
          {recipe.servings ? (
            <span className="inline-flex items-center gap-1">
              <Users size={14} /> {formatNumber(recipe.servings)} portions
            </span>
          ) : null}
          <span>{recipe.ingredients.length} ingrédients</span>
        </p>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between border-t border-line px-4 py-3 text-sm font-semibold text-terra"
      >
        {open ? 'Masquer la recette' : 'Consulter la recette'}
        <ChevronDown size={18} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-line px-4 py-4 text-[15px] animate-fade">
          <div>
            <h4 className="mb-1 font-serif text-lg font-semibold">Ingrédients</h4>
            <ul className="space-y-0.5">
              {recipe.ingredients.map((i, k) => (
                <li key={k} className="flex gap-2">
                  <span className="w-24 shrink-0 text-right font-semibold tabular-nums text-terra-strong">
                    {i.quantity != null ? `${formatNumber(i.quantity)} ${i.unit ?? ''}` : '—'}
                  </span>
                  <span>
                    {i.name}
                    {i.note ? <span className="text-muted">, {i.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="mb-1 font-serif text-lg font-semibold">Étapes</h4>
            <ol className="list-decimal space-y-1.5 pl-5">
              {recipe.steps.map((s, k) => (
                <li key={k}>
                  {s.text}
                  {s.temperatureC ? <span className="text-muted"> ({s.temperatureC} °C)</span> : null}
                </li>
              ))}
            </ol>
          </div>
          {recipe.tips && (
            <p className="rounded-2xl bg-sage-soft p-3 text-sm">
              <strong>Conseil : </strong>
              {recipe.tips}
            </p>
          )}
          <p className="text-xs text-faint">Recette générée par IA : vérifiez les temps de cuisson, températures et allergènes.</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2 border-t border-line p-3">
        <Button size="sm" icon={<BookPlus size={16} />} onClick={() => void openAiRecipeInEditor(navigate, recipe, extra)}>
          Ajouter au carnet
        </Button>
        <Button size="sm" variant="secondary" icon={<PenLine size={15} />} onClick={() => void openAiRecipeInEditor(navigate, recipe, extra)}>
          Modifier
        </Button>
        {onVariant && (
          <Button size="sm" variant="ghost" icon={<Shuffle size={15} />} onClick={() => onVariant(recipe)}>
            Une variante
          </Button>
        )}
      </div>
    </article>
  )
}
