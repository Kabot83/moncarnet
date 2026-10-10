import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowRight, ChefHat, Search, ShoppingBasket, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { RecipeCardMini } from '@/components/RecipeCard'
import { CollectionTile } from '@/components/CollectionTile'
import { PostCard } from '@/components/social/SocialUi'
import { AddRecipeSheet } from '@/components/BottomNav'
import { Button } from '@/components/ui/Button'
import { AppHeader, EmptyState, Page, SectionTitle } from '@/components/ui/Layout'
import { Skeleton } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { relativeDays } from '@/lib/format'
import { rediscover } from '@/lib/search'
import { useSettings } from '@/services/settings'

function greeting() {
  const h = new Date().getHours()
  if (h < 5) return 'Bonne nuit'
  if (h < 12) return 'Bonjour'
  if (h < 18) return 'Bon après-midi'
  return 'Bonsoir'
}

function Rail({ children }: { children: React.ReactNode }) {
  return <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2">{children}</div>
}

export default function HomePage() {
  const navigate = useNavigate()
  const recipes = useLiveQuery(() => db.recipes.toArray(), [])
  const collections = useLiveQuery(() => db.collections.orderBy('order').toArray(), [])
  const toTryPosts = useLiveQuery(() => db.posts.where('status').equals('toTry').reverse().sortBy('createdAt'), [])
  const shoppingCount = useLiveQuery(() => db.shopping.filter((i) => !i.checked).count(), [], 0)
  const settings = useSettings()
  const [query, setQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const favorites = useMemo(() => (recipes ?? []).filter((r) => r.favorite).sort((a, b) => b.updatedAt - a.updatedAt), [recipes])
  const lastCooked = useMemo(
    () => (recipes ?? []).filter((r) => r.lastCookedAt).sort((a, b) => (b.lastCookedAt ?? 0) - (a.lastCookedAt ?? 0)).slice(0, 10),
    [recipes],
  )
  const forgotten = useMemo(() => rediscover(recipes ?? [], 6), [recipes])
  const backupOld = settings.lastBackupAt == null || Date.now() - settings.lastBackupAt > 30 * 86_400_000

  return (
    <>
    <AppHeader />
    <Page>
      <section aria-label="Bienvenue" className="pt-3">
        <p className="eyebrow">{new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p>
        <h1 className="mt-1 font-serif text-[2.1rem] leading-[1.1] font-semibold">
          {greeting()},<br />
          <span className="text-terra italic">qu’est-ce qu’on cuisine&nbsp;?</span>
        </h1>
      </section>

      <form
        role="search"
        className="relative mt-6"
        onSubmit={(e) => {
          e.preventDefault()
          navigate(`/recettes?q=${encodeURIComponent(query)}`)
        }}
      >
        <Search size={20} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Une recette, un ingrédient…"
          aria-label="Rechercher dans mes recettes"
          className="field h-14 rounded-full pl-12 shadow-[var(--shadow-card)]"
        />
      </form>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Link to="/chef" className="flex items-center gap-3 rounded-2xl bg-sage-soft p-4 transition-transform active:scale-[.98]">
          <ChefHat size={26} strokeWidth={1.5} className="text-sage" />
          <span>
            <span className="block font-semibold">Mon Chef IA</span>
            <span className="block text-xs text-muted">Idées, conseils</span>
          </span>
        </Link>
        <Link to="/courses" className="flex items-center gap-3 rounded-2xl bg-terra-soft p-4 transition-transform active:scale-[.98]">
          <ShoppingBasket size={26} strokeWidth={1.5} className="text-terra" />
          <span>
            <span className="block font-semibold">Courses</span>
            <span className="block text-xs text-muted">{shoppingCount ? `${shoppingCount} article${shoppingCount > 1 ? 's' : ''}` : 'Liste vide'}</span>
          </span>
        </Link>
      </div>

      {recipes === undefined ? (
        <div className="mt-8 flex gap-3">
          <Skeleton className="h-56 w-44" />
          <Skeleton className="h-56 w-44" />
        </div>
      ) : recipes.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={28} strokeWidth={1.5} />}
          title="Votre carnet est vide"
          action={<Button onClick={() => setAddOpen(true)}>Ajouter ma première recette</Button>}
        >
          Ajoutez vos recettes à la main, depuis un lien, une photo ou un texte.
        </EmptyState>
      ) : (
        <>
          {favorites.length > 0 && (
            <section aria-labelledby="h-fav">
              <SectionTitle id="h-fav" action={<SeeAll to="/recettes?favoris=1" />}>
                Mes favorites
              </SectionTitle>
              <Rail>
                {favorites.slice(0, 10).map((r) => (
                  <RecipeCardMini key={r.id} recipe={r} />
                ))}
              </Rail>
            </section>
          )}

          {lastCooked.length > 0 && (
            <section aria-labelledby="h-last">
              <SectionTitle id="h-last">Cuisinées récemment</SectionTitle>
              <Rail>
                {lastCooked.map((r) => (
                  <RecipeCardMini key={r.id} recipe={r} caption={relativeDays(r.lastCookedAt)} />
                ))}
              </Rail>
            </section>
          )}

          {toTryPosts && toTryPosts.length > 0 && (
            <section aria-labelledby="h-totry">
              <SectionTitle id="h-totry" action={<SeeAll to="/a-essayer" />}>
                À essayer
              </SectionTitle>
              <Rail>
                {toTryPosts.slice(0, 10).map((p) => (
                  <div key={p.id} className="w-36 shrink-0 snap-start">
                    <PostCard post={p} onOpen={() => navigate(`/a-essayer/${p.id}`)} />
                  </div>
                ))}
              </Rail>
            </section>
          )}

          {forgotten.length > 0 && (
            <section aria-labelledby="h-forgot">
              <SectionTitle id="h-forgot">À redécouvrir</SectionTitle>
              <p className="-mt-2 mb-3 text-sm text-muted">Des recettes que vous n’avez pas préparées depuis longtemps.</p>
              <Rail>
                {forgotten.map((r) => (
                  <RecipeCardMini key={r.id} recipe={r} caption={r.lastCookedAt ? `Dernière fois ${relativeDays(r.lastCookedAt)}` : 'Jamais cuisinée'} />
                ))}
              </Rail>
            </section>
          )}

          {collections && collections.length > 0 && (
            <section aria-labelledby="h-col">
              <SectionTitle id="h-col" action={<SeeAll to="/collections" />}>
                Mes collections
              </SectionTitle>
              <Rail>
                {collections.map((c) => (
                  <CollectionTile key={c.id} collection={c} compact />
                ))}
              </Rail>
            </section>
          )}

          <Link
            to="/chef"
            className="mt-8 flex items-center gap-4 overflow-hidden rounded-[var(--radius-card)] bg-ink p-5 text-bg shadow-[var(--shadow-card)]"
          >
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-white/10">
              <Sparkles size={22} strokeWidth={1.5} />
            </span>
            <span className="flex-1">
              <span className="block font-serif text-lg font-semibold">Une envie, des restes ?</span>
              <span className="block text-sm opacity-75">Demandez une idée au Chef IA à partir de vos ingrédients.</span>
            </span>
            <ArrowRight size={20} />
          </Link>

          {backupOld && recipes.some((r) => !r.isDemo) && (
            <Link to="/reglages/sauvegarde" className="mt-4 block rounded-2xl border border-dashed border-line p-4 text-sm text-muted">
              <strong className="text-ink">Pensez à sauvegarder votre carnet.</strong> Vos recettes sont stockées uniquement sur ce téléphone.
              {settings.lastBackupAt ? ` Dernière sauvegarde : ${relativeDays(settings.lastBackupAt)}.` : ' Aucune sauvegarde pour le moment.'}
            </Link>
          )}
        </>
      )}
      <AddRecipeSheet open={addOpen} onClose={() => setAddOpen(false)} />
    </Page>
    </>
  )
}

function SeeAll({ to }: { to: string }) {
  return (
    <Link to={to} className="text-sm font-semibold text-terra">
      Tout voir
    </Link>
  )
}
