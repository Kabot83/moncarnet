import { Suspense, lazy, useEffect, useState } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { BottomNav } from './components/BottomNav'
import { TimerEngine, TimersDock } from './components/TimersDock'
import { UpdatePrompt } from './components/UpdatePrompt'
import { LoadingBlock } from './components/ui/Spinner'
import { requestPersistentStorage } from './db/db'
import { seedDemoData } from './db/seed'
import { findUrl } from './importers/url'
import { collectOrphanPhotos } from './services/photos'
import { getSettings, updateSettings, useSettings } from './services/settings'
import { initNative, setSystemBarsDark } from './platform/native'
import HomePage from './pages/HomePage'
import RecipesPage from './pages/RecipesPage'
import RecipePage from './pages/RecipePage'

// Écrans secondaires chargés à la demande (démarrage plus rapide).
const RecipeEditPage = lazy(() => import('./pages/RecipeEditPage'))
const CookModePage = lazy(() => import('./pages/CookModePage'))
const JournalPage = lazy(() => import('./pages/JournalPage'))
const ChefPage = lazy(() => import('./pages/ChefPage'))
const CollectionsPage = lazy(() => import('./pages/CollectionsPage'))
const CollectionPage = lazy(() => import('./pages/CollectionPage'))
const ShoppingPage = lazy(() => import('./pages/ShoppingPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))
const AiSettingsPage = lazy(() => import('./pages/AiSettingsPage'))
const ProfilePage = lazy(() => import('./pages/ProfilePage'))
const BackupPage = lazy(() => import('./pages/BackupPage'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const AboutPage = lazy(() => import('./pages/AboutPage'))

/** Démarrage unique (même si React monte deux fois en mode strict). */
let boot: Promise<void> | null = null
function bootstrap() {
  boot ??= (async () => {
    void initNative()
    const s = await getSettings()
    if (!s.demoSeeded) {
      await updateSettings({ demoSeeded: true })
      await seedDemoData()
    }
    void requestPersistentStorage()
    setTimeout(() => void collectOrphanPhotos(), 5000)
  })()
  return boot
}

/** Pages en plein écran, sans barre de navigation. */
const IMMERSIVE = [/\/cuisine$/, /\/modifier$/, /^\/recettes\/nouvelle/, /^\/importer/]

export function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const settings = useSettings()
  const [ready, setReady] = useState(false)

  // Démarrage : données de démonstration au premier lancement, stockage persistant, ménage photos.
  useEffect(() => {
    void bootstrap().finally(() => setReady(true))
  }, [])

  // Thème clair / sombre / système.
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && mq.matches)
      document.documentElement.classList.toggle('dark', dark)
      document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#1B1916' : '#F7F2EA'))
      void setSystemBarsDark(dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings.theme])

  // Partage Android (« Partager → Mon Carnet ») : ouvre l'import par lien.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const shared = params.get('url') || findUrl(`${params.get('text') ?? ''} ${params.get('title') ?? ''}`)
    if (shared || params.get('text')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.hash)
      if (shared) navigate(`/importer/lien?url=${encodeURIComponent(shared)}`)
      else navigate(`/importer/texte?text=${encodeURIComponent(params.get('text') ?? '')}`)
    }
  }, [navigate])

  // Remonte en haut à chaque changement de page.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  const immersive = IMMERSIVE.some((re) => re.test(location.pathname))
  if (!ready) return <div className="splash" aria-hidden="true"><span>Mon Carnet</span></div>

  return (
    <div className="min-h-dvh">
      <Suspense fallback={<LoadingBlock />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/recettes" element={<RecipesPage />} />
          <Route path="/recettes/nouvelle" element={<RecipeEditPage />} />
          <Route path="/recettes/:id" element={<RecipePage />} />
          <Route path="/recettes/:id/modifier" element={<RecipeEditPage />} />
          <Route path="/recettes/:id/cuisine" element={<CookModePage />} />
          <Route path="/recettes/:id/journal" element={<JournalPage />} />
          <Route path="/importer/:mode" element={<ImportPage />} />
          <Route path="/chef" element={<ChefPage />} />
          <Route path="/chef/:conversationId" element={<ChefPage />} />
          <Route path="/collections" element={<CollectionsPage />} />
          <Route path="/collections/:id" element={<CollectionPage />} />
          <Route path="/courses" element={<ShoppingPage />} />
          <Route path="/reglages" element={<SettingsPage />} />
          <Route path="/reglages/ia" element={<AiSettingsPage />} />
          <Route path="/reglages/profil" element={<ProfilePage />} />
          <Route path="/reglages/sauvegarde" element={<BackupPage />} />
          <Route path="/reglages/a-propos" element={<AboutPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </Suspense>
      <TimerEngine />
      {!immersive && <TimersDock />}
      {!immersive && <BottomNav />}
      <UpdatePrompt />
    </div>
  )
}
