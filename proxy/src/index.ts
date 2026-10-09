/**
 * Proxy Mon Carnet — Cloudflare Worker.
 *
 * Rôles :
 *  1. Relayer les appels à l'API Gemini en gardant la clé côté serveur.
 *     L'application envoie son JETON D'ACCÈS dans l'en-tête `x-goog-api-key`
 *     (c'est ainsi que le SDK officiel transmet la clé) ; le proxy vérifie ce
 *     jeton puis le remplace par la vraie clé, qu'il est seul à connaître.
 *  2. Récupérer une page de recette (import par lien) ou son image, avec
 *     contrôle strict des URL (pas d'adresse interne, ports standard, taille
 *     et durée limitées, redirections revérifiées). Le proxy ne contourne
 *     aucune restriction : les codes d'erreur des sites sont renvoyés tels quels
 *     et robots.txt est respecté.
 *
 * Garde-fous : liste blanche de routes et de modèles, taille de requête
 * limitée, limite quotidienne d'appels Gemini, aucune nouvelle tentative.
 *
 * Secrets (wrangler secret put) : GEMINI_API_KEY, ACCESS_TOKEN.
 * Variables (wrangler.toml) : ALLOWED_ORIGINS, DAILY_LIMIT, RESPECT_ROBOTS.
 * Liaison KV facultative : USAGE (compteur quotidien persistant).
 */

/** Sous-ensemble de l'API KV de Cloudflare utilisé ici. */
interface KVLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export interface Env {
  GEMINI_API_KEY: string
  ACCESS_TOKEN: string
  ALLOWED_ORIGINS?: string
  DAILY_LIMIT?: string
  RESPECT_ROBOTS?: string
  USAGE?: KVLike
}

const GEMINI = 'https://generativelanguage.googleapis.com'
const MAX_BODY = 6 * 1024 * 1024
const MAX_PAGE = 3 * 1024 * 1024
const MAX_IMAGE = 8 * 1024 * 1024
const UA = 'MonCarnet/1.0 (import de recette a usage personnel)'

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

/** Erreur au format de l'API Gemini, pour que le SDK la comprenne. */
const geminiError = (status: number, message: string, statusText = 'FAILED_PRECONDITION') => json(status, { error: { code: status, message, status: statusText } })

/** Comparaison en temps constant (évite les attaques temporelles sur le jeton). */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? ''
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!origin || !allowed.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-goog-api-key, x-goog-api-client, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

function withCors(res: Response, cors: Record<string, string>): Response {
  const r = new Response(res.body, res)
  for (const [k, v] of Object.entries(cors)) r.headers.set(k, v)
  r.headers.set('x-content-type-options', 'nosniff')
  r.headers.set('cache-control', 'no-store')
  return r
}

// ---------------------------------------------------------------------------
// Limite quotidienne
// ---------------------------------------------------------------------------

const memoryCounter = new Map<string, number>()

async function takeQuota(env: Env): Promise<boolean> {
  const limit = Number(env.DAILY_LIMIT ?? '200')
  if (!(limit > 0)) return true
  const day = new Date().toISOString().slice(0, 10)
  const key = `calls:${day}`
  if (env.USAGE) {
    const n = Number((await env.USAGE.get(key)) ?? '0')
    if (n >= limit) return false
    await env.USAGE.put(key, String(n + 1), { expirationTtl: 3 * 86400 })
    return true
  }
  // Sans KV : compteur par instance, indicatif seulement.
  const n = memoryCounter.get(key) ?? 0
  if (n >= limit) return false
  memoryCounter.set(key, n + 1)
  return true
}

// ---------------------------------------------------------------------------
// Relais Gemini
// ---------------------------------------------------------------------------

const MODEL_RE = /^gemini-[a-z0-9.-]{1,60}$/

async function handleGemini(req: Request, url: URL, env: Env): Promise<Response> {
  const token = req.headers.get('x-goog-api-key') ?? ''
  if (!env.ACCESS_TOKEN || !safeEqual(token, env.ACCESS_TOKEN)) return geminiError(401, 'Jeton d’accès invalide.', 'UNAUTHENTICATED')

  const path = url.pathname
  const isList = req.method === 'GET' && /^\/v1beta\/models\/?$/.test(path)
  const gen = path.match(/^\/v1beta\/models\/([^/:]+):generateContent$/)
  if (!isList && !(req.method === 'POST' && gen)) return geminiError(404, 'Route non autorisée par le proxy.', 'NOT_FOUND')
  if (gen && !MODEL_RE.test(gen[1])) return geminiError(400, 'Modèle non autorisé par le proxy.', 'INVALID_ARGUMENT')

  let body: ArrayBuffer | undefined
  if (gen) {
    const len = Number(req.headers.get('content-length') ?? '0')
    if (len > MAX_BODY) return geminiError(413, 'Requête trop volumineuse.', 'INVALID_ARGUMENT')
    body = await req.arrayBuffer()
    if (body.byteLength > MAX_BODY) return geminiError(413, 'Requête trop volumineuse.', 'INVALID_ARGUMENT')
    if (!(await takeQuota(env))) return geminiError(429, 'Limite quotidienne du proxy atteinte.', 'RESOURCE_EXHAUSTED')
  }

  // On ne transmet que les paramètres utiles (jamais de « key » venant du client).
  const upstream = new URL(GEMINI + path)
  if (isList) {
    const pageSize = url.searchParams.get('pageSize')
    const pageToken = url.searchParams.get('pageToken')
    if (pageSize) upstream.searchParams.set('pageSize', String(Math.min(1000, Number(pageSize) || 50)))
    if (pageToken) upstream.searchParams.set('pageToken', pageToken.slice(0, 500))
  }
  const res = await fetch(upstream, {
    method: req.method,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body,
  })
  // Réponse relayée telle quelle (y compris les 429 du niveau gratuit), sans nouvelle tentative.
  return new Response(res.body, { status: res.status, headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' } })
}

// ---------------------------------------------------------------------------
// Récupération de pages et d'images (import par lien)
// ---------------------------------------------------------------------------

/** Refuse toute cible interne ou exotique (protection SSRF). */
export function checkTarget(raw: string): URL | string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'URL invalide.'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'Protocole non autorisé.'
  if (u.username || u.password) return 'Identifiants interdits dans l’URL.'
  if (u.port && u.port !== '80' && u.port !== '443') return 'Port non autorisé.'
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!h.includes('.') || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h)) return 'Hôte non autorisé.'
  if (h.startsWith('[') || /^[0-9a-f:]+$/.test(h)) return 'Adresses IP non autorisées.'
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || /^0x|^\d+$/.test(h)) return 'Adresses IP non autorisées.'
  if (/(^|\.)(metadata\.google\.internal|169\.254\.169\.254)$/.test(h)) return 'Hôte non autorisé.'
  return u
}

