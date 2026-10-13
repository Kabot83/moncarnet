/**
 * Recettes reçues d'autres utilisateurs : ajouter à mon carnet, ou refuser.
 * Nouvelle version d'une recette déjà reçue : mettre à jour ma recette (confirmation explicite,
 * avertissement si je l'ai modifiée depuis), garder les deux, ou refuser.
 * Après acceptation, ma copie est indépendante : rien n'est jamais remplacé automatiquement.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { Inbox } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { EmptyState, Page, TopBar } from '@/components/ui/Layout'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { formatDate, relativeTime } from '@/lib/format'
import type { Recipe } from '@/models/types'
import type { TransferSummary } from '@/sync/api'
import { syncService, useSync } from '@/sync/instance'

/** Ma copie déjà reçue de la même recette d'origine (la plus récente), si elle existe. */
export function previousCopy(recipes: Recipe[], item: Pick<TransferSummary, 'source_key'>): Recipe | null {
  if (!item.source_key) return null // serveur 0.2.0 : origine inconnue → seulement « ajouter » ou « refuser »
  const mine = recipes.filter((r) => r.receivedFrom?.sourceKey === item.source_key)
  return mine.sort((a, b) => (b.receivedFrom?.at ?? 0) - (a.receivedFrom?.at ?? 0) || b.createdAt - a.createdAt)[0] ?? null
}

/** Ma copie a-t-elle été modifiée depuis sa réception ? */
export const modifiedSinceReception = (r: Recipe) => !!r.receivedFrom && r.updatedAt > r.receivedFrom.at + 60_000

function Cover({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let u: string | null = null
    void syncService.api.transferCover(id).then((b) => b && setUrl((u = URL.createObjectURL(b))), () => undefined)
    return () => {
      if (u) URL.revokeObjectURL(u)
    }
  }, [id])
  return url ? <img src={url} alt="" className="size-20 shrink-0 rounded-xl object-cover" /> : <div className="size-20 shrink-0 rounded-xl bg-sunken" />
}

function ReceivedCard({ item, previous, onDone }: { item: TransferSummary; previous: Recipe | null; onDone: () => void }) {
  const toast = useToast()
  const confirm = useConfirm()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)

  const run = async (f: () => Promise<string | null>, ok: string, open = true) => {
    setBusy(true)
    try {
      const id = await f()
      toast.success(ok)
      onDone()
      if (id && open) navigate(`/recettes/${id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action impossible (connexion ?).')
    } finally {
      setBusy(false)
    }
  }

  const replace = async () => {
    if (!previous) return
    const changed = modifiedSinceReception(previous)
    const yes = await confirm({
      title: `Mettre à jour « ${previous.title} » ?`,
      message: changed
        ? `Vous avez modifié votre recette le ${formatDate(previous.updatedAt)}, après l’avoir reçue. La fiche (titre, description, ingrédients, étapes, photos, astuces) sera remplacée par la version de ${item.sender.display_name} : vos modifications de la fiche seront perdues. Vos favoris, note, réalisations, notes personnelles et journal sont conservés. Pour garder vos modifications, choisissez plutôt « Garder les deux ».`
        : `La fiche sera remplacée par la nouvelle version de ${item.sender.display_name}. Vos favoris, note, réalisations, notes personnelles et journal sont conservés.`,
      confirmLabel: 'Mettre à jour',
      danger: changed,
      acknowledge: changed ? 'Je remplace ma version modifiée de la fiche.' : undefined,
    })
    if (yes) await run(() => syncService.decideReceived(item.id, { kind: 'replace', targetId: previous.id }), 'Recette mise à jour')
  }

  const decline = async () => {
    const yes = await confirm({ title: 'Refuser cette recette ?', message: 'Elle ne sera pas ajoutée à votre carnet.', confirmLabel: 'Refuser' })
    if (yes) await run(() => syncService.decideReceived(item.id, { kind: 'decline' }), 'Recette refusée', false)
  }

  return (
    <li className="rounded-[var(--radius-card)] bg-paper p-4 shadow-[var(--shadow-card)]">
      <div className="flex gap-3">
        {item.has_cover ? <Cover id={item.id} /> : <div className="size-20 shrink-0 rounded-xl bg-sunken" />}
        <div className="min-w-0 flex-1">
          <p className="font-serif text-lg leading-snug font-semibold">{item.title}</p>
          <p className="text-xs text-muted">
            Envoyée par {item.sender.display_name} · {relativeTime(item.created_at * 1000)}
          </p>
          <p className="text-xs text-faint">Disponible jusqu’au {formatDate(item.expires_at * 1000)}</p>
        </div>
      </div>
      {previous && (
        <p className="mt-3 rounded-xl bg-sunken p-2.5 text-sm">
          Nouvelle version d’une recette déjà reçue : <strong>« {previous.title} »</strong>
          {modifiedSinceReception(previous) && <span className="block text-xs text-terra">Vous l’avez modifiée depuis sa réception.</span>}
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {previous ? (
          <>
            <Button size="sm" loading={busy} onClick={() => void replace()}>
              Mettre à jour ma recette
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run(() => syncService.decideReceived(item.id, { kind: 'add' }), 'Nouvelle version ajoutée à côté de la précédente')}>
              Garder les deux
            </Button>
          </>
        ) : (
          <Button size="sm" loading={busy} onClick={() => void run(() => syncService.decideReceived(item.id, { kind: 'add' }), 'Recette ajoutée à votre carnet')}>
            Ajouter à mon carnet
          </Button>
        )}
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void decline()}>
          Refuser
        </Button>
      </div>
    </li>
  )
}

export default function ReceivedRecipesPage() {
  useSync()
  const [list, setList] = useState<TransferSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const recipes = useLiveQuery(() => db.recipes.filter((r) => !!r.receivedFrom).toArray(), [], [] as Recipe[])
  const load = useCallback(() => {
    syncService.api.inbox().then((x) => setList(x.filter((t) => t.kind === 'recipe')), (e) => setError(e instanceof Error ? e.message : 'Serveur injoignable.'))
  }, [])
  useEffect(load, [load])

  return (
    <>
      <TopBar back="/reglages/synchronisation" title="Recettes reçues" />
      <Page className="pt-2 pb-28">
        {error && <p className="mt-4 rounded-2xl bg-danger-soft p-4 text-sm text-danger">{error}</p>}
        {!list && !error && <LoadingBlock />}
        {list?.length === 0 && (
          <EmptyState icon={<Inbox size={28} />} title="Aucune recette reçue">
            Quand quelqu’un vous partage une recette, elle apparaît ici : vous choisissez de l’ajouter à votre carnet ou de la refuser.
          </EmptyState>
        )}
        <ul className="mt-3 space-y-3">
          {list?.map((t) => <ReceivedCard key={t.id} item={t} previous={previousCopy(recipes, t)} onDone={load} />)}
        </ul>
      </Page>
    </>
  )
}
