/**
 * Préparation en cours et minuteries.
 *
 * Les ajustements temporaires sont stockés dans une « session » par recette :
 * ils survivent à la fermeture de l'application pendant la préparation, mais
 * une nouvelle préparation repart toujours des quantités d'origine.
 */
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { newId } from '@/lib/id'
import { resetScale } from '@/lib/scaling'
import type { CookingSession, ScaleState, Timer } from '@/models/types'

export function useSession(recipeId: string | undefined): CookingSession | null | undefined {
  return useLiveQuery(async () => (recipeId ? ((await db.sessions.get(recipeId)) ?? null) : null), [recipeId])
}

async function upsert(recipeId: string, patch: Partial<CookingSession>): Promise<CookingSession> {
  return db.transaction('rw', db.sessions, async () => {
    const now = Date.now()
    const existing = await db.sessions.get(recipeId)
    const next: CookingSession = {
      recipeId,
      scale: resetScale(),
      checkedIngredientIds: [],
      currentStep: 0,
      started: false,
      startedAt: now,
      ...existing,
      ...patch,
      updatedAt: now,
    }
    await db.sessions.put(next)
    return next
  })
}

export const setSessionScale = (recipeId: string, scale: ScaleState) => upsert(recipeId, { scale })

/** « Utiliser pour cette préparation » : fige les proportions pour la session cuisine. */
export const startCooking = (recipeId: string) => upsert(recipeId, { started: true })

export const setCurrentStep = (recipeId: string, currentStep: number) => upsert(recipeId, { currentStep })

export async function toggleChecked(recipeId: string, ingredientId: string) {
  const s = await db.sessions.get(recipeId)
  const list = s?.checkedIngredientIds ?? []
  await upsert(recipeId, {
    checkedIngredientIds: list.includes(ingredientId) ? list.filter((x) => x !== ingredientId) : [...list, ingredientId],
  })
}

/** Réinitialise les quantités (la session reste ouverte). */
export const resetSessionScale = (recipeId: string) => upsert(recipeId, { scale: resetScale() })

/** Termine la préparation : la prochaine repartira des quantités d'origine. */
export async function endSession(recipeId: string) {
  await db.sessions.delete(recipeId)
  await db.timers.where('recipeId').equals(recipeId).delete()
}

// ---------------------------------------------------------------------------
// Minuteries (plusieurs en parallèle, persistées)
// ---------------------------------------------------------------------------

export function useTimers(): Timer[] {
  return useLiveQuery(() => db.timers.orderBy('endsAt').toArray(), [], [])
}

export async function addTimer(label: string, minutes: number, recipeId: string | null = null): Promise<string> {
  const id = newId('t_')
  const durationMs = Math.max(1, minutes) * 60_000
  await db.timers.put({ id, label, recipeId, durationMs, endsAt: Date.now() + durationMs, remainingMs: null, done: false, createdAt: Date.now() })
  ensureNotificationPermission()
  return id
}

export async function pauseTimer(t: Timer) {
  if (t.endsAt == null) return
  await db.timers.update(t.id, { endsAt: null, remainingMs: Math.max(0, t.endsAt - Date.now()) })
}

export async function resumeTimer(t: Timer) {
  if (t.remainingMs == null) return
  await db.timers.update(t.id, { endsAt: Date.now() + t.remainingMs, remainingMs: null })
}

export async function addMinute(t: Timer, minutes = 1) {
  const ms = minutes * 60_000
  if (t.endsAt != null) await db.timers.update(t.id, { endsAt: Math.max(Date.now(), t.endsAt) + ms, done: false, durationMs: t.durationMs + ms })
  else await db.timers.update(t.id, { remainingMs: (t.remainingMs ?? 0) + ms, durationMs: t.durationMs + ms })
}

export const removeTimer = (id: string) => db.timers.delete(id)
export const markTimerDone = (id: string) => db.timers.update(id, { done: true })

function ensureNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
  } catch {
    /* Notifications indisponibles : l'alerte sonore et la vibration suffisent */
  }
}
