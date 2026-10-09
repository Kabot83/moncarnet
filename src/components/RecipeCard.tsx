import { Bookmark, Check, Clock, Heart } from 'lucide-react'
import { memo } from 'react'
import { Link } from 'react-router-dom'
import { formatDuration, totalTime } from '@/lib/format'
import { type Recipe, categoryLabel, difficultyLabel } from '@/models/types'
import { toggleFavorite } from '@/services/recipes'
import { Photo, PhotoPlaceholder } from './ui/Layout'
import { Stars } from './ui/Fields'

interface CardProps {
  recipe: Recipe
  /** Mode sélection (liste de courses, collections). */
  selected?: boolean
  onSelect?: (r: Recipe) => void
}

function FavButton({ recipe, className = '' }: { recipe: Recipe; className?: string }) {
  return (
    <button
      type="button"
      aria-label={recipe.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}
      aria-pressed={recipe.favorite}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        void toggleFavorite(recipe)
      }}
      className={`grid size-10 place-items-center rounded-full transition-transform active:scale-90 ${className}`}
    >
      <Heart size={19} strokeWidth={1.8} fill={recipe.favorite ? 'currentColor' : 'none'} className={recipe.favorite ? 'text-terra' : ''} />
    </button>
  )
}

function Wrapper({ recipe, onSelect, className, children, selected }: CardProps & { className: string; children: React.ReactNode }) {
  if (onSelect)
    return (
      <button type="button" onClick={() => onSelect(recipe)} aria-pressed={selected} className={`text-left ${className}`}>
        {children}
      </button>
    )
  return (
    <Link to={`/recettes/${recipe.id}`} className={className}>
      {children}
    </Link>
  )
}

function SelectMark({ selected }: { selected?: boolean }) {
  return (
    <span
      className={`absolute top-2.5 left-2.5 z-10 grid size-7 place-items-center rounded-full border-2 ${
        selected ? 'border-terra bg-terra text-white' : 'border-white/90 bg-black/20'
      }`}
      aria-hidden="true"
    >
      {selected && <Check size={16} strokeWidth={3} />}
    </span>
  )
}

/** Carte « grille » : grande photo, nom, durée, note. */
export const RecipeCardGrid = memo(function RecipeCardGrid({ recipe, selected, onSelect }: CardProps) {
  const time = totalTime(recipe)
  return (
    <Wrapper
      recipe={recipe}
      onSelect={onSelect}
      selected={selected}
      className={`group relative block overflow-hidden rounded-[var(--radius-card)] bg-paper shadow-[var(--shadow-card)] transition-transform active:scale-[.985] ${
        selected ? 'ring-2 ring-terra' : ''
      }`}
    >
      {onSelect && <SelectMark selected={selected} />}
      <div className="relative aspect-[4/3]">
        <Photo id={recipe.mainPhotoId} alt="" className="size-full" fallback={<PhotoPlaceholder title={recipe.title} className="size-full" />} />
        {!onSelect && <FavButton recipe={recipe} className="absolute top-1.5 right-1.5 bg-paper/85 text-ink backdrop-blur" />}
        {recipe.toTry && (
          <span className="absolute bottom-2 left-2 rounded-full bg-sage px-2.5 py-0.5 text-[11px] font-semibold text-white">À essayer</span>
        )}
      </div>
      <div className="p-3 pt-2.5">
        <p className="text-[11px] font-semibold tracking-wider text-terra uppercase">{categoryLabel(recipe.category)}</p>
        <h3 className="mt-0.5 line-clamp-2 font-serif text-[1.02rem] leading-snug font-semibold">{recipe.title}</h3>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted">
          {time > 0 && (
            <span className="inline-flex items-center gap-1">
              <Clock size={13} strokeWidth={1.75} />
              {formatDuration(time)}
            </span>
          )}
          <span>{difficultyLabel(recipe.difficulty)}</span>
          <Stars value={recipe.rating} size={12} />
        </div>
      </div>
    </Wrapper>
  )
})

/** Carte « liste » : compacte, pour parcourir vite un grand catalogue. */
export const RecipeCardList = memo(function RecipeCardList({ recipe, selected, onSelect }: CardProps) {
  const time = totalTime(recipe)
  return (
    <Wrapper
      recipe={recipe}
      onSelect={onSelect}
      selected={selected}
      className={`relative flex items-center gap-3 rounded-2xl bg-paper p-2 pr-1 shadow-[var(--shadow-card)] transition-transform active:scale-[.99] ${
        selected ? 'ring-2 ring-terra' : ''
      }`}
    >
      <div className="relative size-[4.5rem] shrink-0 overflow-hidden rounded-xl">
        {onSelect && <SelectMark selected={selected} />}
        <Photo id={recipe.mainPhotoId} alt="" className="size-full" fallback={<PhotoPlaceholder title={recipe.title} className="size-full text-sm" />} />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-serif text-[1.02rem] font-semibold">{recipe.title}</h3>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span className="text-terra">{categoryLabel(recipe.category)}</span>
          {time > 0 && <span>· {formatDuration(time)}</span>}
          <span>· {difficultyLabel(recipe.difficulty)}</span>
          {recipe.toTry && (
            <span className="inline-flex items-center gap-0.5 text-sage">
              · <Bookmark size={11} /> À essayer
            </span>
          )}
        </p>
        <div className="mt-1">
          <Stars value={recipe.rating} size={12} />
        </div>
      </div>
      {!onSelect && <FavButton recipe={recipe} className="text-muted" />}
    </Wrapper>
  )
})

/** Petite carte horizontale (carrousels de l'accueil). */
export function RecipeCardMini({ recipe, caption }: { recipe: Recipe; caption?: string }) {
  const time = totalTime(recipe)
  return (
    <Link
      to={`/recettes/${recipe.id}`}
      className="block w-[11.5rem] shrink-0 snap-start overflow-hidden rounded-[var(--radius-card)] bg-paper shadow-[var(--shadow-card)] transition-transform active:scale-[.98]"
    >
      <div className="relative aspect-[5/4]">
        <Photo id={recipe.mainPhotoId} alt="" className="size-full" fallback={<PhotoPlaceholder title={recipe.title} className="size-full" />} />
        {recipe.favorite && (
          <span className="absolute top-2 right-2 grid size-7 place-items-center rounded-full bg-paper/85 text-terra">
            <Heart size={14} fill="currentColor" />
          </span>
        )}
      </div>
      <div className="p-3 pt-2">
        <h3 className="line-clamp-2 min-h-[2.6em] font-serif text-[0.98rem] leading-snug font-semibold">{recipe.title}</h3>
        <p className="mt-1 flex items-center gap-2 text-xs text-muted">
          {time > 0 && (
            <span className="inline-flex items-center gap-1">
              <Clock size={12} />
              {formatDuration(time)}
            </span>
          )}
          {caption ? <span className="truncate">{caption}</span> : <Stars value={recipe.rating} size={11} />}
        </p>
      </div>
    </Link>
  )
}
