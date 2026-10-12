/**
 * Vidéos des publications : récupération automatique par le NAS (Carnet Media), copie sur le
 * téléphone pour la lecture hors ligne, import depuis la galerie en solution de secours.
 *
 * Partage → fiche enregistrée immédiatement (posts.ts) → demande au NAS → le NAS récupère
 * métadonnées et MP4 → le téléphone copie la vidéo dans son stockage privé. Rien ne bloque :
 * en cas d'échec, la fiche reste, avec la raison et le bouton « Importer un fichier vidéo ».
 */
import { db } from '@/db/db'
import type { SocialPost } from '@/models/types'
import { CarnetMedia, NasError, carnetMediaAvailable, deleteLocalFile, getNasConfig, localFileSrc, nasApi, nasDownload, pickVideoFile } from '@/platform/carnetMedia'
import { addPhotoFromFile } from '@/services/photos'
import { defaultTitle, titleFromText } from './links'

/** Fiche « média » renvoyée par le NAS. */
export interface RemoteMedia {
  key: string
  platform: string
  post_id: string
  url: string
  title: string | null
  caption: string | null
  creator: string | null
  handle: string | null
  video_status: 'pending' | 'downloading' | 'ready' | 'not_available' | 'failed'
  video_message: string
  video_bytes: number | null
  duration: number | null
  width: number | null
  height: number | null
  has_thumbnail: boolean
}

export interface RemoteJob {
  id: string
  status: 'queued' | 'metadata' | 'downloading' | 'verifying' | 'done' | 'failed'
  progress: number
  error: string | null
  message: string
  media: RemoteMedia | null
}

const POLL_MS = 2000
const MAX_WAIT_MS = 15 * 60 * 1000
const running = new Map<string, Promise<void>>()
/** Fichier en cours de transfert → publication (progression affichée sur la fiche). */
const transferring = new Map<string, string>()
let listening = false

function listenProgress() {
  if (listening || !carnetMediaAvailable) return
  listening = true
  void CarnetMedia.addListener('downloadProgress', ({ name, progress }) => {
    const postId = transferring.get(name)
    if (postId) void db.posts.update(postId, { mediaProgress: 0.8 + 0.2 * Math.min(1, progress) })
  }).catch(() => (listening = false))
}
let sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
/** Tests uniquement. */
export const __setSleep = (fn: typeof sleep) => (sleep = fn)

