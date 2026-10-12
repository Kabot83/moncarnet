/**
 * Récupération des vidéos par le NAS : orchestration côté application (plugin natif SIMULÉ).
 * Le service lui-même est testé en réel dans nas/carnet-media (tests/live_smoke.py).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls: Array<{ method: string; path: string; body?: string }> = []
let jobs: Array<{ status: number; body: unknown }> = []
const files = new Set<string>()

vi.mock('@/platform/carnetMedia', () => {
  class NasError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message)
    }
  }
  return {
    NasError,
    carnetMediaAvailable: true,
    CarnetMedia: { addListener: vi.fn(async () => ({ remove: async () => undefined })) },
    getNasConfig: vi.fn(async () => ({ url: 'https://nas.example:8444', hasToken: true })),
    nasApi: vi.fn(async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body: body ? JSON.stringify(body) : undefined })
      const next = jobs.shift()
      if (!next) throw new Error('réponse non prévue')
      if (next.status === 401) throw new NasError('unauthorized', 'Le NAS refuse le jeton.')
      return { status: next.status, data: next.body }
    }),
    nasDownload: vi.fn(async (path: string, name: string) => {
      files.add(name)
      return { uri: `file:///data/user/0/fr.kabot83.moncarnet/files/carnet-videos/${name}`, name, bytes: 20_492_784, sha256: 'a'.repeat(64), path }
    }),
    pickVideoFile: vi.fn(async (name: string) => {
      files.add(name)
      return { uri: `file:///x/${name}`, name, bytes: 5_000_000, sha256: 'b'.repeat(64), duration: 42, width: 1080, height: 1920, displayName: 'snaptik.mp4' }
    }),
    deleteLocalFile: vi.fn(async (name: string) => void files.delete(name)),
    localFileSrc: (u: string) => u,
  }
})
vi.mock('@/services/photos', async (orig) => ({ ...(await orig<typeof import('@/services/photos')>()), addPhotoFromFile: vi.fn(async () => 'ph_nas') }))

import { db } from '@/db/db'
import { __setSleep, importVideoFromGallery, mergeRemoteMeta, startNasImport } from '@/social/nasMedia'
import { deletePost, savePostFromLink, updatePost } from '@/social/posts'
import { parseSocialUrl } from '@/social/links'

__setSleep(async () => undefined)
const media = (over: Record<string, unknown> = {}) => ({
  key: 'instagram:DMmxU4bKcsR', platform: 'instagram', post_id: 'DMmxU4bKcsR', url: 'https://www.instagram.com/reel/DMmxU4bKcsR/',
  title: 'Pâtes crémeuses au citron', caption: 'Pâtes crémeuses au citron\n200 g de pâtes\n#pasta', creator: 'Julie Cuisine', handle: 'julie.cuisine',
  video_status: 'ready', video_message: '', video_bytes: 20_492_784, duration: 58, width: 720, height: 1280, has_thumbnail: false, ...over,
})

async function newPost(url = 'https://www.instagram.com/reel/DMmxU4bKcsR/?igsh=x') {
  const link = parseSocialUrl(url)!
  return (await savePostFromLink(link, { originalUrl: url })).post
}

beforeEach(async () => {
  await db.posts.clear()
  calls.length = 0
  jobs = []
  files.clear()
})

describe('récupération automatique par le NAS', () => {
  it('partage → tâche NAS → vidéo copiée sur le téléphone, métadonnées complétées', async () => {
    const post = await newPost()
    jobs = [
      { status: 202, body: { id: 'job_1', status: 'queued', progress: 0, error: null, message: '', media: null } },
      { status: 200, body: { id: 'job_1', status: 'downloading', progress: 0.5, error: null, message: '', media: null } },
      { status: 200, body: { id: 'job_1', status: 'done', progress: 1, error: null, message: 'Vidéo enregistrée et vérifiée.', media: media() } },
    ]
    await startNasImport(post.id)
    expect(calls[0]).toEqual({ method: 'POST', path: '/v1/jobs', body: JSON.stringify({ url: 'https://www.instagram.com/reel/DMmxU4bKcsR/?igsh=x', retry: false }) })
    expect(calls[1].path).toBe('/v1/jobs/job_1')
    const p = (await db.posts.get(post.id))!
    expect(p.mediaStatus).toBe('ready')
    expect(p.video).toMatchObject({ name: 'instagram-DMmxU4bKcsR.mp4', bytes: 20_492_784, duration: 58, source: 'nas' })
    expect(p.title).toBe('Pâtes crémeuses au citron')
    expect(p.description).toContain('200 g de pâtes')
    expect(p.author).toBe('Julie Cuisine')
    expect(files.has('instagram-DMmxU4bKcsR.mp4')).toBe(true)
  })

  it('vidéo non disponible : fiche conservée, raison affichée, aucune vidéo copiée', async () => {
    const post = await newPost()
    jobs = [
      { status: 202, body: { id: 'job_2', status: 'queued', progress: 0, error: null, message: '', media: null } },
      { status: 200, body: { id: 'job_2', status: 'done', progress: 1, error: 'not_available', message: '…', media: media({ video_status: 'not_available', video_message: 'Aucune vidéo téléchargeable dans cette publication.' }) } },
    ]
    await startNasImport(post.id)
    const p = (await db.posts.get(post.id))!
    expect(p).toMatchObject({ mediaStatus: 'unavailable', mediaMessage: 'Aucune vidéo téléchargeable dans cette publication.', video: null })
    expect(p.description).toContain('200 g')
    expect(files.size).toBe(0)
  })

  it('jeton refusé : message clair, nouvel essai possible', async () => {
    const post = await newPost()
    jobs = [{ status: 401, body: {} }]
    await startNasImport(post.id)
    expect(await db.posts.get(post.id)).toMatchObject({ mediaStatus: 'failed', mediaMessage: 'Le NAS refuse le jeton.' })
  })

  it('les corrections manuelles ne sont jamais écrasées par le NAS', async () => {
    const post = await newPost()
    await updatePost(post.id, { title: 'Mes pâtes du jeudi', description: 'Ma version' })
    const p = (await db.posts.get(post.id))!
    expect(mergeRemoteMeta(p, media() as never)).toEqual({ author: 'Julie Cuisine', authorHandle: 'julie.cuisine' })
  })

  it('import depuis la galerie (secours) puis suppression de la fiche : fichier supprimé', async () => {
    const post = await newPost('https://www.tiktok.com/@chloezeitoun/video/7158142848670387462')
    expect(await importVideoFromGallery(post.id)).toBe('ok')
    const p = (await db.posts.get(post.id))!
    expect(p.video).toMatchObject({ name: 'tiktok-7158142848670387462-galerie.mp4', source: 'gallery', duration: 42 })
    expect(p.mediaStatus).toBe('ready')
    await deletePost(post.id)
    expect(files.size).toBe(0)
  })

  it('une vidéo déjà sur le téléphone n’est jamais redemandée', async () => {
    const post = await newPost()
    await db.posts.update(post.id, { video: { name: 'x.mp4', uri: 'file:///x.mp4', bytes: 1, duration: 1, width: 1, height: 1, sha256: '', source: 'nas', savedAt: 1 } })
    await startNasImport(post.id)
    expect(calls).toHaveLength(0)
  })
})
