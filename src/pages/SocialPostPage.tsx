/**
 * Fiche d'une publication enregistrée : titre modifiable, miniature, lecteur intégré officiel,
 * lien vers l'application, description, notes, tags, statut, « Transformer en recette ».
 * Reste consultable hors ligne (tout est stocké localement, miniature comprise) ;
 * seul le lecteur vidéo nécessite Internet.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, BookOpen, CheckCircle2, ExternalLink, Heart, Info, Play, RefreshCw, Trash2, Wand2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { ConvertPostSheet } from '@/components/social/ConvertPostSheet'
import { PlatformBadge, PostThumb, STATUS_LABEL, formatDay } from '@/components/social/SocialUi'
import { Button, IconButton } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { Segmented, TextArea } from '@/components/ui/Fields'
import { EmptyState, Page, TopBar } from '@/components/ui/Layout'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { useOnline } from '@/hooks/useOnline'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import type { SocialPost } from '@/models/types'
import { isNative } from '@/platform/native'
import { openExternal, returnToSourceApp } from '@/platform/shareReceiver'
import { PLATFORM_LABEL, embedUrl } from '@/social/links'
import { deletePost, enrichPost, togglePostFavorite, updatePost } from '@/social/posts'

export default function SocialPostPage() {
  const { id = '' } = useParams()
  const [params, setParams] = useSearchParams()
  const navigate = useSafeNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const online = useOnline()
  const post = useLiveQuery(async () => (await db.posts.get(id)) ?? null, [id])
  const recipe = useLiveQuery(async () => (post?.recipeId ? ((await db.recipes.get(post.recipeId)) ?? null) : null), [post?.recipeId])
  const [convertOpen, setConvertOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const shared = params.get('partage')
  const from = params.get('depuis')

  // Informations publiques : récupérées à l'ouverture si besoin (sans bloquer l'affichage).
  const tried = useRef<string | null>(null)
  useEffect(() => {
    if (!post || tried.current === post.id || !online) return
    if (post.metaStatus !== 'pending' && !(post.metaStatus === 'failed' && post.metaAttempts < 5)) return
    tried.current = post.id
    void enrichPost(post.id).then((r) => {
      if (r.merged && r.id !== post.id) navigate(`/a-essayer/${r.id}?partage=deja`, { replace: true })
    })
  }, [post, online, navigate])

  if (post === undefined) return <LoadingBlock />
  if (post === null)
    return (
      <>
        <TopBar back="/a-essayer" title="À essayer" />
        <Page>
          <EmptyState title="Publication introuvable" action={<Button onClick={() => navigate('/a-essayer', { replace: true })}>Retour à « À essayer »</Button>}>
            Elle a peut-être été supprimée ou fusionnée avec une fiche identique.
          </EmptyState>
        </Page>
      </>
    )

  const platform = PLATFORM_LABEL[post.platform]
  const refresh = async () => {
    setRefreshing(true)
    await db.posts.update(post.id, { metaStatus: 'pending', metaAttempts: 0 })
    const r = await enrichPost(post.id)
    setRefreshing(false)
    if (r.merged && r.id !== post.id) navigate(`/a-essayer/${r.id}?partage=deja`, { replace: true })
    else toast.success(r.status === 'ok' || r.status === 'limited' ? 'Informations mises à jour' : 'Informations indisponibles')
  }

  return (
    <>
      <TopBar
        back="/a-essayer"
        title={platform}
        actions={
          <>
            <IconButton label={post.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} onClick={() => void togglePostFavorite(post)} aria-pressed={post.favorite}>
              <Heart size={21} strokeWidth={1.75} className={post.favorite ? 'text-terra' : ''} fill={post.favorite ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton
              label="Supprimer"
              onClick={async () => {
                const ok = await confirm({
                  title: 'Supprimer cette publication ?',
                  message: recipe ? 'La fiche recette créée à partir d’elle est conservée.' : 'Le lien, vos notes et vos tags seront supprimés.',
                  confirmLabel: 'Supprimer',
                  danger: true,
                })
                if (!ok) return
                await deletePost(post.id)
                toast.success('Publication supprimée')
                navigate('/a-essayer', { replace: true })
              }}
            >
              <Trash2 size={20} strokeWidth={1.75} />
            </IconButton>
          </>
        }
      />
      <Page className="pt-2 pb-28">
        {shared && (
          <div className="mb-4 rounded-2xl bg-sage-soft p-4" role="status">
            <div className="flex items-start gap-3">
              <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-sage" />
              <div className="flex-1">
                <p className="font-semibold">{shared === 'deja' ? 'Déjà dans « À essayer »' : 'Enregistrée dans « À essayer »'}</p>
                <p className="text-sm text-muted">
                  {shared === 'deja' ? `Ajoutée le ${formatDay(post.createdAt)} : aucun doublon créé.` : 'Vous pouvez la retrouver à tout moment, même hors connexion.'}
                </p>
              </div>
              <button type="button" aria-label="Fermer" className="text-muted" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                <X size={18} />
              </button>
            </div>
            {isNative && from && (
              <Button className="mt-3" block variant="secondary" icon={<ArrowLeft size={17} />} onClick={() => void returnToSourceApp()}>
                Retour à {from}
              </Button>
            )}
          </div>
        )}

        <div className="flex gap-4">
          <PostThumb post={post} className="aspect-[4/5] w-28 shrink-0 overflow-hidden rounded-2xl" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <PlatformBadge platform={post.platform} />
              <span className="text-xs text-muted">{STATUS_LABEL[post.status]}</span>
            </div>
            <EditableTitle post={post} />
            <p className="mt-1 text-sm text-muted">
              {post.author && <span className="font-medium text-ink">{post.author} · </span>}
              Ajoutée le {formatDay(post.createdAt)}
            </p>
          </div>
        </div>

        <MetaNotice post={post} online={online} refreshing={refreshing} onRefresh={() => void refresh()} />

        <Player post={post} online={online} />

        <Button className="mt-3" block variant="secondary" icon={<ExternalLink size={17} />} onClick={() => void openExternal(post.url)}>
          Voir sur {platform}
        </Button>

        <section className="mt-6">
          <Segmented
            label="Statut"
            value={post.status}
            onChange={(status) => void updatePost(post.id, { status })}
            options={[
              { value: 'toTry', label: 'À essayer' },
              { value: 'tested', label: 'Testée' },
              { value: 'converted', label: 'Recette' },
            ]}
          />
        </section>

        <section className="mt-6 space-y-2">
          {recipe ? (
            <>
              <Link to={`/recettes/${recipe.id}`} className="flex items-center gap-3 rounded-2xl bg-sage-soft p-4">
                <BookOpen size={22} className="text-sage" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-muted">Fiche recette créée</span>
                  <span className="block truncate font-semibold">{recipe.title}</span>
                </span>
              </Link>
              <Button block variant="ghost" icon={<Wand2 size={17} />} onClick={() => setConvertOpen(true)}>
                Créer une autre fiche
              </Button>
            </>
          ) : (
            <Button block size="lg" icon={<Wand2 size={19} />} onClick={() => setConvertOpen(true)}>
              Transformer en recette
            </Button>
          )}
        </section>

        <AutoText key={`d-${post.id}`} label="Description" initial={post.description} placeholder={post.platform === 'instagram' ? 'Instagram ne transmet pas la légende : collez-la ici si vous le souhaitez.' : 'Aucune description disponible.'} onSave={(v) => updatePost(post.id, { description: v })} />
        {post.sharedText && post.sharedText !== post.description && (
          <div className="mt-4">
            <p className="label">Texte reçu avec le partage</p>
            <p className="rounded-2xl bg-sunken p-3 text-sm whitespace-pre-line text-muted">{post.sharedText}</p>
          </div>
        )}
        <AutoText key={`n-${post.id}`} label="Mes notes" initial={post.notes} placeholder="Idées, adaptations, à acheter…" onSave={(v) => updatePost(post.id, { notes: v })} />
        <TagsEditor post={post} />

        <p className="mt-8 text-xs break-all text-faint">
          Lien : {post.url}
          {post.originalUrl !== post.url && (
            <>
              <br />
              Lien reçu : {post.originalUrl}
            </>
          )}
        </p>
      </Page>
      <ConvertPostSheet open={convertOpen} onClose={() => setConvertOpen(false)} post={post} />
    </>
  )
}

function EditableTitle({ post }: { post: SocialPost }) {
  const [value, setValue] = useState(post.title)
  useEffect(() => setValue(post.title), [post.title])
  const save = () => {
    const v = value.trim()
    if (!v) setValue(post.title)
    else if (v !== post.title) void updatePost(post.id, { title: v.slice(0, 300) })
  }
  return (
    <textarea
      aria-label="Titre"
      rows={2}
      value={value}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ' '))}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.blur())}
      className="mt-1 w-full resize-none rounded-xl border border-transparent bg-transparent px-1 py-0.5 font-serif text-xl leading-snug font-semibold focus:border-line focus:bg-paper focus:outline-none"
    />
  )
}

/** Champ texte enregistré à la sortie du champ (et après une courte pause de saisie). */
function AutoText({ label, initial, placeholder, onSave }: { label: string; initial: string; placeholder: string; onSave: (v: string) => Promise<void> }) {
  const [value, setValue] = useState(initial)
  const last = useRef(initial)
  useEffect(() => {
    if (initial !== last.current) {
      last.current = initial
      setValue(initial)
    }
  }, [initial])
  const commit = (v: string) => {
    if (v === last.current) return
    last.current = v
    void onSave(v)
  }
  useEffect(() => {
    const t = setTimeout(() => commit(value), 800)
    return () => clearTimeout(t)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mt-6">
      <TextArea label={label} rows={3} value={value} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} onBlur={() => commit(value)} />
    </div>
  )
}

