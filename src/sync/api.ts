/**
 * Client HTTP de Carnet Sync. L'identité et les droits viennent uniquement de la session : le
 * téléphone ne désigne jamais un espace par son identifiant, seulement « personal » ou « family ».
 *
 * Sur Android (étape C), `TokenSource` sera implémenté par le plugin natif : jetons chiffrés
 * par l'Android Keystore, jamais dans IndexedDB ni dans les sauvegardes.
 */

export type SyncCollection = 'recipes' | 'photos' | 'journal' | 'collections' | 'shopping' | 'posts' | 'foods' | 'foodMemory'
export type Space = 'personal' | 'family'
type Row = Record<string, unknown>

export interface Person {
  login: string
  name: string
}

/** Informations de la famille sur une recette commune (fixées par le serveur). */
export interface FamilyInfo {
  createdBy: Person | null
  createdAt: number
  updatedBy: Person | null
  updatedAt: number
  lockedBy: Person | null
  openConflicts: number
}

export interface Me {
  id: string
  login: string
  display_name: string
  family: { name: string; role: 'admin' | 'member'; members: { login: string; display_name: string; role: string }[] } | null
  /** Retiré de la famille : les recettes familiales doivent quitter cet appareil. */
  family_revoked: boolean
}

export interface PushChange {
  collection: SyncCollection | 'recipeMeta'
  id: string
  space?: Space
  base_rev: number
  deleted?: boolean
  data?: Row
  updated_at?: number
}

export interface ServerVersion {
  rev: number
  deleted: boolean
  data: Row | null
  space?: Space
  info?: FamilyInfo
}

type Base = { collection: SyncCollection | 'recipeMeta'; id: string; space: Space }
export type PushResult =
  | (Base & { status: 'ok'; rev: number })
  | (Base & { status: 'merged'; rev: number; data: Row; conflict: string | null; info: FamilyInfo })
  | (Base & { status: 'conflict'; server: ServerVersion })
  | (Base & { status: 'locked'; server: ServerVersion })
  | (Base & { status: 'wrong_space'; space_actual: Space })
  | (Base & { status: 'missing_blob'; missing: string[] })
  | (Base & { status: 'rejected'; error: string })

export interface ServerChange extends ServerVersion {
  collection: SyncCollection | 'recipeMeta'
  id: string
  trashed?: boolean
}

export interface TransferSummary {
  id: string
  kind: 'recipe' | 'post'
  title: string
  sender: { login: string; display_name: string }
  created_at: number
  expires_at: number
  has_cover: boolean
  /** Recette d'origine (serveur 0.2.1+) : reconnaît une nouvelle version d'une recette déjà reçue. */
  source_key?: string | null
}

export interface FamilyConflict {
  id: string
  recipeId: string
  createdAt: number
  by: Person
  items: { path: string; theirs: unknown; mine: unknown }[]
  mine: Row
}