const fileBase = (post: Pick<SocialPost, 'platform' | 'postId' | 'id'>) => `${post.platform}-${(post.postId ?? post.id).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 110)

export async function nasReady(): Promise<boolean> {
  if (!carnetMediaAvailable) return false
  const cfg = await getNasConfig()
  return !!cfg.url && cfg.hasToken
}

async function patch(id: string, p: Partial<SocialPost>) {
  await db.posts.update(id, { ...p, updatedAt: Date.now() })
}

/** Métadonnées du NAS : complètent la fiche sans jamais écraser une correction manuelle. */
export function mergeRemoteMeta(post: SocialPost, m: RemoteMedia): Partial<SocialPost> {
  const keep = new Set(post.edited)
  const out: Partial<SocialPost> = {}
  if (m.caption && !keep.has('description') && !post.description.trim()) out.description = m.caption.slice(0, 5000)
  if (m.creator && !keep.has('author') && (!post.author || post.author.startsWith('@'))) out.author = m.creator.slice(0, 200)
  if (m.handle && !post.authorHandle) out.authorHandle = m.handle.slice(0, 100)
  const generic = !post.title || post.title.startsWith(defaultTitle(post.platform, post.kind))
  const title = m.title || titleFromText(m.caption ?? '')
  if (title && !keep.has('title') && generic) out.title = title.slice(0, 300)
  return out
}

/** Lance (ou reprend) la récupération par le NAS. Sans effet si le service n'est pas configuré. */
export function startNasImport(postId: string, opts: { retry?: boolean } = {}): Promise<void> {
  const current = running.get(postId)
  if (current) return current
  const p = (async () => {
    if (!(await nasReady())) return
    const post = await db.posts.get(postId)
    if (!post || post.video) return
    try {
      let jobId = post.mediaJobId
      if (!jobId || opts.retry || post.mediaStatus === 'failed' || post.mediaStatus === 'unavailable') {
        await patch(postId, { mediaStatus: 'pending', mediaProgress: 0, mediaMessage: '' })
        const { status, data } = await nasApi<RemoteJob & { error?: string; message?: string }>('POST', '/v1/jobs', { url: post.originalUrl || post.url, retry: !!opts.retry })
        if (status === 422) {
          await patch(postId, { mediaStatus: 'unavailable', mediaMessage: data.message ?? 'Lien refusé par le service.' })
          return
        }
        if (status === 429) {
          await patch(postId, { mediaStatus: 'failed', mediaMessage: 'Trop de demandes envoyées au NAS : nouvel essai plus tard.' })
          return
        }
        jobId = data.id
        await patch(postId, { mediaJobId: jobId })
      }
      await followJob(postId, jobId)
    } catch (e) {
      const msg = e instanceof NasError ? e.message : 'Le NAS ne répond pas.'
      await patch(postId, { mediaStatus: 'failed', mediaMessage: msg })
    }
  })().finally(() => running.delete(postId))
  running.set(postId, p)
  return p
}

async function followJob(postId: string, jobId: string): Promise<void> {
  const started = Date.now()
  let job: RemoteJob
  for (;;) {
    const { status, data } = await nasApi<RemoteJob>('GET', `/v1/jobs/${encodeURIComponent(jobId)}`)
    if (status === 404) {
      await patch(postId, { mediaJobId: null, mediaStatus: 'failed', mediaMessage: 'Demande inconnue du NAS : relancez.' })
      return
    }
    job = data
    if (job.status === 'done' || job.status === 'failed') break
    // NAS : 0 → 80 % ; transfert vers le téléphone : 80 → 100 %.
    await patch(postId, { mediaStatus: job.status === 'downloading' || job.status === 'verifying' ? 'downloading' : 'pending', mediaProgress: Math.min(0.8, (job.progress || 0) * 0.8) })
    if (Date.now() - started > MAX_WAIT_MS) {
      await patch(postId, { mediaStatus: 'failed', mediaMessage: 'Le NAS met trop de temps : nouvel essai plus tard.' })
      return
    }
    await sleep(POLL_MS)
  }
  const m = job.media
  const post = await db.posts.get(postId)
  if (!post) return
  if (!m) {
    await patch(postId, { mediaStatus: 'unavailable', mediaMessage: job.message || 'Informations indisponibles.' })
    return
  }
  await patch(postId, mergeRemoteMeta(post, m))
  if (!post.thumbnailPhotoId && m.has_thumbnail) await copyThumbnail(postId, m)

  if (m.video_status !== 'ready') {
    const retryable = m.video_status === 'failed'
    await patch(postId, { mediaStatus: retryable ? 'failed' : 'unavailable', mediaProgress: 0, mediaMessage: m.video_message || job.message || 'Vidéo non disponible au téléchargement.' })
    return
  }
  await patch(postId, { mediaStatus: 'downloading', mediaProgress: 0.8 })
  const name = `${fileBase(post)}.mp4`
  listenProgress()
  transferring.set(name, postId)
  let saved
  try {
    saved = await nasDownload(`/v1/media/${m.platform}/${encodeURIComponent(m.post_id)}/video`, name)
  } finally {
    transferring.delete(name)
  }
  await patch(postId, {
    video: { name: saved.name, uri: saved.uri, bytes: saved.bytes, duration: m.duration, width: m.width, height: m.height, sha256: saved.sha256, source: 'nas', savedAt: Date.now() },
    mediaStatus: 'ready',
    mediaProgress: 1,
    mediaMessage: '',
  })
}

async function copyThumbnail(postId: string, m: RemoteMedia) {
  const post = await db.posts.get(postId)
  if (!post) return
  const name = `${fileBase(post)}.jpg`
  try {
    const f = await nasDownload(`/v1/media/${m.platform}/${encodeURIComponent(m.post_id)}/thumbnail`, name)
    const blob = await (await fetch(localFileSrc(f.uri))).blob()
    const photoId = await addPhotoFromFile(blob)
    const fresh = await db.posts.get(postId)
    if (fresh && !fresh.thumbnailPhotoId) await patch(postId, { thumbnailPhotoId: photoId })
  } catch {
    /* miniature facultative */
  } finally {
    await deleteLocalFile(name)
  }
}

/** Reprend les récupérations interrompues (fermeture de l'application, perte de réseau). */
export async function resumeNasImports(): Promise<void> {
  if (!(await nasReady())) return
  const todo = await db.posts.filter((p) => !p.video && (p.mediaStatus === 'pending' || p.mediaStatus === 'downloading')).toArray()
  for (const p of todo) void startNasImport(p.id)
}

/** Solution de secours : vidéo choisie dans la galerie (téléchargée depuis TikTok / Instagram). */
export async function importVideoFromGallery(postId: string): Promise<'ok' | 'cancelled'> {
  const post = await db.posts.get(postId)
  if (!post) return 'cancelled'
  const name = `${fileBase(post)}-galerie.mp4`
  let picked
  try {
    picked = await pickVideoFile(name)
  } catch (e) {
    if (e instanceof NasError && e.code === 'cancelled') return 'cancelled'
    throw e
  }
  if (post.video && post.video.name !== picked.name) await deleteLocalFile(post.video.name)
  const p: Partial<SocialPost> = {
    video: { name: picked.name, uri: picked.uri, bytes: picked.bytes, duration: picked.duration, width: picked.width, height: picked.height, sha256: picked.sha256, source: 'gallery', savedAt: Date.now() },
    mediaStatus: 'ready',
    mediaProgress: 1,
    mediaMessage: '',
  }
  if (!post.thumbnailPhotoId && picked.thumbnailUri) {
    try {
      p.thumbnailPhotoId = await addPhotoFromFile(await (await fetch(localFileSrc(picked.thumbnailUri))).blob())
    } catch {
      /* miniature facultative */
    }
  }
  if (picked.thumbnailUri) await deleteLocalFile(picked.thumbnailUri.split('/').pop() ?? '')
  await patch(postId, p)
  return 'ok'
}

/** Supprime la vidéo locale d'une publication (fiche conservée). */
export async function removeLocalVideo(post: SocialPost): Promise<void> {
  if (post.video) await deleteLocalFile(post.video.name)
  await patch(post.id, { video: null, mediaStatus: 'none', mediaJobId: null, mediaProgress: 0, mediaMessage: '' })
}

export const videoSrc = (post: SocialPost) => (post.video ? localFileSrc(post.video.uri) : null)
