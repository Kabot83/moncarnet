import { useEffect, useState } from 'react'
import { db } from '@/db/db'

/**
 * URL d'affichage d'une photo stockée dans IndexedDB. Les URL d'objets sont
 * mises en cache (LRU) pour éviter de relire les mêmes images en boucle.
 */
const MAX = 250
const cache = new Map<string, string>()

function remember(key: string, url: string) {
  cache.set(key, url)
  if (cache.size > MAX) {
    const oldest = cache.keys().next().value as string
    URL.revokeObjectURL(cache.get(oldest)!)
    cache.delete(oldest)
  }
}

export function forgetPhoto(id: string) {
  for (const k of [`${id}:full`, `${id}:thumb`]) {
    const u = cache.get(k)
    if (u) URL.revokeObjectURL(u)
    cache.delete(k)
  }
}

export async function photoUrl(id: string, variant: 'full' | 'thumb' = 'thumb'): Promise<string | null> {
  const key = `${id}:${variant}`
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const p = await db.photos.get(id)
  if (!p) return null
  const url = URL.createObjectURL(variant === 'thumb' ? p.thumb : p.blob)
  remember(key, url)
  return url
}

export function usePhotoUrl(id: string | null | undefined, variant: 'full' | 'thumb' = 'thumb'): string | null {
  const [url, setUrl] = useState<string | null>(() => (id ? (cache.get(`${id}:${variant}`) ?? null) : null))
  useEffect(() => {
    let alive = true
    if (!id) {
      setUrl(null)
      return
    }
    photoUrl(id, variant).then((u) => alive && setUrl(u))
    return () => {
      alive = false
    }
  }, [id, variant])
  return url
}
