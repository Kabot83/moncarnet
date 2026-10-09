/**
 * Retours utilisateur : messages éphémères (toasts) et confirmations.
 *   const toast = useToast();  toast.success('Recette enregistrée')
 *   const confirm = useConfirm();  if (await confirm({...})) …
 */
import { AlertTriangle, Check, Info, X } from 'lucide-react'
import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button } from './Button'
import { Sheet } from './Sheet'

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  message: string
  action?: { label: string; onClick: () => void }
}

interface ToastApi {
  success: (m: string, action?: ToastItem['action']) => void
  error: (m: string, action?: ToastItem['action']) => void
  info: (m: string, action?: ToastItem['action']) => void
}

interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  /** Exige de cocher une case explicite avant de confirmer. */
  acknowledge?: string
}

const ToastCtx = createContext<ToastApi | null>(null)
const ConfirmCtx = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null)

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const seq = useRef(0)
  const push = useCallback((kind: ToastKind, message: string, action?: ToastItem['action']) => {
    const id = ++seq.current
    setToasts((t) => [...t.slice(-2), { id, kind, message, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : action ? 6000 : 3200)
  }, [])
  const api = useMemo<ToastApi>(
    () => ({
      success: (m, a) => push('success', m, a),
      error: (m, a) => push('error', m, a),
      info: (m, a) => push('info', m, a),
    }),
    [push],
  )

  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const [ack, setAck] = useState(false)
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setAck(false)
        setConfirmState({ ...o, resolve })
      }),
    [],
  )
  const settle = (v: boolean) => {
    confirmState?.resolve(v)
    setConfirmState(null)
  }

  return (
    <ToastCtx.Provider value={api}>
      <ConfirmCtx.Provider value={confirm}>
        {children}
        <Sheet
          open={!!confirmState}
          onClose={() => settle(false)}
          title={confirmState?.title}
          footer={
            <div className="flex gap-3">
              <Button variant="secondary" block onClick={() => settle(false)}>
                {confirmState?.cancelLabel ?? 'Annuler'}
              </Button>
              <Button
                variant={confirmState?.danger ? 'danger' : 'primary'}
                block
                disabled={!!confirmState?.acknowledge && !ack}
                onClick={() => settle(true)}
                data-autofocus
              >
                {confirmState?.confirmLabel ?? 'Confirmer'}
              </Button>
            </div>
          }
        >
          {confirmState?.message && <div className="text-[15px] text-muted">{confirmState.message}</div>}
          {confirmState?.acknowledge && (
            <label className="mt-4 flex items-start gap-3 rounded-2xl bg-sunken p-3 text-sm">
              <input type="checkbox" className="mt-0.5 size-5 accent-[var(--c-terra)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>{confirmState.acknowledge}</span>
            </label>
          )}
        </Sheet>
        {createPortal(
          <div
            className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4"
            aria-live="polite"
            role="status"
          >
            {toasts.map((t) => (
              <div
                key={t.id}
                className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-ink px-4 py-3 text-[15px] text-bg shadow-[var(--shadow-float)] animate-fade-up"
              >
                <span className={t.kind === 'error' ? 'text-[#f4a39a]' : t.kind === 'success' ? 'text-[#b9cba9]' : 'text-bg/70'}>
                  {t.kind === 'error' ? <AlertTriangle size={18} /> : t.kind === 'success' ? <Check size={18} /> : <Info size={18} />}
                </span>
                <span className="flex-1">{t.message}</span>
                {t.action && (
                  <button
                    className="font-semibold text-[#f0b79c]"
                    onClick={() => {
                      t.action!.onClick()
                      setToasts((x) => x.filter((y) => y.id !== t.id))
                    }}
                  >
                    {t.action.label}
                  </button>
                )}
                <button aria-label="Masquer" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-bg/60">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
      </ConfirmCtx.Provider>
    </ToastCtx.Provider>
  )
}

export function useToast(): ToastApi {
  const c = useContext(ToastCtx)
  if (!c) throw new Error('FeedbackProvider manquant')
  return c
}

export function useConfirm() {
  const c = useContext(ConfirmCtx)
  if (!c) throw new Error('FeedbackProvider manquant')
  return c
}
