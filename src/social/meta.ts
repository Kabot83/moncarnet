/**
 * Informations publiques des publications, par les seules voies officielles :
 *
 * - TikTok : API oEmbed officielle (https://www.tiktok.com/oembed), sans clé ni compte.
 *   Fournit légende, auteur, miniature et identifiant de la vidéo. Ouverte aux applications
 *   web (CORS) : fonctionne dans la PWA comme dans l'APK.
 * - Instagram : l'oEmbed officiel (graph.facebook.com/instagram_oembed) ne fournit plus ni
 *   titre, ni légende, ni miniature sans compte développeur Meta. Il sert seulement à savoir
 *   si la publication est publique et intégrable. Aucune autre donnée n'est récupérée.
 *
 * Aucune page n'est « aspirée », aucune vidéo téléchargée, aucune restriction contournée.
 * Le HTML renvoyé par les oEmbed n'est jamais inséré dans l'application : seul le texte
 * brut d'un champ précis est éventuellement lu, après analyse inerte (DOMParser).
 */
import { isNative } from '@/platform/native'
import { type ParsedSocialLink, parseSocialUrl } from './links'

export type MetaErrorKind = 'offline' | 'unavailable' | 'unresolved' | 'network'

export class MetaError extends Error {
  constructor(
    public kind: MetaErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface PostMeta {
  /** Légende (TikTok) : texte intégral publié par l'auteur. */
  caption: string | null
  author: string | null
  authorHandle: string | null
  authorUrl: string | null
  thumbnailUrl: string | null
  /** Lien résolu (lien court → publication). */
  link: ParsedSocialLink
  /** Publication accessible mais sans métadonnées publiques (Instagram). */
  limited: boolean
}

const TIMEOUT = 12_000

async function getJson(url: string): Promise<{ status: number; json: unknown }> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new MetaError('offline', 'Pas de connexion : les informations seront récupérées plus tard.')
  let res: Response
  try {
    res = await fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT) })
  } catch {
    throw new MetaError('network', 'Service momentanément injoignable : nouvel essai plus tard.')
  }
  let json: unknown = null
  try {
    json = await res.json()
  } catch {
    /* réponse non JSON */
  }
  return { status: res.status, json }
}

const str = (v: unknown, max = 5000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

/**
 * Lien court (vm.tiktok.com, instagram.com/share/…) → lien de la publication.
 * Dans l'APK : simple suivi de la redirection publique, comme le ferait un navigateur.
 * Dans la PWA, les navigateurs l'interdisent (CORS) : on renonce proprement.
 */
export async function resolveShortLink(link: ParsedSocialLink): Promise<ParsedSocialLink | null> {
  if (!link.short) return link
  if (!isNative) return null
  try {
    const { CapacitorHttp } = await import('@capacitor/core')
    const res = await CapacitorHttp.get({ url: link.url, connectTimeout: 10_000, readTimeout: 10_000, headers: { Accept: 'text/html' } })
    const finalUrl = (res as { url?: string }).url
    const parsed = finalUrl ? parseSocialUrl(finalUrl) : null
    return parsed && !parsed.short ? parsed : null
  } catch {
    return null
  }
}

export async function fetchTikTokMeta(link: ParsedSocialLink): Promise<PostMeta> {
  // L'oEmbed accepte le lien complet ; un lien court est d'abord résolu si possible.
  const resolved = (await resolveShortLink(link)) ?? link
  const { status, json } = await getJson(`https://www.tiktok.com/oembed?url=${encodeURIComponent(resolved.url)}`)
  if (status >= 500) throw new MetaError('network', 'TikTok ne répond pas pour le moment : nouvel essai plus tard.')
  const o = (json ?? {}) as Record<string, unknown>
  if (status !== 200 || !str(o.embed_product_id) && !str(o.title) && !str(o.author_name)) {
    if (resolved.short) throw new MetaError('unresolved', 'Lien court : les informations de la vidéo n’ont pas pu être lues. Le lien est bien enregistré.')
    throw new MetaError('unavailable', 'Vidéo privée, supprimée ou introuvable : les informations ne sont pas accessibles.')
  }
  const id = str(o.embed_product_id, 25)
  const handle = str(o.author_unique_id, 100) ?? resolved.handle
  const finalLink =
    id && /^\d{8,25}$/.test(id)
      ? (parseSocialUrl(handle ? `https://www.tiktok.com/@${handle}/${resolved.kind === 'photo' ? 'photo' : 'video'}/${id}` : `https://www.tiktok.com/video/${id}`) ?? resolved)
      : resolved
  const thumb = str(o.thumbnail_url, 2000)
  return {
    caption: str(o.title),
    author: str(o.author_name, 200),
    authorHandle: handle,
    authorUrl: str(o.author_url, 500),
    thumbnailUrl: thumb && /^https:\/\//.test(thumb) ? thumb : null,
    link: finalLink,
    limited: false,
  }
}

/** Auteur indiqué dans le texte de l'oEmbed Instagram (« A post shared by … »), lu sans rien exécuter. */
export function instagramAuthorFromEmbed(html: string): string | null {
  if (typeof DOMParser === 'undefined' || !html) return null
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const p of Array.from(doc.querySelectorAll('p'))) {
    const t = (p.textContent ?? '').replace(/\s+/g, ' ').trim()
    const m = /(?:shared by|partagée? par)\s+(.+?)(?:\s*\(@([\w.]+)\))?$/i.exec(t)
    if (m) return (m[2] ? `@${m[2]}` : m[1]).slice(0, 200)
  }
  return null
}

export async function fetchInstagramMeta(link: ParsedSocialLink): Promise<PostMeta> {
  const resolved = (await resolveShortLink(link)) ?? link
  if (resolved.short) throw new MetaError('unresolved', 'Lien de partage Instagram : la publication sera accessible en ouvrant le lien.')
  const { status, json } = await getJson(`https://graph.facebook.com/v22.0/instagram_oembed?url=${encodeURIComponent(resolved.url)}&omitscript=true`)
  if (status >= 500) throw new MetaError('network', 'Instagram ne répond pas pour le moment : nouvel essai plus tard.')
  const o = (json ?? {}) as Record<string, unknown>
  if (status !== 200 || typeof o.html !== 'string') throw new MetaError('unavailable', 'Publication privée, supprimée ou non intégrable : seul le lien est conservé.')
  return { caption: null, author: instagramAuthorFromEmbed(o.html), authorHandle: resolved.handle, authorUrl: null, thumbnailUrl: null, link: resolved, limited: true }
}

export function fetchPostMeta(link: ParsedSocialLink): Promise<PostMeta> {
  return link.platform === 'tiktok' ? fetchTikTokMeta(link) : fetchInstagramMeta(link)
}
