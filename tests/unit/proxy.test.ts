import { afterEach, describe, expect, it, vi } from 'vitest'
import proxy, { type Env, checkTarget } from '../../proxy/src/index'

const env: Env = {
  GEMINI_API_KEY: 'vraie-cle-serveur',
  ACCESS_TOKEN: 'jeton-de-test',
  ALLOWED_ORIGINS: 'https://moi.github.io',
  DAILY_LIMIT: '2',
  RESPECT_ROBOTS: 'false',
}
const ORIGIN = { origin: 'https://moi.github.io' }

afterEach(() => vi.restoreAllMocks())

describe('proxy : relais Gemini', () => {
  it('refuse un jeton invalide sans appeler Google', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const res = await proxy.fetch(new Request('https://p.dev/v1beta/models', { headers: { ...ORIGIN, 'x-goog-api-key': 'mauvais' } }), env)
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  it('remplace le jeton par la vraie clé et filtre les routes', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"candidates":[]}', { status: 200 }))
    const ok = await proxy.fetch(
      new Request('https://p.dev/v1beta/models/gemini-3.7-flash:generateContent?key=volee', {
        method: 'POST',
        headers: { ...ORIGIN, 'x-goog-api-key': 'jeton-de-test', 'content-type': 'application/json' },
        body: '{}',
      }),
      { ...env, DAILY_LIMIT: '0' },
    )
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://moi.github.io')
    const [url, init] = spy.mock.calls[0] as [URL, RequestInit]
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent')
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('vraie-cle-serveur')

    for (const path of ['/v1beta/files', '/v1beta/models/gemini-x:streamGenerateContent', '/v1beta/models/../../etc:generateContent', '/v1beta/cachedContents']) {
      const r = await proxy.fetch(new Request(`https://p.dev${path}`, { method: 'POST', headers: { ...ORIGIN, 'x-goog-api-key': 'jeton-de-test' }, body: '{}' }), env)
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
    const notGemini = await proxy.fetch(
      new Request('https://p.dev/v1beta/models/imagen-4:generateContent', { method: 'POST', headers: { ...ORIGIN, 'x-goog-api-key': 'jeton-de-test' }, body: '{}' }),
      env,
    )
    expect(notGemini.status).toBe(400)
  })

  it('applique la limite quotidienne avec une erreur 429 au format Gemini', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }))
    const store = new Map<string, string>()
    const kvEnv: Env = { ...env, USAGE: { get: async (k) => store.get(k) ?? null, put: async (k, v) => void store.set(k, v) } }
    const call = () =>
      proxy.fetch(new Request('https://p.dev/v1beta/models/gemini-2.5-flash:generateContent', { method: 'POST', headers: { ...ORIGIN, 'x-goog-api-key': 'jeton-de-test' }, body: '{}' }), kvEnv)
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    const third = await call()
    expect(third.status).toBe(429)
    expect(((await third.json()) as { error: { status: string } }).error.status).toBe('RESOURCE_EXHAUSTED')
  })

  it('refuse les origines non autorisées', async () => {
    const res = await proxy.fetch(new Request('https://p.dev/v1beta/models', { headers: { origin: 'https://pirate.example', 'x-goog-api-key': 'jeton-de-test' } }), env)
    expect(res.status).toBe(403)
  })
})

describe('proxy : import par lien (SSRF)', () => {
  it.each([
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://2130706433/',
    'http://metadata.google.internal/',
    'http://intranet/',
    'https://site.fr:8443/',
    'file:///etc/passwd',
    'https://user:pw@site.fr/',
  ])('refuse %s', (u) => {
    expect(typeof checkTarget(u)).toBe('string')
  })

  it('accepte une page publique et revérifie les redirections', async () => {
    expect(checkTarget('https://www.exemple-cuisine.fr/recette')).toBeInstanceOf(URL)
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }))
    const res = await proxy.fetch(
      new Request('https://p.dev/fetch?url=' + encodeURIComponent('https://www.exemple-cuisine.fr/r'), { headers: { ...ORIGIN, authorization: 'Bearer jeton-de-test' } }),
      env,
    )
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/Redirection refusée/)
  })

  it('renvoie la page, limite le type de contenu', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>ok</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    const res = await proxy.fetch(new Request('https://p.dev/fetch?url=https%3A%2F%2Fa.fr%2Fr', { headers: { ...ORIGIN, authorization: 'Bearer jeton-de-test' } }), env)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>ok</html>')
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }))
    const pdf = await proxy.fetch(new Request('https://p.dev/fetch?url=https%3A%2F%2Fa.fr%2Fr.pdf', { headers: { ...ORIGIN, authorization: 'Bearer jeton-de-test' } }), env)
    expect(pdf.status).toBe(415)
  })

  it('ne contourne pas les refus des sites', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('interdit', { status: 403 }))
    const res = await proxy.fetch(new Request('https://p.dev/fetch?url=https%3A%2F%2Fa.fr%2Fpaywall', { headers: { ...ORIGIN, authorization: 'Bearer jeton-de-test' } }), env)
    expect(res.status).toBe(403)
  })

  it('respecte robots.txt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('User-agent: *\nDisallow: /recettes/', { status: 200 }))
    const res = await proxy.fetch(
      new Request('https://p.dev/fetch?url=https%3A%2F%2Fa.fr%2Frecettes%2Fx', { headers: { ...ORIGIN, authorization: 'Bearer jeton-de-test' } }),
      { ...env, RESPECT_ROBOTS: 'true' },
    )
    expect(res.status).toBe(451)
  })
})
