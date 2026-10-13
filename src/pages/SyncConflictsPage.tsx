/**
 * Modifications à revoir (catalogue familial) : deux membres ont modifié le même élément d'une
 * recette. La version enregistrée est restée en place et la proposition écartée est conservée ;
 * on choisit ici, élément par élément. Rien n'est jamais tranché en silence.
 */
import { CheckCircle2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Feedback'
import { EmptyState, Page, TopBar } from '@/components/ui/Layout'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { relativeTime } from '@/lib/format'
import type { FamilyConflict } from '@/sync/api'
import { applyChoices, describePath, describeValue } from '@/sync/conflicts'
import { syncService } from '@/sync/instance'

function ConflictCard({ c, onDone }: { c: FamilyConflict; onDone: () => void }) {
  const toast = useToast()
  const [title, setTitle] = useState<string>('')
  const [take, setTake] = useState<boolean[]>(() => c.items.map(() => false))
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void db.recipes.get(c.recipeId).then((r) => setTitle(r?.title ?? String(c.mine.title ?? 'Recette')))
  }, [c])

  const apply = async () => {
    setBusy(true)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await syncService.syncNow('conflit') // version actuelle à jour
        const cur = await syncService.engine.familyRecipeState(c.recipeId)
        if (!cur) throw new Error('Recette introuvable sur ce téléphone : synchronisez puis réessayez.')
        const keepCurrent = take.every((t) => !t)
        try {
          await syncService.api.resolveConflict(c.id, keepCurrent ? null : applyChoices(cur.data, c.items, take), keepCurrent ? null : cur.rev)
          break
        } catch (e) {
          if (attempt === 1 || (e as { status?: number }).status !== 409) throw e // recette modifiée entre-temps : nouvel essai
        }
      }
      await syncService.syncNow('conflit')
      await syncService.refreshCounters()
      toast.success('Choix enregistré pour toute la famille')
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Résolution impossible.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mt-5 rounded-[var(--radius-card)] bg-paper p-4 shadow-[var(--shadow-card)]">
      <h2 className="font-serif text-lg font-semibold">{title}</h2>
      <p className="text-xs text-muted">
        Proposition de {c.by.name} · {relativeTime(c.createdAt * 1000)}
      </p>
      <div className="mt-3 space-y-4">
        {c.items.map((it, i) => (
          <fieldset key={it.path} className="space-y-1.5">
            <legend className="mb-1 text-sm font-semibold">{describePath(it.path, it)}</legend>
            {[false, true].map((proposal) => (
              <label key={String(proposal)} className={`flex cursor-pointer items-start gap-2 rounded-xl p-2.5 text-sm ${take[i] === proposal ? 'bg-terra-soft' : 'bg-sunken'}`}>
                <input type="radio" className="mt-0.5 accent-[var(--c-terra)]" checked={take[i] === proposal} onChange={() => setTake((t) => t.map((v, j) => (j === i ? proposal : v)))} />
                <span>
                  <span className="block text-xs text-muted">{proposal ? `Proposition de ${c.by.name}` : 'Version actuelle'}</span>
                  {describeValue(it.path, proposal ? it.mine : it.theirs)}
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <Button block className="mt-4" loading={busy} onClick={() => void apply()}>
        Valider mon choix
      </Button>
    </section>
  )
}

export default function SyncConflictsPage() {
  const [list, setList] = useState<FamilyConflict[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    syncService.api.familyConflicts().then(setList, (e) => setError(e instanceof Error ? e.message : 'Serveur injoignable.'))
  }, [])
  useEffect(load, [load])

  return (
    <>
      <TopBar back="/reglages/synchronisation" title="Modifications à revoir" />
      <Page className="pt-2 pb-28">
        {error && <p className="mt-4 rounded-2xl bg-danger-soft p-4 text-sm text-danger">{error}</p>}
        {!list && !error && <LoadingBlock />}
        {list?.length === 0 && (
          <EmptyState icon={<CheckCircle2 size={28} />} title="Rien à revoir">
            Les modifications de la famille ont toutes été fusionnées automatiquement.
          </EmptyState>
        )}
        {list?.map((c) => <ConflictCard key={c.id} c={c} onDone={load} />)}
      </Page>
    </>
  )
}
