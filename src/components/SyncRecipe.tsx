/**
 * Recette et synchronisation familiale : indication « Familiale » / « Privée », auteur, verrou,
 * déplacement entre le catalogue familial et le carnet personnel.
 * Rien ne s'affiche tant que la synchronisation n'est pas active (carnet local comme avant).
 */
import { Lock, LockOpen, Users } from 'lucide-react'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { relativeTime } from '@/lib/format'
import type { Recipe } from '@/models/types'
import type { FamilyInfo } from '@/sync/api'
import { syncActive, syncService, useSync } from '@/sync/instance'

export const isFamily = (r: Recipe) => r.space === 'family'
const infoOf = (r: Recipe) => (r.familyInfo ?? null) as FamilyInfo | null

/** Petite mention discrète sur les cartes et la fiche. */
export function SpaceBadge({ recipe, className = '' }: { recipe: Recipe; className?: string }) {
  const s = useSync()
  if (!syncActive(s) || recipe.isDemo) return null
  return isFamily(recipe) ? (
    <span className={`inline-flex items-center gap-0.5 text-terra ${className}`} title="Visible par la famille">
      <Users size={12} strokeWidth={2} />
      Familiale
    </span>
  ) : (
    <span className={`inline-flex items-center gap-0.5 text-faint ${className}`} title="Visible de vous seul">
      <Lock size={11} strokeWidth={2} />
      Privée
    </span>
  )
}

/** Ligne d'information d'une recette familiale (auteur, dernier modificateur, verrou). */
export function FamilyLine({ recipe }: { recipe: Recipe }) {
  const s = useSync()
  const info = infoOf(recipe)
  if (!syncActive(s) || !isFamily(recipe) || !info) return null
  const parts = [info.createdBy && `Ajoutée par ${info.createdBy.name}`, info.updatedBy && info.updatedAt && `modifiée par ${info.updatedBy.name} ${relativeTime(info.updatedAt * 1000)}`].filter(Boolean)
  return (
    <p className="mt-1 text-xs text-muted">
      {parts.join(' · ')}
      {info.lockedBy && <span className="ml-1 inline-flex items-center gap-0.5 text-terra"><Lock size={11} /> verrouillée par {info.lockedBy.name}</span>}
    </p>
  )
}

/** Verrouillée par un autre membre (seuls l'auteur et l'administrateur peuvent la modifier). */
export function lockedForMe(recipe: Recipe, login: string | undefined, role: string | undefined): string | null {
  const l = infoOf(recipe)?.lockedBy
  return l && l.login !== login && role !== 'admin' ? l.name : null
}

/** Actions du menu de la fiche : déplacer, verrouiller. `Item` = élément de menu de la page. */
export function FamilyMenuItems({ recipe, close, Item }: { recipe: Recipe; close: () => void; Item: (p: { icon: typeof Users; label: string; onClick: () => void }) => React.ReactNode }) {
  const s = useSync()
  const confirm = useConfirm()
  const toast = useToast()
  if (!syncActive(s) || !s.family || recipe.isDemo) return null
  const info = infoOf(recipe)
  const mine = info?.createdBy?.login === s.user?.login
  const admin = s.family.role === 'admin'
  const others = s.family.members.length - 1

  const run = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f()
      toast.success(ok)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action impossible pour le moment (réseau ?).')
    }
  }

  const toFamily = async () => {
    close()
    const yes = await confirm({
      title: `Partager avec « ${s.family!.name} » ?`,
      message: `La recette, ses ingrédients, étapes, photos et astuces seront visibles et modifiables par ${others > 0 ? `${others} autre(s) membre(s)` : 'les membres de la famille'}. Vos favoris, note et notes personnelles restent privés.`,
      confirmLabel: 'Partager',
    })
    if (yes) await run(() => syncService.moveRecipe(recipe.id, 'family'), 'Recette ajoutée au catalogue familial')
  }

  const toPersonal = async () => {
    close()
    const yes = await confirm({
      title: 'Retirer du catalogue familial ?',
      message: `Vous gardez la recette complète dans votre carnet privé. Pour ${others > 0 ? `les ${others} autre(s) membre(s)` : 'la famille'}, elle passe dans la corbeille familiale (restaurable 30 jours).`,
      confirmLabel: 'Retirer du catalogue',
      acknowledge: others > 0 ? 'Les autres membres ne la verront plus.' : undefined,
    })
    if (yes) await run(() => syncService.moveRecipe(recipe.id, 'personal'), 'Recette retirée du catalogue familial')
  }

  const toggleLock = async () => {
    close()
    const locked = !!info?.lockedBy
    await run(async () => {
      await syncService.api.setLock(recipe.id, !locked)
      await syncService.syncNow('verrou')
    }, locked ? 'Recette déverrouillée' : 'Recette verrouillée : seuls vous et l’administrateur pourrez la modifier')
  }

  if (!isFamily(recipe)) return <>{Item({ icon: Users, label: 'Partager avec la famille', onClick: () => void toFamily() })}</>
  return (
    <>
      {(mine || admin) && Item({ icon: Lock, label: 'Retirer du catalogue familial (garder privée)', onClick: () => void toPersonal() })}
      {(mine || admin) && Item({ icon: info?.lockedBy ? LockOpen : Lock, label: info?.lockedBy ? 'Déverrouiller la recette' : 'Verrouiller (moi seul la modifie)', onClick: () => void toggleLock() })}
    </>
  )
}
