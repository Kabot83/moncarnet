/**
 * Comptes sur l'appareil : une base locale par compte (téléphone partagé).
 *
 * - Sans compte (comme en 1.4.1) : base « mon-carnet », inchangée.
 * - Le premier compte connecté sur l'appareil reprend « mon-carnet » (après accord, cf. migration) :
 *   aucune donnée n'est déplacée ni recopiée.
 * - Tout autre compte : base « mon-carnet@<id du compte> », vide au départ puis remplie par le serveur.
 * - Déconnexion : rien n'est supprimé. L'application ouvre « mon-carnet~hors-compte » (vide) pour que
 *   la personne suivante ne voie pas le carnet précédent ; la reconnexion retrouve la base intacte.
 */
import type { CarnetDB } from '@/db/db'
import { DB_NAME } from '@/db/db'
import { SYNCED } from './engine'

export interface DeviceBinding {
  /** Compte propriétaire de la base historique « mon-carnet » (null : aucun). */
  primaryUserId: string | null
  /** Compte connecté actuellement (null : déconnecté). */
  currentUserId: string | null
  /** Une session a déjà existé sur l'appareil. */
  everSignedIn: boolean
}

export const SIGNED_OUT_DB = `${DB_NAME}~hors-compte`

export function localDbName(b: DeviceBinding): string {
  if (!b.currentUserId) return b.everSignedIn ? SIGNED_OUT_DB : DB_NAME
  if (!b.primaryUserId || b.primaryUserId === b.currentUserId) return DB_NAME
  return `${DB_NAME}@${b.currentUserId}`
}

/** Connexion : le premier compte reprend la base historique ; les suivants ont la leur. */
export function signIn(b: DeviceBinding, userId: string): DeviceBinding {
  return { primaryUserId: b.primaryUserId ?? userId, currentUserId: userId, everSignedIn: true }
}

/** Déconnexion : la base du compte est conservée telle quelle. */
export function signOut(b: DeviceBinding): DeviceBinding {
  return { ...b, currentUserId: null }
}

export interface MigrationSummary {
  /** Données personnelles qui seront envoyées vers le compte. */
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
    const rows = (await (db as unknown as Record<string, { toArray(): Promise<{ isDemo?: boolean }[]> }>)[coll].toArray())
    personal[coll] = rows.filter((r) => !r.isDemo).length
    demo[coll] = rows.filter((r) => r.isDemo).length
  }
  return { personal, demo, hasPersonalData: Object.values(personal).some((n) => n > 0) }
}
