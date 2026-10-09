/**
 * Clavier virtuel : un seul état, `<html data-keyboard="open|closed">`, utilisé
 * par les styles pour masquer la navigation inférieure et les boutons flottants
 * pendant la saisie, puis les restaurer.
 *
 * - Android (APK) : l'activité native envoie l'événement « mc-keyboard ».
 * - Navigateur (PWA) : la page est redimensionnée par le clavier
 *   (`interactive-widget=resizes-content` dans index.html) ; on compare la
 *   hauteur à la hauteur de référence, en ne comptant que si un champ de saisie
 *   a le focus (une rotation d'écran ne doit pas être prise pour un clavier).
 */
import { useSyncExternalStore } from 'react'
import { isNative } from './native'

let open = false
const listeners = new Set<() => void>()

function setOpen(next: boolean) {
  if (next === open) return
  open = next
  document.documentElement.dataset.keyboard = next ? 'open' : 'closed'
  listeners.forEach((l) => l())
  if (next) keepFocusedFieldVisible()
}

export function isEditable(el: Element | null): boolean {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly
  if (el instanceof HTMLInputElement)
    return !el.readOnly && !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color', 'image', 'hidden'].includes(el.type)
  return (el as HTMLElement).isContentEditable === true
}

/** Le champ actif reste visible au-dessus du clavier. */
function keepFocusedFieldVisible() {
  setTimeout(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el || !isEditable(el)) return
    const r = el.getBoundingClientRect()
    const viewport = window.visualViewport?.height ?? window.innerHeight
    if (r.top < 64 || r.bottom > viewport - 16) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, 80)
}

/** Seuil : en dessous, c'est une barre d'adresse qui bouge, pas un clavier. */
export const KEYBOARD_MIN_HEIGHT = 120

/** Décision pure (testée) pour la PWA. */
export function webKeyboardOpen(baseline: number, current: number, focusedEditable: boolean): boolean {
  return focusedEditable && baseline - current > KEYBOARD_MIN_HEIGHT
}

let started = false

export function initKeyboard(): void {
  if (started || typeof window === 'undefined') return
  started = true
  document.documentElement.dataset.keyboard = 'closed'

  if (isNative) {
    window.addEventListener('mc-keyboard', (e) => setOpen(Boolean((e as CustomEvent<{ open: boolean }>).detail?.open)))
    if ((window as unknown as { __mcKeyboardOpen?: boolean }).__mcKeyboardOpen) setOpen(true)
    return
  }

  let width = window.innerWidth
  let baseline = window.innerHeight
  const evaluate = () => {
    const h = window.visualViewport?.height ?? window.innerHeight
    if (window.innerWidth !== width) {
      // Rotation ou redimensionnement de fenêtre : nouvelle référence.
      width = window.innerWidth
      baseline = h
    }
    const focused = isEditable(document.activeElement)
    // Sans champ actif, ou si la page s'agrandit, la hauteur courante devient la référence.
    if (!focused || h > baseline) baseline = h
    setOpen(webKeyboardOpen(baseline, h, focused))
  }
  window.visualViewport?.addEventListener('resize', evaluate)
  window.addEventListener('resize', evaluate)
  document.addEventListener('focusin', () => setTimeout(evaluate, 250))
  document.addEventListener('focusout', () => setTimeout(evaluate, 120))
}

export function useKeyboardOpen(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => open,
    () => false,
  )
}
