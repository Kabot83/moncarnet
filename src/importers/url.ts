/**
 * Import d'une recette depuis une URL.
 *
 * Les navigateurs bloquent la lecture des pages d'autres sites (CORS). Deux voies :
 *  1. Votre proxy Mon Carnet (/proxy), s'il est configuré : il récupère la page
 *     côté serveur, après contrôle de l'URL (pas d'adresse interne, taille et
 *     durée limitées). Il ne contourne aucune restriction d'accès : une page
 *     protégée (connexion, paywall, blocage des robots) reste inaccessible.
 *  2. Lecture directe, qui ne fonctionne que pour les rares sites autorisant CORS.
 * À défaut, l'utilisateur peut coller le texte de la recette (import par texte).
 */
import { getSecrets, getSettings } from '@/services/settings'
import { addPhotoFromFile } from '@/services/photos'
import { isNative, nativeGet } from '@/platform/native'
import { robotsAllows } from './robots'
import { type ExtractedRecipe, extractRecipeFromHtml, htmlToText, pageTitle } from './schemaOrg'

export class UrlImportError extends Error {
  constructor(
    public kind: 'invalid-url' | 'blocked' | 'not-found' | 'no-recipe' | 'offline' | 'too-large',
    message: string,
    /** Texte de la page, si disponible, pour proposer l'import par l'IA. */
    public pageText?: string,
  ) {
    super(message)
  }
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i

/** Contrôle de base de l'URL (le proxy refait ces contrôles côté serveur). */
export function validateRecipeUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new UrlImportError('invalid-url', 'Ce lien n’est pas une adresse web valide.')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UrlImportError('invalid-url', 'Seuls les liens http et https sont acceptés.')
  if (PRIVATE_HOST.test(url.hostname)) throw new UrlImportError('invalid-url', 'Les adresses locales ou internes ne sont pas acceptées.')
  if (url.username || url.password) throw new UrlImportError('invalid-url', 'Les liens contenant des identifiants ne sont pas acceptés.')
  return url
}

/** Extrait un lien d'un texte partagé (« Regarde cette recette https://… »). */
export function findUrl(text: string): string | null {
  return text.match(/https?:\/\/[^\s<>"']+/i)?.[0] ?? null
}

async function proxyConfig() {
  const [s, sec] = await Promise.all([getSettings(), getSecrets()])
  return s.proxyUrl && sec.proxyToken ? { base: s.proxyUrl.replace(/\/+$/, ''), token: sec.proxyToken } : null
}

function checkStatus(status: number) {
  if (status === 404) throw new UrlImportError('not-found', 'Page introuvable (erreur 404).')
  if (status === 413) throw new UrlImportError('too-large', 'Cette page est trop volumineuse.')
  if (status === 401 || status === 403 || status === 451)
    throw new UrlImportError('blocked', 'Ce site refuse l’accès automatique à cette page. Copiez le texte de la recette et utilisez l’import par texte.')
  if (status < 200 || status >= 300) throw new UrlImportError('blocked', `Le site a répondu avec une erreur (${status}).`)
}

/** Android : requête native (pas de restriction CORS), robots.txt respecté. */
async function fetchHtmlNative(url: URL): Promise<string> {
  try {
    const robots = await nativeGet(`${url.origin}/robots.txt`, 'text')
    if (robots.status === 200 && robots.text && !robotsAllows(robots.text, url.pathname))
      throw new UrlImportError('blocked', 'Ce site n’autorise pas la récupération automatique de cette page. Copiez le texte de la recette et utilisez l’import par texte.')
  } catch (e) {
    if (e instanceof UrlImportError) throw e
    // robots.txt inaccessible : comme un navigateur, on poursuit.
  }
  let res
  try {
    res = await nativeGet(url.href, 'text')
  } catch {
    throw new UrlImportError('blocked', 'Impossible de joindre ce site. Vérifiez le lien et votre connexion.')
  }
  checkStatus(res.status)
  if (res.contentType && !/html|xml/i.test(res.contentType)) throw new UrlImportError('no-recipe', 'Ce lien ne mène pas à une page web.')
  if ((res.text?.length ?? 0) > 3 * 1024 * 1024) throw new UrlImportError('too-large', 'Cette page est trop volumineuse.')
  return res.text ?? ''
}

async function fetchHtml(url: URL): Promise<string> {
  if (!navigator.onLine) throw new UrlImportError('offline', 'Vous êtes hors ligne : l’import par lien nécessite une connexion.')
  if (isNative) return fetchHtmlNative(url)
  const proxy = await proxyConfig()
  let res: Response
  try {
    res = proxy
      ? await fetch(`${proxy.base}/fetch?url=${encodeURIComponent(url.href)}`, {
          headers: { Authorization: `Bearer ${proxy.token}` },
          signal: AbortSignal.timeout(20_000),
        })
      : await fetch(url.href, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new UrlImportError(
      'blocked',
      proxy
        ? 'Le proxy n’a pas pu récupérer cette page.'
        : 'Ce site ne permet pas la lecture directe depuis une application web (restriction CORS). Configurez votre proxy Mon Carnet dans les réglages, utilisez l’application Android, ou collez le texte de la recette.',
    )
  }
  checkStatus(res.status)
  return res.text()
}

export async function importFromUrl(raw: string): Promise<ExtractedRecipe> {
  const url = validateRecipeUrl(raw)
  const html = await fetchHtml(url)
  const extracted = extractRecipeFromHtml(html, url.href)
  if (!extracted || !extracted.recipe.ingredients.length) {
    const text = htmlToText(html).slice(0, 20000)
    throw new UrlImportError(
      'no-recipe',
      `Aucune donnée de recette structurée n’a été trouvée sur « ${pageTitle(html) || url.hostname} ».`,
      text.length > 100 ? text : undefined,
    )
  }
  return extracted
}

/** Télécharge et enregistre la photo principale, si le site le permet. */
export async function importImage(imageUrl: string): Promise<string | null> {
  try {
    const url = validateRecipeUrl(imageUrl)
    if (isNative) {
      const res = await nativeGet(url.href, 'blob')
      if (res.status !== 200 || !res.base64 || !/^image\//.test(res.contentType)) return null
      const bin = atob(res.base64)
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
      return await addPhotoFromFile(new Blob([bytes], { type: res.contentType.split(';')[0] }))
    }
    const proxy = await proxyConfig()
    const res = proxy
      ? await fetch(`${proxy.base}/image?url=${encodeURIComponent(url.href)}`, {
          headers: { Authorization: `Bearer ${proxy.token}` },
          signal: AbortSignal.timeout(20_000),
        })
      : await fetch(url.href, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.type.startsWith('image/')) return null
    return await addPhotoFromFile(blob)
  } catch {
    return null
  }
}
