import { RefreshCw, X } from 'lucide-react'
import { useEffect } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { isNative } from '@/platform/native'

/** Dans l'APK, pas de service worker : les mises à jour passent par une nouvelle version de l'application. */
export function UpdatePrompt() {
  return isNative ? null : <PwaUpdatePrompt />
}

/** Propose la mise à jour quand une nouvelle version est en cache (jamais forcée en pleine recette). */
function PwaUpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW()
  // Simple information : elle disparaît d'elle-même.
  useEffect(() => {
    if (!offlineReady) return
    const t = setTimeout(() => setOfflineReady(false), 5000)
    return () => clearTimeout(t)
  }, [offlineReady, setOfflineReady])
  if (!needRefresh && !offlineReady) return null
  return (
    <div className="hide-on-keyboard above-nav pointer-events-none fixed inset-x-0 z-[65] flex justify-center px-4" role="status">
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-sm text-bg shadow-[var(--shadow-float)] animate-fade-up">
        <span className="flex-1">
          {needRefresh ? 'Une nouvelle version de Mon Carnet est prête.' : 'Mon Carnet fonctionne désormais hors ligne.'}
        </span>
        {needRefresh && (
          <button className="flex items-center gap-1.5 font-semibold text-[#f0b79c]" onClick={() => void updateServiceWorker(true)}>
            <RefreshCw size={16} /> Mettre à jour
          </button>
        )}
        <button
          aria-label="Masquer"
          className="text-bg/60"
          onClick={() => {
            setNeedRefresh(false)
            setOfflineReady(false)
          }}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