function TagsEditor({ post }: { post: SocialPost }) {
  const [draft, setDraft] = useState('')
  const add = () => {
    const t = draft.trim().replace(/^#/, '').slice(0, 40)
    if (t && !post.tags.includes(t)) void updatePost(post.id, { tags: [...post.tags, t] })
    setDraft('')
  }
  return (
    <div className="mt-6">
      <label className="label" htmlFor="post-tag">
        Tags
      </label>
      <div className="flex flex-wrap gap-2">
        {post.tags.map((t) => (
          <button
            key={t}
            type="button"
            aria-label={`Retirer le tag ${t}`}
            onClick={() => void updatePost(post.id, { tags: post.tags.filter((x) => x !== t) })}
            className="inline-flex h-8 items-center gap-1 rounded-full bg-terra-soft px-3 text-sm text-terra-strong"
          >
            {t} <X size={13} />
          </button>
        ))}
        <input
          id="post-tag"
          className="field h-8 min-h-0 w-36 rounded-full px-3 text-sm"
          placeholder="Ajouter…"
          value={draft}
          enterKeyHint="done"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
        />
      </div>
    </div>
  )
}

function MetaNotice({ post, online, refreshing, onRefresh }: { post: SocialPost; online: boolean; refreshing: boolean; onRefresh: () => void }) {
  let text: string | null = null
  let canRetry = true
  switch (post.metaStatus) {
    case 'pending':
      text = online ? 'Récupération des informations publiques…' : 'Hors connexion : le lien est enregistré, les informations seront récupérées au retour du réseau.'
      canRetry = online
      break
    case 'failed':
      text = post.metaMessage || 'Informations momentanément indisponibles.'
      break
    case 'unavailable':
      text = post.metaMessage || 'Publication privée, supprimée ou introuvable : le lien et vos notes restent enregistrés.'
      break
    case 'limited':
      text = 'Instagram ne transmet ni titre, ni légende, ni miniature aux applications : le lien, le lecteur intégré et vos propres notes sont disponibles.'
      canRetry = false
      break
    default:
      return null
  }
  return (
    <div className="mt-4 flex items-start gap-2 rounded-2xl bg-sunken p-3 text-sm text-muted">
      <Info size={17} className="mt-0.5 shrink-0" />
      <p className="flex-1">{text}</p>
      {canRetry && post.metaStatus !== 'pending' && (
        <button type="button" onClick={onRefresh} disabled={!online || refreshing} className="inline-flex shrink-0 items-center gap-1 font-semibold text-terra disabled:opacity-50">
          <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Réessayer
        </button>
      )}
    </div>
  )
}

/** Lecteur officiel, chargé seulement à la demande (données mobiles, confidentialité). */
function Player({ post, online }: { post: SocialPost; online: boolean }) {
  const [on, setOn] = useState(false)
  const src = embedUrl(post)
  if (!src) return null
  const vertical = post.platform === 'tiktok' || post.kind === 'reel'
  return (
    <section className="mt-4" aria-label="Lecteur vidéo">
      {on && online ? (
        <div className={`mx-auto overflow-hidden rounded-2xl bg-ink ${vertical ? 'aspect-[9/16] max-h-[78vh] w-full max-w-sm' : 'h-[640px] w-full max-w-md'}`}>
          <iframe
            src={src}
            title={`Lecteur ${PLATFORM_LABEL[post.platform]}`}
            className="size-full border-0"
            allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={!online}
          onClick={() => setOn(true)}
          className="flex w-full items-center gap-3 rounded-2xl bg-ink p-4 text-left text-bg disabled:opacity-60"
        >
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-white/15">
            <Play size={20} fill="currentColor" />
          </span>
          <span>
            <span className="block font-semibold">Lire la vidéo ici</span>
            <span className="block text-xs opacity-75">{online ? `Lecteur officiel ${PLATFORM_LABEL[post.platform]} · nécessite Internet` : 'Hors connexion : la lecture nécessite Internet'}</span>
          </span>
        </button>
      )}
    </section>
  )
}
