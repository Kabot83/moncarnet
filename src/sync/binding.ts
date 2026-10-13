/**
 * Comptes Carnet Sync sur l'appareil : une base locale par compte (téléphone partagé).
 *
 * - Sans compte (comme en 1.4.1) : base « mon-carnet », inchangée.
 * - Le premier compte connecté sur l'appareil reprend « mon-carnet » (après accord : migration) ;
 *   aucune donnée n'est déplacée ni recopiée.
 * - Tout autre compte : base « mon-carnet@<id du compte> », vide au départ puis remplie par le serveur.
 * - Déconnexion : rien n'est supprimé. L'application ouvre « mon-carnet~hors-compte » (vide) pour que
 *   la personne suivante ne voie pas le carnet précédent ; la reconnexion retrouve la base intacte.
 *
 * Le choix de la base doit être connu AVANT l'ouverture de Dexie : il est lu de façon synchrone
 * (localStorage, même stockage que la base). Changer de base = recharger l'application.
 */

export const PRIMARY_DB = 'mon-carnet'
export const SIGNED_OUT_DB = `${PRIMARY_DB}~hors-compte`
const KEY = 'moncarnet.sync.binding'

export interface DeviceBinding {
  /** Compte propriétaire de la base historique « mon-carnet » (null : aucun). */
  primaryUserId: string | null
  /** Compte connecté actuellement (null : déconnecté). */
  currentUserId: string | null
  /** Une session a déjà existé sur l'appareil. */
  everSignedIn: boolean
}

const EMPTY: DeviceBinding = { primaryUserId: null, currentUserId: null, everSignedIn: false }

export function readBinding(): DeviceBinding {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
    if (!raw) return EMPTY
    const b = JSON.parse(raw) as Partial<DeviceBinding>
    return { primaryUserId: b.primaryUserId ?? null, currentUserId: b.currentUserId ?? null, everSignedIn: !!b.everSignedIn }
  } catch {
    return EMPTY
  }
}

export function writeBinding(b: DeviceBinding): void {
  globalThis.localStorage?.setItem(KEY, JSON.stringify(b))
}

export function localDbName(b: DeviceBinding): string {
  if (!b.currentUserId) return b.everSignedIn ? SIGNED_OUT_DB : PRIMARY_DB
  if (!b.primaryUserId || b.primaryUserId === b.currentUserId) return PRIMARY_DB
  return `${PRIMARY_DB}@${b.currentUserId}`
}

/** Connexion : le premier compte reprend la base historique ; les suivants ont la leur. */
export function signIn(b: DeviceBinding, userId: string): DeviceBinding {
  return { primaryUserId: b.primaryUserId ?? userId, currentUserId: userId, everSignedIn: true }
}

/** Déconnexion : la base du compte est conservée telle quelle. */
export function signOut(b: DeviceBinding): DeviceBinding {
  return { ...b, currentUserId: null }
}

/** Base à ouvrir au démarrage. */
export function activeDbName(): string {
  return localDbName(readBinding())
}
