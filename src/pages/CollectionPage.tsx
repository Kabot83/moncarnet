import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowDown, ArrowUp, Check, MoreVertical, PenLine, Plus, Search, ShoppingBasket, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { CollectionFormSheet } from '@/components/CollectionFormSheet'
import { RecipeCardList } from '@/components/RecipeCard'
import { ShoppingBuilder } from '@/components/ShoppingBuilder'
import { Button, IconButton } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { EmptyState, Page, Photo, TopBar } from '@/components/ui/Layout'
import { Sheet } from '@/components/ui/Sheet'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { matchScore } from '@/lib/search'
import type { Recipe } from '@/models/types'
import { deleteCollection, reorderCollectionRecipes, setRecipeInCollection } from '@/services/recipes'

export default function CollectionPage() {
  const { id = '' } = useParams()
  const navigate = useSafeNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const collection = useLiveQuery(() => db.collections.get(id), [id])
  const recipes = useLiveQuery(async () => {
    if (!collection) return []
    const list = await db.recipes.bulkGet(collection.recipeIds)
    return list.filter((r): r is Recipe => !!r)
  }, [collection?.recipeIds.join(',')])
  const [menuOpen, setMenuOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [ordering, setOrdering] = useState(false)
  const [shopOpen, setShopOpen] = useState(false)

  if (collection === undefined) return <LoadingBlock />
  if (!collection) return <LoadingBlock label="Collection introuvable." />

  const move = (i: number, d: number) => {
    const ids = [...collection.recipeIds]
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void reorderCollectionRecipes(collection.id, ids)
  }

  return (
    <>
      <TopBar
        back="/collections"
        asHeading={false}
        title={collection.name}
        actions={
          <IconButton label="Actions de la collection" onClick={() => setMenuOpen(true)}>
            <MoreVertical size={20} />
          </IconButton>
        }
      />
      <Page className="pt-4">
        {collection.coverPhotoId && <Photo id={collection.coverPhotoId} alt="" variant="full" className="mb-4 aspect-[16/9] rounded-[var(--radius-card)]" />}
        <h1 className="font-serif text-3xl font-semibold">{collection.name}</h1>
        {collection.description && <p className="mt-1 text-muted">{collection.description}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button size="sm" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
            Ajouter des recettes
          </Button>
          {collection.recipeIds.length > 1 && (
            <Button size="sm" variant={ordering ? 'primary' : 'secondary'} onClick={() => setOrdering((v) => !v)}>
              {ordering ? 'Terminé' : 'Réorganiser'}
            </Button>
          )}
        </div>

        {recipes === undefined ? (
          <LoadingBlock />
        ) : recipes.length === 0 ? (
          <EmptyState title="Collection vide">Ajoutez des recettes depuis cette page ou depuis une fiche recette.</EmptyState>
        ) : (
          <ul className="mt-5 space-y-2.5">
            {recipes.map((r, i) => (
              <li key={r.id} className="flex items-center gap-1">
                <div className="min-w-0 flex-1">
                  <RecipeCardList recipe={r} />
                </div>
                {ordering && (
                  <div className="flex flex-col">
                    <IconButton label={`Monter ${r.title}`} size="sm" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp size={17} />
                    </IconButton>
                    <IconButton label={`Descendre ${r.title}`} size="sm" disabled={i === recipes.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown size={17} />
                    </IconButton>
                  </div>
                )}
                {ordering && (
                  <IconButton label={`Retirer ${r.title} de la collection`} size="sm" onClick={() => void setRecipeInCollection(collection.id, r.id, false)}>
                    <X size={17} />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        )}
      </Page>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={collection.name}>
        <nav className="grid gap-1 pb-2">
          <button type="button" className="flex items-center gap-4 rounded-xl px-3 py-3.5 text-left font-medium hover:bg-sunken" onClick={() => (setMenuOpen(false), setEditOpen(true))}>
            <PenLine size={20} className="text-muted" /> Modifier le nom et la couverture
          </button>
          <button
            type="button"
            disabled={!collection.recipeIds.length}
            className="flex items-center gap-4 rounded-xl px-3 py-3.5 text-left font-medium hover:bg-sunken disabled:opacity-40"
            onClick={() => (setMenuOpen(false), setShopOpen(true))}
          >
            <ShoppingBasket size={20} className="text-muted" /> Liste de courses de la collection
          </button>
          <button
            type="button"
            className="flex items-center gap-4 rounded-xl px-3 py-3.5 text-left font-medium text-danger hover:bg-sunken"
            onClick={async () => {
              setMenuOpen(false)
              const ok = await confirm({
                title: 'Supprimer cette collection ?',
                message: 'Les recettes ne sont pas supprimées : elles restent dans votre carnet.',
                confirmLabel: 'Supprimer',
                danger: true,
              })
              if (!ok) return
              await deleteCollection(collection.id)
              toast.success('Collection supprimée')
              navigate('/collections', { replace: true })
            }}
          >
            <Trash2 size={20} /> Supprimer la collection
          </button>
        </nav>
      </Sheet>
      <CollectionFormSheet open={editOpen} onClose={() => setEditOpen(false)} collection={collection} />
      <AddRecipesSheet open={addOpen} onClose={() => setAddOpen(false)} collectionId={collection.id} inside={collection.recipeIds} />
      <ShoppingBuilder open={shopOpen} onClose={() => setShopOpen(false)} recipeIds={collection.recipeIds} />
    </>
  )
}

function AddRecipesSheet({ open, onClose, collectionId, inside }: { open: boolean; onClose: () => void; collectionId: string; inside: string[] }) {
  const all = useLiveQuery(() => (open ? db.recipes.orderBy('title').toArray() : []), [open], [])
  const [q, setQ] = useState('')
  const list = useMemo(() => all.filter((r) => matchScore(r, q) > 0), [all, q])
  return (
    <Sheet open={open} onClose={onClose} title="Ajouter des recettes" size="tall" footer={<Button block onClick={onClose}>Terminé</Button>}>
      <div className="relative mb-3">
        <Search size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
        <input className="field pl-10" placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Rechercher une recette" />
      </div>
      <ul className="space-y-1">
        {list.map((r) => {
          const on = inside.includes(r.id)
          return (
            <li key={r.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => void setRecipeInCollection(collectionId, r.id, !on)}
                className="flex w-full items-center gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-sunken"
              >
                <Photo id={r.mainPhotoId} alt="" className="size-11 shrink-0 rounded-lg" fallback={<span className="size-11 shrink-0 rounded-lg bg-sunken" />} />
                <span className="flex-1 truncate">{r.title}</span>
                <span className={`grid size-7 place-items-center rounded-full border-2 ${on ? 'border-terra bg-terra text-white' : 'border-line'}`}>{on && <Check size={15} strokeWidth={3} />}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </Sheet>
  )
}
