/**
 * Bibliothèque « À essayer » : publications TikTok / Instagram enregistrées.
 *
 * Principes :
 * - L'enregistrement est immédiat et local : il n'attend jamais le réseau. Au minimum, le lien,
 *   la plateforme et le texte partagé sont conservés.
 * - L'enrichissement (oEmbed) est fait ensuite, sans jamais écraser un champ corrigé à la main
 *   (`edited`) ni créer de doublon : si la publication résolue existe déjà, les deux fiches
 *   sont fusionnées dans la plus ancienne.
 * - Identifiants stables et `updatedAt` : prêt pour une future synchronisation (fusion « la plus
 *   récente l'emporte », comme la restauration des sauvegardes).
 */
import { db } from '@/db/db'
import { newId } from '@/lib/id'
import { normalize } from '@/lib/text'
import { type PostStatus, type SocialPost, SocialPostSchema } from '@/models/types'
import { addPhotoFromFile } from '@/services/photos'
import { type ParsedSocialLink, defaultTitle, parseSocialUrl, titleFromText } from './links'
import { MetaError, type PostMeta, fetchPostMeta } from './meta'

export interface SaveResult {
  post: SocialPost
  /** Déjà présente dans la bibliothèque (aucun doublon créé). */
  existing: boolean
}

export async function findByDedupeKey(key: string): Promise<SocialPost | undefined> {
  return db.posts.where('dedupeKey').equals(key).first()
}

/** Enregistre une publication à partir d'un lien (partage ou collage). Instantané, hors ligne compris. */
export async function savePostFromLink(link: ParsedSocialLink, input: { originalUrl: string; sharedText?: string; subject?: string }): Promise<SaveResult> {
  const existing = await findByDedupeKey(link.dedupeKey)
  if (existing) {
    // Texte partagé nouveau (ex. légende transmise cette fois) : conservé sans toucher au reste.
    const shared = (input.sharedText ?? '').trim()
    if (shared && !existing.sharedText.includes(shared)) {
      await db.posts.update(existing.id, { sharedText: [existing.sharedText, shared].filter(Boolean).join('\n\n').slice(0, 5000), updatedAt: Date.now() })
    }
    return { post: (await db.posts.get(existing.id))!, existing: true }
  }
  const now = Date.now()
  const sharedText = (input.sharedText ?? '').trim().slice(0, 5000)
  const title = titleFromText(sharedText) || titleFromText(input.subject ?? '') || defaultTitle(link.platform, link.kind, link.handle ? `@${link.handle}` : '')
  const post = SocialPostSchema.parse({
    id: newId('p_'),
    platform: link.platform,
    kind: link.kind,
    originalUrl: input.originalUrl.trim().slice(0, 2000),
    url: link.url,
    postId: link.postId,
    dedupeKey: link.dedupeKey,
    title,
    sharedText,
    authorHandle: link.handle ?? '',
    author: link.handle ? `@${link.handle}` : '',
    createdAt: now,
    updatedAt: now,
  })
  try {
    await db.posts.add(post)
  } catch (e) {
    // Même publication enregistrée au même instant (double partage) : pas de doublon.
    const twin = await findByDedupeKey(link.dedupeKey)
    if (twin) return { post: twin, existing: true }
    throw e
  }
  return { post, existing: false }
}

/** Mise à jour par l'utilisateur : les champs touchés ne seront plus écrasés par l'enrichissement. */
export async function updatePost(id: string, patch: Partial<SocialPost>) {
  const post = await db.posts.get(id)
  if (!post) return
  const edited = new Set(post.edited)
  for (const k of ['title', 'description', 'author'] as const) if (k in patch && patch[k] !== post[k]) edited.add(k)
  await db.posts.update(id, { ...patch, edited: [...edited], updatedAt: Date.now() })
}

export const setPostStatus = (id: string, status: PostStatus) => updatePost(id, { status })
export const togglePostFavorite = (p: SocialPost) => db.posts.update(p.id, { favorite: !p.favorite, updatedAt: Date.now() })

export async function deletePost(id: string) {
  await db.posts.delete(id)
  // La fiche recette éventuelle reste intacte ; elle perd seulement son lien vers la publication.
  await db.recipes.where('sourcePostId').equals(id).modify({ sourcePostId: null })
}

