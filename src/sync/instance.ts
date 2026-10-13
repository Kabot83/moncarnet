/** Instance unique de la synchronisation familiale dans l'application, et accès React. */
import { useSyncExternalStore } from 'react'
import { db } from '@/db/db'
import { nativeSession } from '@/platform/carnetSync'
import { SyncService, type SyncState } from './service'

export const syncService = new SyncService({
  backend: nativeSession,
  db,
  reload: () => window.location.reload(),
  device: 'Téléphone Android',
})

let started: Promise<void> | null = null
/** Démarrage (une fois) : session, base du compte, synchronisation automatique. */
export function startSync(): Promise<void> {
  started ??= syncService.init().catch(() => undefined)
  return started
}

export function useSync(): SyncState {
  return useSyncExternalStore(
    (cb) => syncService.subscribe(cb),
    () => syncService.state,
  )
}

/** Synchronisation active (compte connecté et carnet lié) : badges, choix « Garder privée »… */
export function syncActive(s: SyncState): boolean {
  return ['idle', 'syncing', 'offline', 'error', 'revoked'].includes(s.status) && !!s.user
}
