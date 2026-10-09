import { AlertCircle, Settings } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { AiError } from '@/ai/errors'
import { Button } from './ui/Button'

/** Affichage homogène des erreurs IA (quota, hors ligne, configuration…). */
export function AiErrorBox({ error, onRetry, onFallback, fallbackModel }: { error: AiError; onRetry?: () => void; onFallback?: () => void; fallbackModel?: string }) {
  const config = error.kind === 'not-configured' || error.kind === 'disabled' || error.kind === 'auth' || error.kind === 'model'
  const retryable = error.kind !== 'local-limit' && !config
  return (
    <div className="my-3 rounded-2xl border border-danger/25 bg-danger-soft p-4 text-sm animate-fade-up" role="alert">
      <div className="flex gap-3">
        <AlertCircle size={20} className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-ink">{error.message}</p>
          {error.retryAfterSec ? <p className="mt-1 text-muted">Google suggère de patienter environ {error.retryAfterSec} s.</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {retryable && onRetry && (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                Réessayer
              </Button>
            )}
            {error.suggestsFallback && onFallback && fallbackModel && (
              <Button size="sm" variant="secondary" onClick={onFallback}>
                Essayer {fallbackModel}
              </Button>
            )}
            {config && (
              <Link to="/reglages/ia" className="inline-flex h-9 items-center gap-1.5 rounded-full bg-paper px-3.5 text-sm font-semibold">
                <Settings size={15} /> Réglages du Chef IA
              </Link>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
