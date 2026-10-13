/**
 * Première synchronisation : migration contrôlée du carnet existant vers SON carnet privé
 * (synchronisé entre ses propres appareils, invisible des autres comptes).
 * 1. Sauvegarde préalable vérifiée (obligatoire). 2. Résumé détaillé. 3. Envoi puis vérification
 * sur le serveur. Aucune donnée locale n'est supprimée, ni pendant ni après.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { CheckCircle2, ShieldCheck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/Feedback'
import { Page, TopBar } from '@/components/ui/Layout'
import { db } from '@/db/db'
import { formatBytes } from '@/lib/format'
import { type MigrationSummary, migrationSummary } from '@/sync/account'
import { syncService, useSync } from '@/sync/instance'
import { type MigrationCandidate, migrationCandidates } from '@/sync/migration'
import { type PreMigrationBackup, preMigrationBackup } from '@/sync/preMigrationBackup'
import { SettingsGroup } from './SettingsPage'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n > 1 ? many : one}`

export default function SyncMigrationPage() {
  const s = useSync()
  const navigate = useNavigate()
  const confirm = useConfirm()
  const [cands, setCands] = useState<{ recipes: MigrationCandidate[]; demo: number } | null>(null)
  const [summary, setSummary] = useState<MigrationSummary | null>(null)
  const [backup, setBackup] = useState<PreMigrationBackup | null>(null)
  const [backupError, setBackupError] = useState<string | null>(null)
  const [phase, setPhase] = useState<'prepare' | 'sending' | 'done' | 'failed'>('prepare')
  const [error, setError] = useState<string | null>(null)
  const photoCount = useLiveQuery(() => db.photos.filter((p) => !p.isDemo).count(), [], 0)

  useEffect(() => {
    void migrationCandidates(db).then(setCands)
    void migrationSummary(db).then(setSummary)
  }, [])

  const makeBackup = async () => {
    setBackupError(null)
    try {
      setBackup(await preMigrationBackup())
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : 'Sauvegarde impossible.')
    }
  }

  const total = cands?.recipes.length ?? 0
  const personal = useMemo(() => summary?.personal ?? {}, [summary])

  const send = async () => {
    const ok = await confirm({
      title: 'Confirmer la première synchronisation ?',
      message: (
        <div className="space-y-2 text-left text-sm">
          <p><strong>{plural(total, 'recette')}</strong> et {plural(photoCount, 'photo')} envoyées vers votre carnet privé, visible de vous seul.</p>
          <p>Avec vos favoris, notes, journal ({personal.journal ?? 0}), collections ({personal.collections ?? 0}), liste de courses, aliments mémorisés et publications « À essayer » ({personal.posts ?? 0}) — leurs vidéos ne sont jamais envoyées.</p>
          {!!cands?.demo && <p>Recettes de démonstration ({cands.demo}) : non envoyées.</p>}
          <p>Rien n’est supprimé de ce téléphone.</p>
        </div>
      ),
      confirmLabel: 'Envoyer',
      acknowledge: 'J’ai vérifié le résumé',
    })
    if (!ok) return
    setPhase('sending')
    setError(null)
    try {
      const m = await syncService.migrate([], async () => backup ?? (await preMigrationBackup())) // tout reste privé
      setPhase(m?.ok ? 'done' : 'failed')
      if (!m?.ok) setError(`${m?.issues.length ?? 0} élément(s) n’ont pas pu être confirmés sur le serveur. Vos données sont intactes sur le téléphone ; la synchronisation reprendra automatiquement.`)
    } catch (e) {
      setPhase('failed')
      setError(`${e instanceof Error ? e.message : 'Envoi interrompu.'} Rien n’est perdu : l’envoi reprendra là où il s’est arrêté, sans doublon.`)
    }
  }

  if (phase === 'done' || phase === 'failed') {
    return (
      <>
        <TopBar back="/reglages/synchronisation" title="Première synchronisation" />
        <Page className="space-y-4 pt-6 pb-28 text-center">
          {phase === 'done' ? (
            <>
              <CheckCircle2 size={48} className="mx-auto text-sage" />
              <h2 className="font-serif text-xl font-semibold">Synchronisation terminée</h2>
              <p className="text-sm text-muted">
                {s.migration?.checked ?? 0} éléments vérifiés un à un sur le serveur, photos comprises. Vos recettes restent aussi sur ce téléphone. Les prochaines modifications seront envoyées automatiquement.
              </p>
            </>
          ) : (
            <>
              <h2 className="font-serif text-xl font-semibold">Synchronisation incomplète</h2>
              <p className="text-sm text-danger">{error}</p>
              <Button variant="secondary" onClick={() => void syncService.resumeMigration().then((m) => m?.ok && setPhase('done'))}>
                Reprendre maintenant
              </Button>
            </>
          )}
          <Button block onClick={() => navigate('/reglages/synchronisation')}>
            Terminer
          </Button>
        </Page>
      </>
    )
  }

  return (
    <>
      <TopBar back="/reglages/synchronisation" title="Première synchronisation" />
      <Page className="pt-2 pb-40">
        <SettingsGroup title="1. Sauvegarde préalable">
          <div className="space-y-3 py-4 text-sm">
            {backup ? (
              <p className="flex items-start gap-2 text-sage">
                <ShieldCheck size={18} className="mt-0.5 shrink-0" />
                Sauvegarde vérifiée : {plural(backup.recipes, 'recette')}, {plural(backup.photos, 'photo')} ({formatBytes(backup.bytes)}), relue entièrement et conservée sur ce téléphone.
              </p>
            ) : (
              <>
                <p className="text-muted">Avant tout envoi, une sauvegarde complète de votre carnet est créée puis relue pour vérifier qu’elle contient chaque recette et chaque photo.</p>
                {backupError && <p className="text-danger">{backupError}</p>}
                <Button size="sm" onClick={() => void makeBackup()}>
                  Créer et vérifier la sauvegarde
                </Button>
              </>
            )}
          </div>
        </SettingsGroup>

        <SettingsGroup title="2. Votre carnet privé">
          <p className="py-4 text-sm text-muted">
            Vos {plural(total, 'recette')} restent privées : elles sont synchronisées entre vos appareils, et personne d’autre ne les voit. Pour en envoyer une à un proche, utilisez ensuite « Partager avec un utilisateur » dans la fiche.
          </p>
        </SettingsGroup>

        <SettingsGroup title="3. Résumé">
          <div className="space-y-1.5 py-4 text-sm">
            <p>Envoyées vers votre carnet privé : <strong>{plural(total, 'recette')}</strong>, {plural(photoCount, 'photo')}</p>
            <p className="text-muted">
              Avec vos favoris, notes, journal ({personal.journal ?? 0}), collections ({personal.collections ?? 0}), courses ({personal.shopping ?? 0}), aliments mémorisés ({personal.foods ?? 0}) et publications « À essayer » ({personal.posts ?? 0}, sans leurs vidéos)
            </p>
            {!!cands?.demo && <p className="text-muted">Recettes de démonstration ({cands.demo}) : non envoyées.</p>}
          </div>
        </SettingsGroup>

        <div className="mt-7">
          <Button block size="lg" disabled={!backup || phase === 'sending'} loading={phase === 'sending'} onClick={() => void send()}>
            {phase === 'sending' ? 'Envoi et vérification…' : 'Vérifier le résumé et envoyer'}
          </Button>
          {!backup && <p className="mt-2 text-center text-xs text-muted">Créez d’abord la sauvegarde préalable.</p>}
        </div>
      </Page>
    </>
  )
}
