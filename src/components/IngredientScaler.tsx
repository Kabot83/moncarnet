/**
 * Liste d'ingrédients avec ajustement proportionnel à la volée.
 *
 * Toute la logique de calcul vit dans `lib/scaling.ts` (module pur et testé).
 * Ici : uniquement l'interface — boutons − / +, saisie directe, portions,
 * portée (toute la recette ou un groupe), bandeau d'ajustement temporaire.
 */
import { Check, Lock, Minus, MoreHorizontal, Plus, RotateCcw, Users } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import {
  type ScaleScope,
  describeFactor,
  factorFor,
  ingredientGroups,
  isAdjusted,
  isScalable,
  resetScale,
  scaleByServings,
  scaleFromIngredient,
  scaledQuantity,
  scaledServings,
} from '@/lib/scaling'
import { displayQuantity, formatNumber, isEgg, nextOnGrid, normalizeUnit, parseQuantity, pluralizeUnit, stepFor } from '@/lib/units'
import type { Ingredient, Recipe, ScaleState } from '@/models/types'
import { useSettings } from '@/services/settings'
import { IconButton } from './ui/Button'
import { Segmented } from './ui/Fields'

interface Props {
  recipe: Recipe
  scale: ScaleState
  onScaleChange: (s: ScaleState) => void
  /** Mode cuisine : cases à cocher et typographie plus grande. */
  checkable?: boolean
  checked?: string[]
  onToggleChecked?: (id: string) => void
  /** Ouvre le menu d'un ingrédient (remplacement IA…). */
  onIngredientMenu?: (ing: Ingredient) => void
  /** Actions supplémentaires affichées quand les quantités sont ajustées. */
  adjustedActions?: ReactNode
  large?: boolean
}

