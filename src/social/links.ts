/**
 * Liens TikTok et Instagram : reconnaissance, nettoyage, clé d'unicité.
 * Module pur (aucun accès réseau) : testé sur les formats réels.
 *
 * Nettoyage : seuls le domaine et le chemin identifient une publication ; les paramètres
 * (« ?is_from_webapp=1&sender_device=pc », « ?igsh=… », « utm_* ») ne servent qu'au suivi
 * et sont retirés. L'identifiant de la publication n'est jamais modifié.
 */
import type { Platform, SocialPost } from '@/models/types'

export interface ParsedSocialLink {
  platform: Platform
  kind: SocialPost['kind']
  /** Identifiant de la publication, si présent dans le lien. */
  postId: string | null
  /** Lien court (vm.tiktok.com, /share/…) : l'identifiant n'est connu qu'après résolution. */
  short: boolean
  /** Lien nettoyé, canonique quand c'est possible. */
  url: string
  /** Pseudo de l'auteur présent dans le lien (« @user » TikTok), sans « @ ». */
  handle: string | null
  dedupeKey: string
}

const TIKTOK_HOST = /^(?:(?:www|m|vm|vt)\.)?tiktok\.com$/i
const INSTAGRAM_HOST = /^(?:(?:www|m)\.)?(?:instagram\.com|instagr\.am)$/i
const IG_CODE = '[A-Za-z0-9_-]{5,64}'

export const PLATFORM_LABEL: Record<Platform, string> = { tiktok: 'TikTok', instagram: 'Instagram' }

/** Ajoute « https:// » aux liens sans protocole (« vm.tiktok.com/ZM… »). */
function toUrl(raw: string): URL | null {
  const s = raw.trim()
  if (!s) return null
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
}

export function parseTikTok(u: URL): ParsedSocialLink | null {
  const host = u.hostname.toLowerCase()
  if (!TIKTOK_HOST.test(host)) return null
  const path = u.pathname.replace(/\/+$/, '')
  const short = (code: string, base: string): ParsedSocialLink => {
    const url = `https://${base}/${code}/`
    return { platform: 'tiktok', kind: 'unknown', postId: null, short: true, url, handle: null, dedupeKey: `tiktok-short:${base}/${code}` }
  }
  // vm.tiktok.com/ZMabc123/ ou vt.tiktok.com/ZSabc/
  if (/^(vm|vt)\./i.test(host)) {
    const m = /^\/([A-Za-z0-9]+)$/.exec(path)
    return m ? short(m[1], host.toLowerCase()) : null
  }
  // www.tiktok.com/t/ZTabc/
  const t = /^\/t\/([A-Za-z0-9]+)$/.exec(path)
  if (t) return short(t[1], 'www.tiktok.com/t')

  const full = /^\/@([^/]+)\/(video|photo)\/(\d{8,25})$/.exec(path)
  if (full) {
    const [, rawHandle, kind, id] = full
    const handle = decodeURIComponent(rawHandle)
    return {
      platform: 'tiktok',
      kind: kind as 'video' | 'photo',
      postId: id,
      short: false,
      url: `https://www.tiktok.com/@${encodeURIComponent(handle)}/${kind}/${id}`,
      handle,
      dedupeKey: `tiktok:${id}`,
    }
  }
  // Variantes sans pseudo : m.tiktok.com/v/123.html, /video/123, lecteurs intégrés.
  const bare = /^\/(?:v\/(\d{8,25})\.html|video\/(\d{8,25})|embed(?:\/v2)?\/(\d{8,25})|player\/v1\/(\d{8,25}))$/.exec(path)
  if (bare) {
    const id = bare[1] ?? bare[2] ?? bare[3] ?? bare[4]
    return { platform: 'tiktok', kind: 'video', postId: id, short: false, url: `https://www.tiktok.com/video/${id}`, handle: null, dedupeKey: `tiktok:${id}` }
  }
  return null
}

export function parseInstagram(u: URL): ParsedSocialLink | null {
  if (!INSTAGRAM_HOST.test(u.hostname)) return null
  const path = u.pathname.replace(/\/+$/, '')
  // instagram.com/share/reel/BAxyz… (lien de partage, redirigé vers la publication)
  const share = new RegExp(`^/share/(?:(reel|p)/)?(${IG_CODE})$`).exec(path)
  if (share) {
    const kind = share[1] === 'reel' ? 'reel' : share[1] === 'p' ? 'post' : 'unknown'
    const url = `https://www.instagram.com/share/${share[1] ? `${share[1]}/` : ''}${share[2]}/`
    return { platform: 'instagram', kind, postId: null, short: true, url, handle: null, dedupeKey: `instagram-share:${share[2]}` }
  }
  // /p/CODE, /reel/CODE, /reels/CODE, /tv/CODE, éventuellement précédés du pseudo.
  const m = new RegExp(`^(?:/([A-Za-z0-9._]{1,30}))?/(p|reel|reels|tv)/(${IG_CODE})$`).exec(path)
  if (!m) return null
  const [, handle, type, code] = m
  const kind = type === 'p' ? 'post' : 'reel'
  return {
    platform: 'instagram',
    kind,
    postId: code,
    short: false,
    url: `https://www.instagram.com/${kind === 'post' ? 'p' : 'reel'}/${code}/`,
    handle: handle ?? null,
    dedupeKey: `instagram:${code}`,
  }
}

