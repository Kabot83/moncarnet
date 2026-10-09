import { useLiveQuery } from 'dexie-react-hooks'
import { Check, Plus } from 'lucide-react'
import { useState } from 'react'
import { db } from '@/db/db'
import { saveCollection, setRecipeInCollection } from '@/services/recipes'
import { Button } from './ui/Button'
import { Sheet } from './ui/Sheet'

/** Ranger une recette dans une ou plusieurs collections. */
export function CollectionPicker({ open, onClose, recipeId }: { open: boolean; onClose: () => void; recipeId: string }) {
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), [], [])
  const [name, setName] = useState('')
  const create = async () => {
    if (!name.trim()) return
    await saveCollection({ name, recipeIds: [recipeId] })
    setName('')
  }
  return (
    <Sheet open={open} onClose={onClose} title="Collections" description="Une recette peut appartenir à plusieurs collections.">
      <ul className="space-y-1.5">
        {collections.map((c) => {
          const inside = c.recipeIds.includes(recipeId)
          return (
            <li key={c.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={inside}
                onClick={() => void setRecipeInCollection(c.id, recipeId, !inside)}
                className="flex w-full items-center gap-3 rounded-2xl bg-paper px-4 py-3.5 text-left"
              >
                <span className={`grid size-7 place-items-center rounded-full border-2 ${inside ? 'border-terra bg-terra text-white' : 'border-line'}`}>
                  {inside && <Check size={15} strokeWidth={3} />}
                </span>
                <span className="flex-1 font-medium">{c.name}</span>
                <span className="text-xs text-muted">{c.recipeIds.length}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <form
        className="mt-4 flex gap-2 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <input className="field" placeholder="Nouvelle collection…" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nom de la nouvelle collection" />
        <Button type="submit" variant="soft" icon={<Plus size={18} />} disabled={!name.trim()}>
          Créer
        </Button>
      </form>
    </Sheet>
  )
}
