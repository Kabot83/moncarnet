/**
 * Recette et synchronisation : chaque compte a son carnet PRIVÉ (synchronisé entre ses appareils).
 * Mentions : « Reçue de … » pour une copie reçue, « Familiale » pour les anciennes recettes du
 * catalogue familial (jusqu'à leur conversion en copies privées), « Non synchronisée » pour la
 * démonstration. Rien ne s'affiche tant que la synchronisation n'est pas active.
 */
import { CloudOff, Inbox, Lock, LockOpen, Users } from 'lucide-react'
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
  if (!syncActive(s)) return null
  if (recipe.isDemo)
    return (
      <span className={`inline-flex items-center gap-0.5 text-faint ${className}`} title="Recette de démonstration : jamais synchronisée">
        <CloudOff size={11} strokeWidth={2} />
        Non synchronisée
      </span>
    )
  if (isFamily(recipe))
    return (
      <span className={`inline-flex items-center gap-0.5 text-terra ${className}`} title="Ancien catalogue familial : partagée et modifiable par les membres">
        <Users size={12} strokeWidth={2} />
        Familiale
      </span>
    )
  if (recipe.receivedFrom)
    return (
      <span className={`inline-flex items-center gap-0.5 text-muted ${className}`} title={`Copie reçue de ${recipe.receivedFrom.name}`}>
        <Inbox size={11} strokeWidth={2} />
        Reçue
      </span>
    )
  return null // privée : le cas normal, sans mention
}

/** « Reçue de Jona le 13 octobre » (copie indépendante). */
export function ReceivedLine({ recipe }: { recipe: Recipe }) {
  const r = recipe.receivedFrom
  if (!r) return null
  return <p className="mt-1 text-xs text-muted">Reçue de {r.name} {relativeTime(r.at)} · copie indépendante, modifiable librement</p>
}

/** Ligne d'information d'une recette familiale (auteur, dernier modificateur, verrou). */
export function FamilyLine({ recipe }: { recipe: Recipe }) {
  const s = useSync()
  const info = infoOf(recipe)
  if (syncActive(s) && recipe.isDemo)
    return <p className="mt-1 text-xs text-muted">Recette de démonstration : elle reste sur ce téléphone et n’est jamais synchronisée. Pour la garder dans votre carnet, menu ⋮ → « En faire ma recette ».</p>
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

/** Actions du menu de la fiche : démonstration → ma recette ; anciennes recettes familiales : garder privée, verrou. */
export function FamilyMenuItems({ recipe, close, Item }: { recipe: Recipe; close: () => void; Item: (p: { icon: typeof Users; label: string; onClick: () => void }) => React.ReactNode }) {
  const s = useSync()
  const confirm = useConfirm()
  const toast = useToast()
  if (!syncActive(s)) return null
  const run = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f()
      toast.success(ok)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action impossible pour le moment (réseau ?).')
    }
  }

  if (recipe.isDemo) {
    const adopt = async () => {
      close()
      const yes = await confirm({
        title: 'En faire ma recette ?',
        message: 'Cette recette de démonstration deviendra une recette de votre carnet privé, synchronisée entre vos appareils, avec ses photos.',
        confirmLabel: 'Garder dans mon carnet',
      })
      if (yes) await run(() => syncService.adoptDemoRecipe(recipe.id, 'personal'), 'Recette ajoutée à votre carnet')
    }
    return <>{Item({ icon: Lock, label: 'En faire ma recette', onClick: () => void adopt() })}</>
  }
  if (!s.family || !isFamily(recipe)) return null // plus aucune nouvelle recette familiale
  const info = infoOf(recipe)
  const mine = info?.createdBy?.login === s.user?.login
  const admin = s.family.role === 'admin'
  const others = s.family.members.length - 1

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

  return (
    <>
      {(mine || admin) && Item({ icon: Lock, label: 'Retirer du catalogue familial (garder privée)', onClick: () => void toPersonal() })}
      {(mine || admin) && Item({ icon: info?.lockedBy ? LockOpen : Lock, label: info?.lockedBy ? 'Déverrouiller la recette' : 'Verrouiller (moi seul la modifie)', onClick: () => void toggleLock() })}
    </>
  )
}
