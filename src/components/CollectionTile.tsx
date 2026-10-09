import { useLiveQuery } from 'dexie-react-hooks'
import { Link } from 'react-router-dom'
import { db } from '@/db/db'
import type { Collection } from '@/models/types'
import { Photo, PhotoPlaceholder } from './ui/Layout'

/** Couverture de collection : photo choisie, sinon celle de la première recette. */
export function CollectionTile({ collection, compact }: { collection: Collection; compact?: boolean }) {
  const fallbackPhoto = useLiveQuery(async () => {
    if (collection.coverPhotoId) return null
    for (const id of collection.recipeIds) {
      const r = await db.recipes.get(id)
      if (r?.mainPhotoId) return r.mainPhotoId
    }
    return null
  }, [collection.coverPhotoId, collection.recipeIds.join(',')])
  const cover = collection.coverPhotoId ?? fallbackPhoto
  const n = collection.recipeIds.length
  return (
    <Link
      to={`/collections/${collection.id}`}
      className={`relative block shrink-0 snap-start overflow-hidden rounded-[var(--radius-card)] shadow-[var(--shadow-card)] transition-transform active:scale-[.98] ${
        compact ? 'h-36 w-44' : 'aspect-[4/3] w-full'
      }`}
    >
      <Photo id={cover} alt="" className="absolute inset-0 size-full" fallback={<PhotoPlaceholder title={collection.name} className="absolute inset-0 size-full" />} />
      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/15 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 p-3 text-white">
        <h3 className="font-serif text-lg leading-tight font-semibold">{collection.name}</h3>
        <p className="text-xs opacity-85">
          {n} recette{n > 1 ? 's' : ''}
        </p>
      </div>
    </Link>
  )
}
