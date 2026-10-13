/**
 * Première synchronisation : migration contrôlée du carnet existant.
 * 1. Sauvegarde préalable vérifiée (obligatoire). 2. Choix des recettes à partager (aucune
 * présélectionnée). 3. Résumé détaillé. 4. Envoi puis vérification sur le serveur.
 * Aucune donnée locale n'est supprimée, ni pendant ni après.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { CheckCircle2, Lock, ShieldCheck, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/Feedback'
import { Page, Photo, PhotoPlaceholder, TopBar } from '@/components/ui/Layout'
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
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [phase, setPhase] = useState<'prepare' | 'sending' | 'done' | 'failed'>('prepare')
  const [error, setError] = useState<string | null>(null)
  const photoCount = useLiveQuery(() => db.photos.filter((p) => !p.isDemo).count(), [], 0)

  useEffect(() => {
    void migrationCandidates(db).then(setCands)
    void migrationSummary(db).then(setSummary)
  }, [])

  const familyPhotos = useLiveQuery(
    async () => {
      const ids = new Set<string>()
      for (const r of await db.recipes.where('id').anyOf([...selected]).toArray()) {
        for (const p of [r.mainPhotoId, ...r.galleryPhotoIds, ...r.steps.map((x) => x.photoId)]) if (p) ids.add(p)
      }
      return ids.size
    },
    [selected],
    0,
  )

  const makeBackup = async () => {
    setBackupError(null)
    try {
      setBackup(await preMigrationBackup())
    } catch (e) {
      setBackupError(e instanceof Error ? e.message : 'Sauvegarde impossible.')
    }
  }

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const total = cands?.recipes.length ?? 0
  const familyName = s.family?.name ?? 'la famille'
  const personal = useMemo(() => summary?.personal ?? {}, [summary])

  const send = async () => {
    const ok = await confirm({
      title: 'Confirmer la première synchronisation ?',
      message: (
        <div className="space-y-2 text-left text-sm">
          <p><strong>{plural(selected.size, 'recette')}</strong> partagée{selected.size > 1 ? 's' : ''} avec « {familyName} » ({plural(familyPhotos, 'photo')}).</p>
          <p><strong>{plural(total - selected.size, 'recette')}</strong> gardée{total - selected.size > 1 ? 's' : ''} privée{total - selected.size > 1 ? 's' : ''}, dans votre espace personnel.</p>
          <p>Restent personnels : favoris, notes et commentaires, journal ({personal.journal ?? 0}), collections ({personal.collections ?? 0}), liste de courses, aliments mémorisés, publications « À essayer » ({personal.posts ?? 0}) — leurs vidéos ne sont jamais envoyées.</p>
          {!!cands?.demo && <p>Recettes de démonstration ({cands.demo}) : non envoyées.</p>}
          <p>Rien n’est supprimé de ce téléphone.</p>
        </div>
      ),
      confirmLabel: 'Envoyer',
      acknowledge: 'J’ai vérifié ma sélection',
    })
    if (!ok) return
    setPhase('sending')
    setError(null)
    try {
      const m = await syncService.migrate([...selected], async () => backup ?? (await preMigrationBackup()))
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

        <SettingsGroup title={`2. Recettes à partager avec « ${familyName} »`}>
          <div className="flex items-center justify-between gap-2 py-3 text-sm">
            <span className="text-muted">
              {selected.size} / {total} sélectionnée{selected.size > 1 ? 's' : ''} · les autres restent privées
            </span>
            <button type="button" className="font-semibold text-terra" onClick={() => setSelected(selected.size === total ? new Set() : new Set(cands?.recipes.map((r) => r.id)))}>
              {selected.size === total && total > 0 ? 'Tout désélectionner' : 'Tout sélectionner'}
            </button>
          </div>
          {cands?.recipes.map((r) => (
            <label key={r.id} className="flex cursor-pointer items-center gap-3 py-2.5">
              <input type="checkbox" className="size-5 accent-[var(--c-terra)]" checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
              <span className="size-11 shrink-0 overflow-hidden rounded-lg">
                <Photo id={r.mainPhotoId} alt="" className="size-full" fallback={<PhotoPlaceholder title={r.title} className="size-full text-xs" />} />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.title}</span>
              {selected.has(r.id) ? <Users size={16} className="text-terra" aria-label="Familiale" /> : <Lock size={15} className="text-faint" aria-label="Privée" />}
            </label>
          ))}
          {cands && total === 0 && <p className="py-4 text-sm text-muted">Aucune recette personnelle sur ce téléphone.</p>}
        </SettingsGroup>

        <SettingsGroup title="3. Résumé">
          <div className="space-y-1.5 py-4 text-sm">
            <p>Partagées avec la famille : <strong>{plural(selected.size, 'recette')}</strong>, {plural(familyPhotos, 'photo')}</p>
            <p>Gardées privées : <strong>{plural(total - selected.size, 'recette')}</strong></p>
            <p className="text-muted">
              Toujours personnels : favoris, notes, journal ({personal.journal ?? 0}), collections ({personal.collections ?? 0}), courses ({personal.shopping ?? 0}), aliments mémorisés ({personal.foods ?? 0}), publications « À essayer » ({personal.posts ?? 0}, sans leurs vidéos) · {plural(photoCount, 'photo')} sur le téléphone
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
