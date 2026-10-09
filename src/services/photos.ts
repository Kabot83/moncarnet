/**
 * Photos : compression, stockage (Blob dans IndexedDB) et nettoyage.
 *
 * Chaque photo est stockée deux fois : une version « pleine » (1600 px max)
 * et une miniature (480 px) pour les listes, ce qui garde le catalogue fluide
 * même avec plusieurs centaines de recettes.
 */
import { db } from '@/db/db'
import { newId } from '@/lib/id'
import type { Photo } from '@/models/types'

const FULL_MAX = 1600
const THUMB_MAX = 480
const QUALITY = 0.82

let webpSupport: boolean | null = null
function supportsWebp(): boolean {
  if (webpSupport != null) return webpSupport
  try {
    const c = document.createElement('canvas')
    c.width = c.height = 1
    webpSupport = c.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    webpSupport = false
  }
  return webpSupport
}

async function loadBitmap(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if ('createImageBitmap' in window) {
    try {
      // Respecte l'orientation EXIF des photos de téléphone.
      return await createImageBitmap(blob, { imageOrientation: 'from-image' })
    } catch {
      /* repli sur <img> ci-dessous */
    }
  }
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    return img
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function resize(source: ImageBitmap | HTMLImageElement, max: number): Promise<{ blob: Blob; w: number; h: number }> {
  const sw = 'naturalWidth' in source ? source.naturalWidth : source.width
  const sh = 'naturalHeight' in source ? source.naturalHeight : source.height
  const ratio = Math.min(1, max / Math.max(sw, sh))
  const w = Math.max(1, Math.round(sw * ratio))
  const h = Math.max(1, Math.round(sh * ratio))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas indisponible')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(source, 0, 0, w, h)
  const type = supportsWebp() ? 'image/webp' : 'image/jpeg'
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Compression impossible'))), type, QUALITY),
  )
  return { blob, w, h }
}

export class PhotoError extends Error {}

/** Compresse une image choisie par l'utilisateur. */
export async function compressImage(file: Blob, max = FULL_MAX): Promise<{ blob: Blob; thumb: Blob; w: number; h: number }> {
  if (!file.type.startsWith('image/')) throw new PhotoError("Ce fichier n'est pas une image.")
  if (file.size > 40 * 1024 * 1024) throw new PhotoError('Image trop lourde (40 Mo maximum).')
  let bmp: ImageBitmap | HTMLImageElement
  try {
    bmp = await loadBitmap(file)
  } catch {
    throw new PhotoError("Impossible de lire cette image. Essayez une photo JPEG ou PNG.")
  }
  const full = await resize(bmp, max)
  const thumb = await resize(bmp, THUMB_MAX)
  if ('close' in bmp) bmp.close()
  return { blob: full.blob, thumb: thumb.blob, w: full.w, h: full.h }
}

/** Compresse puis enregistre une photo ; renvoie son identifiant. */
export async function addPhotoFromFile(file: Blob): Promise<string> {
  const { blob, thumb, w, h } = await compressImage(file)
  return putPhoto({ blob, thumb, width: w, height: h })
}

export async function putPhoto(p: {
  blob: Blob
  thumb?: Blob
  width?: number
  height?: number
  isDemo?: boolean
  id?: string
}): Promise<string> {
  const id = p.id ?? newId('ph_')
  const photo: Photo = {
    id,
    blob: p.blob,
    thumb: p.thumb ?? p.blob,
    mime: p.blob.type || 'image/jpeg',
    width: p.width ?? 0,
    height: p.height ?? 0,
    size: p.blob.size + (p.thumb && p.thumb !== p.blob ? p.thumb.size : 0),
    createdAt: Date.now(),
    isDemo: p.isDemo ?? false,
  }
  await db.photos.put(photo)
  return id
}

/** Toutes les photos référencées quelque part dans le carnet. */
export async function referencedPhotoIds(): Promise<Set<string>> {
  const used = new Set<string>()
  await db.recipes.each((r) => {
    if (r.mainPhotoId) used.add(r.mainPhotoId)
    r.galleryPhotoIds.forEach((id) => used.add(id))
    r.steps.forEach((s) => s.photoId && used.add(s.photoId))
  })
  await db.journal.each((j) => j.photoId && used.add(j.photoId))
  await db.collections.each((c) => c.coverPhotoId && used.add(c.coverPhotoId))
  await db.drafts.each((d) => {
    const r = d.data
    if (r.mainPhotoId) used.add(r.mainPhotoId)
    r.galleryPhotoIds?.forEach((id) => used.add(id))
    r.steps?.forEach((s) => s.photoId && used.add(s.photoId))
  })
  return used
}

/**
 * Supprime les photos devenues inutiles. Une marge de sécurité (`graceMs`)
 * protège les photos venant d'être ajoutées et pas encore rattachées.
 */
export async function collectOrphanPhotos(graceMs = 10 * 60 * 1000): Promise<number> {
  const used = await referencedPhotoIds()
  const limit = Date.now() - graceMs
  const orphans = await db.photos
    .filter((p) => !used.has(p.id) && p.createdAt < limit)
    .primaryKeys()
  await db.photos.bulkDelete(orphans)
  return orphans.length
}

export async function photosSize(): Promise<{ count: number; bytes: number }> {
  let count = 0
  let bytes = 0
  await db.photos.each((p) => {
    count++
    bytes += p.size
  })
  return { count, bytes }
}

/** Lecture d'une image en base64 (pour l'envoyer à Gemini). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode(...buf.subarray(i, i + CHUNK))
  return btoa(bin)
}
