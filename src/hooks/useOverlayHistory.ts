/**
 * Bouton Retour Android : chaque panneau ouvert (feuille, dialogue) ajoute une
 * entrée d'historique. « Retour » ferme le panneau au lieu de quitter la page.
 *
 * Quand l'application ferme elle-même un panneau, son entrée d'historique est
 * laissée en place mais marquée « morte » : si l'utilisateur revient dessus
 * plus tard, elle est sautée automatiquement. Cette approche évite toute
 * course entre `history.back()` asynchrone et l'ouverture d'un autre panneau.
 *
 * Pour naviguer depuis un panneau, `useSafeNavigate()` remplace l'entrée du
 * panneau au lieu d'en empiler une nouvelle.
 */
import { useCallback, useEffect, useRef } from 'react'
import { type NavigateOptions, type To, useNavigate } from 'react-router-dom'

interface Entry {
  id: string
  onBack: () => void
}

const stack: Entry[] = []
let listening = false
let counter = 0

const currentOverlay = () => (window.history.state as { mcOverlay?: string } | null)?.mcOverlay

function onPopState() {
  const current = currentOverlay()
  const liveIndex = current ? stack.findIndex((e) => e.id === current) : -1
  // Ferme les panneaux ouverts au-dessus de l'entrée devenue courante.
  while (stack.length > liveIndex + 1) stack.pop()!.onBack()
  // Entrée d'un panneau déjà fermé : on la saute.
  if (current && liveIndex === -1) window.history.back()
}

export function useOverlayHistory(open: boolean, onBack: () => void) {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack

  useEffect(() => {
    if (!open) return
    if (!listening) {
      window.addEventListener('popstate', onPopState)
      listening = true
    }
    const entry: Entry = { id: `ov${Date.now().toString(36)}${++counter}`, onBack: () => onBackRef.current() }
    stack.push(entry)
    window.history.pushState({ ...(window.history.state ?? {}), mcOverlay: entry.id }, '')
    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [open])
}

/** `navigate` qui remplace l'entrée d'un panneau au lieu d'empiler. */
export function useSafeNavigate() {
  const navigate = useNavigate()
  return useCallback(
    (to: To, options: NavigateOptions = {}) => {
      navigate(to, currentOverlay() ? { ...options, replace: true } : options)
    },
    [navigate],
  )
}
