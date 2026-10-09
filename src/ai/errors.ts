export type AiErrorKind =
  | 'disabled'
  | 'not-configured'
  | 'offline'
  | 'local-limit'
  | 'quota'
  | 'auth'
  | 'model'
  | 'blocked'
  | 'invalid-response'
  | 'server'
  | 'network'
  | 'timeout'

export class AiError extends Error {
  constructor(
    public kind: AiErrorKind,
    message: string,
    public retryAfterSec: number | null = null,
  ) {
    super(message)
  }

  /** Une autre tentative a-t-elle un sens (plus tard ou avec un autre modèle) ? */
  get suggestsFallback() {
    return this.kind === 'quota' || this.kind === 'model'
  }
}

const MESSAGES: Record<AiErrorKind, string> = {
  disabled: 'Le Chef IA est désactivé. Vous pouvez l’activer dans Réglages → Mon Chef IA.',
  'not-configured': 'Le Chef IA n’est pas encore configuré. Ajoutez une clé ou un proxy dans Réglages → Mon Chef IA.',
  offline: 'Vous êtes hors ligne. Votre carnet reste entièrement disponible ; le Chef IA reviendra avec la connexion.',
  'local-limit': 'Vous avez atteint votre limite quotidienne d’appels IA fixée dans les réglages. Elle se réinitialise demain.',
  quota:
    'Le quota gratuit de Google est atteint (limite par minute ou par jour). Réessayez un peu plus tard. Mon Carnet ne bascule jamais vers une offre payante.',
  auth: 'La clé API ou le jeton du proxy est refusé. Vérifiez-les dans Réglages → Mon Chef IA.',
  model: 'Ce modèle n’est pas disponible pour votre clé. Choisissez-en un autre dans Réglages → Mon Chef IA.',
  blocked: 'Gemini a refusé de répondre à cette demande. Essayez de la reformuler.',
  'invalid-response': 'La réponse de Gemini était incomplète ou mal formée. Rien n’a été enregistré. Vous pouvez réessayer.',
  server: 'Le service Gemini rencontre un problème temporaire. Réessayez dans quelques instants.',
  network: 'Impossible de joindre le service. Vérifiez votre connexion.',
  timeout: 'Gemini a mis trop de temps à répondre. Réessayez avec une demande plus courte.',
}

export const aiMessage = (kind: AiErrorKind) => MESSAGES[kind]

/** Traduit une erreur du SDK / du réseau en message clair. */
export function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return new AiError('offline', MESSAGES.offline)
  const err = e as { status?: number; message?: string; name?: string }
  const msg = err?.message ?? String(e)
  const status = err?.status ?? Number(msg.match(/\b(400|401|403|404|429|500|502|503|504)\b/)?.[1] ?? 0)
  if (err?.name === 'AbortError' || /timeout|timed out/i.test(msg)) return new AiError('timeout', MESSAGES.timeout)
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(msg)) {
    const retry = msg.match(/retry(?:Delay)?["\s:]*["']?(\d+(?:\.\d+)?)s/i)
    return new AiError('quota', MESSAGES.quota, retry ? Math.ceil(parseFloat(retry[1])) : null)
  }
  if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED|API_KEY_INVALID|unauthori[sz]ed/i.test(msg))
    return new AiError('auth', MESSAGES.auth)
  if (status === 404 || /not found|is not supported|NOT_FOUND/i.test(msg)) return new AiError('model', MESSAGES.model)
  if (status === 400 && /model/i.test(msg)) return new AiError('model', MESSAGES.model)
  if (status >= 500) return new AiError('server', MESSAGES.server)
  if (/failed to fetch|networkerror|load failed|network/i.test(msg)) return new AiError('network', MESSAGES.network)
  if (status === 400) return new AiError('invalid-response', `Requête refusée par Gemini : ${msg.slice(0, 200)}`)
  return new AiError('server', `${MESSAGES.server} (${msg.slice(0, 160)})`)
}
