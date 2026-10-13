/**
 * Pont vers le plugin natif CarnetSync (android/…/CarnetSyncPlugin.java).
 *
 * Le mot de passe n'est transmis qu'une fois, au plugin, pour ouvrir la session ; il n'est jamais
 * enregistré. Le jeton de renouvellement reste chiffré dans la partie native (Android Keystore) ;
 * l'interface ne reçoit que le jeton d'accès (1 h), gardé en mémoire uniquement.
 */
import { registerPlugin } from '@capacitor/core'
import { isNative } from './native'

export const DEFAULT_SYNC_URL = 'https://carnetmedia.synology.me:8445'

export interface SessionUser {
  id: string
  login: string
  display_name: string
}

export interface OpenedSession {
  accessToken: string
  /** Échéance du jeton d'accès (secondes depuis 1970). */
  expiresAt: number
  user: SessionUser
}

export type SessionErrorCode = 'bad_credentials' | 'too_many_attempts' | 'network' | 'session_revoked' | 'no_session' | 'invalid_url' | 'invalid' | 'http' | 'unavailable'

export class SessionError extends Error {
  constructor(
    public code: SessionErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Gestion de la session : native sur Android ; remplaçable dans les tests. */
export interface SessionBackend {
  available: boolean
  getSession(): Promise<{ configured: boolean; url: string; user: SessionUser | null }>
  login(url: string, login: string, password: string, device: string): Promise<OpenedSession>
  refresh(): Promise<OpenedSession>
  logout(accessToken: string | null): Promise<void>
}

interface CarnetSyncPlugin {
  login(o: { url: string; login: string; password: string; device: string }): Promise<OpenedSession>
  refresh(): Promise<OpenedSession>
  getSession(): Promise<{ configured: boolean; url: string; user: SessionUser | null }>
  logout(o: { accessToken?: string }): Promise<void>
}

const Plugin = registerPlugin<CarnetSyncPlugin>('CarnetSync')
const CODES: SessionErrorCode[] = ['bad_credentials', 'too_many_attempts', 'network', 'session_revoked', 'no_session', 'invalid_url', 'invalid', 'http']

function toSessionError(e: unknown): SessionError {
  const err = e as { code?: string; message?: string }
  const code = CODES.find((c) => c === err?.code) ?? 'http'
  return new SessionError(code, err?.message || 'Erreur de connexion.')
}

/** Adresse acceptée : HTTPS uniquement, sans chemin. */
export function normalizeServerUrl(url: string): string | null {
  const u = url.trim().replace(/\/+$/, '')
  return /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(u) ? u : null
}

export const nativeSession: SessionBackend = {
  available: isNative,
  async getSession() {
    if (!isNative) return { configured: false, url: '', user: null }
    return Plugin.getSession()
  },
  async login(url, login, password, device) {
    if (!isNative) throw new SessionError('unavailable', 'La synchronisation familiale est disponible dans l’application Android.')
    try {
      return await Plugin.login({ url, login, password, device })
    } catch (e) {
      throw toSessionError(e)
    }
  },
  async refresh() {
    try {
      return await Plugin.refresh()
    } catch (e) {
      throw toSessionError(e)
    }
  },
  async logout(accessToken) {
    if (isNative) await Plugin.logout({ accessToken: accessToken ?? undefined })
  },
}
