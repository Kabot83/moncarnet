/**
 * Accès à l'API Gemini via le SDK officiel `@google/genai`.
 *
 * Deux modes, choisis explicitement par l'utilisateur :
 *
 * - `proxy` (recommandé) : l'application parle à VOTRE petit proxy (voir
 *   /proxy). La vraie clé Gemini reste côté serveur. L'application ne détient
 *   qu'un jeton d'accès au proxy, révocable, et le proxy limite les requêtes.
 *
 * - `direct` : la clé API est stockée sur ce téléphone (IndexedDB) et envoyée
 *   directement à Google. Pratique pour un usage strictement personnel, mais
 *   MOINS SÛR : quiconque accède à l'appareil ou au navigateur peut la lire.
 *   Utilisez une clé dédiée, restreinte à l'API Gemini, sur un projet SANS
 *   facturation activée.
 *
 * Garde-fous financiers : aucune nouvelle tentative automatique (une erreur
 * 429 n'est jamais réessayée en boucle), aucun changement de modèle
 * automatique, limite locale d'appels par jour.
 */
import type { Content, GenerateContentResponse, GoogleGenAI } from '@google/genai'
import type { AppSecrets, AppSettings } from '@/models/types'
import { getSecrets, getSettings } from '@/services/settings'
import { AiError, aiMessage, toAiError } from './errors'
import { consumeCall } from './quota'

const TIMEOUT_MS = 90_000

/** Modèle souhaité par défaut, s'il est accessible avec la clé de l'utilisateur. */
export const PREFERRED_MODEL = 'gemini-3.7-flash'

/** Le SDK n'est chargé qu'au premier appel IA : le carnet démarre plus vite. */
async function buildClient(settings: AppSettings, secrets: AppSecrets): Promise<GoogleGenAI> {
  if (settings.aiMode === 'off') throw new AiError('disabled', aiMessage('disabled'))
  const { GoogleGenAI } = await import('@google/genai')
  const common = { retryOptions: { attempts: 1 }, timeout: TIMEOUT_MS }
  if (settings.aiMode === 'proxy') {
    if (!settings.proxyUrl || !secrets.proxyToken) throw new AiError('not-configured', aiMessage('not-configured'))
    // Le SDK envoie le jeton dans l'en-tête x-goog-api-key ; le proxy le vérifie
    // puis le remplace par la vraie clé, qu'il est seul à connaître.
    return new GoogleGenAI({ apiKey: secrets.proxyToken, httpOptions: { ...common, baseUrl: settings.proxyUrl.replace(/\/+$/, '') } })
  }
  if (settings.aiMode === 'direct') {
    if (!secrets.apiKey) throw new AiError('not-configured', aiMessage('not-configured'))
    return new GoogleGenAI({ apiKey: secrets.apiKey, httpOptions: common })
  }
  throw new AiError('disabled', aiMessage('disabled'))
}

export async function getClient(): Promise<{ ai: GoogleGenAI; settings: AppSettings }> {
  const [settings, secrets] = await Promise.all([getSettings(), getSecrets()])
  return { ai: await buildClient(settings, secrets), settings }
}

export interface GenerateOptions {
  contents: Content[] | string
  system?: string
  schema?: unknown
  /** Remplace le modèle des réglages (uniquement sur action explicite de l'utilisateur). */
  model?: string
  temperature?: number
  maxOutputTokens?: number
  signal?: AbortSignal
}

