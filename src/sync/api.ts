/**
 * Client HTTP de Carnet Sync. L'identité vient uniquement du jeton de session (le serveur
 * n'accepte aucun identifiant de propriétaire envoyé par le téléphone).
 *
 * Sur Android (étape C), `TokenSource` sera implémenté par le plugin natif : jetons chiffrés
 * par l'Android Keystore, jamais dans IndexedDB ni dans les sauvegardes.
 */

export type SyncCollection = 'recipes' | 'photos' | 'journal' | 'collections' | 'shopping' | 'posts' | 'foods' | 'foodMemory'

export interface PushChange {
  collection: SyncCollection
  id: string
  base_rev: number
  deleted?: boolean
  data?: Record<string, unknown>
  updated_at?: number
}

export interface ServerVersion {
  rev: number
  deleted: boolean
  data: Record<string, unknown> | null
}

export type PushResult =
  | { collection: SyncCollection; id: string; status: 'ok'; rev: number }
  | { collection: SyncCollection; id: string; status: 'conflict'; server: ServerVersion }
  | { collection: SyncCollection; id: string; status: 'missing_blob'; missing: string[] }
  | { collection: SyncCollection; id: string; status: 'rejected'; error: string }

export interface ServerChange extends ServerVersion {
  collection: SyncCollection
  id: string
}

export interface TransferSummary {
  id: string
  kind: 'recipe' | 'post'
  title: string
  sender: { login: string; display_name: string }
  created_at: number
  expires_at: number
  has_cover: boolean
}

export interface SyncApi {
  /** Compte de la session (identité décidée par le serveur). */
  me(): Promise<{ id: string; login: string; display_name: string }>
  push(changes: PushChange[]): Promise<PushResult[]>
  changes(since: number, pageSize?: number): Promise<{ changes: ServerChange[]; cursor: number; more: boolean }>
  missingBlobs(hashes: string[]): Promise<string[]>
  putBlob(sha: string, blob: Blob, mime: string): Promise<void>
  getBlob(sha: string): Promise<Blob>
  lookupUser(login: string): Promise<{ login: string; display_name: string } | null>
  sendTransfer(recipient: string, kind: 'recipe' | 'post', id: string, includeTips: boolean): Promise<{ id: string }>
  inbox(): Promise<TransferSummary[]>
  acceptTransfer(id: string): Promise<{ id: string }>
  declineTransfer(id: string): Promise<void>
}

export interface TokenSource {
  /** Jeton d'accès courant (mca_…). */
  access(): Promise<string>
  /** Renouvelle la session (jeton mcr_… à usage unique) ; lève une erreur si la session est révoquée. */
  refresh(): Promise<string>
}

export class SyncHttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export function httpSyncApi(baseUrl: string, tokens: TokenSource, fetchImpl: typeof fetch = fetch): SyncApi {
  const base = baseUrl.replace(/\/+$/, '')

  async function call(method: string, path: string, body?: BodyInit, contentType?: string): Promise<Response> {
    let token = await tokens.access()
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
      if (contentType) headers['Content-Type'] = contentType
      const r = await fetchImpl(base + path, { method, headers, body })
      if (r.status === 401 && attempt === 0) {
        token = await tokens.refresh()
        continue
      }
      if (!r.ok && r.status !== 404) {
        const e = (await r.json().catch(() => ({}))) as { error?: string; message?: string }
        throw new SyncHttpError(r.status, e.error ?? 'http', e.message ?? `HTTP ${r.status}`)
      }
      return r
    }
  }
  const json = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await call(method, path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json')
    if (r.status === 404) throw new SyncHttpError(404, 'not_found', 'Introuvable.')
    return r.status === 204 ? (undefined as T) : ((await r.json()) as T)
  }

  return {
    me: async () => (await json<{ user: { id: string; login: string; display_name: string } }>('GET', '/v1/me')).user,
    push: async (changes) => (await json<{ results: PushResult[] }>('POST', '/v1/sync/push', { changes })).results,
    changes: (since, pageSize = 500) => json('GET', `/v1/sync/changes?since=${since}&page_size=${pageSize}`),
    missingBlobs: async (hashes) => (await json<{ missing: string[] }>('POST', '/v1/blobs/missing', { hashes })).missing,
    putBlob: async (sha, blob, mime) => {
      await call('PUT', `/v1/blobs/${sha}`, blob, mime)
    },
    getBlob: async (sha) => {
      const r = await call('GET', `/v1/blobs/${sha}`)
      if (r.status === 404) throw new SyncHttpError(404, 'not_found', 'Fichier introuvable sur le serveur.')
      return r.blob()
    },
    lookupUser: async (login) => {
      try {
        return await json('GET', `/v1/users/lookup?login=${encodeURIComponent(login)}`)
      } catch (e) {
        if (e instanceof SyncHttpError && e.status === 404) return null
        throw e
      }
    },
    sendTransfer: (recipient, kind, id, includeTips) => json('POST', '/v1/transfers', { recipient, kind, id, include_tips: includeTips }),
    inbox: () => json('GET', '/v1/transfers/inbox'),
    acceptTransfer: (id) => json('POST', `/v1/transfers/${encodeURIComponent(id)}/accept`),
    declineTransfer: (id) => json('POST', `/v1/transfers/${encodeURIComponent(id)}/decline`),
  }
}