async function robotsAllows(u: URL): Promise<boolean> {
  try {
    const res = await fetch(`${u.origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(4000), redirect: 'follow' })
    if (!res.ok) return true
    const text = (await res.text()).slice(0, 200_000)
    let applies = false
    const disallow: string[] = []
    for (const line of text.split(/\r?\n/)) {
      const [k, ...rest] = line.replace(/#.*/, '').split(':')
      const v = rest.join(':').trim()
      const key = k.trim().toLowerCase()
      if (key === 'user-agent') applies = v === '*' || /moncarnet/i.test(v)
      else if (applies && key === 'disallow' && v) disallow.push(v)
    }
    return !disallow.some((p) => u.pathname.startsWith(p.replace(/\*.*$/, '')))
  } catch {
    return true
  }
}

/** Suit au plus 3 redirections en revérifiant chaque destination. */
async function safeFetch(target: URL, accept: string): Promise<Response | string> {
  let current = target
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(current, {
      headers: { 'user-agent': UA, accept, 'accept-language': 'fr-FR,fr;q=0.9' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      const next = checkTarget(new URL(res.headers.get('location')!, current).href)
      if (typeof next === 'string') return `Redirection refusée : ${next}`
      current = next
      continue
    }
    return res
  }
  return 'Trop de redirections.'
}

async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.byteLength
  }
  return out
}

async function handleFetch(req: Request, url: URL, env: Env, kind: 'page' | 'image'): Promise<Response> {
  const auth = req.headers.get('authorization') ?? ''
  if (!env.ACCESS_TOKEN || !safeEqual(auth.replace(/^Bearer\s+/i, ''), env.ACCESS_TOKEN)) return json(401, { error: 'Jeton d’accès invalide.' })
  if (req.method !== 'GET') return json(405, { error: 'Méthode non autorisée.' })
  const target = checkTarget(url.searchParams.get('url') ?? '')
  if (typeof target === 'string') return json(400, { error: target })
  if (kind === 'page' && env.RESPECT_ROBOTS !== 'false' && !(await robotsAllows(target)))
    return json(451, { error: 'Ce site n’autorise pas la récupération automatique de cette page.' })

  let res: Response | string
  try {
    res = await safeFetch(target, kind === 'page' ? 'text/html,application/xhtml+xml' : 'image/avif,image/webp,image/jpeg,image/png,image/*')
  } catch {
    return json(504, { error: 'Le site ne répond pas.' })
  }
  if (typeof res === 'string') return json(400, { error: res })
  if (!res.ok) return json(res.status === 404 ? 404 : res.status === 401 || res.status === 403 ? 403 : 502, { error: `Le site a répondu ${res.status}.` })

  const type = (res.headers.get('content-type') ?? '').toLowerCase()
  if (kind === 'page' && !/text\/html|application\/xhtml\+xml/.test(type)) return json(415, { error: 'Ce lien ne mène pas à une page web.' })
  if (kind === 'image' && !/^image\/(jpeg|png|webp|avif|gif)/.test(type)) return json(415, { error: 'Ce lien ne mène pas à une image.' })
  const bytes = await readCapped(res, kind === 'page' ? MAX_PAGE : MAX_IMAGE)
  if (!bytes) return json(413, { error: 'Contenu trop volumineux.' })
  return new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': kind === 'page' ? 'text/html; charset=utf-8' : type } })
}

// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(req, env)
    if (req.method === 'OPTIONS') return new Response(null, { status: cors['access-control-allow-origin'] ? 204 : 403, headers: cors })
    // Requêtes d'un navigateur depuis une origine non autorisée : refusées.
    if (req.headers.get('origin') && !cors['access-control-allow-origin']) return json(403, { error: 'Origine non autorisée.' })
    const url = new URL(req.url)
    let res: Response
    try {
      if (url.pathname.startsWith('/v1beta/')) res = await handleGemini(req, url, env)
      else if (url.pathname === '/fetch') res = await handleFetch(req, url, env, 'page')
      else if (url.pathname === '/image') res = await handleFetch(req, url, env, 'image')
      else if (url.pathname === '/') res = json(200, { service: 'Mon Carnet proxy', ok: true })
      else res = json(404, { error: 'Introuvable.' })
    } catch {
      res = json(500, { error: 'Erreur interne du proxy.' })
    }
    return withCors(res, cors)
  },
}
