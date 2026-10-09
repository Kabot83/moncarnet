import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import {
  type AppSecrets,
  type AppSettings,
  type CulinaryProfile,
  defaultSettings,
  emptyProfile,
} from '@/models/types'

const SETTINGS_KEY = 'app'
const PROFILE_KEY = 'profile'
const SECRETS_KEY = 'ai'

export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get(SETTINGS_KEY)
  return { ...defaultSettings(), ...((row?.value as Partial<AppSettings>) ?? {}) }
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return db.transaction('rw', db.settings, async () => {
    const next = { ...(await getSettings()), ...patch }
    await db.settings.put({ key: SETTINGS_KEY, value: next })
    if (patch.theme) {
      try {
        localStorage.setItem('mc-theme', patch.theme)
      } catch {
        /* stockage indisponible : le thème suivra le système au prochain lancement */
      }
    }
    return next
  })
}

/** Réglages réactifs. Renvoie les valeurs par défaut pendant le chargement. */
export function useSettings(): AppSettings {
  return useLiveQuery(getSettings, [], defaultSettings())
}

export async function getProfile(): Promise<CulinaryProfile> {
  const row = await db.settings.get(PROFILE_KEY)
  return { ...emptyProfile(), ...((row?.value as Partial<CulinaryProfile>) ?? {}) }
}

export async function saveProfile(p: CulinaryProfile) {
  await db.settings.put({ key: PROFILE_KEY, value: p })
}

export function useProfile(): CulinaryProfile {
  return useLiveQuery(getProfile, [], emptyProfile())
}

export async function getSecrets(): Promise<AppSecrets> {
  const row = await db.secrets.get(SECRETS_KEY)
  return { apiKey: '', proxyToken: '', ...((row?.value as Partial<AppSecrets>) ?? {}) }
}

export async function saveSecrets(patch: Partial<AppSecrets>) {
  const next = { ...(await getSecrets()), ...patch }
  await db.secrets.put({ key: SECRETS_KEY, value: next })
}

export async function clearSecrets() {
  await db.secrets.clear()
}

export function useHasSecrets(): { apiKey: boolean; proxyToken: boolean } {
  return useLiveQuery(
    async () => {
      const s = await getSecrets()
      return { apiKey: !!s.apiKey, proxyToken: !!s.proxyToken }
    },
    [],
    { apiKey: false, proxyToken: false },
  )
}
