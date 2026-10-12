/**
 * État du stockage dans Réglages.
 * - APK : vérification réelle (repère au démarrage), copie de sécurité, vidéos présentes.
 *   `navigator.storage.persisted()` n'est pas utilisé : la WebView refuse toujours cette permission.
 * - PWA : contrôle du stockage persistant du navigateur (inchangé).
 * Dans les deux cas : le stockage local n'est jamais présenté comme une sauvegarde.
 */
import { CircleAlert, HardDrive, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { requestPersistentStorage, storageEstimate } from '@/db/db'
import { formatBytes, relativeDays } from '@/lib/format'
import { isNative } from '@/platform/native'
import { type IntegrityState, type VideoCheck, checkIntegrity, checkVideos, refreshSnapshot } from '@/services/integrity'
import { Button } from './ui/Button'
import { useToast } from './ui/Feedback'

export function StorageStatus() {
  return isNative ? <NativeStatus /> : <WebStatus />
}

function Line({ ok, children }: { ok: boolean | null; children: React.ReactNode }) {
  return (
    <p className="mt-1 flex items-start gap-1.5 text-muted">
      {ok === false ? <CircleAlert size={15} className="mt-0.5 shrink-0 text-danger" /> : <ShieldCheck size={15} className={`mt-0.5 shrink-0 ${ok ? 'text-sage' : 'text-faint'}`} />}
      <span>{children}</span>
    </p>
  )
}

function NativeStatus() {
  const toast = useToast()
  const [state, setState] = useState<IntegrityState | null>(null)
  const [videos, setVideos] = useState<VideoCheck | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void checkIntegrity().then(setState)
    void checkVideos().then(setVideos)
  }, [])
  if (!state) return null
  const snapshot = state.kind === 'ok' || state.kind === 'initialized' || state.kind === 'lost' ? state.snapshot : null
  return (
    <>
      <Line ok={null}>Données enregistrées dans l’espace privé de Mon Carnet sur ce téléphone (base de l’application et fichiers vidéo).</Line>
      {state.kind === 'ok' && <Line ok>Vérifié à ce démarrage : aucune perte de données détectée depuis le {new Date(state.since).toLocaleDateString('fr-FR')}.</Line>}
      {state.kind === 'initialized' && <Line ok={null}>Contrôle de persistance activé : il sera vérifié à chaque démarrage.</Line>}
      {state.kind === 'lost' && <Line ok={false}>Perte de la base détectée au démarrage : restaurez une copie.</Line>}
      {state.kind === 'unverifiable' && <Line ok={false}>Vérification impossible ({state.reason}).</Line>}
      <Line ok={snapshot ? true : null}>
        {snapshot
          ? `Copie de sécurité automatique : ${relativeDays(snapshot.at)} (${snapshot.recipes} recettes, ${formatBytes(snapshot.bytes)}, vidéos non comprises).`
          : 'Copie de sécurité automatique : pas encore créée.'}
      </Line>
      {videos && videos.referenced > 0 && (
        <p className="mt-1 flex items-start gap-1.5 text-muted">
          <HardDrive size={15} className={`mt-0.5 shrink-0 ${videos.missing.length ? 'text-danger' : 'text-sage'}`} />
          <span>
            {videos.present} vidéo{videos.present > 1 ? 's' : ''} présente{videos.present > 1 ? 's' : ''} ({formatBytes(videos.bytes)})
            {videos.missing.length ? ` · ${videos.missing.length} manquante(s) : ${videos.missing.map((m) => m.title).slice(0, 3).join(', ')} — « Réessayer » sur leur fiche les récupère.` : ', toutes vérifiées.'}
          </span>
        </p>
      )}
      <p className="mt-2 rounded-xl bg-sunken p-2.5 text-xs text-muted">
        Ce n’est pas une sauvegarde : désinstaller Mon Carnet ou « Effacer les données » efface tout, copie de sécurité et vidéos comprises.{' '}
        <Link to="/reglages/sauvegarde" className="font-semibold text-terra">
          Exportez régulièrement une sauvegarde ZIP
        </Link>{' '}
        hors du téléphone.
      </p>
      {(state.kind === 'ok' || state.kind === 'initialized') && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          loading={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await refreshSnapshot(true)
              setState(await checkIntegrity())
              toast.success('Copie de sécurité mise à jour')
            } catch {
              toast.error('Copie de sécurité impossible (espace insuffisant ?).')
            } finally {
              setBusy(false)
            }
          }}
        >
          Mettre à jour la copie de sécurité
        </Button>
      )}
    </>
  )
}

function WebStatus() {
  const toast = useToast()
  const [storage, setStorage] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null)
  useEffect(() => void storageEstimate().then(setStorage), [])
  if (!storage) return null
  return (
    <>
      <Line ok={storage.persisted}>
        {storage.persisted ? 'Stockage persistant accordé : le navigateur ne l’effacera pas de lui-même.' : 'Stockage non persistant : le navigateur pourrait l’effacer en cas de manque d’espace.'}
      </Line>
      {!storage.persisted && (
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={async () => {
            const ok = await requestPersistentStorage()
            setStorage(await storageEstimate())
            toast[ok ? 'success' : 'info'](ok ? 'Stockage persistant accordé' : 'Le navigateur n’a pas accordé le stockage persistant. Installez l’application sur l’écran d’accueil puis réessayez.')
          }}
        >
          Demander le stockage persistant
        </Button>
      )}
      <p className="mt-2 text-xs text-muted">Même persistant, ce stockage n’est pas une sauvegarde : effacer les données du site supprime tout.</p>
    </>
  )
}
