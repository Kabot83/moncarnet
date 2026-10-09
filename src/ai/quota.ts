/**
 * Compteur LOCAL d'appels IA par jour.
 *
 * Ce compteur est une limite que vous vous fixez pour éviter les appels
 * inutiles. Ce n'est PAS le quota officiel restant chez Google, que Mon Carnet
 * ne peut pas connaître : Google peut refuser un appel (erreur 429) avant que
 * votre limite locale soit atteinte.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { localDay } from '@/lib/format'
import { getSettings } from '@/services/settings'
import { AiError, aiMessage } from './errors'

export async function usedToday(): Promise<number> {
  return (await db.aiUsage.get(localDay()))?.count ?? 0
}

export function useAiUsage(): number {
  return useLiveQuery(usedToday, [], 0)
}

/** Vérifie la limite puis comptabilise l'appel (avant envoi : chaque tentative compte). */
export async function consumeCall(): Promise<void> {
  const { aiDailyLimit } = await getSettings()
  await db.transaction('rw', db.aiUsage, async () => {
    const day = localDay()
    const count = (await db.aiUsage.get(day))?.count ?? 0
    if (aiDailyLimit > 0 && count >= aiDailyLimit) throw new AiError('local-limit', aiMessage('local-limit'))
    await db.aiUsage.put({ day, count: count + 1 })
  })
  // Ménage : on ne garde que 30 jours d'historique.
  const old = localDay(Date.now() - 30 * 86_400_000)
  await db.aiUsage.where('day').below(old).delete()
}