/** Une recette a été créée à partir de la publication. */
export async function linkPostToRecipe(postId: string, recipeId: string) {
  const post = await db.posts.get(postId)
  if (!post) return
  await db.posts.update(postId, { recipeId, status: 'converted', updatedAt: Date.now() })
}

// ---------------------------------------------------------------------------
// Enrichissement
// ---------------------------------------------------------------------------

const running = new Map<string, Promise<EnrichResult>>()

export interface EnrichResult {
  /** Identifiant final (différent si la publication a été fusionnée avec une fiche existante). */
  id: string
  status: SocialPost['metaStatus']
  merged: boolean
}

/** Miniature copiée localement : reste visible hors ligne et après expiration du lien signé. */
async function storeThumbnail(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/') || blob.size > 8 * 1024 * 1024) return null
    return await addPhotoFromFile(blob)
  } catch {
    return null
  }
}

function applyMeta(post: SocialPost, meta: PostMeta): Partial<SocialPost> {
  const keep = new Set(post.edited)
  const patch: Partial<SocialPost> = {
    kind: meta.link.kind !== 'unknown' ? meta.link.kind : post.kind,
    url: meta.link.url,
    postId: meta.link.postId ?? post.postId,
    dedupeKey: meta.link.dedupeKey,
    metaStatus: meta.limited ? 'limited' : 'ok',
    metaMessage: meta.limited ? 'Instagram ne fournit ni titre, ni légende, ni miniature aux applications sans compte développeur.' : '',
    metaFetchedAt: Date.now(),
  }
  if (meta.caption && !keep.has('description')) patch.description = meta.caption
  if (meta.author && !keep.has('author')) patch.author = meta.author
  if (meta.authorHandle) patch.authorHandle = meta.authorHandle
  if (meta.authorUrl) patch.authorUrl = meta.authorUrl
  // Titre : remplacé seulement s'il n'a pas été corrigé et qu'il était un titre par défaut.
  const autoTitle = defaultTitle(post.platform, post.kind, post.author)
  const generic = !post.title || post.title === autoTitle || post.title.startsWith(defaultTitle(post.platform, post.kind))
  if (!keep.has('title') && generic) {
    const t = titleFromText(meta.caption ?? '')
    patch.title = t || defaultTitle(post.platform, patch.kind ?? post.kind, meta.author ?? post.author)
  }
  return patch
}

/** Fusionne `dup` dans `keep` : notes, tags, favori et statut le plus avancé sont conservés. */
async function mergeInto(keepId: string, dupId: string, patch: Partial<SocialPost>): Promise<void> {
  await db.transaction('rw', db.posts, db.recipes, async () => {
    // Relecture dans la transaction : les modifications faites pendant la requête réseau sont incluses.
    const [keep, dup] = await Promise.all([db.posts.get(keepId), db.posts.get(dupId)])
    if (!keep || !dup) return
    const fresh = { ...patch }
    for (const k of keep.edited) delete fresh[k]
    await mergeTx(keep, dup, fresh)
  })
}

async function mergeTx(keep: SocialPost, dup: SocialPost, patch: Partial<SocialPost>): Promise<void> {
  const order: PostStatus[] = ['toTry', 'tested', 'converted']
  const status = order[Math.max(order.indexOf(keep.status), order.indexOf(dup.status))]
  const join = (a: string, b: string) => (a && b && a !== b ? `${a}\n\n${b}` : a || b)
  // Corrections manuelles : celles de la fiche conservée priment, celles du doublon complètent.
  const fromDup = Object.fromEntries(dup.edited.filter((k) => !keep.edited.includes(k)).map((k) => [k, dup[k]]))
  // Le doublon est retiré d'abord : sa clé d'unicité peut être celle que reçoit la fiche conservée.
  await db.posts.delete(dup.id)
  await db.posts.update(keep.id, {
    ...patch,
    ...fromDup,
    edited: [...new Set([...keep.edited, ...dup.edited])],
    dedupeKey: patch.dedupeKey ?? keep.dedupeKey,
    notes: join(keep.notes, dup.notes).slice(0, 10000),
    sharedText: join(keep.sharedText, dup.sharedText).slice(0, 5000),
    tags: [...new Set([...keep.tags, ...dup.tags])].slice(0, 40),
    favorite: keep.favorite || dup.favorite,
    status,
    recipeId: keep.recipeId ?? dup.recipeId,
    thumbnailPhotoId: keep.thumbnailPhotoId ?? dup.thumbnailPhotoId ?? patch.thumbnailPhotoId ?? null,
    updatedAt: Date.now(),
  })
  await db.recipes.where('sourcePostId').equals(dup.id).modify({ sourcePostId: keep.id })
}

