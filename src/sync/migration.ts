/**
 * Première connexion à Carnet Sync : migration contrôlée des données déjà présentes.
 *
 * 1. `migrationCandidates` : recettes de l'appareil, AUCUNE présélectionnée (l'écran propose
 *    « Tout sélectionner », rien n'est partagé automatiquement) ; démonstration à part.
 * 2. `runInitialMigration` :
 *    - sauvegarde complète AVANT tout (si elle échoue, rien n'est lié ni envoyé) ;
 *    - recettes choisies → catalogue familial ; les autres restent personnelles ;
 *    - favoris, notes, journal, collections, courses… restent dans l'espace personnel ;
 *    - liaison de la base au compte, synchronisation, vérification élément par élément ;
 *    - AUCUNE donnée locale n'est supprimée, ni pendant ni après.
 */
import type { CarnetDB } from '@/db/db'
import type { SyncEngine, SyncReport } from './engine'

export interface MigrationCandidate {
  id: string
  title: string
  mainPhotoId: string | null
  isDemo: boolean
  /** Déjà synchronisée (reprise d'une migration interrompue). */
  space: 'family' | 'personal' | null
}

export async function migrationCandidates(db: CarnetDB): Promise<{ recipes: MigrationCandidate[]; demo: number }> {
  const all = await db.recipes.toArray()
  const recipes = all
    .filter((r) => !r.isDemo)
    .map((r) => ({ id: r.id, title: r.title, mainPhotoId: r.mainPhotoId, isDemo: false, space: r.space ?? null }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fr'))
  return { recipes, demo: all.length - recipes.length }
}

export class MigrationError extends Error {}

export async function runInitialMigration(
  engine: SyncEngine,
  opts: {
    /** Recettes à partager dans le catalogue familial (choix explicite de l'utilisateur). */
    share: string[]
    /** Sauvegarde complète de l'appareil (ZIP + copie de sécurité), faite AVANT tout envoi. */
    backup: () => Promise<unknown>
  },
): Promise<{ report: SyncReport; verified: Awaited<ReturnType<SyncEngine['verify']>> }> {
  try {
    await opts.backup()
  } catch (e) {
    throw new MigrationError(`Sauvegarde préalable impossible : migration annulée, rien n'a été envoyé. (${e instanceof Error ? e.message : String(e)})`)
  }
  const db = engine.db
  const share = new Set(opts.share)
  await db.transaction('rw', db.recipes, async () => {
    for (const r of await db.recipes.toArray()) {
      if (r.isDemo || r.space) continue // démonstration exclue ; déjà rangée (reprise) : inchangée
      await db.recipes.update(r.id, { space: share.has(r.id) ? 'family' : 'personal' })
    }
  })
  await engine.bindToAccount()
  const report = await engine.sync()
  return { report, verified: await engine.verify() }
}