export interface SyncApi {
  /** Compte de la session et sa famille (décidés par le serveur). */
  me(): Promise<Me>
  push(changes: PushChange[]): Promise<PushResult[]>
  changes(since: number, pageSize?: number, space?: Space): Promise<{ changes: ServerChange[]; cursor: number; more: boolean }>
  missingBlobs(hashes: string[], space?: Space): Promise<string[]>
  putBlob(sha: string, blob: Blob, mime: string, space?: Space): Promise<void>
  getBlob(sha: string): Promise<Blob>
  // Catalogue familial
  moveRecipe(id: string, to: Space, confirm: boolean): Promise<{ id: string; space: Space }>
  setLock(id: string, locked: boolean): Promise<ServerVersion>
  trash(): Promise<{ id: string; title: string; trashedAt: number; trashedBy: Person | null; purgeAt: number }[]>
  restoreFromTrash(id: string): Promise<{ id: string }>
  purge(id: string): Promise<void>
  history(id: string): Promise<{ rev: number; kind: string; at: number; by: Person | null }[]>
  revert(id: string, rev: number): Promise<{ rev: number }>
  familyConflicts(): Promise<FamilyConflict[]>
  resolveConflict(id: string, data: Row | null, baseRev: number | null): Promise<{ status: string }>
  // Envois à un autre compte
  lookupUser(login: string): Promise<{ login: string; display_name: string } | null>
  sendTransfer(recipient: string, kind: 'recipe' | 'post', id: string, includeTips: boolean): Promise<{ id: string }>
  inbox(): Promise<TransferSummary[]>
  /** `replace` : met à jour ma copie déjà reçue (`targetId`) ; sinon nouvelle recette. */
  acceptTransfer(id: string, opts?: { mode: 'new' | 'replace'; targetId?: string }): Promise<{ id: string; mode?: string }>
  transferCover(id: string): Promise<Blob | null>
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
  const enc = encodeURIComponent

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
    me: async () => {
      const r = await json<{ user: { id: string; login: string; display_name: string }; family: Me['family']; family_revoked: boolean }>('GET', '/v1/me')
      return { ...r.user, family: r.family, family_revoked: r.family_revoked }
    },
    push: async (changes) => (await json<{ results: PushResult[] }>('POST', '/v1/sync/push', { changes })).results,
    changes: (since, pageSize = 500, space) => json('GET', `/v1/sync/changes?since=${since}&page_size=${pageSize}${space ? `&space=${space}` : ''}`),
    missingBlobs: async (hashes, space = 'personal') => (await json<{ missing: string[] }>('POST', '/v1/blobs/missing', { hashes, space })).missing,
    putBlob: async (sha, blob, mime, space = 'personal') => {
      await call('PUT', `/v1/blobs/${sha}?space=${space}`, blob, mime)
    },
    getBlob: async (sha) => {
      const r = await call('GET', `/v1/blobs/${sha}`)
      if (r.status === 404) throw new SyncHttpError(404, 'not_found', 'Fichier introuvable sur le serveur.')
      return r.blob()
    },
    moveRecipe: (id, to, confirm) => json('POST', `/v1/recipes/${enc(id)}/move`, { to, confirm }),
    setLock: (id, locked) => json('POST', `/v1/family/recipes/${enc(id)}/lock`, { locked }),
    trash: () => json('GET', '/v1/family/trash'),
    restoreFromTrash: (id) => json('POST', `/v1/family/trash/${enc(id)}/restore`),
    purge: (id) => json('POST', `/v1/family/trash/${enc(id)}/purge`),
    history: (id) => json('GET', `/v1/family/recipes/${enc(id)}/history`),
    revert: (id, rev) => json('POST', `/v1/family/recipes/${enc(id)}/revert`, { rev }),
    familyConflicts: () => json('GET', '/v1/family/conflicts'),
    resolveConflict: (id, data, baseRev) => json('POST', `/v1/family/conflicts/${enc(id)}/resolve`, { data, base_rev: baseRev }),
    lookupUser: async (login) => {
      try {
        return await json('GET', `/v1/users/lookup?login=${enc(login)}`)
      } catch (e) {
        if (e instanceof SyncHttpError && e.status === 404) return null
        throw e
      }
    },
    sendTransfer: (recipient, kind, id, includeTips) => json('POST', '/v1/transfers', { recipient, kind, id, include_tips: includeTips }),
    inbox: () => json('GET', '/v1/transfers/inbox'),
    acceptTransfer: (id, opts) => json('POST', `/v1/transfers/${enc(id)}/accept`, opts ? { mode: opts.mode, target_id: opts.targetId } : undefined),
    transferCover: async (id) => {
      const r = await call('GET', `/v1/transfers/${enc(id)}/cover`)
      return r.status === 404 ? null : r.blob()
    },
    declineTransfer: (id) => json('POST', `/v1/transfers/${enc(id)}/decline`),
  }
}