export function IngredientScaler({ recipe, scale, onScaleChange, checkable, checked = [], onToggleChecked, onIngredientMenu, adjustedActions, large }: Props) {
  const settings = useSettings()
  const [scope, setScope] = useState<ScaleScope>('all')
  const [editing, setEditing] = useState<string | null>(null)
  const groups = ingredientGroups(recipe.ingredients)
  const hasGroups = groups.filter(Boolean).length > 0 && groups.length > 1
  const adjusted = isAdjusted(scale)
  const servings = scaledServings(scale, recipe.servings)
  const servingsAffected = Object.keys(scale.groups).length === 0

  const setQuantity = (ing: Ingredient, q: number) => onScaleChange(scaleFromIngredient(recipe.ingredients, scale, ing.id, q, scope))

  const bump = (ing: Ingredient, dir: 1 | -1) => {
    const current = scaledQuantity(ing, scale)
    if (current == null) return
    const egg = isEgg(ing.name) && normalizeUnit(ing.unit).kind === 'count'
    let next = nextOnGrid(current, stepFor(current, ing.unit, ing.name), dir)
    if (next != null && egg && !settings.allowHalfEggs && next < 1) next = null
    if (next != null) setQuantity(ing, next)
  }

  const bumpServings = (dir: 1 | -1) => {
    if (!recipe.servings || servings == null) return
    const next = nextOnGrid(servings, servings < 2 ? 0.5 : 1, dir)
    if (next != null) onScaleChange(scaleByServings(scale, recipe.servings, next))
  }

  return (
    <div>
      {recipe.servings ? (
        <div className="mb-4 flex items-center gap-3 rounded-2xl bg-paper p-2 pl-4 shadow-[var(--shadow-card)]">
          <Users size={20} strokeWidth={1.6} className="text-terra" />
          <span className="flex-1 text-[15px]">
            <strong className="font-semibold tabular-nums">{servings != null ? formatNumber(servings, 1) : '–'}</strong>{' '}
            portion{(servings ?? 0) > 1 ? 's' : ''}
            {!servingsAffected && <span className="ml-1 text-xs text-muted">(groupe ajusté)</span>}
          </span>
          <IconButton label="Une portion de moins" tone="paper" onClick={() => bumpServings(-1)}>
            <Minus size={18} />
          </IconButton>
          <IconButton label="Une portion de plus" tone="paper" onClick={() => bumpServings(1)}>
            <Plus size={18} />
          </IconButton>
        </div>
      ) : null}

      {hasGroups && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Ajuster :</span>
          <Segmented
            label="Portée de l’ajustement"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'Toute la recette' },
              { value: 'group', label: 'Le groupe seul' },
            ]}
          />
        </div>
      )}

      {adjusted && (
        <div className="mb-4 rounded-2xl border border-terra/30 bg-terra-soft p-3.5 animate-fade-up" role="status">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-terra-strong">Ajustement temporaire — recette originale conservée</p>
              <p className="mt-0.5 text-xs text-muted">
                Quantités ajustées {describeFactor(scale.global)}
                {Object.entries(scale.groups).map(([g, f]) => ` · ${g || 'Principal'} ${describeFactor(f)}`)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onScaleChange(resetScale())}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-paper px-3 text-sm font-semibold text-terra-strong"
            >
              <RotateCcw size={15} /> Réinitialiser
            </button>
          </div>
          {adjustedActions && <div className="mt-3 flex flex-wrap gap-2">{adjustedActions}</div>}
        </div>
      )}

      {groups.map((g) => {
        const items = recipe.ingredients.filter((i) => (i.group ?? '') === g)
        if (!items.length) return null
        const groupFactor = factorFor(scale, g)
        return (
          <section key={g || '_'} className="mb-5 last:mb-0">
            {g && (
              <h3 className="mb-2 flex items-baseline gap-2 font-serif text-lg font-semibold">
                {g}
                {Math.abs(groupFactor - 1) > 1e-9 && <span className="font-sans text-xs font-medium text-terra">{describeFactor(groupFactor)}</span>}
              </h3>
            )}
            <ul className="divide-y divide-line/70 rounded-2xl bg-paper px-3 shadow-[var(--shadow-card)]">
              {items.map((ing) => (
                <IngredientRow
                  key={ing.id}
                  ing={ing}
                  scale={scale}
                  large={large}
                  rounding={settings.rounding}
                  allowHalfEggs={settings.allowHalfEggs}
                  checkable={checkable}
                  checked={checked.includes(ing.id)}
                  onToggle={() => onToggleChecked?.(ing.id)}
                  editing={editing === ing.id}
                  onEdit={(v) => setEditing(v ? ing.id : null)}
                  onBump={(d) => bump(ing, d)}
                  onSet={(q) => setQuantity(ing, q)}
                  onMenu={onIngredientMenu ? () => onIngredientMenu(ing) : undefined}
                  isReference={scale.referenceId === ing.id && adjusted}
                />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

interface RowProps {
  ing: Ingredient
  scale: ScaleState
  rounding: 'precise' | 'practical'
  allowHalfEggs: boolean
  checkable?: boolean
  checked: boolean
  onToggle: () => void
  editing: boolean
  onEdit: (v: boolean) => void
  onBump: (d: 1 | -1) => void
  onSet: (q: number) => void
  onMenu?: () => void
  isReference: boolean
  large?: boolean
}

function IngredientRow({ ing, scale, rounding, allowHalfEggs, checkable, checked, onToggle, editing, onEdit, onBump, onSet, onMenu, isReference, large }: RowProps) {
  const q = scaledQuantity(ing, scale)
  const scalable = isScalable(ing)
  const changed = scalable && q != null && ing.quantity != null && Math.abs(q - ing.quantity) > 1e-9
  const d = q != null ? displayQuantity(q, ing.unit, { rounding, allowHalfEggs, name: ing.name }) : null
  const unit = d ? pluralizeUnit(d.unit, d.numeric) : ''
  const qtyLabel = d ? `${d.value}${unit ? ` ${unit}` : ''}` : ''

  return (
    <li className={`flex items-center gap-2 py-2.5 ${checked ? 'opacity-55' : ''}`}>
      {checkable && (
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={`${ing.name} utilisé`}
          onClick={onToggle}
          className={`grid size-9 shrink-0 place-items-center rounded-full border-2 transition-colors ${checked ? 'border-sage bg-sage text-white' : 'border-line'}`}
        >
          {checked && <Check size={18} strokeWidth={3} />}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <p className={`leading-snug ${large ? 'text-lg' : 'text-[15px]'} ${checked ? 'line-through' : ''}`}>
          {ing.name}
        </p>
        <p className="text-xs text-muted">
          {ing.toTaste && 'Selon le goût'}
          {!ing.toTaste && ing.quantity == null && ing.quantityText}
          {!scalable && ing.quantity != null && !ing.toTaste && (
            <span className="inline-flex items-center gap-1">
              <Lock size={11} /> Quantité fixe
            </span>
          )}
          {ing.note && (ing.toTaste || ing.quantityText || !scalable ? ` · ${ing.note}` : ing.note)}
          {isReference && <span className="text-terra"> · Référence</span>}
        </p>
      </div>

      {q != null && scalable && !editing && (
        <div className="flex shrink-0 items-center">
          <IconButton label={`Diminuer ${ing.name}`} size={large ? 'md' : 'sm'} onClick={() => onBump(-1)} className="text-muted">
            <Minus size={large ? 20 : 17} />
          </IconButton>
          <button
            type="button"
            onClick={() => onEdit(true)}
            aria-label={`Quantité de ${ing.name} : ${qtyLabel}. Modifier`}
            className={`min-w-[4.5rem] rounded-xl px-2 py-1.5 text-center font-semibold tabular-nums transition-colors ${large ? 'text-lg' : 'text-[15px]'} ${
              changed ? 'bg-terra-soft text-terra-strong' : 'bg-sunken'
            }`}
          >
            {qtyLabel}
          </button>
          <IconButton label={`Augmenter ${ing.name}`} size={large ? 'md' : 'sm'} onClick={() => onBump(1)} className="text-muted">
            <Plus size={large ? 20 : 17} />
          </IconButton>
        </div>
      )}
      {q != null && scalable && editing && <QuantityEditor ing={ing} value={q} onCancel={() => onEdit(false)} onSubmit={(v) => (onSet(v), onEdit(false))} />}
      {q != null && !scalable && <span className={`shrink-0 px-2 font-semibold tabular-nums text-muted ${large ? 'text-lg' : 'text-[15px]'}`}>{qtyLabel}</span>}

      {onMenu && (
        <IconButton label={`Options pour ${ing.name}`} size="sm" onClick={onMenu} className="-mr-1 text-faint">
          <MoreHorizontal size={18} />
        </IconButton>
      )}
    </li>
  )
}

/** Saisie précise : accepte « 135 », « 1,5 », « 1/2 », « 1 ½ ». */
function QuantityEditor({ ing, value, onSubmit, onCancel }: { ing: Ingredient; value: number; onSubmit: (v: number) => void; onCancel: () => void }) {
  const [text, setText] = useState(formatNumber(Math.round(value * 100) / 100, 2))
  const [error, setError] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const submit = () => {
    const v = parseQuantity(text)
    if (v == null || v <= 0) {
      setError(true)
      return
    }
    onSubmit(v)
  }
  return (
    <form
      className="flex shrink-0 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <label className="sr-only" htmlFor={`q-${ing.id}`}>
        Nouvelle quantité de {ing.name}
      </label>
      <input
        ref={ref}
        id={`q-${ing.id}`}
        inputMode="decimal"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setError(false)
        }}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        onBlur={(e) => {
          // Valide en quittant le champ, sauf si l'on clique sur « OK ».
          if (!e.relatedTarget?.closest('form')) submit()
        }}
        aria-invalid={error}
        className={`h-10 w-20 rounded-xl border bg-bg px-2 text-center font-semibold tabular-nums outline-none ${error ? 'border-danger' : 'border-terra'}`}
      />
      <span className="w-8 truncate text-xs text-muted">{ing.unit}</span>
      <button type="submit" className="h-10 rounded-xl bg-terra px-3 text-sm font-semibold text-white dark:text-[#1b1916]">
        OK
      </button>
    </form>
  )
}
