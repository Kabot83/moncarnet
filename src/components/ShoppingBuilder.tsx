import { useLiveQuery } from 'dexie-react-hooks'
import { Minus, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import { db } from '@/db/db'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { formatNumber } from '@/lib/units'
import { isAdjusted, scaleByServings } from '@/lib/scaling'
import { IDENTITY_SCALE } from '@/lib/scaling'
import { addRecipesToShopping } from '@/services/shopping'
import { Button, IconButton } from './ui/Button'
import { Segmented, Switch } from './ui/Fields'
import { useToast } from './ui/Feedback'
import { Sheet } from './ui/Sheet'

/**
 * Génère la liste de courses à partir d'une ou plusieurs recettes, avec choix
 * des portions et prise en compte facultative des ajustements en cours.
 */
export function ShoppingBuilder({
  open,
  recipeIds,
  onClose,
  onDone,
}: {
  open: boolean
  recipeIds: string[]
  onClose: () => void
  onDone?: () => void
}) {
  const toast = useToast()
  const navigate = useSafeNavigate()
  const data = useLiveQuery(
    async () => {
      if (!open) return null
      const recipes = (await db.recipes.bulkGet(recipeIds)).filter((r) => r != null)
      const sessions = (await db.sessions.bulkGet(recipeIds)).filter((s) => s != null)
      return { recipes, sessions }
    },
    [open, recipeIds.join(',')],
  )
  const [servings, setServings] = useState<Record<string, number | null>>({})
  const [useAdjusted, setUseAdjusted] = useState(true)
  const [mode, setMode] = useState<'append' | 'replace'>('append')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!data) return
    setServings(Object.fromEntries(data.recipes.map((r) => [r.id, r.servings])))
  }, [data])

  const adjustedIds = new Set((data?.sessions ?? []).filter((s) => isAdjusted(s.scale)).map((s) => s.recipeId))

  const submit = async () => {
    if (!data) return
    setBusy(true)
    try {
      const sources = data.recipes.map((r) => {
        const session = data.sessions.find((s) => s.recipeId === r.id)
        if (useAdjusted && session && isAdjusted(session.scale)) return { recipe: r, scale: session.scale }
        const target = servings[r.id]
        return { recipe: r, scale: target && r.servings ? scaleByServings(IDENTITY_SCALE, r.servings, target) : IDENTITY_SCALE }
      })
      const n = await addRecipesToShopping(sources, mode)
      toast.success(`${n} ingrédient${n > 1 ? 's' : ''} ajouté${n > 1 ? 's' : ''} à la liste`, { label: 'Voir', onClick: () => navigate('/courses') })
      onDone?.()
      onClose()
    } catch {
      toast.error('Impossible de générer la liste.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Liste de courses"
      description="Choisissez les portions de chaque recette."
      footer={
        <Button block size="lg" loading={busy} onClick={() => void submit()}>
          {mode === 'append' ? 'Ajouter à ma liste' : 'Remplacer ma liste'}
        </Button>
      }
    >
      <ul className="space-y-2">
        {data?.recipes.map((r) => {
          const adjusted = useAdjusted && adjustedIds.has(r.id)
          const s = servings[r.id]
          return (
            <li key={r.id} className="flex items-center gap-3 rounded-2xl bg-paper p-3">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.title}</p>
                <p className="text-xs text-muted">{adjusted ? 'Quantités ajustées de la préparation en cours' : r.servings ? 'Portions' : 'Portions non renseignées'}</p>
              </div>
              {!adjusted && r.servings ? (
                <div className="flex items-center gap-1">
                  <IconButton label="Moins de portions" size="sm" tone="paper" onClick={() => setServings((x) => ({ ...x, [r.id]: Math.max(1, (s ?? 1) - 1) }))}>
                    <Minus size={16} />
                  </IconButton>
                  <span className="w-8 text-center font-semibold tabular-nums">{s ? formatNumber(s, 1) : '–'}</span>
                  <IconButton label="Plus de portions" size="sm" tone="paper" onClick={() => setServings((x) => ({ ...x, [r.id]: (s ?? 0) + 1 }))}>
                    <Plus size={16} />
                  </IconButton>
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
      {adjustedIds.size > 0 && (
        <div className="mt-4 rounded-2xl bg-paper px-4">
          <Switch
            label="Utiliser mes quantités ajustées"
            description="Pour les recettes en cours de préparation avec des proportions modifiées."
            checked={useAdjusted}
            onChange={setUseAdjusted}
          />
        </div>
      )}
      <div className="mt-4">
        <Segmented
          label="Liste existante"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'append', label: 'Compléter ma liste' },
            { value: 'replace', label: 'Nouvelle liste' },
          ]}
        />
      </div>
    </Sheet>
  )
}
