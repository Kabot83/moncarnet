import { BookOpen, Camera, ChefHat, Clapperboard, FileText, Home, Library, Link2, PenLine, Plus, Settings } from 'lucide-react'
import { useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { Sheet } from './ui/Sheet'

const TABS = [
  { to: '/', label: 'Accueil', icon: Home, end: true },
  // « À essayer » (TikTok, Instagram) est un onglet de « Mes recettes ».
  { to: '/recettes', label: 'Mes recettes', icon: BookOpen, also: /^\/a-essayer/ },
  { to: '/chef', label: 'Chef IA', icon: ChefHat },
  { to: '/collections', label: 'Collections', icon: Library },
  { to: '/reglages', label: 'Réglages', icon: Settings },
]

/** Pages où le bouton « + » flottant est proposé. */
const FAB_PAGES = [/^\/$/, /^\/recettes$/, /^\/collections/]

export function BottomNav() {
  const location = useLocation()
  const [addOpen, setAddOpen] = useState(false)
  const showFab = FAB_PAGES.some((re) => re.test(location.pathname))
  return (
    <>
      {showFab && (
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          aria-label="Ajouter une recette"
          className="hide-on-keyboard above-nav fixed right-4 z-30 grid size-15 place-items-center rounded-full bg-terra text-white shadow-[var(--shadow-float)] transition-transform active:scale-95 dark:text-[#1b1916]"
          style={{ width: '3.75rem', height: '3.75rem' }}
        >
          <Plus size={28} strokeWidth={2} />
        </button>
      )}
      <nav
        aria-label="Navigation principale"
        className="hide-on-keyboard safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line/70 bg-bg/92 backdrop-blur-xl"
      >
        <ul className="mx-auto grid h-[4.25rem] max-w-xl grid-cols-5">
          {TABS.map(({ to, label, icon: Icon, end, also }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
                    isActive || also?.test(location.pathname) ? 'text-terra' : 'text-muted hover:text-ink'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span className={`grid h-8 w-14 place-items-center rounded-full transition-colors ${isActive || also?.test(location.pathname) ? 'bg-terra-soft' : ''}`}>
                      <Icon size={21} strokeWidth={isActive || also?.test(location.pathname) ? 2 : 1.6} />
                    </span>
                    <span className="leading-none">{label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <AddRecipeSheet open={addOpen} onClose={() => setAddOpen(false)} />
    </>
  )
}

const ADD_MODES = [
  { to: '/recettes/nouvelle', icon: PenLine, title: 'Saisie manuelle', text: 'Remplir la fiche moi-même, à mon rythme.' },
  { to: '/a-essayer?importer=1', icon: Clapperboard, title: 'Depuis TikTok ou Instagram', text: 'Garder une vidéo dans « À essayer ».' },
  { to: '/importer/lien', icon: Link2, title: 'Depuis un lien', text: 'Récupérer une recette publiée sur Internet.' },
  { to: '/importer/photo', icon: Camera, title: 'Depuis une photo', text: 'Photographier un livre ou une fiche (Chef IA).' },
  { to: '/importer/texte', icon: FileText, title: 'Depuis un texte', text: 'Coller une recette copiée (Chef IA).' },
]

export function AddRecipeSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useSafeNavigate()
  return (
    <Sheet open={open} onClose={onClose} title="Ajouter une recette">
      <ul className="space-y-2 pb-2">
        {ADD_MODES.map(({ to, icon: Icon, title, text }) => (
          <li key={to}>
            <button
              type="button"
              onClick={() => {
                navigate(to)
                onClose()
              }}
              className="flex w-full items-center gap-4 rounded-2xl bg-paper p-4 text-left shadow-[var(--shadow-card)] transition-transform active:scale-[.99]"
            >
              <span className="grid size-12 shrink-0 place-items-center rounded-full bg-terra-soft text-terra">
                <Icon size={22} strokeWidth={1.75} />
              </span>
              <span className="min-w-0">
                <span className="block font-semibold">{title}</span>
                <span className="block text-sm text-muted">{text}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
