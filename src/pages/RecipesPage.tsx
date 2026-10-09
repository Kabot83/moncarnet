import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowDownUp, BookOpen, LayoutGrid, List, ListChecks, Search, SlidersHorizontal, X } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RecipeCardGrid, RecipeCardList } from '@/components/RecipeCard'
import { ShoppingBuilder } from '@/components/ShoppingBuilder'
import { Button, IconButton } from '@/components/ui/Button'
import { Chip, Segmented, Switch } from '@/components/ui/Fields'
import { EmptyState, Page } from '@/components/ui/Layout'
import { Sheet } from '@/components/ui/Sheet'
import { Skeleton } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { type RecipeFilters, SORTS, type SortKey, activeFilterCount, allTags, emptyFilters, filterRecipes } from '@/lib/search'
import { CATEGORIES, DIFFICULTIES, type Recipe } from '@/models/types'
import { updateSettings, useSettings } from '@/services/settings'

const PAGE = 60
const TIME_OPTIONS = [
  { value: 15, label: '≤ 15 min' },
  { value: 30, label: '≤ 30 min' },
  { value: 60, label: '≤ 1 h' },
  { value: 120, label: '≤ 2 h' },
]

export default function RecipesPage() {
  const [params, setParams] = useSearchParams()
  const settings = useSettings()
  const recipes = useLiveQuery(() => db.recipes.toArray(), [])
  const [filters, setFilters] = useState<RecipeFilters>(() => ({
    ...emptyFilters(),
    query: params.get('q') ?? '',
    favorite: params.get('favoris') === '1',
    toTry: params.get('essayer') === '1',
  }))
  const [sort, setSort] = useState<SortKey>(() => (sessionStorageGet('mc-sort') as SortKey) || 'recent')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [builderOpen, setBuilderOpen] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const deferredQuery = useDeferredValue(filters.query)

  // Garde la recherche dans l'URL (retour arrière fidèle).
  useEffect(() => {
    const next = new URLSearchParams()
    if (filters.query) next.set('q', filters.query)
    setParams(next, { replace: true })
  }, [filters.query, setParams])
  useEffect(() => sessionStorageSet('mc-sort', sort), [sort])

  const results = useMemo(
    () => (recipes ? filterRecipes(recipes, { ...filters, query: deferredQuery }, sort) : []),
    [recipes, filters, deferredQuery, sort],
  )
  const tags = useMemo(() => allTags(recipes ?? []), [recipes])
  const nFilters = activeFilterCount(filters)
  useEffect(() => setLimit(PAGE), [filters, sort])

  // Affichage progressif : plusieurs centaines de recettes restent fluides.
  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((e) => e[0].isIntersecting && setLimit((l) => l + PAGE), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [results.length])

  const set = (patch: Partial<RecipeFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const toggleIn = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
  const toggleSelect = (r: Recipe) => setSelected((s) => toggleIn(s, r.id))
  const grid = settings.catalogView === 'grid'

  return (
    <>
      <header className="safe-top sticky top-0 z-30 border-b border-line/60 bg-bg/92 backdrop-blur-lg">
        <div className="mx-auto max-w-5xl px-4 pt-3 pb-3">
          <div className="flex items-center gap-2">
            <h1 className="flex-1 font-serif text-2xl font-semibold">{selecting ? `${selected.length} sélectionnée(s)` : 'Mes recettes'}</h1>
            {selecting ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSelecting(false)
                  setSelected([])
                }}
              >
                Annuler
              </Button>
            ) : (
              <>
                <IconButton label="Sélectionner pour la liste de courses" onClick={() => setSelecting(true)}>
                  <ListChecks size={21} strokeWidth={1.75} />
                </IconButton>
                <IconButton label="Trier" onClick={() => setSortOpen(true)}>
                  <ArrowDownUp size={20} strokeWidth={1.75} />
                </IconButton>
                <IconButton
                  label={grid ? 'Afficher en liste' : 'Afficher en grille'}
                  onClick={() => void updateSettings({ catalogView: grid ? 'list' : 'grid' })}
                >
                  {grid ? <List size={21} strokeWidth={1.75} /> : <LayoutGrid size={20} strokeWidth={1.75} />}
                </IconButton>
              </>
            )}
          </div>
          <div className="relative mt-2">
            <Search size={19} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
            <input
              type="search"
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="Titre, ingrédient, note, tag…"
              aria-label="Rechercher"
              className="field h-12 rounded-full pr-11 pl-11"
            />
            {filters.query && (
              <button
                type="button"
                aria-label="Effacer la recherche"
                onClick={() => set({ query: '' })}
                className="absolute top-1/2 right-3 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted"
              >
                <X size={18} />
              </button>
            )}
          </div>
          <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4">
            <Chip active={nFilters > 0} onClick={() => setFiltersOpen(true)} icon={<SlidersHorizontal size={15} />}>
              Filtres{nFilters ? ` (${nFilters})` : ''}
            </Chip>
            <Chip active={filters.favorite} onClick={() => set({ favorite: !filters.favorite })}>
              Favoris
            </Chip>
            {CATEGORIES.filter((c) => c.id !== 'autre').map((c) => (
              <Chip key={c.id} active={filters.categories.includes(c.id)} onClick={() => set({ categories: toggleIn(filters.categories, c.id) })}>
                {c.label}
              </Chip>
            ))}
            <Chip active={filters.toTry} onClick={() => set({ toTry: !filters.toTry })}>
              À essayer
            </Chip>
          </div>
        </div>
      </header>

      <Page wide className="pt-4">
        {recipes === undefined ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="aspect-[3/4]" />
            ))}
          </div>
        ) : results.length === 0 ? (
          <EmptyState
            icon={<BookOpen size={28} strokeWidth={1.5} />}
            title={recipes.length ? 'Aucune recette ne correspond' : 'Aucune recette pour l’instant'}
            action={
              nFilters || filters.query ? (
                <Button variant="secondary" onClick={() => setFilters(emptyFilters())}>
                  Effacer la recherche et les filtres
                </Button>
              ) : undefined
            }
          >
            {recipes.length ? 'Essayez un autre mot ou retirez un filtre.' : 'Utilisez le bouton + pour ajouter votre première recette.'}
          </EmptyState>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted" aria-live="polite">
              {results.length} recette{results.length > 1 ? 's' : ''}
            </p>
            {grid ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {results.slice(0, limit).map((r) => (
                  <RecipeCardGrid key={r.id} recipe={r} onSelect={selecting ? toggleSelect : undefined} selected={selected.includes(r.id)} />
                ))}
              </div>
            ) : (
              <div className="grid gap-2.5 lg:grid-cols-2">
                {results.slice(0, limit).map((r) => (
                  <RecipeCardList key={r.id} recipe={r} onSelect={selecting ? toggleSelect : undefined} selected={selected.includes(r.id)} />
                ))}
              </div>
            )}
            {limit < results.length && <div ref={sentinel} className="h-10" />}
          </>
        )}
      </Page>

      {selecting && (
        <div className="fixed inset-x-0 bottom-[calc(4.6rem+env(safe-area-inset-bottom))] z-40 flex justify-center px-4 animate-fade-up">
          <Button size="lg" className="w-full max-w-md shadow-[var(--shadow-float)]" disabled={!selected.length} onClick={() => setBuilderOpen(true)}>
            Ajouter à la liste de courses
          </Button>
        </div>
      )}

      <ShoppingBuilder
        open={builderOpen}
        recipeIds={selected}
        onClose={() => setBuilderOpen(false)}
        onDone={() => {
          setSelecting(false)
          setSelected([])
        }}
      />

      <Sheet open={sortOpen} onClose={() => setSortOpen(false)} title="Trier par">
        <div className="space-y-1 pb-2" role="radiogroup" aria-label="Tri">
          {SORTS.map((s) => (
            <button
              key={s.id}
              role="radio"
              aria-checked={sort === s.id}
              onClick={() => {
                setSort(s.id)
                setSortOpen(false)
              }}
              className={`flex w-full items-center justify-between rounded-xl px-4 py-3.5 text-left ${sort === s.id ? 'bg-terra-soft font-semibold text-terra-strong' : ''}`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filtres"
        size="tall"
        footer={
          <div className="flex gap-3">
            <Button variant="secondary" block onClick={() => setFilters((f) => ({ ...emptyFilters(), query: f.query }))}>
              Réinitialiser
            </Button>
            <Button block onClick={() => setFiltersOpen(false)}>
              Voir {results.length} recette{results.length > 1 ? 's' : ''}
            </Button>
          </div>
        }
      >
        <FilterGroup title="Catégories">
          {CATEGORIES.map((c) => (
            <Chip key={c.id} active={filters.categories.includes(c.id)} onClick={() => set({ categories: toggleIn(filters.categories, c.id) })}>
              {c.label}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup title="Durée totale">
          {TIME_OPTIONS.map((t) => (
            <Chip key={t.value} active={filters.maxTime === t.value} onClick={() => set({ maxTime: filters.maxTime === t.value ? null : t.value })}>
              {t.label}
            </Chip>
          ))}
        </FilterGroup>
        <FilterGroup title="Difficulté">
          {DIFFICULTIES.map((d) => (
            <Chip key={d.id} active={filters.difficulties.includes(d.id)} onClick={() => set({ difficulties: toggleIn(filters.difficulties, d.id) })}>
              {d.label}
            </Chip>
          ))}
        </FilterGroup>
        <div className="mt-5 divide-y divide-line rounded-2xl bg-paper px-4">
          <Switch label="Favoris uniquement" checked={filters.favorite} onChange={(v) => set({ favorite: v })} />
          <Switch label="Déjà cuisinées" checked={filters.cooked} onChange={(v) => set({ cooked: v })} />
          <Switch label="À essayer" checked={filters.toTry} onChange={(v) => set({ toTry: v })} />
        </div>
        {tags.length > 0 && (
          <FilterGroup title="Mes tags">
            {tags.slice(0, 40).map((t) => (
              <Chip key={t} active={filters.tags.includes(t)} onClick={() => set({ tags: toggleIn(filters.tags, t) })}>
                #{t}
              </Chip>
            ))}
          </FilterGroup>
        )}
        <div className="mt-6">
          <Segmented
            label="Affichage"
            value={settings.catalogView}
            onChange={(v) => void updateSettings({ catalogView: v })}
            options={[
              { value: 'grid', label: 'Grille', icon: <LayoutGrid size={15} /> },
              { value: 'list', label: 'Liste', icon: <List size={15} /> },
            ]}
          />
        </div>
      </Sheet>
    </>
  )
}

function FilterGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="mt-5">
      <legend className="label">{title}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  )
}

function sessionStorageGet(k: string) {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}
function sessionStorageSet(k: string, v: string) {
  try {
    sessionStorage.setItem(k, v)
  } catch {
    /* stockage indisponible */
  }
}
