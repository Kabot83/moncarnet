/**
 * « À essayer » : vidéos et publications TikTok / Instagram enregistrées.
 * Accessible depuis l'onglet « Mes recettes » (sans alourdir la navigation inférieure).
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { CheckCircle2, Link2, Search, Share2, X } from 'lucide-react'
import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ImportLinkSheet, PostCard, RecipesTabs } from '@/components/social/SocialUi'
import { Button } from '@/components/ui/Button'
import { Chip, Segmented } from '@/components/ui/Fields'
import { EmptyState, Page } from '@/components/ui/Layout'
import { Skeleton } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import type { SocialPost } from '@/models/types'
import { isNative } from '@/platform/native'
import { type PostFilters, enrichPending, filterPosts } from '@/social/posts'

const STATUS_KEY = 'mc-posts-status'

export default function SocialLibraryPage() {
  const navigate = useSafeNavigate()
  const [params, setParams] = useSearchParams()
  const posts = useLiveQuery(() => db.posts.toArray(), [])
  const [importOpen, setImportOpen] = useState(params.get('importer') === '1')
  const [filters, setFilters] = useState<PostFilters>(() => ({
    query: '',
    platform: 'all',
    favorite: false,
    status: (sessionGet(STATUS_KEY) as PostFilters['status']) || 'all',
  }))
  const query = useDeferredValue(filters.query)
  const sharedCount = params.get('partage')
  const error = params.get('erreur')

  useEffect(() => void enrichPending(), [])
  // « Ajouter → Depuis TikTok ou Instagram » : ouvre directement l'import d'un lien.
  useEffect(() => {
    if (params.get('importer') !== '1') return
    setImportOpen(true)
    setParams(new URLSearchParams(), { replace: true })
  }, [params, setParams])
  useEffect(() => sessionSet(STATUS_KEY, filters.status), [filters.status])

  const results = useMemo(() => (posts ? filterPosts(posts, { ...filters, query }) : []), [posts, filters, query])
  const counts = useMemo(() => {
    const c: Record<SocialPost['status'] | 'all', number> = { all: 0, toTry: 0, tested: 0, converted: 0 }
    for (const p of posts ?? []) {
      c.all++
      c[p.status]++
    }
    return c
  }, [posts])
  const set = (patch: Partial<PostFilters>) => setFilters((f) => ({ ...f, ...patch }))
  const dismissBanner = () => setParams(new URLSearchParams(), { replace: true })

  return (
    <>
      <header className="safe-top sticky top-0 z-30 border-b border-line/60 bg-bg/92 backdrop-blur-lg">
        <div className="mx-auto max-w-5xl px-4 pt-3 pb-3">
          <RecipesTabs />
          <div className="mt-3 flex items-center gap-2">
            <h1 className="flex-1 font-serif text-2xl font-semibold">À essayer</h1>
            <Button size="sm" variant="secondary" icon={<Link2 size={16} />} onClick={() => setImportOpen(true)}>
              Importer un lien
            </Button>
          </div>
          <div className="relative mt-2">
            <Search size={19} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-faint" strokeWidth={1.75} />
            <input
              type="search"
              value={filters.query}
              onChange={(e) => set({ query: e.target.value })}
              placeholder="Titre, auteur, note, tag…"
              aria-label="Rechercher dans À essayer"
              className="field h-12 rounded-full pr-11 pl-11"
            />
            {filters.query && (
              <button type="button" aria-label="Effacer la recherche" onClick={() => set({ query: '' })} className="absolute top-1/2 right-3 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted">
                <X size={18} />
              </button>
            )}
          </div>
          <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4">
            <Chip active={filters.platform === 'all'} onClick={() => set({ platform: 'all' })}>
              Tout
            </Chip>
            <Chip active={filters.platform === 'tiktok'} onClick={() => set({ platform: filters.platform === 'tiktok' ? 'all' : 'tiktok' })}>
              TikTok
            </Chip>
            <Chip active={filters.platform === 'instagram'} onClick={() => set({ platform: filters.platform === 'instagram' ? 'all' : 'instagram' })}>
              Instagram
            </Chip>
            <Chip active={filters.favorite} onClick={() => set({ favorite: !filters.favorite })}>
              Favoris
            </Chip>
          </div>
        </div>
      </header>

      <Page className="pt-4">
        {(sharedCount || error) && (
          <div className={`mb-4 flex items-start gap-3 rounded-2xl p-4 text-sm ${error ? 'bg-danger-soft' : 'bg-sage-soft'}`} role="status">
            {error ? null : <CheckCircle2 size={20} className="shrink-0 text-sage" />}
            <p className="flex-1">{error ?? `${sharedCount} publications enregistrées dans À essayer.`}</p>
            <button type="button" aria-label="Fermer" onClick={dismissBanner} className="text-muted">
              <X size={18} />
            </button>
          </div>
        )}

        {posts && posts.length > 0 && (
          <div className="mb-4 flex justify-center">
            <Segmented
              label="Statut"
              value={filters.status}
              onChange={(status) => set({ status })}
              options={[
                { value: 'all', label: `Tout ${counts.all}` },
                { value: 'toTry', label: `À essayer ${counts.toTry}` },
                { value: 'tested', label: `Testées ${counts.tested}` },
                { value: 'converted', label: `Recettes ${counts.converted}` },
              ]}
            />
          </div>
        )}

        {posts === undefined ? (
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="aspect-[4/5]" />
            <Skeleton className="aspect-[4/5]" />
          </div>
        ) : posts.length === 0 ? (
          <EmptyState
            icon={<Share2 size={28} strokeWidth={1.5} />}
            title="Vos idées de recettes, en un geste"
            action={
              <Button icon={<Link2 size={17} />} onClick={() => setImportOpen(true)}>
                Importer un lien
              </Button>
            }
          >
            {isNative
              ? 'Dans TikTok ou Instagram, touchez « Partager » puis « Mon Carnet » : la vidéo arrive ici, prête à être essayée.'
              : 'Collez le lien d’une vidéo TikTok ou d’une publication Instagram. Depuis l’application Android, utilisez « Partager → Mon Carnet ».'}
          </EmptyState>
        ) : results.length === 0 ? (
          <p className="py-12 text-center text-muted">Aucune publication ne correspond.</p>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {results.map((p) => (
              <li key={p.id}>
                <PostCard post={p} onOpen={() => navigate(`/a-essayer/${p.id}`)} />
              </li>
            ))}
          </ul>
        )}
      </Page>
      <ImportLinkSheet open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  )
}

function sessionGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}
function sessionSet(k: string, v: string) {
  try {
    sessionStorage.setItem(k, v)
  } catch {
    /* préférence non mémorisée */
  }
}
