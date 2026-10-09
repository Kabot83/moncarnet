import { useLiveQuery } from 'dexie-react-hooks'
import { NotebookPen, PenLine, Thermometer, Timer as TimerIcon, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { JournalEntrySheet } from '@/components/JournalEntrySheet'
import { Button, IconButton } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { Stars } from '@/components/ui/Fields'
import { EmptyState, Page, Photo, TopBar } from '@/components/ui/Layout'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { formatDate, formatDuration } from '@/lib/format'
import { describeFactor } from '@/lib/scaling'
import { displayQuantity } from '@/lib/units'
import type { JournalEntry } from '@/models/types'
import { deleteJournalEntry } from '@/services/recipes'

/** Historique complet des réalisations d'une recette. */
export default function JournalPage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const confirm = useConfirm()
  const recipe = useLiveQuery(() => db.recipes.get(id), [id])
  const entries = useLiveQuery(() => db.journal.where('recipeId').equals(id).reverse().sortBy('date'), [id])
  const [editing, setEditing] = useState<JournalEntry | null>(null)
  const [creating, setCreating] = useState(false)

  if (recipe === undefined || entries === undefined) return <LoadingBlock />
  if (!recipe) return <LoadingBlock label="Recette introuvable." />

  const avg = entries.filter((e) => e.rating).reduce((s, e, _, a) => s + e.rating / a.length, 0)

  return (
    <>
      <TopBar back={`/recettes/${id}`} title="Journal de cuisine" subtitle={recipe.title} />
      <Page className="pt-4">
        <div className="rounded-[var(--radius-card)] bg-paper p-5 shadow-[var(--shadow-card)]">
          <p className="font-serif text-2xl font-semibold">
            Cuisinée {recipe.cookCount} fois
          </p>
          {avg > 0 && (
            <p className="mt-1 flex items-center gap-2 text-sm text-muted">
              Note moyenne <Stars value={Math.round(avg * 2) / 2} size={14} /> ({avg.toFixed(1).replace('.', ',')}/5)
            </p>
          )}
          <Button className="mt-4" icon={<NotebookPen size={17} />} onClick={() => setCreating(true)}>
            Ajouter une réalisation
          </Button>
        </div>

        {entries.length === 0 ? (
          <EmptyState icon={<NotebookPen size={26} strokeWidth={1.5} />} title="Aucune réalisation">
            Après chaque préparation, notez le résultat, vos ajustements et ce qu’il faudra changer la prochaine fois.
          </EmptyState>
        ) : (
          <ol className="relative mt-6 space-y-4 border-l-2 border-line pl-5">
            {entries.map((e) => (
              <li key={e.id} className="relative">
                <span className="absolute top-5 -left-[1.6rem] size-3 rounded-full border-2 border-bg bg-terra" aria-hidden="true" />
                <article className="rounded-[var(--radius-card)] bg-paper p-4 shadow-[var(--shadow-card)]">
                  <header className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h2 className="font-serif text-lg font-semibold">{formatDate(e.date)}</h2>
                      <Stars value={e.rating} size={15} />
                    </div>
                    <IconButton label="Modifier" size="sm" onClick={() => setEditing(e)}>
                      <PenLine size={17} />
                    </IconButton>
                    <IconButton
                      label="Supprimer"
                      size="sm"
                      onClick={async () => {
                        if (await confirm({ title: 'Supprimer cette réalisation ?', confirmLabel: 'Supprimer', danger: true })) {
                          await deleteJournalEntry(e)
                          toast.success('Réalisation supprimée')
                        }
                      }}
                    >
                      <Trash2 size={17} />
                    </IconButton>
                  </header>
                  {e.photoId && <Photo id={e.photoId} alt="Résultat" variant="full" className="mt-3 aspect-[4/3] rounded-2xl" />}
                  {e.comment && <p className="mt-3 text-[15px] leading-relaxed whitespace-pre-line">{e.comment}</p>}
                  {e.modifications && (
                    <p className="mt-2 text-sm">
                      <strong>Modifications :</strong> <span className="text-muted">{e.modifications}</span>
                    </p>
                  )}
                  {(e.actualCookTime || e.temperatureC) && (
                    <div className="mt-3 flex flex-wrap gap-2 text-sm text-muted">
                      {e.actualCookTime ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1">
                          <TimerIcon size={14} /> Cuisson {formatDuration(e.actualCookTime)}
                        </span>
                      ) : null}
                      {e.temperatureC ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1">
                          <Thermometer size={14} /> {e.temperatureC} °C
                        </span>
                      ) : null}
                    </div>
                  )}
                  {e.quantitiesUsed.length > 0 && (
                    <details className="mt-3 rounded-2xl bg-sunken p-3 text-sm">
                      <summary className="cursor-pointer font-semibold">
                        Quantités utilisées {e.factor && Math.abs(e.factor - 1) > 1e-9 ? `(${describeFactor(e.factor)})` : ''}
                      </summary>
                      <ul className="mt-2 space-y-0.5">
                        {e.quantitiesUsed.map((q) => {
                          const d = q.quantity != null ? displayQuantity(q.quantity, q.unit, { rounding: 'practical', name: q.name }) : null
                          return (
                            <li key={q.ingredientId} className="flex justify-between gap-3">
                              <span>{q.name}</span>
                              <span className="font-semibold tabular-nums">{d ? `${d.value} ${d.unit}` : '—'}</span>
                            </li>
                          )
                        })}
                      </ul>
                    </details>
                  )}
                </article>
              </li>
            ))}
          </ol>
        )}
      </Page>
      <JournalEntrySheet open={creating || !!editing} onClose={() => (setCreating(false), setEditing(null))} recipe={recipe} entry={editing} />
    </>
  )
}
