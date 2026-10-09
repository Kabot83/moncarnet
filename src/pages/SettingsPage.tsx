import { useLiveQuery } from 'dexie-react-hooks'
import { ChefHat, ChevronRight, Database, Info, Monitor, Moon, ShieldCheck, ShoppingBasket, Sun, User } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { Segmented, Switch } from '@/components/ui/Fields'
import { Page } from '@/components/ui/Layout'
import { db, requestPersistentStorage, storageEstimate } from '@/db/db'
import { seedDemoData } from '@/db/seed'
import { formatBytes, relativeDays } from '@/lib/format'
import { deleteDemoData } from '@/services/recipes'
import { photosSize } from '@/services/photos'
import { updateSettings, useSettings } from '@/services/settings'

export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-2 px-1 text-xs font-semibold tracking-[0.12em] text-terra uppercase">{title}</h2>
      <div className="divide-y divide-line/70 rounded-[var(--radius-card)] bg-paper px-4 shadow-[var(--shadow-card)]">{children}</div>
    </section>
  )
}

function NavRow({ to, icon, label, detail }: { to: string; icon: ReactNode; label: string; detail?: string }) {
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

export default function SettingsPage() {
  const settings = useSettings()
  const toast = useToast()
  const confirm = useConfirm()
  const demoCount = useLiveQuery(() => db.recipes.filter((r) => r.isDemo).count(), [], 0)
  const recipeCount = useLiveQuery(() => db.recipes.count(), [], 0)
  const [storage, setStorage] = useState<{ usage: number; quota: number; persisted: boolean } | null>(null)
  const [photos, setPhotos] = useState<{ count: number; bytes: number } | null>(null)

  useEffect(() => {
    void storageEstimate().then(setStorage)
    void photosSize().then(setPhotos)
  }, [recipeCount])

  const aiDetail = settings.aiMode === 'off' ? 'Désactivé' : `${settings.aiMode === 'proxy' ? 'Via mon proxy' : 'Clé sur cet appareil'} · ${settings.aiModel || 'modèle à choisir'}`

  return (
    <Page>
      <header className="pt-[calc(2rem+var(--sat))]">
        <p className="eyebrow">Mon Carnet</p>
        <h1 className="mt-1 font-serif text-[2rem] font-semibold">Réglages</h1>
      </header>

      <SettingsGroup title="Apparence">
        <div className="flex items-center justify-between gap-3 py-3">
          <span className="font-medium">Thème</span>
          <Segmented
            label="Thème"
            value={settings.theme}
            onChange={(theme) => void updateSettings({ theme })}
            options={[
              { value: 'light', label: 'Clair', icon: <Sun size={15} /> },
              { value: 'dark', label: 'Sombre', icon: <Moon size={15} /> },
              { value: 'system', label: 'Auto', icon: <Monitor size={15} /> },
            ]}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title="Ajustement des quantités">
        <div className="py-3">
          <p className="font-medium">Arrondis d’affichage</p>
          <p className="mb-3 text-sm text-muted">Les calculs internes ne sont jamais arrondis. Exemple : 133,3 g de farine.</p>
          <Segmented
            label="Arrondis"
            value={settings.rounding}
            onChange={(rounding) => void updateSettings({ rounding })}
            options={[
              { value: 'practical', label: 'Pratique (135 g)' },
              { value: 'precise', label: 'Précis (133 g)' },
            ]}
          />
        </div>
        <Switch label="Autoriser les demi-œufs" description="Sinon, les œufs sont arrondis à l’unité." checked={settings.allowHalfEggs} onChange={(v) => void updateSettings({ allowHalfEggs: v })} />
        <Switch label="Informations nutritionnelles" description="Module facultatif sur les fiches recettes." checked={settings.nutritionEnabled} onChange={(v) => void updateSettings({ nutritionEnabled: v })} />
      </SettingsGroup>

      <SettingsGroup title="Assistant">
        <NavRow to="/reglages/ia" icon={<ChefHat size={18} />} label="Mon Chef IA" detail={aiDetail} />
        <NavRow to="/reglages/profil" icon={<User size={18} />} label="Profil culinaire" detail="Goûts, allergènes, matériel…" />
      </SettingsGroup>

      <SettingsGroup title="Mes données">
        <NavRow
          to="/reglages/sauvegarde"
          icon={<Database size={18} />}
          label="Sauvegarder / restaurer mon carnet"
          detail={settings.lastBackupAt ? `Dernière sauvegarde ${relativeDays(settings.lastBackupAt)}` : 'Aucune sauvegarde'}
        />
        <NavRow to="/courses" icon={<ShoppingBasket size={18} />} label="Liste de courses" />
        <div className="py-3.5 text-sm">
          <p className="font-medium">Stockage sur ce téléphone</p>
          <p className="mt-1 text-muted">
            {recipeCount} recette{recipeCount > 1 ? 's' : ''}
            {photos ? ` · ${photos.count} photo${photos.count > 1 ? 's' : ''} (${formatBytes(photos.bytes)})` : ''}
            {storage ? ` · ${formatBytes(storage.usage)} utilisés` : ''}
          </p>
          {storage && (
            <p className="mt-1 flex items-center gap-1.5 text-muted">
              <ShieldCheck size={15} className={storage.persisted ? 'text-sage' : 'text-faint'} />
              {storage.persisted ? 'Stockage persistant accordé : le navigateur ne l’effacera pas de lui-même.' : 'Stockage non persistant : le navigateur pourrait l’effacer en cas de manque d’espace.'}
            </p>
          )}
          {storage && !storage.persisted && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={async () => {
                const ok = await requestPersistentStorage()
                setStorage(await storageEstimate())
                toast[ok ? 'success' : 'info'](ok ? 'Stockage persistant accordé' : 'Le navigateur n’a pas accordé le stockage persistant. Installez l’application sur l’écran d’accueil puis réessayez.')
              }}
            >
              Demander le stockage persistant
            </Button>
          )}
        </div>
      </SettingsGroup>

      <SettingsGroup title="Données de démonstration">
        <div className="py-3.5">
          <p className="text-sm text-muted">
            {demoCount
              ? `${demoCount} recette${demoCount > 1 ? 's' : ''} de démonstration (identifiées par l’étiquette « Démonstration »), avec leurs photos, journaux et collections.`
              : 'Aucune recette de démonstration.'}
          </p>
          <div className="mt-3">
            {demoCount ? (
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  if (!(await confirm({ title: 'Supprimer les données de démonstration ?', message: 'Vos propres recettes ne sont pas concernées.', confirmLabel: 'Supprimer', danger: true }))) return
                  await deleteDemoData()
                  toast.success('Données de démonstration supprimées')
                }}
              >
                Supprimer les recettes de démonstration
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  await seedDemoData()
                  toast.success('Recettes de démonstration ajoutées')
                }}
              >
                Réinstaller les recettes de démonstration
              </Button>
            )}
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Application">
        <NavRow to="/reglages/a-propos" icon={<Info size={18} />} label="À propos et confidentialité" detail="Installation, hors ligne, vos données" />
      </SettingsGroup>
    </Page>
  )
}
