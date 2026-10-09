import { X } from 'lucide-react'
import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useOverlayHistory } from '@/hooks/useOverlayHistory'
import { IconButton } from './Button'

interface SheetProps {
  open: boolean
  onClose: () => void
  title?: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /** `full` : occupe tout l'écran (formulaires longs). */
  size?: 'auto' | 'tall' | 'full'
  /** Empêche la fermeture par clic extérieur (formulaire en cours). */
  dismissible?: boolean
}

/**
 * Feuille modale qui monte du bas de l'écran : zone d'action à portée du pouce.
 * Accessible : rôle dialog, piège du focus, Échap, bouton Retour Android.
 */
export function Sheet({ open, onClose, title, description, children, footer, size = 'auto', dismissible = true }: SheetProps) {
  const titleId = useId()
  const descId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useOverlayHistory(open, onClose)

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const focusables = () =>
      [...(panel?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])].filter(
        (el) => !el.hasAttribute('disabled'),
      )
    requestAnimationFrame(() => {
      const first = panel?.querySelector<HTMLElement>('[data-autofocus]') ?? panel
      first?.focus({ preventScroll: true })
    })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
      if (e.key === 'Tab') {
        const els = focusables()
        if (!els.length) return
        const first = els[0]
        const last = els[els.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = overflow
      previous?.focus?.({ preventScroll: true })
    }
  }, [open])

  if (!open) return null
  const heights = { auto: 'max-h-[90dvh]', tall: 'h-[90dvh]', full: 'h-[100dvh] !rounded-none' }
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <div className="absolute inset-0 bg-black/40 animate-fade" onClick={dismissible ? onClose : undefined} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={`relative flex w-full max-w-xl flex-col rounded-t-[1.75rem] bg-bg shadow-[var(--shadow-float)] animate-sheet-up outline-none ${heights[size]}`}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-line" aria-hidden="true" />
        {(title || description) && (
          <header className="flex items-start gap-3 px-5 pt-3 pb-2">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id={titleId} className="text-xl font-semibold leading-tight">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="mt-1 text-sm text-muted">
                  {description}
                </p>
              )}
            </div>
            <IconButton label="Fermer" size="sm" onClick={onClose} className="-mr-1">
              <X size={20} strokeWidth={1.75} />
            </IconButton>
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        {footer ? (
          <footer className="safe-bottom shrink-0 border-t border-line/70 bg-bg px-5 pt-3 pb-4">{footer}</footer>
        ) : (
          <div className="safe-bottom" />
        )}
      </div>
    </div>,
    document.body,
  )
}