async function doEnrich(id: string): Promise<EnrichResult> {
  const post = await db.posts.get(id)
  if (!post) return { id, status: 'failed', merged: false }
  const link = parseSocialUrl(post.url) ?? parseSocialUrl(post.originalUrl)
  if (!link) {
    await db.posts.update(id, { metaStatus: 'unavailable', metaMessage: 'Lien non reconnu.', metaFetchedAt: Date.now() })
    return { id, status: 'unavailable', merged: false }
  }
  let meta: PostMeta
  try {
    meta = await fetchPostMeta(link)
  } catch (e) {
    const err = e instanceof MetaError ? e : new MetaError('network', 'Informations indisponibles pour le moment.')
    // Hors ligne / erreur passagère : nouvel essai plus tard. Introuvable : définitif (le lien reste).
    const status: SocialPost['metaStatus'] = err.kind === 'offline' ? 'pending' : err.kind === 'network' ? 'failed' : 'unavailable'
    await db.posts.update(id, { metaStatus: status, metaMessage: err.message, metaAttempts: post.metaAttempts + 1, metaFetchedAt: Date.now() })
    return { id, status, merged: false }
  }
  const patch = applyMeta(post, meta)
  // Miniature : téléchargée avant la transaction (réseau), une seule fois.
  if (meta.thumbnailUrl && !post.thumbnailPhotoId) patch.thumbnailPhotoId = await storeThumbnail(meta.thumbnailUrl)

  // Lien court résolu vers une publication déjà enregistrée : fusion, jamais de doublon.
  const twin = patch.dedupeKey && patch.dedupeKey !== post.dedupeKey ? await findByDedupeKey(patch.dedupeKey) : undefined
  if (twin && twin.id !== post.id) {
    const [keep, dup] = twin.createdAt <= post.createdAt ? [twin, post] : [post, twin]
    const keepPatch = keep.id === post.id ? patch : { ...applyMeta(keep, meta), thumbnailPhotoId: keep.thumbnailPhotoId ?? patch.thumbnailPhotoId ?? null }
    await mergeInto(keep.id, dup.id, keepPatch)
    return { id: keep.id, status: keepPatch.metaStatus ?? 'ok', merged: true }
  }
  // Champs corrigés pendant la requête : relus juste avant l'écriture.
  const fresh = await db.posts.get(id)
  if (!fresh) return { id, status: 'failed', merged: false }
  for (const k of fresh.edited) delete patch[k]
  await db.posts.update(id, { ...patch, metaMessage: patch.metaMessage ?? '', updatedAt: Date.now() })
  return { id, status: patch.metaStatus ?? 'ok', merged: false }
}

/** Récupère les informations publiques d'une publication (une seule requête à la fois par fiche). */
export function enrichPost(id: string): Promise<EnrichResult> {
  const current = running.get(id)
  if (current) return current
  const p = doEnrich(id).finally(() => running.delete(id))
  running.set(id, p)
  return p
}

/** Nouvel essai pour les fiches en attente (au retour du réseau, à l'ouverture de la bibliothèque). */
export async function enrichPending(max = 5): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  const todo = await db.posts.filter((p) => p.metaStatus === 'pending' || (p.metaStatus === 'failed' && p.metaAttempts < 5)).limit(max).toArray()
  for (const p of todo) await enrichPost(p.id)
}

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------

export interface PostFilters {
  query: string
  platform: SocialPost['platform'] | 'all'
  status: PostStatus | 'all'
  favorite: boolean
}

export function filterPosts(posts: SocialPost[], f: PostFilters): SocialPost[] {
  const q = normalize(f.query)
  return posts
    .filter((p) => (f.platform === 'all' || p.platform === f.platform) && (f.status === 'all' || p.status === f.status) && (!f.favorite || p.favorite))
    .filter((p) => !q || normalize([p.title, p.description, p.author, p.authorHandle, p.notes, p.sharedText, p.tags.join(' ')].join(' ')).includes(q))
    .sort((a, b) => b.createdAt - a.createdAt)
}
