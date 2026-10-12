/**
 * Au démarrage (APK) : vérification réelle de la persistance, copie de sécurité automatique et,
 * si une perte de la base est détectée, proposition de restauration.
 */
import { useEffect, useState } from 'react'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { formatBytes, relativeDays } from '@/lib/format'
import { isNative } from '@/platform/native'
import { type IntegrityState, acknowledgeLoss, checkIntegrity, refreshSnapshot, restoreSnapshot } from '@/services/integrity'
import { Button } from './ui/Button'
import { useToast } from './ui/Feedback'
import { Sheet } from './ui/Sheet'

let pauseHooked = false

export function IntegrityGuard() {
  const toast = useToast()
  const navigate = useSafeNavigate()
  const [state, setState] = useState<IntegrityState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!isNative) return
    let timer: ReturnType<typeof setTimeout> | undefined
    void checkIntegrity().then((s) => {
      setState(s)
      // Copie de sécurité quand l'application est au calme, puis à chaque passage en arrière-plan.
      if (s.kind === 'ok' || s.kind === 'initialized') timer = setTimeout(() => void refreshSnapshot().catch(() => undefined), 15_000)
    })
    if (!pauseHooked) {
      pauseHooked = true
      void import('@capacitor/app').then(({ App }) => App.addListener('pause', () => void refreshSnapshot().catch(() => undefined)))
    }
    return () => clearTimeout(timer)
  }, [])

  if (state?.kind !== 'lost') return null
  const snap = state.snapshot
  return (
    <Sheet open onClose={() => undefined} dismissible={false} title="Données locales introuvables" description="Les recettes enregistrées dans Mon Carnet n’ont pas été retrouvées au démarrage.">
      <div className="space-y-3 pb-4 text-sm">
        <p>
          Les fichiers de l’application sont présents, mais sa base de données a été vidée (par exemple par Android, si le téléphone a manqué d’espace). Rien n’a été modifié automatiquement.
        </p>
        {snap ? (
          <Button
            block
            size="lg"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r = await restoreSnapshot()
                toast.success(`${r.recipes} recette(s) restaurée(s) depuis la copie de sécurité`)
                setState(await checkIntegrity(true))
              } catch (e) {
                toast.error(e instanceof Error ? e.message : 'Restauration impossible.')
              } finally {
                setBusy(false)
              }
            }}
          >
            Restaurer la copie du {new Date(snap.at).toLocaleDateString('fr-FR')} ({snap.recipes} recettes, {formatBytes(snap.bytes)})
          </Button>
        ) : (
          <p className="rounded-2xl bg-sunken p-3 text-muted">Aucune copie de sécurité n’est disponible sur ce téléphone.</p>
        )}
        <Button block variant="secondary" onClick={() => navigate('/reglages/sauvegarde')}>
          Restaurer une sauvegarde ZIP
        </Button>
        <Button
          block
          variant="ghost"
          onClick={async () => {
            await acknowledgeLoss()
            setState(await checkIntegrity(true))
          }}
        >
          Continuer sans restaurer
        </Button>
        {snap && <p className="text-xs text-faint">Copie créée {relativeDays(snap.at)}. Elle reste disponible tant que vous ne la remplacez pas.</p>}
      </div>
    </Sheet>
  )
}
