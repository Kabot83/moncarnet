import { CheckCircle2, CircleSlash, ExternalLink, KeyRound, Server, ShieldAlert, Wifi } from 'lucide-react'
import { useEffect, useState } from 'react'
import { type ModelInfo, PREFERRED_MODEL, listModels, suggestModels, testConnection } from '@/ai/client'
import { type AiError, toAiError } from '@/ai/errors'
import { useAiUsage } from '@/ai/quota'
import { AiErrorBox } from '@/components/AiErrorBox'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Feedback'
import { NumberInput, TextInput } from '@/components/ui/Fields'
import { Page, TopBar } from '@/components/ui/Layout'
import { useOnline } from '@/hooks/useOnline'
import type { AiMode } from '@/models/types'
import { clearSecrets, getSecrets, saveSecrets, updateSettings, useHasSecrets, useSettings } from '@/services/settings'
import { SettingsGroup } from './SettingsPage'

const MODES: { id: AiMode; title: string; text: string; icon: typeof KeyRound }[] = [
  { id: 'off', title: 'Désactivé', text: 'Aucun appel à Gemini. Le carnet fonctionne entièrement.', icon: CircleSlash },
  { id: 'proxy', title: 'Via mon proxy (recommandé)', text: 'La clé reste sur votre serveur. L’application n’a qu’un jeton révocable.', icon: Server },
  { id: 'direct', title: 'Clé sur ce téléphone', text: 'Plus simple, mais moins sûr : la clé est stockée sur l’appareil.', icon: KeyRound },
]