/** Reconnaît un lien de publication TikTok ou Instagram (null : autre site ou page qui n'est pas une publication). */
export function parseSocialUrl(raw: string): ParsedSocialLink | null {
  const u = toUrl(raw)
  if (!u || !/^https?:$/.test(u.protocol)) return null
  return parseTikTok(u) ?? parseInstagram(u)
}

/** Le lien vient-il de TikTok / Instagram (même si ce n'est pas une publication : profil, page d'accueil) ? */
export function socialPlatformOf(raw: string): Platform | null {
  const u = toUrl(raw)
  if (!u) return null
  if (TIKTOK_HOST.test(u.hostname)) return 'tiktok'
  if (INSTAGRAM_HOST.test(u.hostname)) return 'instagram'
  return null
}

// ---------------------------------------------------------------------------
// Contenu d'un partage Android (texte libre contenant un ou plusieurs liens)
// ---------------------------------------------------------------------------

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'«»]+|\b(?:(?:www|m|vm|vt)\.)?(?:tiktok\.com|instagram\.com|instagr\.am)\/[^\s<>"'«»]+/gi

export interface SharedContent {
  urls: string[]
  /** Texte sans les liens. */
  text: string
  /** Titre / sujet transmis par l'application (Chrome : titre de la page). */
  subject: string
}

/** Sépare les liens et le texte d'un partage. */
export function parseSharedContent(text: string | null | undefined, ...subjects: Array<string | null | undefined>): SharedContent {
  const raw = (text ?? '').replace(/\r/g, '')
  const urls: string[] = []
  const rest = raw.replace(URL_IN_TEXT, (m) => {
    const clean = m.replace(/[).,;:!?»]+$/, '')
    if (!urls.includes(clean)) urls.push(clean)
    return ' '
  })
  // Un lien peut aussi n'être transmis que dans le sujet.
  for (const s of subjects) for (const m of (s ?? '').match(URL_IN_TEXT) ?? []) if (!urls.includes(m)) urls.push(m.replace(/[).,;:!?»]+$/, ''))
  const subject = subjects.map((s) => (s ?? '').replace(URL_IN_TEXT, ' ').replace(/\s+/g, ' ').trim()).find(Boolean) ?? ''
  return {
    urls,
    text: rest
      .split('\n')
      .map((l) => l.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    subject,
  }
}

/** Formules génériques ajoutées par les applications au texte partagé (« Regarde cette vidéo TikTok »…). */
const GENERIC = [
  /^(?:regarde|découvre|check out|watch)\b.*\b(?:tiktok|instagram|vidéo|video|reel)\b.*$/i,
  /^.*\bon tiktok\b.*$/i,
  /^.*\bsur tiktok\b.*$/i,
  /^(?:tiktok|instagram)(?:\s*·.*)?$/i,
]

/** Titre lisible tiré d'un texte (légende, sujet) : sans mots-dièse ni formules génériques. */
export function titleFromText(text: string, max = 90): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !GENERIC.some((re) => re.test(l)))
  if (!line) return ''
  const clean = line
    .replace(/\s*\|\s*(?:TikTok|Instagram)\s*$/i, '')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/(^|\s)@[\w.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trim()}…`
}

export function defaultTitle(platform: Platform, kind: SocialPost['kind'], author = ''): string {
  const base = platform === 'tiktok' ? 'Vidéo TikTok' : kind === 'reel' ? 'Reel Instagram' : kind === 'post' ? 'Publication Instagram' : 'Instagram'
  return author ? `${base} de ${author}` : base
}

/** Application d'origine d'un partage Android (package de l'appelant). */
export function sourceAppLabel(referrer: string | null | undefined): string | null {
  const r = (referrer ?? '').toLowerCase()
  if (/musically|ugc\.trill|ugc\.aweme|tiktok/.test(r)) return 'TikTok'
  if (/instagram/.test(r)) return 'Instagram'
  if (/chrome/.test(r)) return 'Chrome'
  if (/sbrowser|samsung\.android\.app\.internet/.test(r)) return 'Samsung Internet'
  if (/firefox/.test(r)) return 'Firefox'
  return null
}

/** Lecteurs intégrés officiels. */
export function embedUrl(post: Pick<SocialPost, 'platform' | 'postId' | 'kind'>): string | null {
  if (!post.postId) return null
  if (post.platform === 'tiktok') return post.kind === 'photo' ? null : `https://www.tiktok.com/player/v1/${post.postId}?description=1&music_info=1&rel=0`
  return `https://www.instagram.com/${post.kind === 'post' ? 'p' : 'reel'}/${post.postId}/embed/captioned/`
}
