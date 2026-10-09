import { ArrowDown, ArrowUp, ChevronDown, ClipboardList, ImagePlus, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { SinglePhotoField, usePhotoInput } from '@/components/PhotoPicker'
import { Button, IconButton } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { Chip, NumberInput, Segmented, Switch, TextArea, TextInput } from '@/components/ui/Fields'
import { EmptyState, Photo, TopBar } from '@/components/ui/Layout'
import { Sheet } from '@/components/ui/Sheet'
import { LoadingBlock } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { suggestNonScalable } from '@/lib/scaling'
import { formatNumber, parseIngredientLine, parseQuantity } from '@/lib/units'
import { CATEGORIES, DIFFICULTIES, type Draft, type Ingredient, NOTE_FIELDS, type Recipe, type Step } from '@/models/types'
import { deleteDraft, saveDraft } from '@/services/drafts'
import { ValidationError, emptyIngredient, emptyRecipe, emptyStep, saveRecipe } from '@/services/recipes'

const UNIT_SUGGESTIONS = ['g', 'kg', 'ml', 'cl', 'l', 'c. à soupe', 'c. à café', 'pincée', 'gousse', 'tranche', 'sachet', 'brin', 'boîte', 'pot', 'feuille']

function move<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr
  const next = [...arr]
  const [x] = next.splice(from, 1)
  next.splice(to, 0, x)
  return next
}