export default function AiSettingsPage() {
  const settings = useSettings()
  const has = useHasSecrets()
  const usage = useAiUsage()
  const online = useOnline()
  const toast = useToast()
  const [apiKey, setApiKey] = useState('')
  const [proxyUrl, setProxyUrl] = useState(settings.proxyUrl)
  const [proxyToken, setProxyToken] = useState('')
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [error, setError] = useState<AiError | null>(null)

  useEffect(() => setProxyUrl(settings.proxyUrl), [settings.proxyUrl])

  const saveCredentials = async () => {
    if (settings.aiMode === 'direct' && apiKey.trim()) await saveSecrets({ apiKey: apiKey.trim() })
    if (settings.aiMode === 'proxy') {
      const url = proxyUrl.trim().replace(/\/+$/, '')
      if (url && !/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(url)) {
        toast.error('L’adresse du proxy doit commencer par https://')
        return false
      }
      await updateSettings({ proxyUrl: url })
      if (proxyToken.trim()) await saveSecrets({ proxyToken: proxyToken.trim() })
    }
    setApiKey('')
    setProxyToken('')
    return true
  }

  const loadModels = async () => {
    setError(null)
    setLoadingModels(true)
    try {
      if (!(await saveCredentials())) return
      const list = await listModels()
      setModels(list)
      if (!list.length) {
        setStatus({ ok: false, text: 'Aucun modèle Gemini accessible avec cette clé.' })
        return
      }
      const s = suggestModels(list)
      const patch: Record<string, string> = {}
      if (!settings.aiModel || !list.some((m) => m.id === settings.aiModel)) patch.aiModel = s.main
      if (!settings.aiFallbackModel || !list.some((m) => m.id === settings.aiFallbackModel)) patch.aiFallbackModel = s.fallback
      if (Object.keys(patch).length) await updateSettings(patch)
      setStatus({ ok: true, text: `${list.length} modèle(s) accessible(s) avec votre clé.` })
    } catch (e) {
      setError(toAiError(e))
      setStatus({ ok: false, text: 'Connexion impossible.' })
    } finally {
      setLoadingModels(false)
    }
  }

  const test = async () => {
    setError(null)
    setTesting(true)
    try {
      if (!(await saveCredentials())) return
      const r = await testConnection()
      setStatus({ ok: true, text: `Gemini répond (${r.model}, ${(r.ms / 1000).toFixed(1).replace('.', ',')} s).` })
    } catch (e) {
      setError(toAiError(e))
      setStatus({ ok: false, text: 'Le test a échoué.' })
    } finally {
      setTesting(false)
    }
  }

  const preferredAvailable = models?.some((m) => m.id === PREFERRED_MODEL)

  return (
    <>
      <TopBar back="/reglages" title="Mon Chef IA" />
      <Page className="pt-4">
        <div className="rounded-[var(--radius-card)] bg-sage-soft p-4 text-[15px]">
          <p className="font-semibold">Gratuit, sans abonnement, sans facturation</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            <li>
              Créez une clé dans <strong>Google AI Studio</strong> sur un projet <strong>sans compte de facturation</strong> : seul le niveau gratuit est alors utilisable, et un dépassement provoque un refus (erreur 429), jamais une facture.
            </li>
            <li>N’activez pas la facturation Google Cloud sur ce projet. Mon Carnet ne peut pas vérifier cet état lui-même : c’est pourtant la seule garantie réelle.</li>
            <li>Mon Carnet ne réessaie jamais automatiquement, ne change jamais de modèle sans votre action et applique une limite locale d’appels par jour.</li>
          </ul>
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-sage">
            Ouvrir Google AI Studio <ExternalLink size={14} />
          </a>
        </div>

        <SettingsGroup title="Mode de connexion">
          <div className="space-y-1 py-2" role="radiogroup" aria-label="Mode de connexion">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={settings.aiMode === m.id}
                onClick={() => {
                  void updateSettings({ aiMode: m.id })
                  setStatus(null)
                  setError(null)
                }}
                className={`flex w-full items-start gap-3 rounded-xl p-3 text-left ${settings.aiMode === m.id ? 'bg-terra-soft' : ''}`}
              >
                <m.icon size={20} className={`mt-0.5 shrink-0 ${settings.aiMode === m.id ? 'text-terra' : 'text-muted'}`} />
                <span>
                  <span className="block font-semibold">{m.title}</span>
                  <span className="block text-sm text-muted">{m.text}</span>
                </span>
              </button>
            ))}
          </div>
        </SettingsGroup>

        {settings.aiMode === 'direct' && (
          <SettingsGroup title="Clé API Gemini">
            <div className="space-y-3 py-4">
              <div className="flex gap-3 rounded-2xl bg-danger-soft p-3 text-sm">
                <ShieldAlert size={20} className="shrink-0 text-danger" />
                <p>
                  La clé est stockée sur ce téléphone, dans les données de l’application, <strong>non chiffrée</strong>. Toute personne ou extension ayant accès à ce navigateur pourrait la lire. Ce n’est pas équivalent à un stockage serveur. Utilisez une clé dédiée, restreinte à l’API Gemini, révocable à tout moment, et jamais exportée dans les sauvegardes.
                </p>
              </div>
              <TextInput
                label={has.apiKey ? 'Remplacer la clé enregistrée' : 'Clé API'}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={has.apiKey ? '•••••••••••• (enregistrée)' : 'AIza…'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              {has.apiKey && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger"
                  onClick={async () => {
                    await saveSecrets({ apiKey: '' })
                    toast.success('Clé supprimée de cet appareil')
                  }}
                >
                  Supprimer la clé de cet appareil
                </Button>
              )}
            </div>
          </SettingsGroup>
        )}

        {settings.aiMode === 'proxy' && (
          <SettingsGroup title="Mon proxy">
            <div className="space-y-3 py-4">
              <p className="text-sm text-muted">
                Déployez le petit proxy fourni (dossier <code>proxy/</code>, Cloudflare Workers) : il conserve la clé Gemini côté serveur, vérifie un jeton d’accès, filtre les requêtes et limite le nombre d’appels. Il sert aussi à l’import de recettes par lien.
              </p>
              <TextInput label="Adresse du proxy" type="url" inputMode="url" placeholder="https://mon-carnet-proxy.exemple.workers.dev" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} />
              <TextInput
                label={has.proxyToken ? 'Remplacer le jeton d’accès' : 'Jeton d’accès'}
                type="password"
                autoComplete="off"
                placeholder={has.proxyToken ? '•••••••••••• (enregistré)' : 'Le jeton défini lors du déploiement'}
                value={proxyToken}
                onChange={(e) => setProxyToken(e.target.value)}
              />
            </div>
          </SettingsGroup>
        )}

        {settings.aiMode !== 'off' && (
          <>
            <SettingsGroup title="Connexion et modèle">
              <div className="space-y-3 py-4">
                <div className="flex items-center gap-2 text-sm" role="status">
                  {!online ? (
                    <>
                      <Wifi size={16} className="text-faint" /> Hors ligne
                    </>
                  ) : status ? (
                    <>
                      {status.ok ? <CheckCircle2 size={16} className="text-sage" /> : <CircleSlash size={16} className="text-danger" />} {status.text}
                    </>
                  ) : (
                    <span className="text-muted">Disponibilité non vérifiée.</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" loading={loadingModels} disabled={!online} onClick={() => void loadModels()}>
                    Lister les modèles accessibles
                  </Button>
                  <Button loading={testing} disabled={!online || !settings.aiModel} onClick={() => void test()}>
                    Tester la connexion
                  </Button>
                </div>
                <p className="text-xs text-faint">Lister les modèles ne consomme pas de quota de génération. Le test effectue 1 appel minimal.</p>
                {error && <AiErrorBox error={error} />}

                <div>
                  <label className="label" htmlFor="model">
                    Modèle principal
                  </label>
                  {models?.length ? (
                    <select id="model" className="field" value={settings.aiModel} onChange={(e) => void updateSettings({ aiModel: e.target.value })}>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                          {m.id === PREFERRED_MODEL ? ' (préféré)' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input id="model" className="field" value={settings.aiModel} placeholder={PREFERRED_MODEL} onChange={(e) => void updateSettings({ aiModel: e.target.value.trim() })} />
                  )}
                  {models && !preferredAvailable && (
                    <p className="mt-1 text-xs text-muted">« {PREFERRED_MODEL} » n’est pas proposé à votre clé : le modèle « flash » le plus récent a été présélectionné.</p>
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="fallback">
                    Modèle de repli (utilisé seulement si vous le demandez)
                  </label>
                  {models?.length ? (
                    <select id="fallback" className="field" value={settings.aiFallbackModel} onChange={(e) => void updateSettings({ aiFallbackModel: e.target.value })}>
                      <option value="">Aucun</option>
                      {models.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input id="fallback" className="field" value={settings.aiFallbackModel} placeholder="Ex. : un modèle flash-lite" onChange={(e) => void updateSettings({ aiFallbackModel: e.target.value.trim() })} />
                  )}
                </div>
                <p className="text-xs text-muted">
                  La liste indique les modèles disponibles pour votre clé, pas leur gratuité : celle-ci dépend de votre projet (sans facturation) et des quotas gratuits publiés par Google, qui peuvent évoluer.
                </p>
              </div>
            </SettingsGroup>

            <SettingsGroup title="Limite locale">
              <div className="space-y-2 py-4">
                <NumberInput
                  label="Appels IA maximum par jour (0 = sans limite locale)"
                  value={settings.aiDailyLimit}
                  onChange={(v) => void updateSettings({ aiDailyLimit: Math.round(v ?? 0) })}
                  step={1}
                />
                <p className="text-sm text-muted">
                  Aujourd’hui : <strong className="text-ink">{usage}</strong> appel{usage > 1 ? 's' : ''} depuis ce téléphone.
                </p>
                <p className="text-xs text-faint">Ce compteur est une limite que vous vous fixez. Ce n’est pas le quota restant chez Google, que l’application ne peut pas connaître.</p>
              </div>
            </SettingsGroup>
          </>
        )}

        {(has.apiKey || has.proxyToken) && (
          <div className="mt-6">
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                await clearSecrets()
                const s = await getSecrets()
                toast.success(!s.apiKey && !s.proxyToken ? 'Clé et jeton effacés de cet appareil' : 'Effacement partiel')
              }}
            >
              Effacer tous les secrets de cet appareil
            </Button>
          </div>
        )}
      </Page>
    </>
  )
}
