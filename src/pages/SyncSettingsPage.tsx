/**
 * Réglages → Synchronisation familiale (Carnet Sync).
 * Le mot de passe n'est transmis qu'une fois au stockage sécurisé d'Android pour ouvrir la
 * session ; il n'est ni conservé par l'interface ni enregistré sur le téléphone.
 */
import { AlertTriangle, CheckCircle2, ChevronRight, CloudOff, GitMerge, LogOut, RefreshCw, SearchCheck, Trash2, Users } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { TextInput } from '@/components/ui/Fields'
import { Page, TopBar } from '@/components/ui/Layout'
import { db } from '@/db/db'
import { relativeTime } from '@/lib/format'
import { deleteDemoData } from '@/services/recipes'
import { DEFAULT_SYNC_URL, SessionError, normalizeServerUrl } from '@/platform/carnetSync'
import { syncService, useSync } from '@/sync/instance'
import type { SyncState } from '@/sync/service'
import { SettingsGroup } from './SettingsPage'

const STATUS: Record<SyncState['status'], string> = {
  unavailable: 'Disponible dans l’application Android',
  'signed-out': 'Non connecté',
  'needs-migration': 'Première synchronisation à préparer',
  idle: 'Synchronisé',
  syncing: 'Synchronisation en cours…',
  offline: 'Hors connexion',
  error: 'Erreur de synchronisation',
  revoked: 'Session expirée',
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{children}</span>
    </div>
  )
}

function LinkRow({ to, icon, label, detail }: { to: string; icon: ReactNode; label: string; detail?: string }) {
  return (
    <Link to={to} className="flex items-center gap-3 py-3.5">
      <span className="grid size-9 place-items-center rounded-full bg-sunken text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {detail && <span className="block truncate text-sm text-muted">{detail}</span>}
      </span>
      <ChevronRight size={18} className="text-faint" />
    </Link>
  )
}

