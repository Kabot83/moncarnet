/**
 * Traitement d'un partage ou d'un lien collé : même chemin pour le partage Android (APK),
 * la cible de partage de la PWA et le bouton « Importer un lien ».
 *
 * L'enregistrement est local et immédiat ; l'enrichissement (oEmbed) part ensuite en
 * arrière-plan, sans jamais bloquer.
 */
import { parseSharedContent, parseSocialUrl, socialPlatformOf, sourceAppLabel } from './links'
import { enrichPost, savePostFromLink } from './posts'

export interface IncomingShare {
  text?: string | null
  subject?: string | null
  title?: string | null
  /** Application d'origine (Android), ex. « android-app://com.zhiliaoapp.musically ». */
  referrer?: string | null
}

export type ShareOutcome =
  | { kind: 'post'; postId: string; existing: boolean; from: string | null }
  | { kind: 'posts'; count: number; existing: number }
  | { kind: 'recipeUrl'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'invalid'; message: string }

export async function processShare(share: IncomingShare): Promise<ShareOutcome> {
  const content = parseSharedContent(share.text, share.subject, share.title)
  const links = content.urls.map((u) => ({ raw: u, link: parseSocialUrl(u) })).filter((x) => x.link)
  const from = sourceAppLabel(share.referrer)
  if (links.length) {
    const results = []
    for (const { raw, link } of links) results.push(await savePostFromLink(link!, { originalUrl: raw, sharedText: content.text, subject: content.subject }))
    // Informations publiques récupérées ensuite (jamais bloquant).
    for (const r of results) if (!r.existing || r.post.metaStatus === 'pending') void enrichPost(r.post.id).catch(() => undefined)
    if (results.length === 1) return { kind: 'post', postId: results[0].post.id, existing: results[0].existing, from }
    return { kind: 'posts', count: results.length, existing: results.filter((r) => r.existing).length }
  }
  const social = content.urls.find((u) => socialPlatformOf(u))
  if (social) {
    const name = socialPlatformOf(social) === 'tiktok' ? 'TikTok' : 'Instagram'
    return { kind: 'invalid', message: `Ce lien ${name} ne mène pas à une publication (profil, page d’accueil…). Partagez la vidéo ou la publication elle-même.` }
  }
  if (content.urls.length) return { kind: 'recipeUrl', url: content.urls[0] }
  const text = [content.subject, content.text].filter(Boolean).join('\n\n')
  if (text) return { kind: 'text', text }
  return { kind: 'invalid', message: 'Le partage ne contenait ni lien ni texte.' }
}

/** Écran à ouvrir après un partage. */
export function routeForShare(o: ShareOutcome): string {
  switch (o.kind) {
    case 'post':
      return `/a-essayer/${o.postId}?partage=${o.existing ? 'deja' : 'nouveau'}${o.from ? `&depuis=${encodeURIComponent(o.from)}` : ''}`
    case 'posts':
      return `/a-essayer?partage=${o.count}`
    case 'recipeUrl':
      return `/importer/lien?url=${encodeURIComponent(o.url)}`
    case 'text':
      return `/importer/texte?text=${encodeURIComponent(o.text.slice(0, 6000))}`
    case 'invalid':
      return `/a-essayer?erreur=${encodeURIComponent(o.message)}`
  }
}
