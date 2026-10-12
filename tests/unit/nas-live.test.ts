/**
 * Test RÉEL (désactivé par défaut) : l'orchestration de l'application face à un vrai service
 * Carnet Media, avec de vraies publications. Seul le plugin natif est remplacé par des requêtes
 * HTTPS équivalentes (même chemins, même jeton, même vérification du certificat).
 *
 *   NODE_EXTRA_CA_CERTS=<cert.pem> LIVE_NAS_URL=https://127.0.0.1:8443 LIVE_NAS_TOKEN=mc_… \
 *   LIVE_NAS_DIR=<dossier> npx vitest run tests/unit/nas-live.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'

const URL_ = process.env.LIVE_NAS_URL
const TOKEN = process.env.LIVE_NAS_TOKEN
const DIR = process.env.LIVE_NAS_DIR ?? '.'

vi.mock('@/platform/carnetMedia', () => {
  class NasError extends Error {
    constructor(
      public code: string,
      message: string,
    ) {
      super(message)
    }
  }
  const headers = () => ({ Authorization: `Bearer ${process.env.LIVE_NAS_TOKEN}`, 'Content-Type': 'application/json' })
  return {
    NasError,
    carnetMediaAvailable: true,
    CarnetMedia: { addListener: async () => ({ remove: async () => undefined }) },
    getNasConfig: async () => ({ url: process.env.LIVE_NAS_URL, hasToken: !!process.env.LIVE_NAS_TOKEN }),
    nasApi: async (method: string, path: string, body?: unknown) => {
      const r = await fetch(process.env.LIVE_NAS_URL + path, { method, headers: headers(), body: body === undefined ? undefined : JSON.stringify(body) })
      if (r.status === 401) throw new NasError('unauthorized', 'jeton refusé')
      return { status: r.status, data: await r.json() }
    },
    nasDownload: async (path: string, name: string) => {
      const r = await fetch(process.env.LIVE_NAS_URL + path, { headers: headers() })
      if (r.status !== 200) throw new NasError('http', `HTTP ${r.status}`)
      const buf = Buffer.from(await r.arrayBuffer())
      const file = `${process.env.LIVE_NAS_DIR ?? '.'}/${name}`
      writeFileSync(file, buf)
      return { uri: `file:///${file}`, name, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') }
    },
    pickVideoFile: async () => {
      throw new NasError('cancelled', 'non utilisé')
    },
    deleteLocalFile: async () => undefined,
    // Dans l'application : adresse servie par la WebView. Ici : contenu du fichier (data:).
    localFileSrc: (u: string) => `data:image/jpeg;base64,${readFileSync(u.replace(/^file:\/\/\//, '')).toString('base64')}`,
  }
})
vi.mock('@/services/photos', async (orig) => ({ ...(await orig<typeof import('@/services/photos')>()), addPhotoFromFile: async () => 'ph_live' }))

import { db } from '@/db/db'
import { processShare } from '@/social/share'
import { startNasImport } from '@/social/nasMedia'

describe.skipIf(!URL_ || !TOKEN)('Carnet Media réel', () => {
  it.each([
    ['Instagram', 'https://www.instagram.com/reel/DMmxU4bKcsR/?igsh=reel'],
    ['TikTok', 'https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1'],
  ])('%s : partage → NAS → vidéo vérifiée copiée « sur le téléphone »', async (_, url) => {
    const o = await processShare({ text: url, referrer: 'android-app://com.instagram.android' })
    const id = (o as { postId: string }).postId
    await startNasImport(id)
    const p = (await db.posts.get(id))!
    console.log(JSON.stringify({ titre: p.title, auteur: p.author, legende: p.description.slice(0, 60), statut: p.mediaStatus, video: p.video && { name: p.video.name, Mo: +(p.video.bytes / 1_048_576).toFixed(1), duree: p.video.duration } }))
    expect(p.mediaStatus).toBe('ready')
    expect(p.video!.bytes).toBeGreaterThan(100_000)
    expect(p.video!.sha256).toHaveLength(64)
    expect(p.thumbnailPhotoId).toBe('ph_live')
    expect(p.title).not.toMatch(/^Video by|^Vidéo (TikTok|Instagram)/)
  }, 180_000)

  it('lien refusé par le service : fiche conservée, statut « non disponible »', async () => {
    const o = await processShare({ text: 'https://www.instagram.com/p/CUbHfhpswxt/' })
    const id = (o as { postId: string }).postId
    await startNasImport(id)
    expect(await db.posts.get(id)).toMatchObject({ mediaStatus: 'unavailable', video: null })
  }, 120_000)
})

void DIR