function LoginForm({ state }: { state: SyncState }) {
  const navigate = useNavigate()
  const [url, setUrl] = useState(state.url || DEFAULT_SYNC_URL)
  const [login, setLogin] = useState(state.user?.login ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const u = normalizeServerUrl(url)
    if (!u) return setError('Adresse invalide : elle doit commencer par https://')
    setBusy(true)
    setError(null)
    try {
      const r = await syncService.login(u, login.trim(), password)
      setPassword('') // le mot de passe ne reste pas dans l'interface
      if (r === 'needs-migration') navigate('/reglages/synchronisation/migration')
    } catch (e) {
      setPassword('')
      setError(e instanceof SessionError ? e.message : 'Connexion impossible.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="space-y-4 py-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <TextInput label="Adresse du serveur" value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <TextInput label="Identifiant" value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <TextInput label="Mot de passe" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      {error && <p className="rounded-xl bg-danger-soft p-3 text-sm text-danger">{error}</p>}
      <Button type="submit" block disabled={busy || !login.trim() || !password} loading={busy}>
        Se connecter
      </Button>
      <p className="text-xs text-muted">
        Connexion chiffrée (HTTPS, certificat vérifié). Votre mot de passe n’est jamais enregistré : il sert une seule fois à ouvrir une session, conservée chiffrée par Android.
      </p>
    </form>
  )
}

export default function SyncSettingsPage() {
  const s = useSync()
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<{ ok: boolean; text: string; items: string[] } | null>(null)
  const connected = ['idle', 'syncing', 'offline', 'error'].includes(s.status)

  const syncNow = async () => {
    setBusy(true)
    await syncService.syncNow('manuel')
    setBusy(false)
  }

  /** Compare chaque élément du téléphone avec le serveur (rien n'est modifié). */
  const verify = async () => {
    setBusy(true)
    setCheck(null)
    try {
      await syncService.syncNow('vérification')
      const v = await syncService.engine.verify()
      const titles = async (keys: string[]) =>
        Promise.all(keys.map(async (k) => {
          const [coll, id] = k.split('/')
          const r = coll === 'recipes' || coll === 'recipeMeta' ? await db.recipes.get(id) : null
          return r ? `${r.title}${coll === 'recipeMeta' ? ' (notes personnelles)' : ''}` : k
        }))
      const items = [...(await titles(v.missingOnServer)).map((t) => `${t} : absente du serveur`), ...(await titles(v.different)).map((t) => `${t} : différente du serveur`)]
      setCheck({ ok: v.ok, text: v.ok ? `${v.checked} éléments identiques sur le téléphone et le serveur.` : `${items.length} élément(s) à vérifier sur ${v.checked}.`, items: items.slice(0, 20) })
    } catch (e) {
      setCheck({ ok: false, text: e instanceof Error ? e.message : 'Vérification impossible.', items: [] })
    } finally {
      setBusy(false)
    }
  }

  const removeDemo = async () => {
    const ok = await confirm({ title: 'Supprimer les recettes de démonstration ?', message: 'Elles ne sont jamais synchronisées. Vos recettes, familiales ou privées, ne sont pas concernées.', confirmLabel: 'Supprimer', danger: true })
    if (!ok) return
    await deleteDemoData()
    await syncService.refreshCounters()
    toast.success('Recettes de démonstration supprimées')
  }

  const logout = async () => {
    const ok = await confirm({
      title: 'Se déconnecter ?',
      message:
        s.pending > 0
          ? `${s.pending} modification(s) ne sont pas encore envoyées : une dernière synchronisation sera tentée. Votre carnet reste sur ce téléphone, masqué jusqu’à votre reconnexion.`
          : 'Votre carnet reste sur ce téléphone, masqué jusqu’à votre reconnexion. Un carnet vide s’ouvre pour la personne suivante.',
      confirmLabel: 'Se déconnecter',
    })
    if (!ok) return
    await syncService.logout()
    toast.success('Déconnecté')
  }

  return (
    <>
      <TopBar back="/reglages" title="Synchronisation familiale" />
      <Page className="pt-2 pb-28">
        {s.status === 'unavailable' && (
          <p className="mt-4 rounded-2xl bg-sunken p-4 text-sm text-muted">
            La synchronisation familiale est disponible dans l’application Android (session conservée chiffrée par le téléphone). Cette version web reste un carnet local.
          </p>
        )}

        {(s.status === 'signed-out' || s.status === 'revoked') && (
          <SettingsGroup title={s.status === 'revoked' ? 'Reconnexion' : 'Connexion à Carnet Sync'}>
            {s.status === 'revoked' && <p className="pt-4 text-sm text-muted">{s.lastError}</p>}
            {s.status === 'signed-out' && (
              <p className="pt-4 text-sm text-muted">
                Retrouvez le catalogue familial sur tous vos appareils. Vos favoris, notes, journal et listes restent personnels.
              </p>
            )}
            <LoginForm state={s} />
          </SettingsGroup>
        )}

        {s.status === 'needs-migration' && (
          <SettingsGroup title="Première synchronisation">
            <div className="space-y-3 py-4 text-sm">
              <p>Connecté en tant que <strong>{s.user?.display_name}</strong>. Votre carnet contient déjà des recettes : choisissez celles à partager avec la famille. Rien n’est envoyé sans votre confirmation, et rien n’est supprimé du téléphone.</p>
              <Link to="/reglages/synchronisation/migration" className="block">
                <Button block>Préparer la première synchronisation</Button>
              </Link>
            </div>
          </SettingsGroup>
        )}

        {(connected || s.status === 'needs-migration' || s.status === 'revoked') && s.user && (
          <SettingsGroup title="Compte">
            <Row label="Connecté en tant que">
              {s.user.display_name} <span className="text-muted">({s.user.login})</span>
            </Row>
            {s.family && (
              <Row label="Catalogue familial">
                {s.family.name}
                <span className="block text-xs font-normal text-muted">
                  {s.family.role === 'admin' ? 'Administrateur' : 'Membre'} · {s.family.members.length} membre{s.family.members.length > 1 ? 's' : ''}
                </span>
              </Row>
            )}
            <Row label="Serveur">
              <span className="text-xs break-all">{s.url}</span>
            </Row>
          </SettingsGroup>
        )}

        {connected && (
          <>
            <SettingsGroup title="État">
              <div className="flex items-center gap-2 py-3 font-medium">
                {s.status === 'idle' && <CheckCircle2 size={18} className="text-sage" />}
                {s.status === 'syncing' && <RefreshCw size={18} className="animate-spin text-terra" />}
                {s.status === 'offline' && <CloudOff size={18} className="text-muted" />}
                {s.status === 'error' && <AlertTriangle size={18} className="text-danger" />}
                {STATUS[s.status]}
              </div>
              <Row label="Dernière synchronisation réussie">{relativeTime(s.lastSyncAt)}</Row>
              <Row label="Recettes synchronisées">
                {s.synced.family} familiale{s.synced.family > 1 ? 's' : ''} · {s.synced.personal} privée{s.synced.personal > 1 ? 's' : ''}
              </Row>
              <Row label="Modifications en attente">{s.pending ? `${s.pending} — envoi automatique` : 'aucune'}</Row>
              {s.lastError && <p className="py-3 text-sm text-danger">{s.lastError}</p>}
              {s.notice && <p className="py-3 text-sm text-muted">{s.notice}</p>}
              {s.migration && !s.migration.ok && (
                <div className="space-y-2 py-3 text-sm">
                  <p className="text-danger">La vérification de la première synchronisation n’est pas terminée ({s.migration.issues.length} élément(s) à confirmer). Vos données sont intactes sur le téléphone.</p>
                  <Button size="sm" variant="secondary" onClick={() => void syncService.resumeMigration()}>
                    Reprendre et vérifier
                  </Button>
                </div>
              )}
              <div className="py-3">
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" icon={<RefreshCw size={16} />} onClick={() => void syncNow()} loading={busy}>
                    Synchroniser maintenant
                  </Button>
                  <Button size="sm" variant="secondary" icon={<SearchCheck size={16} />} onClick={() => void verify()} disabled={busy}>
                    Vérifier avec le serveur
                  </Button>
                </div>
                {check && (
                  <div className={`mt-3 rounded-xl p-3 text-sm ${check.ok ? 'bg-sage-soft' : 'bg-danger-soft text-danger'}`}>
                    <p>{check.text}</p>
                    {check.items.map((t) => (
                      <p key={t} className="mt-1 text-xs">• {t}</p>
                    ))}
                  </div>
                )}
                <p className="mt-2 text-xs text-muted">
                  Inutile en temps normal : l’envoi est automatique après chaque modification, à l’ouverture et au retour du réseau. Android ne permet pas de synchroniser quand l’application est fermée.
                </p>
              </div>
            </SettingsGroup>

            {s.localOnly > 0 && (
              <SettingsGroup title="Recettes de démonstration">
                <div className="space-y-3 py-4 text-sm">
                  <p>
                    {s.localOnly} recette{s.localOnly > 1 ? 's' : ''} de démonstration sur ce téléphone : elles ne sont <strong>jamais synchronisées</strong>, même modifiées. Chaque téléphone a ses propres exemplaires, aux mêmes noms.
                  </p>
                  <p className="text-muted">Pour en partager une, ouvrez-la puis menu ⋮ → « En faire une recette familiale ».</p>
                  <Button size="sm" variant="secondary" onClick={() => void removeDemo()}>
                    Supprimer les recettes de démonstration
                  </Button>
                </div>
              </SettingsGroup>
            )}

            {s.family && (
              <SettingsGroup title="Catalogue familial">
                <LinkRow to="/reglages/synchronisation/conflits" icon={<GitMerge size={18} />} label="Modifications à revoir" detail={s.conflicts ? `${s.conflicts} conflit${s.conflicts > 1 ? 's' : ''} à résoudre` : 'Aucun conflit'} />
                <LinkRow to="/reglages/synchronisation/corbeille" icon={<Trash2 size={18} />} label="Corbeille familiale" detail="Recettes supprimées, restaurables 30 jours" />
                <div className="flex items-center gap-3 py-3.5 text-sm text-muted">
                  <span className="grid size-9 place-items-center rounded-full bg-sunken">
                    <Users size={18} />
                  </span>
                  {s.family.members.map((m) => m.display_name).join(', ')}
                </div>
              </SettingsGroup>
            )}
          </>
        )}

        {(connected || s.status === 'needs-migration' || s.status === 'revoked') && (
          <div className="mt-7">
            <Button variant="secondary" block icon={<LogOut size={17} />} onClick={() => void logout()}>
              Se déconnecter
            </Button>
          </div>
        )}
      </Page>
    </>
  )
}
