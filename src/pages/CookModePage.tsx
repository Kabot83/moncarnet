import { useLiveQuery } from 'dexie-react-hooks'
import { ChevronLeft, ChevronRight, Flag, ListChecks, Maximize, Minimize, Sun, Thermometer, Timer as TimerIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { IngredientScaler } from '@/components/IngredientScaler'
import { JournalEntrySheet } from '@/components/JournalEntrySheet'
import { TimerRow, useNow } from '@/components/TimersDock'
import { Button, IconButton } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Feedback'
import { Photo } from '@/components/ui/Layout'
import { Sheet } from '@/components/ui/Sheet'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { useWakeLock } from '@/hooks/useWakeLock'
import { formatDuration } from '@/lib/format'
import { IDENTITY_SCALE, isAdjusted } from '@/lib/scaling'
import { addTimer, endSession, setCurrentStep, setSessionScale, startCooking, toggleChecked, useSession, useTimers } from '@/services/sessions'

export default function CookModePage() {
  const { id = '' } = useParams()
  const navigate = useSafeNavigate()
  const toast = useToast()
  const recipe = useLiveQuery(() => db.recipes.get(id), [id])
  const session = useSession(id)
  const timers = useTimers().filter((t) => t.recipeId === id)
  const now = useNow()
  const { supported: wakeSupported, locked } = useWakeLock(true)
  const [ingredientsOpen, setIngredientsOpen] = useState(false)
  const [finishOpen, setFinishOpen] = useState(false)
  const [journalOpen, setJournalOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement)
  const touch = useRef<{ x: number; y: number } | null>(null)

  // La préparation est conservée : on la crée (ou la marque démarrée) en entrant.
  useEffect(() => {
    if (session === null || (session && !session.started)) void startCooking(id)
  }, [session, id])

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => {
      document.removeEventListener('fullscreenchange', on)
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    }
  }, [])

  if (recipe === undefined || session === undefined) return <LoadingBlock />
  if (!recipe) return <LoadingBlock label="Recette introuvable." />

  const scale = session?.scale ?? IDENTITY_SCALE
  const total = recipe.steps.length + 1 // écran 0 = mise en place
  const current = Math.min(session?.currentStep ?? 0, total - 1)
  const step = current > 0 ? recipe.steps[current - 1] : null
  const checked = session?.checkedIngredientIds ?? []
  const go = (k: number) => void setCurrentStep(id, Math.max(0, Math.min(total - 1, k)))

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await document.documentElement.requestFullscreen()
    } catch {
      toast.info('Le plein écran n’est pas disponible sur cet appareil.')
    }
  }

  const finish = async (withJournal: boolean) => {
    setFinishOpen(false)
    if (withJournal) {
      setJournalOpen(true)
      return
    }
    await endSession(id)
    navigate(`/recettes/${id}`, { replace: true })
  }

  return (
    <div
      className="flex min-h-dvh flex-col bg-bg"
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const s = touch.current
        touch.current = null
        if (!s) return
        const dx = e.changedTouches[0].clientX - s.x
        const dy = e.changedTouches[0].clientY - s.y
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) go(current + (dx < 0 ? 1 : -1))
      }}
    >
      <header className="safe-top sticky top-0 z-20 bg-bg/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-2 px-3">
          <IconButton label="Quitter le mode cuisine" size="lg" onClick={() => navigate(`/recettes/${id}`)}>
            <X size={26} />
          </IconButton>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate font-serif text-lg font-semibold">{recipe.title}</p>
            <p className="text-xs text-muted">
              {current === 0 ? 'Mise en place' : `Étape ${current} sur ${recipe.steps.length}`}
              {wakeSupported && locked && (
                <span className="ml-2 inline-flex items-center gap-1 text-sage">
                  <Sun size={11} /> écran allumé
                </span>
              )}
            </p>
          </div>
          <IconButton label={fullscreen ? 'Quitter le plein écran' : 'Plein écran'} size="lg" onClick={() => void toggleFullscreen()}>
            {fullscreen ? <Minimize size={22} /> : <Maximize size={22} />}
          </IconButton>
        </div>
        <div className="h-1.5 w-full bg-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={total - 1} aria-valuenow={current} aria-label="Progression">
          <div className="h-full bg-terra transition-[width] duration-300" style={{ width: `${(current / Math.max(1, total - 1)) * 100}%` }} />
        </div>
      </header>

      {timers.length > 0 && (
        <div className="mx-auto w-full max-w-3xl space-y-2 px-4 pt-3">
          {timers.map((t) => (
            <TimerRow key={t.id} t={t} now={now} />
          ))}
        </div>
      )}

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-5 pt-6 pb-40" aria-live="polite">
        {current === 0 ? (
          <div key="prep" className="animate-fade-up">
            <h1 className="font-serif text-3xl font-semibold">Mise en place</h1>
            <p className="mt-1 mb-5 text-muted">Cochez les ingrédients au fur et à mesure. Vous pouvez encore ajuster les quantités.</p>
            <IngredientScaler
              recipe={recipe}
              scale={scale}
              onScaleChange={(s) => void setSessionScale(id, s)}
              checkable
              checked={checked}
              onToggleChecked={(ing) => void toggleChecked(id, ing)}
              large
            />
          </div>
        ) : step ? (
          <div key={step.id} className="animate-fade-up">
            <p className="font-serif text-6xl font-semibold text-terra/80">{current}</p>
            <p className="mt-4 text-[1.6rem] leading-[1.45] font-medium whitespace-pre-line">{step.text}</p>
            {step.photoId && <Photo id={step.photoId} alt="" variant="full" className="mt-5 aspect-video rounded-2xl" />}
            <div className="mt-6 flex flex-wrap gap-3">
              {step.temperatureC != null && (
                <span className="inline-flex h-12 items-center gap-2 rounded-full bg-sunken px-5 text-lg font-semibold">
                  <Thermometer size={20} /> {step.temperatureC} °C
                </span>
              )}
              {(step.timerMin || step.durationMin) && (
                <Button
                  size="lg"
                  variant="soft"
                  icon={<TimerIcon size={20} />}
                  onClick={() => {
                    void addTimer(`Étape ${current} — ${recipe.title}`, (step.timerMin ?? step.durationMin)!, id)
                    toast.success('Minuterie lancée')
                  }}
                >
                  Minuterie {formatDuration(step.timerMin ?? step.durationMin)}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-muted">Cette recette n’a pas encore d’étapes.</p>
        )}
      </main>

      <nav className="hide-on-keyboard safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-line/70 bg-bg/95 backdrop-blur" aria-label="Navigation des étapes">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <IconButton label="Étape précédente" size="lg" tone="paper" disabled={current === 0} onClick={() => go(current - 1)} className="!size-16">
            <ChevronLeft size={30} />
          </IconButton>
          <button
            type="button"
            onClick={() => setIngredientsOpen(true)}
            className="flex h-16 flex-1 items-center justify-center gap-2 rounded-full bg-paper text-[15px] font-semibold shadow-[var(--shadow-card)]"
          >
            <ListChecks size={20} /> Ingrédients
            {isAdjusted(scale) && <span className="rounded-full bg-terra-soft px-2 text-xs text-terra-strong">ajustés</span>}
          </button>
          {current < total - 1 ? (
            <IconButton label="Étape suivante" size="lg" tone="terra" onClick={() => go(current + 1)} className="!size-16">
              <ChevronRight size={30} />
            </IconButton>
          ) : (
            <IconButton label="Terminer la préparation" size="lg" tone="terra" onClick={() => setFinishOpen(true)} className="!size-16">
              <Flag size={26} />
            </IconButton>
          )}
        </div>
      </nav>

      <Sheet open={ingredientsOpen} onClose={() => setIngredientsOpen(false)} title="Ingrédients" size="tall">
        <IngredientScaler
          recipe={recipe}
          scale={scale}
          onScaleChange={(s) => void setSessionScale(id, s)}
          checkable
          checked={checked}
          onToggleChecked={(ing) => void toggleChecked(id, ing)}
          large
        />
      </Sheet>

      <Sheet open={finishOpen} onClose={() => setFinishOpen(false)} title="Bon appétit !" description="La préparation est terminée. La prochaine repartira des quantités d’origine.">
        <div className="space-y-3 pb-2">
          <Button block size="lg" onClick={() => void finish(true)}>
            Noter cette réalisation dans le journal
          </Button>
          <Button block size="lg" variant="secondary" onClick={() => void finish(false)}>
            Terminer sans noter
          </Button>
          <Button block variant="ghost" onClick={() => setFinishOpen(false)}>
            Continuer la préparation
          </Button>
        </div>
      </Sheet>

      <JournalEntrySheet
        open={journalOpen}
        onClose={() => setJournalOpen(false)}
        recipe={recipe}
        scale={scale}
        onSaved={async () => {
          await endSession(id)
          navigate(`/recettes/${id}`, { replace: true })
        }}
      />
    </div>
  )
}
