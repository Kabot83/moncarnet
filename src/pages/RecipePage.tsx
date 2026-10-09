import { useLiveQuery } from 'dexie-react-hooks'
import {
  Bookmark,
  BookmarkCheck,
  ChefHat,
  Clock,
  Copy,
  ExternalLink,
  Flame,
  Heart,
  Library,
  MoreVertical,
  NotebookPen,
  PenLine,
  Play,
  Share2,
  ShoppingBasket,
  Sparkles,
  Thermometer,
  Timer as TimerIcon,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { CollectionPicker } from '@/components/CollectionPicker'
import { IngredientScaler } from '@/components/IngredientScaler'
import { JournalEntrySheet } from '@/components/JournalEntrySheet'
import { NotesSection } from '@/components/NotesSection'
import { NutritionPanel } from '@/components/NutritionPanel'
import { ShoppingBuilder } from '@/components/ShoppingBuilder'
import { SubstitutionSheet } from '@/components/SubstitutionSheet'
import { Button, IconButton } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { Stars, TextInput } from '@/components/ui/Fields'
import { EmptyState, Photo, PhotoPlaceholder, SectionTitle, TopBar } from '@/components/ui/Layout'
import { Sheet } from '@/components/ui/Sheet'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { formatDate, formatDuration, relativeDays } from '@/lib/format'
import { IDENTITY_SCALE, isAdjusted } from '@/lib/scaling'
import { recipeToText, shareText } from '@/lib/share'
import { type Ingredient, type JournalEntry, categoryLabel, difficultyLabel } from '@/models/types'
import { deleteRecipe, duplicateRecipe, patchRecipe, replaceOriginalQuantities, saveVariant, toggleFavorite, toggleToTry } from '@/services/recipes'
import { addTimer, resetSessionScale, setSessionScale, startCooking, useSession } from '@/services/sessions'
import { useSettings } from '@/services/settings'

export default function RecipePage() {
  const { id = '' } = useParams()
  const navigate = useSafeNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const settings = useSettings()
  const recipe = useLiveQuery(() => db.recipes.get(id), [id])
  const journal = useLiveQuery(() => db.journal.where('recipeId').equals(id).reverse().sortBy('date'), [id], [] as JournalEntry[])
  const parent = useLiveQuery(async () => (recipe?.variantOf ? db.recipes.get(recipe.variantOf) : undefined), [recipe?.variantOf])
  const session = useSession(id)
  const scale = session?.scale ?? IDENTITY_SCALE

  const [menuOpen, setMenuOpen] = useState(false)
  const [journalOpen, setJournalOpen] = useState(false)
  const [collectionsOpen, setCollectionsOpen] = useState(false)
  const [shoppingOpen, setShoppingOpen] = useState(false)
  const [variantOpen, setVariantOpen] = useState(false)
  const [variantTitle, setVariantTitle] = useState('')
  const [ingMenu, setIngMenu] = useState<Ingredient | null>(null)
  const [subFor, setSubFor] = useState<Ingredient | null>(null)

  if (recipe === undefined) return <LoadingBlock />
  if (recipe === null || !recipe)
    return (
      <>
        <TopBar back="/recettes" />
        <EmptyState title="Recette introuvable" action={<Button onClick={() => navigate('/recettes')}>Retour au catalogue</Button>}>
          Elle a peut-être été supprimée.
        </EmptyState>
      </>
    )

  const adjusted = isAdjusted(scale)
  const share = async () => {
    const res = await shareText(recipe.title, recipeToText(recipe, scale))
    if (res === 'copied') toast.success('Recette copiée dans le presse-papiers')
  }

  const remove = async () => {
    setMenuOpen(false)
    const ok = await confirm({
      title: 'Supprimer cette recette ?',
      message: `« ${recipe.title} », son journal (${journal.length} réalisation${journal.length > 1 ? 's' : ''}) et ses photos seront supprimés définitivement de ce téléphone.`,
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    await deleteRecipe(recipe.id)
    toast.success('Recette supprimée')
    navigate('/recettes', { replace: true })
  }

  const replaceOriginal = async () => {
    const ok = await confirm({
      title: 'Remplacer la recette originale ?',
      message: 'Les quantités ajustées deviendront les nouvelles quantités de référence de cette recette. Les anciennes quantités seront perdues (pensez à « Enregistrer comme variante » pour les conserver).',
      confirmLabel: 'Remplacer l’original',
      danger: true,
      acknowledge: 'Je comprends que les quantités d’origine seront remplacées.',
    })
    if (!ok) return
    await replaceOriginalQuantities(recipe, scale)
    await resetSessionScale(recipe.id)
    toast.success('Recette mise à jour avec les nouvelles proportions')
  }

  const createVariant = async () => {
    const v = await saveVariant(recipe, scale, variantTitle.trim() || undefined)
    setVariantOpen(false)
    toast.success('Variante enregistrée')
    navigate(`/recettes/${v.id}`)
  }

  const meta = [
    { icon: Clock, label: 'Préparation', value: formatDuration(recipe.prepTime) },
    { icon: Flame, label: 'Cuisson', value: formatDuration(recipe.cookTime) },
    { icon: TimerIcon, label: 'Repos', value: formatDuration(recipe.restTime) },
  ].filter((m) => m.value)

  return (
    <>
      <TopBar
        transparent
        back
        asHeading={false}
        title={recipe.title}
        actions={
          <>
            <IconButton label={recipe.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} tone="glass" onClick={() => void toggleFavorite(recipe)} aria-pressed={recipe.favorite}>
              <Heart size={20} fill={recipe.favorite ? 'currentColor' : 'none'} />
            </IconButton>
            <IconButton label="Partager" tone="glass" onClick={() => void share()}>
              <Share2 size={19} />
            </IconButton>
            <IconButton label="Plus d’actions" tone="glass" onClick={() => setMenuOpen(true)}>
              <MoreVertical size={20} />
            </IconButton>
          </>
        }
      />
      <div className="-mt-[calc(3.5rem+env(safe-area-inset-top))]">
        <div className="relative mx-auto aspect-[4/3] max-h-[60vh] w-full max-w-3xl overflow-hidden sm:rounded-b-[2rem]">
          <Photo id={recipe.mainPhotoId} alt={recipe.title} variant="full" className="size-full" fallback={<PhotoPlaceholder title={recipe.title} className="size-full" />} />
          <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/45 to-transparent" />
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4 pb-36">
        <div className="relative -mt-8 rounded-[1.75rem] bg-bg px-1 pt-6 animate-fade-up">
          <p className="eyebrow">
            {categoryLabel(recipe.category)} · {difficultyLabel(recipe.difficulty)}
            {recipe.isDemo && <span className="ml-2 rounded-full bg-sunken px-2 py-0.5 text-[10px] text-muted normal-case">Démonstration</span>}
          </p>
          <h1 className="mt-1.5 font-serif text-[2rem] leading-[1.15] font-semibold">{recipe.title}</h1>
          {parent && (
            <p className="mt-1 text-sm text-muted">
              Variante de{' '}
              <Link to={`/recettes/${parent.id}`} className="font-medium text-terra underline-offset-2 hover:underline">
                {parent.title}
              </Link>
            </p>
          )}
          {recipe.description && <p className="mt-3 text-[16px] leading-relaxed text-muted">{recipe.description}</p>}

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Stars value={recipe.rating} onChange={(v) => void patchRecipe(recipe.id, { rating: v }, false)} size={20} label="Ma note" />
            <button
              type="button"
              onClick={() => void toggleToTry(recipe)}
              aria-pressed={recipe.toTry}
              className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-medium ${recipe.toTry ? 'bg-sage-soft text-sage' : 'bg-sunken text-muted'}`}
            >
              {recipe.toTry ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}À essayer
            </button>
          </div>

          {meta.length > 0 && (
            <dl className="mt-5 grid grid-cols-3 gap-2">
              {meta.map(({ icon: Icon, label, value }) => (
                <div key={label} className="rounded-2xl bg-paper p-3 text-center shadow-[var(--shadow-card)]">
                  <Icon size={18} strokeWidth={1.6} className="mx-auto text-terra" />
                  <dt className="mt-1 text-[11px] tracking-wide text-muted uppercase">{label}</dt>
                  <dd className="font-semibold">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          <p className="mt-4 text-sm text-muted">
            {recipe.cookCount ? (
              <>
                Cuisinée <strong className="text-ink">{recipe.cookCount} fois</strong> · dernière fois {relativeDays(recipe.lastCookedAt)}
              </>
            ) : (
              'Jamais cuisinée pour l’instant'
            )}
          </p>
          {recipe.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {recipe.tags.map((t) => (
                <Link key={t} to={`/recettes?q=${encodeURIComponent(t)}`} className="rounded-full bg-sunken px-3 py-1 text-xs font-medium text-muted">
                  #{t}
                </Link>
              ))}
            </div>
          )}

          <div className="mt-6 grid grid-cols-2 gap-3">
            <Button size="lg" icon={<Play size={18} fill="currentColor" />} onClick={() => navigate(`/recettes/${recipe.id}/cuisine`)}>
              Cuisiner
            </Button>
            <Button size="lg" variant="secondary" icon={<NotebookPen size={18} />} onClick={() => setJournalOpen(true)}>
              J’ai cuisiné
            </Button>
          </div>
          <Button variant="sage" block className="mt-3" icon={<Sparkles size={17} />} onClick={() => navigate(`/chef?recette=${recipe.id}`)}>
            Demander au Chef IA
          </Button>

          <SectionTitle id="ingredients">Ingrédients</SectionTitle>
          {recipe.ingredients.length ? (
            <IngredientScaler
              recipe={recipe}
              scale={scale}
              onScaleChange={(s) => void setSessionScale(recipe.id, s)}
              onIngredientMenu={setIngMenu}
              adjustedActions={
                <>
                  <Button
                    size="sm"
                    onClick={async () => {
                      await startCooking(recipe.id)
                      navigate(`/recettes/${recipe.id}/cuisine`)
                    }}
                  >
                    Utiliser pour cette préparation
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setVariantTitle(`${recipe.title} (variante)`)
                      setVariantOpen(true)
                    }}
                  >
                    Enregistrer comme variante
                  </Button>
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => void replaceOriginal()}>
                    Remplacer l’original…
                  </Button>
                </>
              }
            />
          ) : (
            <p className="text-muted">Aucun ingrédient renseigné.</p>
          )}
          {!adjusted && recipe.ingredients.some((i) => i.quantity) && (
            <p className="mt-3 text-xs text-faint">Astuce : touchez − ou + à côté de n’importe quel ingrédient, ou sa quantité, pour adapter toute la recette.</p>
          )}

          <SectionTitle>Préparation</SectionTitle>
          {recipe.steps.length ? (
            <ol className="space-y-4">
              {recipe.steps.map((s, k) => (
                <li key={s.id} className="flex gap-4">
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-terra-soft font-serif font-semibold text-terra-strong">{k + 1}</span>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <p className="text-[16px] leading-relaxed whitespace-pre-line">{s.text}</p>
                    {s.photoId && <Photo id={s.photoId} alt={`Étape ${k + 1}`} variant="full" className="mt-3 aspect-video rounded-2xl" />}
                    {(s.temperatureC != null || s.durationMin || s.timerMin) && (
                      <div className="mt-2 flex flex-wrap gap-2 text-sm">
                        {s.temperatureC != null && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1 text-muted">
                            <Thermometer size={14} /> {s.temperatureC} °C
                          </span>
                        )}
                        {s.durationMin && !s.timerMin ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-sunken px-2.5 py-1 text-muted">
                            <Clock size={14} /> {formatDuration(s.durationMin)}
                          </span>
                        ) : null}
                        {s.timerMin ? (
                          <button
                            type="button"
                            onClick={() => {
                              void addTimer(`${recipe.title} — étape ${k + 1}`, s.timerMin!, recipe.id)
                              toast.success(`Minuterie de ${formatDuration(s.timerMin)} lancée`)
                            }}
                            className="inline-flex items-center gap-1 rounded-full bg-terra-soft px-3 py-1 font-semibold text-terra-strong"
                          >
                            <TimerIcon size={14} /> Minuterie {formatDuration(s.timerMin)}
                          </button>
                        ) : null}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-muted">Aucune étape renseignée.</p>
          )}

          <SectionTitle>Mes notes</SectionTitle>
          <NotesSection recipe={recipe} />

          {settings.nutritionEnabled && (
            <>
              <SectionTitle>Nutrition</SectionTitle>
              <NutritionPanel recipe={recipe} scale={scale} />
            </>
          )}

          <SectionTitle action={journal.length > 0 ? <Link to={`/recettes/${recipe.id}/journal`} className="text-sm font-semibold text-terra">Tout l’historique</Link> : undefined}>
            Journal de cuisine
          </SectionTitle>
          {journal.length === 0 ? (
            <p className="text-muted">Notez chaque réalisation pour garder une trace de vos essais.</p>
          ) : (
            <ul className="space-y-2">
              {journal.slice(0, 3).map((j) => (
                <li key={j.id}>
                  <Link to={`/recettes/${recipe.id}/journal`} className="flex gap-3 rounded-2xl bg-paper p-3 shadow-[var(--shadow-card)]">
                    {j.photoId && <Photo id={j.photoId} alt="" className="size-16 shrink-0 rounded-xl" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{formatDate(j.date)}</span>
                        <Stars value={j.rating} size={13} />
                      </div>
                      {j.comment && <p className="line-clamp-2 text-sm text-muted">{j.comment}</p>}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Button variant="secondary" className="mt-3" icon={<NotebookPen size={16} />} onClick={() => setJournalOpen(true)}>
            Ajouter une réalisation
          </Button>

          {recipe.galleryPhotoIds.length > 0 && (
            <>
              <SectionTitle>Galerie</SectionTitle>
              <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4">
                {recipe.galleryPhotoIds.map((p) => (
                  <Photo key={p} id={p} alt="" variant="full" className="aspect-[4/3] w-64 shrink-0 snap-start rounded-2xl" />
                ))}
              </div>
            </>
          )}

          {(recipe.source || recipe.sourceUrl) && (
            <p className="mt-8 text-sm text-muted">
              Source :{' '}
              {recipe.sourceUrl ? (
                <a href={recipe.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-terra underline-offset-2 hover:underline">
                  {recipe.source || new URL(recipe.sourceUrl).hostname} <ExternalLink size={13} />
                </a>
              ) : (
                recipe.source
              )}
            </p>
          )}
          <p className="mt-2 text-xs text-faint">
            Créée le {formatDate(recipe.createdAt)} · modifiée le {formatDate(recipe.updatedAt)}
          </p>
        </div>
      </main>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title={recipe.title}>
        <nav className="grid gap-1 pb-2">
          <MenuItem icon={PenLine} label="Modifier la recette" onClick={() => navigate(`/recettes/${recipe.id}/modifier`)} />
          <MenuItem icon={Library} label="Ranger dans une collection" onClick={() => (setMenuOpen(false), setCollectionsOpen(true))} />
          <MenuItem icon={ShoppingBasket} label="Ajouter à la liste de courses" onClick={() => (setMenuOpen(false), setShoppingOpen(true))} />
          <MenuItem icon={ChefHat} label="Demander au Chef IA" onClick={() => navigate(`/chef?recette=${recipe.id}`)} />
          <MenuItem
            icon={Copy}
            label="Dupliquer"
            onClick={async () => {
              const copy = await duplicateRecipe(recipe)
              navigate(`/recettes/${copy.id}/modifier`)
            }}
          />
          <MenuItem icon={Share2} label="Partager en texte" onClick={() => (setMenuOpen(false), void share())} />
          <MenuItem icon={Trash2} label="Supprimer" danger onClick={() => void remove()} />
        </nav>
      </Sheet>

      <Sheet open={!!ingMenu} onClose={() => setIngMenu(null)} title={ingMenu?.name}>
        <nav className="grid gap-1 pb-2">
          <MenuItem
            icon={Sparkles}
            label="Par quoi le remplacer ? (Chef IA)"
            onClick={() => {
              setSubFor(ingMenu)
              setIngMenu(null)
            }}
          />
          <MenuItem icon={PenLine} label="Modifier dans la fiche" onClick={() => navigate(`/recettes/${recipe.id}/modifier`)} />
        </nav>
      </Sheet>

      <Sheet
        open={variantOpen}
        onClose={() => setVariantOpen(false)}
        title="Enregistrer comme variante"
        description="Une nouvelle recette est créée avec les proportions ajustées. L’originale reste inchangée."
        footer={
          <Button block onClick={() => void createVariant()}>
            Créer la variante
          </Button>
        }
      >
        <TextInput label="Nom de la variante" value={variantTitle} onChange={(e) => setVariantTitle(e.target.value)} data-autofocus />
      </Sheet>

      <JournalEntrySheet open={journalOpen} onClose={() => setJournalOpen(false)} recipe={recipe} scale={session?.scale ?? null} />
      <CollectionPicker open={collectionsOpen} onClose={() => setCollectionsOpen(false)} recipeId={recipe.id} />
      <ShoppingBuilder open={shoppingOpen} onClose={() => setShoppingOpen(false)} recipeIds={[recipe.id]} />
      <SubstitutionSheet open={!!subFor} onClose={() => setSubFor(null)} recipe={recipe} ingredient={subFor} />
    </>
  )
}

function MenuItem({ icon: Icon, label, onClick, danger }: { icon: typeof Heart; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={`flex items-center gap-4 rounded-xl px-3 py-3.5 text-left text-[15px] font-medium hover:bg-sunken ${danger ? 'text-danger' : ''}`}>
      <Icon size={20} strokeWidth={1.7} className={danger ? '' : 'text-muted'} />
      {label}
    </button>
  )
}
