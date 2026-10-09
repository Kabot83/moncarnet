import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowDown, ArrowUp, FolderPlus, Library } from 'lucide-react'
import { useState } from 'react'
import { CollectionTile } from '@/components/CollectionTile'
import { CollectionFormSheet } from '@/components/CollectionFormSheet'
import { Button, IconButton } from '@/components/ui/Button'
import { EmptyState, Page } from '@/components/ui/Layout'
import { Skeleton } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { reorderCollections } from '@/services/recipes'

const SUGGESTIONS = ['Mes classiques', 'Recettes familiales', 'Repas rapides', 'Protéinées', 'Desserts', 'Plats mijotés', 'À essayer', 'À perfectionner']

export default function CollectionsPage() {
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), [])
  const [formOpen, setFormOpen] = useState(false)
  const [suggested, setSuggested] = useState('')
  const [ordering, setOrdering] = useState(false)

  const move = (i: number, d: number) => {
    if (!collections) return
    const ids = collections.map((c) => c.id)
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void reorderCollections(ids)
  }

  return (
    <>
      <header className="mx-auto flex max-w-5xl items-end gap-2 px-4 pt-[calc(2rem+var(--sat))] pb-2">
        <div className="flex-1">
          <p className="eyebrow">Ranger, retrouver</p>
          <h1 className="mt-1 font-serif text-[2rem] font-semibold">Collections</h1>
        </div>
        {collections && collections.length > 1 && (
          <Button size="sm" variant={ordering ? 'primary' : 'ghost'} onClick={() => setOrdering((v) => !v)}>
            {ordering ? 'Terminé' : 'Réorganiser'}
          </Button>
        )}
        <IconButton label="Nouvelle collection" tone="paper" onClick={() => (setSuggested(''), setFormOpen(true))}>
          <FolderPlus size={20} />
        </IconButton>
      </header>
      <Page wide className="pt-3">
        {collections === undefined ? (
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="aspect-[4/3]" />
            <Skeleton className="aspect-[4/3]" />
          </div>
        ) : collections.length === 0 ? (
          <EmptyState icon={<Library size={28} strokeWidth={1.5} />} title="Aucune collection" action={<Button onClick={() => setFormOpen(true)}>Créer une collection</Button>}>
            Regroupez vos recettes : classiques, repas rapides, desserts… Une recette peut appartenir à plusieurs collections.
          </EmptyState>
        ) : ordering ? (
          <ul className="space-y-2">
            {collections.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 rounded-2xl bg-paper p-3 shadow-[var(--shadow-card)]">
                <span className="flex-1 font-medium">{c.name}</span>
                <IconButton label={`Monter ${c.name}`} size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={18} />
                </IconButton>
                <IconButton label={`Descendre ${c.name}`} size="sm" disabled={i === collections.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={18} />
                </IconButton>
              </li>
            ))}
          </ul>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {collections.map((c) => (
              <CollectionTile key={c.id} collection={c} />
            ))}
          </div>
        )}

        {collections && !ordering && (
          <div className="mt-8">
            <p className="label">Idées de collections</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.filter((s) => !collections.some((c) => c.name.toLowerCase() === s.toLowerCase())).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    setSuggested(s)
                    setFormOpen(true)
                  }}
                  className="h-9 rounded-full border border-dashed border-line px-3.5 text-sm text-muted"
                >
                  + {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </Page>
      <CollectionFormSheet open={formOpen} onClose={() => setFormOpen(false)} initialName={suggested} />
    </>
  )
}
