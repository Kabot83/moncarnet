import { BellRing, Pause, Play, Plus, Timer as TimerIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { formatClock } from '@/lib/format'
import type { Timer } from '@/models/types'
import { isNative } from '@/platform/native'
import { addMinute, markTimerDone, pauseTimer, removeTimer, resumeTimer, useTimers } from '@/services/sessions'
import { IconButton } from './ui/Button'
import { Sheet } from './ui/Sheet'

/** Temps restant d'une minuterie à l'instant `now`. */
export function remaining(t: Timer, now: number): number {
  if (t.endsAt != null) return Math.max(0, t.endsAt - now)
  return t.remainingMs ?? 0
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Signal sonore discret, généré localement (aucun fichier audio). */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const ctx = new Ctx()
    const notes = [880, 660, 880, 660, 1046]
    notes.forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      const t0 = ctx.currentTime + i * 0.28
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.exponentialRampToValueAtTime(0.35, t0 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26)
      o.connect(g).connect(ctx.destination)
      o.start(t0)
      o.stop(t0 + 0.27)
    })
    setTimeout(() => void ctx.close(), 2000)
  } catch {
    /* audio indisponible */
  }
}

async function notify(label: string) {
  try {
    navigator.vibrate?.([300, 150, 300, 150, 600])
  } catch {
    /* vibration indisponible */
  }
  chime()
  try {
    // Android : la notification système est déjà programmée à l'heure exacte.
    if (!isNative && 'Notification' in window && Notification.permission === 'granted') {
      const reg = await navigator.serviceWorker?.getRegistration()
      const opts = { body: `${label} : c’est prêt !`, tag: `timer-${label}`, icon: 'icons/icon-192.png' }
      if (reg) await reg.showNotification('Minuterie terminée', opts)
      else new Notification('Minuterie terminée', opts)
    }
  } catch {
    /* notifications indisponibles */
  }
}

/** Surveille les minuteries en continu (même en mode cuisine) et sonne à la fin. */
export function TimerEngine() {
  const timers = useTimers()
  const now = useNow(500)
  const fired = useRef(new Set<string>())
  useEffect(() => {
    for (const t of timers) {
      if (!t.done && t.endsAt != null && t.endsAt <= now && !fired.current.has(t.id)) {
        fired.current.add(t.id)
        void markTimerDone(t.id)
        void notify(t.label)
      }
    }
  }, [timers, now])
  return null
}

export function TimerRow({ t, now }: { t: Timer; now: number }) {
  const left = remaining(t, now)
  const progress = 1 - left / t.durationMs
  const running = t.endsAt != null && !t.done
  return (
    <div className={`flex items-center gap-3 rounded-2xl p-3 ${t.done ? 'bg-terra-soft animate-pop' : 'bg-paper shadow-[var(--shadow-card)]'}`}>
      <div className="relative grid size-12 shrink-0 place-items-center">
        <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90" aria-hidden="true">
          <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeOpacity=".12" strokeWidth="3" />
          <circle
            cx="18"
            cy="18"
            r="16"
            fill="none"
            stroke="var(--c-terra)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${Math.min(1, Math.max(0, progress)) * 100.5} 100.5`}
          />
        </svg>
        {t.done ? <BellRing size={18} className="text-terra" /> : <TimerIcon size={18} className="text-muted" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted">{t.label}</p>
        <p className="font-serif text-2xl font-semibold tabular-nums" aria-live="off">
          {t.done ? 'Terminé' : formatClock(left)}
        </p>
      </div>
      {!t.done && (
        <IconButton label="Ajouter une minute" size="sm" onClick={() => void addMinute(t)}>
          <Plus size={18} />
        </IconButton>
      )}
      {!t.done &&
        (running ? (
          <IconButton label="Mettre en pause" size="sm" onClick={() => void pauseTimer(t)}>
            <Pause size={18} />
          </IconButton>
        ) : (
          <IconButton label="Reprendre" size="sm" onClick={() => void resumeTimer(t)}>
            <Play size={18} />
          </IconButton>
        ))}
      <IconButton label={t.done ? 'Fermer la minuterie' : 'Arrêter la minuterie'} size="sm" onClick={() => void removeTimer(t.id)}>
        <X size={18} />
      </IconButton>
    </div>
  )
}

/** Pastille flottante listant les minuteries en cours, partout dans l'app. */
export function TimersDock() {
  const timers = useTimers()
  const now = useNow()
  const [open, setOpen] = useState(false)
  if (!timers.length) return null
  const next = [...timers].sort((a, b) => remaining(a, now) - remaining(b, now))
  const doneCount = timers.filter((t) => t.done).length
  const first = next.find((t) => !t.done)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`hide-on-keyboard above-nav fixed left-4 z-30 flex h-12 items-center gap-2 rounded-full px-4 font-semibold shadow-[var(--shadow-float)] animate-fade-up ${
          doneCount ? 'bg-terra text-white dark:text-[#1b1916]' : 'bg-ink text-bg'
        }`}
        aria-label={`${timers.length} minuterie(s). Ouvrir`}
      >
        {doneCount ? <BellRing size={18} className="animate-bounce" /> : <TimerIcon size={18} />}
        <span className="tabular-nums">{doneCount ? 'Minuterie terminée' : first ? formatClock(remaining(first, now)) : ''}</span>
        {timers.length > 1 && <span className="rounded-full bg-white/20 px-2 text-xs">{timers.length}</span>}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Minuteries">
        <div className="space-y-2 pb-2">
          {next.map((t) => (
            <TimerRow key={t.id} t={t} now={now} />
          ))}
        </div>
      </Sheet>
    </>
  )
}