export default function RecipeEditPage() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const navigate = useSafeNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const draftId = id ? `edit:${id}` : (params.get('draft') ?? 'new')

  const [recipe, setRecipe] = useState<Recipe | null>(null)
  const [origin, setOrigin] = useState<Draft['origin']>('manual')
  const [warnings, setWarnings] = useState<string[]>([])
  const [restored, setRestored] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const dirty = useRef(false)
  const original = useRef<string>('')

  // Chargement : brouillon en cours, recette existante ou fiche vierge.
  useEffect(() => {
    let alive = true
    ;(async () => {
      const draft = await db.drafts.get(draftId)
      const existing = id ? await db.recipes.get(id) : undefined
      if (!alive) return
      if (id && !existing) return setNotFound(true)
      if (draft && (!existing || draft.updatedAt > existing.updatedAt)) {
        setRecipe(draft.data)
        setOrigin(draft.origin)
        setWarnings(draft.warnings ?? [])
        setRestored(draft.origin === 'manual' || draft.origin === 'edit')
        original.current = JSON.stringify(existing ?? null)
        dirty.current = draft.origin === 'manual' || draft.origin === 'edit'
      } else {
        const r = existing ?? emptyRecipe({ title: '', ingredients: [emptyIngredient()], steps: [emptyStep()] })
        setRecipe(r)
        setOrigin(id ? 'edit' : 'manual')
        original.current = JSON.stringify(r)
      }
    })().catch(() => alive && setLoadError(true))
    return () => {
      alive = false
    }
  }, [draftId, id])

  // Sauvegarde automatique du brouillon.
  useEffect(() => {
    if (!recipe) return
    const json = JSON.stringify(recipe)
    if (json === original.current && origin !== 'url' && origin !== 'photo' && origin !== 'text' && origin !== 'ai') return
    dirty.current = json !== original.current
    const t = setTimeout(() => void saveDraft({ id: draftId, data: recipe, origin, warnings, updatedAt: Date.now() }), 500)
    return () => clearTimeout(t)
  }, [recipe, draftId, origin, warnings])

  const groups = useMemo(() => [...new Set((recipe?.ingredients ?? []).map((i) => i.group).filter(Boolean))], [recipe?.ingredients])

  if (notFound || loadError)
    return (
      <>
        <TopBar back title={id ? 'Modifier la recette' : 'Nouvelle recette'} />
        <EmptyState title={notFound ? 'Recette introuvable' : 'Impossible d’ouvrir cette fiche'} action={<Button onClick={() => navigate('/recettes', { replace: true })}>Retour au catalogue</Button>}>
          {notFound ? 'Elle a peut-être été supprimée.' : 'Le brouillon est peut-être corrompu. Vous pouvez recommencer la saisie.'}
        </EmptyState>
      </>
    )
  if (!recipe) return <LoadingBlock />

  const set = (patch: Partial<Recipe>) => setRecipe((r) => (r ? { ...r, ...patch } : r))
  const setIng = (i: number, patch: Partial<Ingredient>) => set({ ingredients: recipe.ingredients.map((x, k) => (k === i ? { ...x, ...patch } : x)) })
  const setStep = (i: number, patch: Partial<Step>) => set({ steps: recipe.steps.map((x, k) => (k === i ? { ...x, ...patch } : x)) })

  const save = async () => {
    setErrors([])
    if (!recipe.title.trim()) {
      setErrors(['Donnez un nom à la recette.'])
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    setSaving(true)
    try {
      const saved = await saveRecipe(recipe)
      await deleteDraft(draftId)
      dirty.current = false
      toast.success(id ? 'Modifications enregistrées' : 'Recette ajoutée à votre carnet')
      navigate(`/recettes/${saved.id}`, { replace: true })
    } catch (e) {
      setErrors(e instanceof ValidationError ? e.issues : ['Enregistrement impossible. Vérifiez les champs.'])
    } finally {
      setSaving(false)
    }
  }

  const cancel = async () => {
    if (dirty.current) {
      const ok = await confirm({
        title: 'Abandonner les modifications ?',
        message: 'Le brouillon sera supprimé.',
        confirmLabel: 'Abandonner',
        cancelLabel: 'Continuer l’édition',
        danger: true,
      })
      if (!ok) return
    }
    await deleteDraft(draftId)
    if (id) navigate(`/recettes/${id}`, { replace: true })
    else window.history.length > 1 ? window.history.back() : navigate('/', { replace: true })
  }

  return (
    <>
      <TopBar
        title={id ? 'Modifier la recette' : 'Nouvelle recette'}
        actions={
          <>
            <IconButton label="Annuler" onClick={() => void cancel()}>
              <X size={22} />
            </IconButton>
          </>
        }
      />
      <main className="mx-auto max-w-2xl space-y-8 px-4 pt-4 pb-40">
        {restored && (
          <div className="rounded-2xl bg-sage-soft p-3 text-sm" role="status">
            Brouillon restauré : vous reprenez là où vous vous étiez arrêté.
          </div>
        )}
        {warnings.length > 0 && (
          <div className="rounded-2xl border border-gold/40 bg-[color-mix(in_oklab,var(--c-gold)_14%,transparent)] p-4 text-sm" role="note">
            <p className="font-semibold">À vérifier avant d’enregistrer</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
            {(origin === 'photo' || origin === 'text' || origin === 'ai') && (
              <p className="mt-2 text-muted">Contenu proposé par IA : contrôlez les quantités, températures et temps de cuisson.</p>
            )}
          </div>
        )}
        {errors.length > 0 && (
          <div className="rounded-2xl bg-danger-soft p-4 text-sm text-danger" role="alert">
            {errors.map((e) => (
              <p key={e}>{e}</p>
            ))}
          </div>
        )}

        <section className="space-y-4">
          <SinglePhotoField label="Photo principale" value={recipe.mainPhotoId} onChange={(v) => set({ mainPhotoId: v })} />
          <TextInput label="Nom de la recette *" value={recipe.title} placeholder="Ex. : Crêpes de ma grand-mère" onChange={(e) => set({ title: e.target.value })} required />
          <TextArea label="Description" value={recipe.description} placeholder="Quelques mots pour donner envie…" onChange={(e) => set({ description: e.target.value })} />
          <div>
            <span className="label">Catégorie</span>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <Chip key={c.id} active={recipe.category === c.id} onClick={() => set({ category: c.id })}>
                  {c.label.replace(/s$/, '').replace('Petits-déjeuner', 'Petit-déjeuner')}
                </Chip>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Difficulté</span>
            <Segmented label="Difficulté" value={recipe.difficulty} onChange={(v) => set({ difficulty: v })} options={DIFFICULTIES.map((d) => ({ value: d.id, label: d.label }))} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <NumberInput label="Préparation" suffix="min" value={recipe.prepTime} onChange={(v) => set({ prepTime: v })} />
            <NumberInput label="Cuisson" suffix="min" value={recipe.cookTime} onChange={(v) => set({ cookTime: v })} />
            <NumberInput label="Repos" suffix="min" value={recipe.restTime} onChange={(v) => set({ restTime: v })} />
            <NumberInput label="Portions" value={recipe.servings} onChange={(v) => set({ servings: v })} />
          </div>
          <TagsInput tags={recipe.tags} onChange={(tags) => set({ tags })} />
        </section>

        <section>
          <div className="mb-3 flex items-end justify-between">
            <h2 className="font-serif text-xl font-semibold">Ingrédients</h2>
            <Button size="sm" variant="ghost" icon={<ClipboardList size={16} />} onClick={() => setBulkOpen(true)}>
              Coller une liste
            </Button>
          </div>
          <datalist id="units">
            {UNIT_SUGGESTIONS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          <datalist id="groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <ol className="space-y-2">
            {recipe.ingredients.map((ing, i) => (
              <IngredientEditor
                key={ing.id}
                ing={ing}
                index={i}
                count={recipe.ingredients.length}
                onChange={(p) => setIng(i, p)}
                onMove={(d) => set({ ingredients: move(recipe.ingredients, i, i + d) })}
                onRemove={() => set({ ingredients: recipe.ingredients.filter((_, k) => k !== i) })}
              />
            ))}
          </ol>
          <Button
            variant="secondary"
            block
            className="mt-3"
            icon={<Plus size={18} />}
            onClick={() => set({ ingredients: [...recipe.ingredients, emptyIngredient({ group: recipe.ingredients.at(-1)?.group ?? '' })] })}
          >
            Ajouter un ingrédient
          </Button>
        </section>

        <section>
          <h2 className="mb-3 font-serif text-xl font-semibold">Étapes</h2>
          <ol className="space-y-3">
            {recipe.steps.map((s, i) => (
              <StepEditor
                key={s.id}
                step={s}
                index={i}
                count={recipe.steps.length}
                onChange={(p) => setStep(i, p)}
                onMove={(d) => set({ steps: move(recipe.steps, i, i + d) })}
                onRemove={() => set({ steps: recipe.steps.filter((_, k) => k !== i) })}
              />
            ))}
          </ol>
          <Button variant="secondary" block className="mt-3" icon={<Plus size={18} />} onClick={() => set({ steps: [...recipe.steps, emptyStep()] })}>
            Ajouter une étape
          </Button>
        </section>

        <section className="space-y-4">
          <h2 className="font-serif text-xl font-semibold">Mes notes</h2>
          {NOTE_FIELDS.map((f) => (
            <TextArea key={f.id} label={f.label} value={recipe.notes[f.id]} onChange={(e) => set({ notes: { ...recipe.notes, [f.id]: e.target.value } })} />
          ))}
        </section>

        <section className="space-y-4">
          <h2 className="font-serif text-xl font-semibold">Galerie et source</h2>
          <Gallery ids={recipe.galleryPhotoIds} onChange={(galleryPhotoIds) => set({ galleryPhotoIds })} />
          <TextInput label="Source" placeholder="Livre, site, personne…" value={recipe.source} onChange={(e) => set({ source: e.target.value })} />
          <TextInput label="Lien d’origine" type="url" inputMode="url" placeholder="https://…" value={recipe.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} />
          <div className="divide-y divide-line rounded-2xl bg-paper px-4">
            <Switch label="Favorite" checked={recipe.favorite} onChange={(v) => set({ favorite: v })} />
            <Switch label="À essayer" description="Recette pas encore testée." checked={recipe.toTry} onChange={(v) => set({ toTry: v })} />
          </div>
        </section>
      </main>

      <div className="hide-on-keyboard safe-bottom fixed inset-x-0 bottom-0 z-40 border-t border-line/70 bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl gap-3 px-4 py-3">
          <Button variant="secondary" onClick={() => void cancel()}>
            Annuler
          </Button>
          <Button block size="lg" loading={saving} onClick={() => void save()}>
            {id ? 'Enregistrer' : 'Ajouter au carnet'}
          </Button>
        </div>
      </div>

      <BulkIngredientsSheet
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onAdd={(list) => set({ ingredients: [...recipe.ingredients.filter((i) => i.name.trim() || i.quantity != null), ...list] })}
      />
    </>
  )
}

function IngredientEditor({
  ing,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  ing: Ingredient
  index: number
  count: number
  onChange: (p: Partial<Ingredient>) => void
  onMove: (d: 1 | -1) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [qtyText, setQtyText] = useState(ing.quantity != null ? formatNumber(ing.quantity, 3) : ing.quantityText)
  const commitQty = (t: string) => {
    const q = parseQuantity(t)
    onChange(q != null ? { quantity: q, quantityText: '' } : { quantity: null, quantityText: t.trim() })
  }
  return (
    <li className="rounded-2xl bg-paper p-2.5 shadow-[var(--shadow-card)]">
      <div className="flex items-center gap-2">
        <input
          aria-label={`Quantité de l’ingrédient ${index + 1}`}
          className="field h-11 min-h-0 w-[4.5rem] px-2 text-center"
          inputMode="decimal"
          placeholder="Qté"
          value={qtyText}
          onChange={(e) => {
            setQtyText(e.target.value)
            commitQty(e.target.value)
          }}
        />
        <input aria-label="Unité" list="units" className="field h-11 min-h-0 w-[5.5rem] px-2" placeholder="Unité" value={ing.unit} onChange={(e) => onChange({ unit: e.target.value })} />
        <input
          aria-label="Nom de l’ingrédient"
          className="field h-11 min-h-0 flex-1 px-3"
          placeholder="Ingrédient"
          value={ing.name}
          onChange={(e) => onChange({ name: e.target.value })}
          onBlur={() => {
            // Suggestion : sel, épices, levure… exclus de la proportionnalité.
            if (ing.name && ing.scalable && suggestNonScalable(ing.name) && ing.quantity != null && ing.quantity <= 5) onChange({ scalable: false })
          }}
        />
        <IconButton label={expanded ? 'Masquer les options' : 'Plus d’options'} size="sm" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          <ChevronDown size={18} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </IconButton>
      </div>
      {(!ing.scalable || ing.toTaste || ing.group || ing.note || ing.nutrition || ing.nutritionExcluded) && !expanded && (
        <p className="mt-1.5 px-1 text-xs text-muted">
          {[
            ing.group && `Groupe : ${ing.group}`,
            !ing.scalable && 'Quantité fixe',
            ing.toTaste && 'Selon le goût',
            ing.nutrition && `Nutrition : ${ing.nutrition.food.name}`,
            ing.nutritionExcluded && 'Hors calcul nutritionnel',
            ing.note,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {expanded && (
        <div className="mt-3 space-y-3 border-t border-line pt-3 animate-fade">
          <div className="grid grid-cols-2 gap-2">
            <TextInput label="Note" placeholder="Ex. : bien froid" value={ing.note} onChange={(e) => onChange({ note: e.target.value })} />
            <TextInput label="Groupe" list="groups" placeholder="Ex. : Pâte, Sauce" value={ing.group} onChange={(e) => onChange({ group: e.target.value })} />
          </div>
          <Switch
            label="Proportionnel"
            description="Suit l’ajustement des quantités. À désactiver pour le sel, les épices, la levure…"
            checked={ing.scalable}
            onChange={(v) => onChange({ scalable: v })}
          />
          <Switch label="Selon le goût" checked={ing.toTaste} onChange={(v) => onChange({ toTaste: v })} />
          {ing.nutrition && (
            <div className="flex items-center gap-2 rounded-xl bg-sunken p-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                Nutrition : <strong>{ing.nutrition.food.name}</strong>
              </span>
              <Button size="sm" variant="ghost" onClick={() => onChange({ nutrition: null })}>
                Retirer
              </Button>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="flex gap-1">
              <IconButton label="Monter" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>
                <ArrowUp size={18} />
              </IconButton>
              <IconButton label="Descendre" size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>
                <ArrowDown size={18} />
              </IconButton>
            </div>
            <Button size="sm" variant="danger" icon={<Trash2 size={15} />} onClick={onRemove}>
              Supprimer
            </Button>
          </div>
        </div>
      )}
    </li>
  )
}

function StepEditor({
  step,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  step: Step
  index: number
  count: number
  onChange: (p: Partial<Step>) => void
  onMove: (d: 1 | -1) => void
  onRemove: () => void
}) {
  const { inputs, openGallery, busy } = usePhotoInput((id) => onChange({ photoId: id }))
  return (
    <li className="rounded-2xl bg-paper p-3 shadow-[var(--shadow-card)]">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-full bg-terra-soft text-sm font-semibold text-terra-strong">{index + 1}</span>
        <span className="flex-1" />
        <IconButton label="Monter l’étape" size="sm" disabled={index === 0} onClick={() => onMove(-1)}>
          <ArrowUp size={17} />
        </IconButton>
        <IconButton label="Descendre l’étape" size="sm" disabled={index === count - 1} onClick={() => onMove(1)}>
          <ArrowDown size={17} />
        </IconButton>
        <IconButton label="Supprimer l’étape" size="sm" onClick={onRemove} className="text-danger">
          <Trash2 size={17} />
        </IconButton>
      </div>
      <TextArea aria-label={`Étape ${index + 1}`} placeholder="Décrivez cette étape…" value={step.text} onChange={(e) => onChange({ text: e.target.value })} />
      <div className="mt-2 grid grid-cols-2 gap-2">
        <NumberInput label="Durée" suffix="min" value={step.durationMin} onChange={(v) => onChange({ durationMin: v, timerMin: step.timerMin != null ? v : null })} />
        <NumberInput label="Température" suffix="°C" value={step.temperatureC} onChange={(v) => onChange({ temperatureC: v })} />
      </div>
      <div className="mt-1">
        <Switch
          label="Proposer une minuterie"
          checked={step.timerMin != null}
          onChange={(v) => onChange({ timerMin: v ? (step.durationMin ?? 5) : null })}
          description={step.timerMin != null ? `Minuterie de ${step.timerMin} min en mode cuisine` : undefined}
        />
      </div>
      {inputs}
      {step.photoId ? (
        <div className="relative mt-2 aspect-video overflow-hidden rounded-xl">
          <Photo id={step.photoId} alt="" variant="full" className="size-full" />
          <button type="button" onClick={() => onChange({ photoId: null })} className="absolute top-2 right-2 rounded-full bg-black/55 px-3 py-1.5 text-sm font-semibold text-white">
            Retirer
          </button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" icon={<ImagePlus size={16} />} loading={busy} onClick={openGallery} className="mt-1">
          Photo de l’étape
        </Button>
      )}
    </li>
  )
}

function TagsInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [text, setText] = useState('')
  const add = () => {
    const t = text.trim().replace(/^#/, '')
    if (t && !tags.includes(t)) onChange([...tags, t])
    setText('')
  }
  return (
    <div>
      <label className="label" htmlFor="tags">
        Tags
      </label>
      <div className="flex flex-wrap items-center gap-2 rounded-[0.9rem] border border-line bg-paper p-2">
        {tags.map((t) => (
          <span key={t} className="inline-flex items-center gap-1 rounded-full bg-sunken py-1 pr-1 pl-3 text-sm">
            #{t}
            <button type="button" aria-label={`Retirer le tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))} className="grid size-6 place-items-center rounded-full">
              <X size={13} />
            </button>
          </span>
        ))}
        <input
          id="tags"
          className="min-w-32 flex-1 bg-transparent px-2 py-1.5 outline-none"
          placeholder={tags.length ? 'Ajouter…' : 'Ex. : rapide, hiver, familial'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
        />
      </div>
    </div>
  )
}

function Gallery({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }) {
  const { inputs, openGallery, busy } = usePhotoInput((id) => onChange([...ids, id]), true)
  return (
    <div>
      <span className="label">Galerie</span>
      {inputs}
      <div className="flex flex-wrap gap-2">
        {ids.map((p) => (
          <div key={p} className="relative size-24 overflow-hidden rounded-xl">
            <Photo id={p} alt="" className="size-full" />
            <button type="button" aria-label="Retirer la photo" onClick={() => onChange(ids.filter((x) => x !== p))} className="absolute top-1 right-1 grid size-7 place-items-center rounded-full bg-black/55 text-white">
              <X size={14} />
            </button>
          </div>
        ))}
        <button type="button" onClick={openGallery} disabled={busy} className="grid size-24 place-items-center rounded-xl border border-dashed border-line bg-paper text-muted" aria-label="Ajouter des photos">
          <ImagePlus size={22} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

function BulkIngredientsSheet({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (list: Ingredient[]) => void }) {
  const [text, setText] = useState('')
  const parsed = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const p = parseIngredientLine(l)
      return emptyIngredient({ name: p.name, quantity: p.quantity, unit: p.unit, quantityText: p.quantityText, toTaste: /selon (le )?go[uû]t/i.test(l) })
    })
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Coller une liste d’ingrédients"
      description="Une ligne par ingrédient : « 200 g de farine », « 3 œufs », « 1 c. à soupe d’huile »."
      footer={
        <Button
          block
          disabled={!parsed.length}
          onClick={() => {
            onAdd(parsed)
            setText('')
            onClose()
          }}
        >
          Ajouter {parsed.length || ''} ingrédient{parsed.length > 1 ? 's' : ''}
        </Button>
      }
    >
      <TextArea aria-label="Liste d’ingrédients" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'3 œufs\n100 g de farine\n30 cl de lait\nsel'} />
      {parsed.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {parsed.map((i) => (
            <li key={i.id} className="flex gap-2">
              <span className="w-24 shrink-0 text-right font-semibold text-terra">{i.quantity != null ? `${formatNumber(i.quantity)} ${i.unit}` : '—'}</span>
              <span>{i.name}</span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  )
}