/** Appel de génération unique, comptabilisé, sans nouvelle tentative automatique. */
export async function generate(opts: GenerateOptions): Promise<{ text: string; model: string }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) throw new AiError('offline', aiMessage('offline'))
  const { ai, settings } = await getClient()
  const model = opts.model || settings.aiModel
  if (!model) throw new AiError('not-configured', 'Aucun modèle choisi. Ouvrez Réglages → Mon Chef IA et testez la connexion.')
  await consumeCall()
  let res: GenerateContentResponse
  try {
    res = await ai.models.generateContent({
      model,
      contents: opts.contents,
      config: {
        systemInstruction: opts.system,
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.maxOutputTokens ?? 16384,
        ...(opts.schema ? { responseMimeType: 'application/json', responseJsonSchema: opts.schema } : {}),
        abortSignal: opts.signal,
      },
    })
  } catch (e) {
    throw toAiError(e)
  }
  const blocked = res.promptFeedback?.blockReason
  if (blocked) throw new AiError('blocked', aiMessage('blocked'))
  const finish = res.candidates?.[0]?.finishReason
  const text = res.text ?? ''
  if (!text.trim()) {
    if (finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT') throw new AiError('blocked', aiMessage('blocked'))
    throw new AiError('invalid-response', aiMessage('invalid-response'))
  }
  if (finish === 'MAX_TOKENS' && opts.schema) throw new AiError('invalid-response', 'Réponse tronquée (trop longue). Demandez moins de recettes à la fois.')
  return { text, model }
}

/** Analyse le JSON renvoyé (tolère un bloc ```json éventuel). */
export function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1))
      } catch {
        /* ci-dessous */
      }
    }
    throw new AiError('invalid-response', aiMessage('invalid-response'))
  }
}

export interface ModelInfo {
  id: string
  label: string
  inputTokenLimit?: number
}

/**
 * Liste les modèles de génération réellement accessibles avec la clé.
 * Cette liste n'indique PAS si un modèle est gratuit : la gratuité dépend de
 * l'absence de facturation sur le projet Google AI Studio.
 * (Lister les modèles ne consomme pas de quota de génération.)
 */
export async function listModels(): Promise<ModelInfo[]> {
  if (!navigator.onLine) throw new AiError('offline', aiMessage('offline'))
  const { ai } = await getClient()
  const out: ModelInfo[] = []
  try {
    const pager = await ai.models.list({ config: { pageSize: 100 } })
    for await (const m of pager) {
      const id = (m.name ?? '').replace(/^models\//, '')
      if (!id.startsWith('gemini')) continue
      if (m.supportedActions && !m.supportedActions.includes('generateContent')) continue
      if (/embedding|tts|image-generation|live|native-audio|robotics|computer-use/i.test(id)) continue
      out.push({ id, label: m.displayName ?? id, inputTokenLimit: m.inputTokenLimit })
    }
  } catch (e) {
    throw toAiError(e)
  }
  return sortModels(out)
}

/** Trie : modèles « flash » récents d'abord (les plus adaptés au niveau gratuit). */
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  const version = (id: string) => parseFloat(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? '0')
  const rank = (id: string) => (/flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : /pro/.test(id) ? 3 : 2) + (/preview|exp/.test(id) ? 0.5 : 0)
  return [...models].sort((a, b) => rank(a.id) - rank(b.id) || version(b.id) - version(a.id) || a.id.localeCompare(b.id))
}

/** Choix proposé : le modèle préféré s'il existe, sinon le flash stable le plus récent. */
export function suggestModels(models: ModelInfo[]): { main: string; fallback: string } {
  const ids = models.map((m) => m.id)
  const stable = ids.filter((id) => !/preview|exp/.test(id))
  const main = ids.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : (stable.find((id) => /flash/.test(id) && !/lite/.test(id)) ?? ids[0] ?? '')
  const fallback = stable.find((id) => id !== main && /flash-lite/.test(id)) ?? stable.find((id) => id !== main && /flash/.test(id)) ?? ''
  return { main, fallback }
}

/** Test de connexion : un appel minimal, comptabilisé dans la limite locale. */
export async function testConnection(model?: string): Promise<{ ok: true; model: string; ms: number }> {
  const t0 = performance.now()
  const { text, model: used } = await generate({
    model,
    contents: 'Réponds uniquement par le mot : OK',
    temperature: 0,
    maxOutputTokens: 1024,
  })
  if (!/ok/i.test(text)) throw new AiError('invalid-response', 'Réponse inattendue du modèle.')
  return { ok: true, model: used, ms: Math.round(performance.now() - t0) }
}
