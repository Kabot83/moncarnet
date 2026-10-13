/**
 * Comptes sur l'appareil (voir binding.ts) et résumé des données avant la première migration.
 */
import type { CarnetDB } from '@/db/db'
import { SYNCED } from './engine'

export { localDbName, signIn, signOut, SIGNED_OUT_DB, type DeviceBinding } from './binding'

export interface MigrationSummary {
  /** Données personnelles présentes sur l'appareil. */
  personal: Record<string, number>
  /** Données de démonstration (envoyées seulement avec accord explicite). */
  demo: Record<string, number>
  hasPersonalData: boolean
}

/** Résumé affiché avant la première synchronisation (« 42 recettes, 120 photos… »). */
export async function migrationSummary(db: CarnetDB): Promise<MigrationSummary> {
  const personal: Record<string, number> = {}
  const demo: Record<string, number> = {}
  for (const coll of SYNCED) {
    const rows = await (db as unknown as Record<string, { toArray(): Promise<{ isDemo?: boolean }[]> }>)[coll].toArray()
    personal[coll] = rows.filter((r) => !r.isDemo).length
    demo[coll] = rows.filter((r) => r.isDemo).length
  }
  return { personal, demo, hasPersonalData: Object.values(personal).some((n) => n > 0) }
}
