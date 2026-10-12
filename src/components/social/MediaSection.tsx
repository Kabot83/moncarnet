/**
 * Vidéo d'une publication : lecteur local (hors ligne) si la vidéo est sur le téléphone,
 * sinon état de la récupération par le NAS et solution de secours (import depuis la galerie).
 */
import { CheckCircle2, CloudDownload, FolderInput, HardDrive, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatBytes } from '@/lib/format'
import type { SocialPost } from '@/models/types'
import { NasError, carnetMediaAvailable } from '@/platform/carnetMedia'
import { importVideoFromGallery, nasReady, removeLocalVideo, startNasImport, videoSrc } from '@/social/nasMedia'
import { Button } from '../ui/Button'
import { useConfirm, useToast } from '../ui/Feedback'

const duration = (s: number | null | undefined) => (s ? `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')}` : '')

export function MediaSection({ post }: { post: SocialPost }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [nas, setNas] = useState(false)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => void nasReady().then(setNas), [])
  useEffect(() => setMissing(false), [post.video?.name])

  const importFile = async () => {
    setBusy(true)
    try {
      if ((await importVideoFromGallery(post.id)) === 'ok') toast.success('Vidéo enregistrée sur le téléphone')
    } catch (e) {
      toast.error(e instanceof NasError ? e.message : 'Import impossible.')
    } finally {
      setBusy(false)
    }
  }
  const retry = () => void startNasImport(post.id, { retry: true })
  const status = post.mediaStatus ?? 'none'

  if (post.video && !missing) {
    const v = post.video
    return (
      <section className="mt-4" aria-label="Vidéo">
        <video
          key={v.name}
          src={videoSrc(post) ?? undefined}
          controls
          playsInline
          preload="metadata"
          onError={() => setMissing(true)}
          className={`mx-auto w-full max-w-sm rounded-2xl bg-ink ${v.height && v.width && v.height > v.width ? 'aspect-[9/16]' : 'aspect-video'} max-h-[78vh] object-contain`}
        />
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
          <HardDrive size={14} className="text-sage" />
          Vidéo enregistrée sur ce téléphone · {formatBytes(v.bytes)}
          {v.duration ? ` · ${duration(v.duration)}` : ''} · {v.source === 'nas' ? 'via le NAS' : 'depuis la galerie'} · lecture hors ligne
        </p>
        <div className="mt-1 flex gap-3 text-xs">
          {carnetMediaAvailable && (
            <button type="button" className="font-semibold text-terra" onClick={() => void importFile()} disabled={busy}>
              Remplacer par un fichier
            </button>
          )}
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold text-muted"
            onClick={async () => {
              if (await confirm({ title: 'Retirer la vidéo de ce téléphone ?', message: 'La fiche, vos notes et la copie du NAS sont conservées.', confirmLabel: 'Retirer', danger: true })) await removeLocalVideo(post)
            }}
          >
            <Trash2 size={13} /> Retirer du téléphone
          </button>
        </div>
      </section>
    )
  }

  let icon = <CloudDownload size={20} />
  let title = 'Lien enregistré uniquement'
  let text = carnetMediaAvailable ? 'Configurez votre NAS pour récupérer automatiquement la vidéo, ou importez-la depuis la galerie.' : 'Dans l’application Android, la vidéo peut être récupérée automatiquement par votre NAS.'
  let progress: number | null = null
  let canRetry = false
  if (missing) {
    icon = <TriangleAlert size={20} />
    title = 'Fichier vidéo absent de ce téléphone'
    text = 'Il a peut-être été supprimé ou la fiche vient d’une sauvegarde. Récupérez-le de nouveau ou importez-le.'
    canRetry = nas
  } else if (status === 'pending' || status === 'downloading') {
    title = status === 'pending' ? 'Récupération par le NAS…' : post.mediaProgress >= 0.8 ? 'Transfert vers le téléphone…' : 'Téléchargement par le NAS…'
    text = 'Vous pouvez quitter cette page : la vidéo arrivera en arrière-plan.'
    progress = post.mediaProgress
  } else if (status === 'unavailable') {
    icon = <TriangleAlert size={20} />
    title = 'Vidéo non disponible au téléchargement'
    text = post.mediaMessage || 'La plateforme ne fournit pas cette vidéo.'
    canRetry = nas
  } else if (status === 'failed') {
    icon = <TriangleAlert size={20} />
    title = 'Récupération interrompue'
    text = post.mediaMessage || 'Nouvel essai possible.'
    canRetry = nas
  } else if (nas) {
    title = 'Vidéo pas encore récupérée'
    text = 'Votre NAS peut la récupérer maintenant.'
    canRetry = true
  }

  return (
    <section className="mt-4 rounded-2xl bg-sunken p-4" aria-label="Vidéo" role="status">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-terra">{status === 'ready' ? <CheckCircle2 size={20} /> : icon}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="text-sm text-muted">{text}</p>
          {progress != null && (
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-terra transition-all" style={{ width: `${Math.max(4, Math.round(progress * 100))}%` }} />
            </div>
          )}
        </div>
      </div>
      {(canRetry || carnetMediaAvailable) && progress == null && (
        <div className="mt-3 grid gap-2">
          {canRetry && (
            <Button size="sm" icon={<RefreshCw size={15} />} onClick={retry}>
              {status === 'none' ? 'Récupérer la vidéo' : 'Réessayer'}
            </Button>
          )}
          {carnetMediaAvailable && (
            <Button size="sm" variant="secondary" icon={<FolderInput size={15} />} loading={busy} onClick={() => void importFile()}>
              Importer un fichier vidéo
            </Button>
          )}
          {carnetMediaAvailable && !nas && (
            <Link to="/reglages/videos" className="text-center text-xs font-semibold text-terra">
              Configurer le NAS
            </Link>
          )}
        </div>
      )}
    </section>
  )
}
