import { useEffect, useState } from 'react'
import { isNative, nativeKeepAwake } from '@/platform/native'

/** Garde l'écran allumé (API Wake Lock) tant que `active` est vrai. */
export function useWakeLock(active: boolean): { supported: boolean; locked: boolean } {
  const supported = isNative || (typeof navigator !== 'undefined' && 'wakeLock' in navigator)
  const [locked, setLocked] = useState(false)
  useEffect(() => {
    if (!active || !supported) return
    if (isNative) {
      // Android : maintien natif de l'écran, fiable dans la WebView.
      void nativeKeepAwake(true).then(setLocked)
      return () => {
        void nativeKeepAwake(false)
        setLocked(false)
      }
    }
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false
    const request = async () => {
      try {
        sentinel = await navigator.wakeLock.request('screen')
        if (cancelled) return void sentinel.release()
        setLocked(true)
        sentinel.addEventListener('release', () => setLocked(false))
      } catch {
        setLocked(false)
      }
    }
    void request()
    // Le verrou est perdu quand l'application passe en arrière-plan : on le reprend.
    const onVisible = () => document.visibilityState === 'visible' && void request()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release().catch(() => undefined)
      setLocked(false)
    }
  }, [active, supported])
  return { supported, locked }
}
