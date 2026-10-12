/**
 * Pont vers le plugin natif CarnetMedia (android/…/CarnetMediaPlugin.java).
 * Le jeton d'appareil est chiffré par le magasin de clés Android et ne revient jamais ici :
 * l'interface demande au plugin d'effectuer les requêtes.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { isNative } from './native'

export interface CarnetMediaConfig {
  url: string
  hasToken: boolean
}

export interface SavedFile {
  uri: string
  name: string
  bytes: number
  sha256: string
}

export interface PickedVideo extends SavedFile {
  duration: number | null
  width: number | null
  height: number | null
  displayName: string
  thumbnailUri?: string
}

interface CarnetMediaPlugin {
  configure(o: { url: string; token?: string }): Promise<CarnetMediaConfig>
  getConfig(): Promise<CarnetMediaConfig>
  request(o: { method: string; path: string; body?: string }): Promise<{ status: number; body: string }>
  download(o: { path: string; name: string }): Promise<SavedFile>
  pickVideo(o: { name: string }): Promise<PickedVideo>
  deleteFile(o: { name: string }): Promise<void>
  usage(): Promise<{ bytes: number; videos: number; free: number }>
  addListener(event: 'downloadProgress', cb: (e: { name: string; progress: number }) => void): Promise<{ remove: () => Promise<void> }>
}

export const CarnetMedia = registerPlugin<CarnetMediaPlugin>('CarnetMedia')

/** Disponible uniquement dans l'application Android (fichiers natifs, jeton chiffré). */
export const carnetMediaAvailable = isNative

export class NasError extends Error {
  constructor(
    public code: 'not_configured' | 'unauthorized' | 'network' | 'http' | 'cancelled' | 'no_space' | 'too_large' | 'invalid' | 'incomplete' | 'other',
    message: string,
  ) {
    super(message)
  }
}

function toNasError(e: unknown): NasError {
  const err = e as { code?: string; message?: string }
  const known = ['not_configured', 'unauthorized', 'network', 'cancelled', 'no_space', 'too_large', 'invalid', 'incomplete'] as const
  const code = known.find((k) => k === err?.code) ?? (err?.code?.startsWith('http_') ? 'http' : 'other')
  return new NasError(code, err?.message || 'Erreur du service vidéo.')
}

/** Appel JSON à l'API Carnet Media. */
export async function nasApi<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; data: T }> {
  let res: { status: number; body: string }
  try {
    res = await CarnetMedia.request({ method, path, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch (e) {
    throw toNasError(e)
  }
  if (res.status === 401) throw new NasError('unauthorized', 'Le NAS refuse le jeton : vérifiez-le dans Réglages → Vidéos (NAS).')
  let data: T
  try {
    data = (res.body ? JSON.parse(res.body) : {}) as T
  } catch {
    throw new NasError('http', `Réponse inattendue du NAS (HTTP ${res.status}).`)
  }
  return { status: res.status, data }
}

export async function nasDownload(path: string, name: string): Promise<SavedFile> {
  try {
    return await CarnetMedia.download({ path, name })
  } catch (e) {
    throw toNasError(e)
  }
}

export async function pickVideoFile(name: string): Promise<PickedVideo> {
  try {
    return await CarnetMedia.pickVideo({ name })
  } catch (e) {
    throw toNasError(e)
  }
}

export async function deleteLocalFile(name: string): Promise<void> {
  if (!isNative) return
  try {
    await CarnetMedia.deleteFile({ name })
  } catch {
    /* déjà absent */
  }
}

let cachedConfig: Promise<CarnetMediaConfig> | null = null

export function getNasConfig(refresh = false): Promise<CarnetMediaConfig> {
  if (!isNative) return Promise.resolve({ url: '', hasToken: false })
  if (refresh || !cachedConfig) cachedConfig = CarnetMedia.getConfig().catch(() => ({ url: '', hasToken: false }))
  return cachedConfig
}

export async function configureNas(url: string, token?: string): Promise<CarnetMediaConfig> {
  try {
    const cfg = await CarnetMedia.configure({ url, token })
    cachedConfig = Promise.resolve(cfg)
    return cfg
  } catch (e) {
    throw toNasError(e)
  }
}

/** Adresse lisible par le lecteur vidéo de l'application pour un fichier local. */
export const localFileSrc = (uri: string) => Capacitor.convertFileSrc(uri)
