/**
 * Éléments d'interface de la bibliothèque « À essayer » : carte, badge de plateforme,
 * import d'un lien, onglets « Mes recettes / À essayer ».
 */
import { ClipboardPaste, Heart, Link2, Play } from 'lucide-react'
import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import type { Platform, SocialPost } from '@/models/types'
import { isNative } from '@/platform/native'
import { PLATFORM_LABEL, parseSharedContent, parseSocialUrl, socialPlatformOf } from '@/social/links'
import { processShare, routeForShare } from '@/social/share'
import { Button } from '../ui/Button'
import { Photo } from '../ui/Layout'
import { Sheet } from '../ui/Sheet'

export const STATUS_LABEL: Record<SocialPost['status'], string> = { toTry: 'À essayer', tested: 'Testée', converted: 'Recette créée' }

export function PlatformBadge({ platform, className = '' }: { platform: Platform; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide ${
        platform === 'tiktok' ? 'bg-ink text-bg' : 'bg-terra text-white dark:text-[#1b1916]'
      } ${className}`}
    >
      {PLATFORM_LABEL[platform]}
    </span>
  )
}

export const formatDay = (ts: number) => new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', year: new Date(ts).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }).format(ts)

/** Vignette sans miniature : fond chaud, plateforme et titre. */
function PostPlaceholder({ post }: { post: SocialPost }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-terra-soft to-sunken p-3 text-center">
      <span className="grid size-11 place-items-center rounded-full bg-paper/80 text-terra shadow-sm">
        <Play size={20} fill="currentColor" />
      </span>
      <span className="text-xs font-semibold text-muted">{PLATFORM_LABEL[post.platform]}</span>
    </div>
  )
}

export function PostThumb({ post, className = '' }: { post: SocialPost; className?: string }) {
  return <Photo id={post.thumbnailPhotoId} alt="" className={className} fallback={<div className={className}><PostPlaceholder post={post} /></div>} />
}

export function PostCard({ post, onOpen }: { post: SocialPost; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group w-full overflow-hidden rounded-[var(--radius-card)] bg-paper text-left shadow-[var(--shadow-card)] transition-transform active:scale-[.98]">
      <div className="relative">
        <PostThumb post={post} className="aspect-[4/5] w-full" />
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-2">
          <PlatformBadge platform={post.platform} />
          {post.favorite && (
            <span className="grid size-7 place-items-center rounded-full bg-paper/90 text-terra" aria-label="Favori">
              <Heart size={15} fill="currentColor" />
            </span>
          )}
        </div>
        {post.status !== 'toTry' && (
          <span className={`absolute bottom-2 left-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${post.status === 'converted' ? 'bg-sage text-white dark:text-[#1b1916]' : 'bg-paper/90 text-ink'}`}>
            {STATUS_LABEL[post.status]}
          </span>
        )}
      </div>
      <div className="p-3">
        <h3 className="line-clamp-2 font-serif text-[15px] leading-snug font-semibold">{post.title}</h3>
        <p className="mt-1 truncate text-xs text-muted">
          {post.author ? `${post.author} · ` : ''}
          {formatDay(post.createdAt)}
        </p>
      </div>
    </button>
  )
}

/** Coller un lien TikTok / Instagram : même comportement que le partage Android. */
export function ImportLinkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useSafeNavigate()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urls = parseSharedContent(value).urls
  const recognized = urls.map((u) => parseSocialUrl(u)).find(Boolean)
  const hint = !value.trim()
    ? null
    : recognized
      ? `${PLATFORM_LABEL[recognized.platform]} · ${recognized.short ? 'lien court' : recognized.kind === 'reel' ? 'reel' : recognized.kind === 'post' ? 'publication' : 'vidéo'} reconnu`
      : urls.some((u) => socialPlatformOf(u))
        ? 'Ce lien ne mène pas à une publication.'
        : urls.length
          ? 'Lien d’un autre site : il sera ouvert dans l’import de recette.'
          : 'Collez un lien TikTok ou Instagram.'

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const outcome = await processShare({ text: value })
      if (outcome.kind === 'invalid' || outcome.kind === 'text') {
        setError(outcome.kind === 'invalid' ? outcome.message : 'Aucun lien trouvé dans le texte collé.')
        return
      }
      setValue('')
      onClose()
      navigate(routeForShare(outcome))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Importer un lien"
      description="Vidéo TikTok, reel ou publication Instagram."
      footer={
        <Button block size="lg" icon={<Link2 size={18} />} loading={busy} disabled={!urls.length} onClick={() => void submit()}>
          Enregistrer dans À essayer
        </Button>
      }
    >
      <form
        className="space-y-2 pt-1 pb-2"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="label" htmlFor="social-url">
          Lien de la publication
        </label>
        <div className="flex gap-2">
          <input
            id="social-url"
            className="field"
            inputMode="url"
            autoComplete="off"
            placeholder="https://vm.tiktok.com/…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            variant="secondary"
            icon={<ClipboardPaste size={18} />}
            aria-label="Coller"
            onClick={async () => {
              try {
                setValue((await navigator.clipboard.readText()).trim())
              } catch {
                /* presse-papiers refusé : saisie manuelle */
              }
            }}
          />
        </div>
        {hint && <p className={`text-sm ${recognized ? 'text-sage' : 'text-muted'}`}>{hint}</p>}
        {error && (
          <p className="rounded-2xl bg-danger-soft p-3 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <p className="pt-2 text-xs text-faint">
          {isNative
            ? 'Plus rapide : dans TikTok ou Instagram, touchez « Partager » puis « Mon Carnet ».'
            : 'Le lien est enregistré immédiatement, même hors connexion ; les informations publiques sont récupérées ensuite.'}
        </p>
      </form>
    </Sheet>
  )
}

/** Onglets en tête de « Mes recettes » et « À essayer ». */
export function RecipesTabs() {
  const tab = (active: boolean) =>
    `inline-flex h-9 flex-1 items-center justify-center rounded-full text-sm font-semibold transition-colors ${active ? 'bg-paper text-ink shadow-sm' : 'text-muted'}`
  return (
    <nav aria-label="Bibliothèque" className="flex gap-1 rounded-full bg-sunken p-1">
      <NavLink to="/recettes" end className={({ isActive }) => tab(isActive)}>
        Mes recettes
      </NavLink>
      <NavLink to="/a-essayer" className={({ isActive }) => tab(isActive)}>
        À essayer
      </NavLink>
    </nav>
  )
}
