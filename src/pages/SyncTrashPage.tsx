/** Corbeille familiale : recettes supprimées, restaurables 30 jours par tout membre. */
import { RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { EmptyState, Page, TopBar } from '@/components/ui/Layout'
import { LoadingBlock } from '@/components/ui/Spinner'
import { formatDate } from '@/lib/format'
import { syncService, useSync } from '@/sync/instance'

type TrashItem = Awaited<ReturnType<typeof syncService.api.trash>>[number]

export default function SyncTrashPage() {
  const s = useSync()
  const toast = useToast()
  const confirm = useConfirm()
  const [list, setList] = useState<TrashItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    syncService.api.trash().then(setList, (e) => setError(e instanceof Error ? e.message : 'Serveur injoignable.'))
  }, [])
  useEffect(load, [load])

  const restore = async (t: TrashItem) => {
    await syncService.api.restoreFromTrash(t.id)
    await syncService.syncNow('corbeille')
    toast.success(`« ${t.title} » restaurée pour toute la famille`)
    load()
  }

  const purge = async (t: TrashItem) => {
    const ok = await confirm({ title: `Supprimer définitivement « ${t.title} » ?`, message: 'La recette et son historique seront effacés du serveur pour toute la famille. Action irréversible.', confirmLabel: 'Supprimer définitivement', danger: true })
    if (!ok) return
    await syncService.api.purge(t.id)
    load()
  }

  return (
    <>
      <TopBar back="/reglages/synchronisation" title="Corbeille familiale" />
      <Page className="pt-2 pb-28">
        {error && <p className="mt-4 rounded-2xl bg-danger-soft p-4 text-sm text-danger">{error}</p>}
        {!list && !error && <LoadingBlock />}
        {list?.length === 0 && <EmptyState icon={<Trash2 size={28} />} title="Corbeille vide" />}
        <ul className="mt-3 space-y-3">
          {list?.map((t) => (
            <li key={t.id} className="rounded-[var(--radius-card)] bg-paper p-4 shadow-[var(--shadow-card)]">
              <p className="font-serif text-lg font-semibold">{t.title}</p>
              <p className="text-xs text-muted">
                Supprimée par {t.trashedBy?.name ?? '?'} le {formatDate(t.trashedAt * 1000)} · effacement automatique le {formatDate(t.purgeAt * 1000)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={<RotateCcw size={16} />} onClick={() => void restore(t)}>
                  Restaurer
                </Button>
                {s.family?.role === 'admin' && (
                  <Button size="sm" variant="danger" onClick={() => void purge(t)}>
                    Supprimer définitivement
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Page>
    </>
  )
}
