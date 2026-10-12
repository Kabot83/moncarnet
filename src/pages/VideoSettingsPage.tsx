/**
 * Réglages → Vidéos (NAS) : adresse du service Carnet Media et jeton d'appareil.
 * Le jeton est transmis une seule fois au stockage chiffré d'Android (AndroidKeyStore) ; il
 * n'est jamais réaffiché ni conservé par l'interface.
 */
import { CheckCircle2, KeyRound, ServerCog, Trash2, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { TextInput } from '@/components/ui/Fields'
import { Page, TopBar } from '@/components/ui/Layout'
import { formatBytes } from '@/lib/format'
import { CarnetMedia, type CarnetMediaConfig, NasError, carnetMediaAvailable, configureNas, getNasConfig, nasApi } from '@/platform/carnetMedia'

type Test = { ok: boolean; text: string } | null

export default function VideoSettingsPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const [cfg, setCfg] = useState<CarnetMediaConfig | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [test, setTest] = useState<Test>(null)
  const [usage, setUsage] = useState<{ bytes: number; videos: number; free: number } | null>(null)

  useEffect(() => {
    void getNasConfig(true).then((c) => {
      setCfg(c)
      setUrl(c.url)
    })
    if (carnetMediaAvailable) void CarnetMedia.usage().then(setUsage).catch(() => undefined)
  }, [])

  const save = async () => {
    setBusy(true)
    setTest(null)
    try {
      const c = await configureNas(url.trim(), token.trim() || undefined)
      setCfg(c)
      setToken('') // le jeton ne reste pas dans l'interface
      toast.success(token.trim() ? 'Adresse et jeton enregistrés (jeton chiffré sur le téléphone)' : 'Adresse enregistrée')
      if (c.url && c.hasToken) await runTest()
    } catch (e) {
      toast.error(e instanceof NasError ? e.message : 'Enregistrement impossible.')
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setBusy(true)
    try {
      const health = await nasApi<{ status?: string; version?: string }>('GET', '/v1/health')
      if (health.data.status !== 'ok') throw new NasError('http', 'Le service ne répond pas comme prévu.')
      const st = await nasApi<{ bytes: number; media: number }>('GET', '/v1/storage')
      setTest({ ok: true, text: `Connecté à Carnet Media ${health.data.version ?? ''} · ${st.data.media} publication(s) sur le NAS, ${formatBytes(st.data.bytes)}` })
    } catch (e) {
      setTest({ ok: false, text: e instanceof NasError ? e.message : 'NAS injoignable.' })
    } finally {
      setBusy(false)
    }
  }

  const forget = async () => {
    if (!(await confirm({ title: 'Retirer le jeton de ce téléphone ?', message: 'Les vidéos déjà enregistrées restent. Les nouvelles ne seront plus récupérées automatiquement.', confirmLabel: 'Retirer', danger: true }))) return
    setCfg(await configureNas(url.trim(), ''))
    setTest(null)
  }

  return (
    <>
      <TopBar back="/reglages" title="Vidéos (NAS)" />
      <Page className="space-y-6 pt-2 pb-28">
        {!carnetMediaAvailable ? (
          <p className="rounded-2xl bg-sunken p-4 text-sm text-muted">
            La récupération automatique des vidéos par votre NAS est disponible dans l’application Android (stockage sécurisé du jeton et des vidéos). Dans cette version web, utilisez « Importer un lien ».
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              Après « Partager → Mon Carnet », votre service Carnet Media récupère la vidéo et ses informations, puis le téléphone l’enregistre pour la regarder hors ligne.
            </p>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <TextInput label="Adresse du service" inputMode="url" autoComplete="off" placeholder="https://monnas.synology.me:8444" value={url} onChange={(e) => setUrl(e.target.value)} />
              <TextInput
                label={cfg?.hasToken ? 'Nouveau jeton (facultatif)' : 'Jeton de ce téléphone'}
                type="password"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                placeholder={cfg?.hasToken ? 'Jeton enregistré — saisir pour le remplacer' : 'mc_…'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                hint="Créé sur le NAS (python -m app.admin token create). Il est chiffré par le magasin de clés d’Android et n’est plus jamais affiché."
              />
              <Button type="submit" block size="lg" icon={<KeyRound size={18} />} loading={busy} disabled={!url.trim()}>
                Enregistrer
              </Button>
            </form>

            {cfg?.url && cfg.hasToken && (
              <div className="space-y-2">
                <Button block variant="secondary" icon={<ServerCog size={17} />} loading={busy} onClick={() => void runTest()}>
                  Tester la connexion
                </Button>
                {test && (
                  <p className={`flex items-start gap-2 rounded-2xl p-3 text-sm ${test.ok ? 'bg-sage-soft' : 'bg-danger-soft'}`} role="status">
                    {test.ok ? <CheckCircle2 size={18} className="shrink-0 text-sage" /> : <XCircle size={18} className="shrink-0 text-danger" />}
                    {test.text}
                  </p>
                )}
                <Button block variant="ghost" className="text-danger" icon={<Trash2 size={16} />} onClick={() => void forget()}>
                  Retirer le jeton de ce téléphone
                </Button>
              </div>
            )}

            {usage && (
              <p className="rounded-2xl bg-sunken p-3 text-sm text-muted">
                Sur ce téléphone : {usage.videos} vidéo(s), {formatBytes(usage.bytes)} · espace libre {formatBytes(usage.free)}.
              </p>
            )}
          </>
        )}
      </Page>
    </>
  )
}
