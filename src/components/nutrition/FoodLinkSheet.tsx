/**
 * Associer un ingrédient à un aliment nutritionnel (CIQUAL, Open Food Facts ou saisie
 * personnelle). Aucune association n'est faite sans validation explicite.
 */
import { ArrowLeft, Barcode, Check, History, Search, Star, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useOnline } from '@/hooks/useOnline'
import { formatNumber, normalizeUnit } from '@/lib/units'
import { type Food, type FoodLink, FoodLinkSchema, type Ingredient, MAIN_NUTRIENTS, type NutrientKey, type NutrientValue, type Per100 } from '@/models/types'
import { CIQUAL_CITATION, type CiqualFood, ciqualToFood, loadCiqual, searchCiqual } from '@/nutrition/ciqual'
import { LABELS, SPOON_ML, UNITS, effectiveValue, formatNutrient, toBasisAmount } from '@/nutrition/engine'
import { customFood, foodKey, rememberFood, setIngredientNutrition, toggleFoodFavorite, useFoodEntry, useFoodSuggestions } from '@/nutrition/foods'
import { OFF_ATTRIBUTION, OffError, confirmOffProduct, isComplete, searchOff } from '@/nutrition/off'
import { Button, IconButton } from '../ui/Button'
import { useToast } from '../ui/Feedback'
import { NumberInput, Segmented, Switch, TextInput } from '../ui/Fields'
import { Sheet } from '../ui/Sheet'
import { Spinner } from '../ui/Spinner'

type Tab = 'mine' | 'ciqual' | 'off' | 'manual'

const SOURCE_LABEL: Record<Food['source'], string> = { ciqual: 'CIQUAL', off: 'Open Food Facts', custom: 'Personnel' }

/** Affichage d'une teneur selon les conventions (traces, < seuil, inconnue). */
export function formatValue(key: NutrientKey, v: NutrientValue | undefined): string {
  if (v == null) return 'inconnue'
  if (v === 't') return 'traces'
  if (typeof v === 'string') return `< ${formatNumber(Number(v.slice(1)), 3)}`
  return formatNutrient(key, v)
}

function MacroLine({ food }: { food: Food }) {
  const per = food.basis === '100ml' ? '100 ml' : '100 g'
  return (
    <span className="text-xs text-muted">
      {formatValue('kcal', food.per100.kcal)} kcal · P {formatValue('protein', food.per100.protein)} · G {formatValue('carbs', food.per100.carbs)} · L{' '}
      {formatValue('fat', food.per100.fat)} <span className="text-faint">/ {per}</span>
    </span>
  )
}

function FoodRow({ food, onPick, badge }: { food: Food; onPick: (f: Food) => void; badge?: string }) {
  const complete = isComplete(food)
  return (
    <li>
      <button type="button" onClick={() => onPick(food)} className="w-full rounded-2xl bg-paper p-3 text-left shadow-[var(--shadow-card)] active:scale-[.99]">
        {badge && <span className="mb-1 inline-block rounded-full bg-sage-soft px-2 py-0.5 text-[11px] font-semibold text-sage">{badge}</span>}
        <span className="block text-[15px] leading-snug font-medium">{food.name}</span>
        <span className="mt-0.5 block text-xs text-faint">
          {SOURCE_LABEL[food.source]}
          {food.brand ? ` · ${food.brand}` : ''}
          {food.source === 'ciqual' ? ` · code ${food.id}` : food.source === 'off' ? ` · ${food.id}` : ''}
          {!complete && <span className="ml-1 font-semibold text-danger">· incomplet</span>}
        </span>
        <MacroLine food={food} />
      </button>
    </li>
  )
}

/** Quantité de départ de la recherche : le nom de l'ingrédient, sans les précisions. */
const searchText = (name: string) => name.replace(/\(.*?\)/g, '').replace(/,.*$/, '').trim()

export function FoodLinkSheet({ open, onClose, recipeId, ingredient }: { open: boolean; onClose: () => void; recipeId: string; ingredient: Ingredient | null }) {
  const toast = useToast()
  const online = useOnline()
  const [step, setStep] = useState<'search' | 'confirm'>('search')
  const [tab, setTab] = useState<Tab>('ciqual')
  const [query, setQuery] = useState('')
  const [ciqual, setCiqual] = useState<CiqualFood[] | null>(null)
  const [offResults, setOffResults] = useState<Food[] | null>(null)
  const [offBusy, setOffBusy] = useState(false)
  const [offError, setOffError] = useState<string | null>(null)
  const [draft, setDraft] = useState<FoodLink | null>(null)
  const [confirming, setConfirming] = useState(false)
  const suggestions = useFoodSuggestions(ingredient?.name ?? '')

  // Ouverture : on repart de l'association existante, sinon de la recherche.
  useEffect(() => {
    if (!open || !ingredient) return
    setQuery(searchText(ingredient.name))
    setOffResults(null)
    setOffError(null)
    if (ingredient.nutrition) {
      setDraft(ingredient.nutrition)
      setStep('confirm')
    } else {
      setDraft(null)
      setStep('search')
      setTab('ciqual')
    }
  }, [open, ingredient?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && suggestions.remembered && !ingredient?.nutrition && tab === 'ciqual' && step === 'search') setTab('mine')
  }, [open, suggestions.remembered]) // eslint-disable-line react-hooks/exhaustive-deps

  // CIQUAL : recherche locale instantanée (aucun appel réseau).
  useEffect(() => {
    if (!open || tab !== 'ciqual') return
    let alive = true
    const t = setTimeout(() => {
      void (query.trim().length >= 2 ? searchCiqual(query, 40) : loadCiqual().then(() => [])).then((r) => alive && setCiqual(r))
    }, 120)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [open, tab, query])

  /** Produit Open Food Facts issu d'une recherche : relecture de la fiche complète avant validation. */
  const pickOff = async (food: Food) => {
    setConfirming(true)
    setOffError(null)
    try {
      pick(await confirmOffProduct(food))
    } catch (e) {
      setOffError(e instanceof OffError ? e.message : 'Fiche produit indisponible.')
    } finally {
      setConfirming(false)
    }
  }

  const pick = (food: Food, memory?: { gramsPerUnit: number | null; density: number | null }) => {
    const remembered = suggestions.remembered?.entry.key === foodKey(food) ? suggestions.remembered.memory : null
    setDraft(
      FoodLinkSchema.parse({
        food,
        gramsPerUnit: memory?.gramsPerUnit ?? remembered?.gramsPerUnit ?? null,
        density: memory?.density ?? remembered?.density ?? null,
        overrides: {},
        linkedAt: Date.now(),
      }),
    )
    setStep('confirm')
  }

  const runOff = async () => {
    setOffBusy(true)
    setOffError(null)
    try {
      setOffResults((await searchOff(query)).foods)
    } catch (e) {
      setOffError(e instanceof OffError ? e.message : 'Recherche impossible.')
    } finally {
      setOffBusy(false)
    }
  }

  const save = async (link: FoodLink | null) => {
    if (!ingredient) return
    await setIngredientNutrition(recipeId, ingredient.id, { nutrition: link, nutritionExcluded: false })
    if (link) await rememberFood(link.food, ingredient.name, link)
    toast.success(link ? 'Valeurs nutritionnelles associées' : 'Association retirée')
    onClose()
  }

  const exclude = async (v: boolean) => {
    if (!ingredient) return
    await setIngredientNutrition(recipeId, ingredient.id, { nutritionExcluded: v })
    toast.success(v ? 'Ingrédient exclu du calcul nutritionnel' : 'Ingrédient réintégré au calcul')
    onClose()
  }

  if (!ingredient) return null
  const qty = ingredient.quantity != null ? `${formatNumber(ingredient.quantity, 2)} ${ingredient.unit}`.trim() : ingredient.toTaste ? 'selon le goût' : ingredient.quantityText || 'sans quantité'

  return (
    <Sheet open={open} onClose={onClose} size="full" title={ingredient.name} description={`Valeurs nutritionnelles · ${qty}`}>
      {step === 'search' ? (
        <div className="space-y-4 pt-1 pb-4">
          <Segmented
            label="Source"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'mine', label: 'Mes aliments' },
              { value: 'ciqual', label: 'CIQUAL' },
              { value: 'off', label: 'Marques' },
              { value: 'manual', label: 'Saisie' },
            ]}
          />

          {(tab === 'ciqual' || tab === 'off') && (
            <form
              className="relative"
              onSubmit={(e) => {
                e.preventDefault()
                if (tab === 'off') void runOff()
              }}
            >
              <Search size={18} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" />
              <input
                className="field pr-24 pl-10"
                value={query}
                inputMode={tab === 'off' && /^\d+$/.test(query) ? 'numeric' : 'search'}
                enterKeyHint="search"
                onChange={(e) => setQuery(e.target.value)}
                placeholder={tab === 'off' ? 'Produit, marque ou code-barres' : 'Rechercher un aliment'}
                aria-label={tab === 'off' ? 'Rechercher dans Open Food Facts' : 'Rechercher dans CIQUAL'}
              />
              {tab === 'off' && (
                <Button type="submit" size="sm" className="absolute top-1/2 right-1.5 -translate-y-1/2" loading={offBusy} disabled={!online || query.trim().length < 2}>
                  Chercher
                </Button>
              )}
            </form>
          )}

          {tab === 'mine' && (
            <div className="space-y-4">
              {suggestions.remembered && (
                <ul>
                  <FoodRow food={suggestions.remembered.entry.food} onPick={(f) => pick(f, suggestions.remembered!.memory)} badge="Déjà choisi pour cet ingrédient" />
                </ul>
              )}
              {suggestions.favorites.length > 0 && (
                <section>
                  <h3 className="label flex items-center gap-1.5">
                    <Star size={14} /> Favoris
                  </h3>
                  <ul className="space-y-2">
                    {suggestions.favorites.map((e) => (
                      <FoodRow key={e.key} food={e.food} onPick={pick} />
                    ))}
                  </ul>
                </section>
              )}
              {suggestions.recents.length > 0 && (
                <section>
                  <h3 className="label flex items-center gap-1.5">
                    <History size={14} /> Récemment utilisés
                  </h3>
                  <ul className="space-y-2">
                    {suggestions.recents.map((e) => (
                      <FoodRow key={e.key} food={e.food} onPick={pick} />
                    ))}
                  </ul>
                </section>
              )}
              {!suggestions.remembered && !suggestions.favorites.length && !suggestions.recents.length && (
                <p className="text-sm text-muted">Les aliments que vous associez apparaîtront ici, pour les retrouver sans les rechercher.</p>
              )}
            </div>
          )}

          {tab === 'ciqual' && (
            <>
              {ciqual === null ? (
                <p className="flex items-center gap-2 text-sm text-muted">
                  <Spinner size={16} /> Chargement de la table CIQUAL…
                </p>
              ) : ciqual.length === 0 ? (
                <p className="text-sm text-muted">{query.trim().length < 2 ? 'Saisissez le nom d’un aliment.' : 'Aucun aliment trouvé. Essayez un autre mot, ou l’onglet « Marques ».'}</p>
              ) : (
                <ul className="space-y-2">
                  {ciqual.map((f) => (
                    <FoodRow key={f.code} food={ciqualToFood(f)} onPick={pick} />
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-faint">Source : {CIQUAL_CITATION}. Valeurs pour 100 g de partie comestible.</p>
            </>
          )}

          {tab === 'off' && (
            <>
              {!online && <p className="text-sm text-muted">Hors ligne : la recherche de produits de marque nécessite une connexion. Vos aliments déjà utilisés restent disponibles dans « Mes aliments ».</p>}
              {offError && (
                <p className="rounded-2xl bg-danger-soft p-3 text-sm text-danger" role="alert">
                  {offError}
                </p>
              )}
              {confirming && (
                <p className="flex items-center gap-2 text-sm text-muted" role="status">
                  <Spinner size={16} /> Lecture de la fiche du produit…
                </p>
              )}
              {offResults && offResults.length === 0 && <p className="text-sm text-muted">Aucun produit trouvé.</p>}
              {offResults && offResults.length > 0 && (
                <ul className="space-y-2">
                  {offResults.map((f) => (
                    <FoodRow key={f.id} food={f} onPick={(x) => void pickOff(x)} />
                  ))}
                </ul>
              )}
              <p className="flex items-center gap-1.5 text-[11px] text-faint">
                <Barcode size={13} /> Un code-barres (8 à 13 chiffres) donne directement la fiche du produit. {OFF_ATTRIBUTION}.
              </p>
            </>
          )}

          {tab === 'manual' && <ManualFood defaultName={searchText(ingredient.name)} onDone={(f) => pick(f)} />}

          {(ingredient.nutrition || !ingredient.nutritionExcluded) && (
            <div className="border-t border-line pt-4">
              <Switch
                label="Ne pas compter cet ingrédient"
                description="Pour l’eau de cuisson, une décoration… Il n’apparaîtra plus comme manquant."
                checked={ingredient.nutritionExcluded}
                onChange={(v) => void exclude(v)}
              />
            </div>
          )}
          {ingredient.nutrition && (
            <Button variant="ghost" icon={<ArrowLeft size={16} />} onClick={() => (setDraft(ingredient.nutrition), setStep('confirm'))}>
              Revenir à l’aliment associé
            </Button>
          )}
        </div>
      ) : (
        draft && (
          <ConfirmLink
            ingredient={ingredient}
            link={draft}
            onChange={setDraft}
            onChangeFood={() => setStep('search')}
            onSave={() => void save(draft)}
            onRemove={ingredient.nutrition ? () => void save(null) : undefined}
          />
        )
      )}
    </Sheet>
  )
}

function ConfirmLink({
  ingredient,
  link,
  onChange,
  onChangeFood,
  onSave,
  onRemove,
}: {
  ingredient: Ingredient
  link: FoodLink
  onChange: (l: FoodLink) => void
  onChangeFood: () => void
  onSave: () => void
  onRemove?: () => void
}) {
  const entry = useFoodEntry(link.food)
  const [showCorrections, setShowCorrections] = useState(Object.keys(link.overrides).length > 0)
  const unit = normalizeUnit(ingredient.unit)
  const needsPieceWeight = !(unit.kind === 'mass' || unit.kind === 'volume' || (unit.kind === 'spoon' && SPOON_ML[unit.canonical] != null))
  const usesVolume = unit.kind === 'volume' || unit.kind === 'spoon'
  const needsDensity = (usesVolume && link.food.basis === '100g') || (unit.kind === 'mass' && link.food.basis === '100ml')
  const amount = ingredient.quantity != null ? toBasisAmount(ingredient.quantity, ingredient.unit, link) : null
  const per = link.food.basis === '100ml' ? '100 ml' : '100 g'
  const canSave = !needsPieceWeight || !!link.gramsPerUnit || ingredient.quantity == null

  const contribution = useMemo(() => {
    if (!amount || 'error' in amount) return null
    return MAIN_NUTRIENTS.map((k) => {
      const v = effectiveValue(link, k)
      return { k, value: v.kind === 'missing' ? null : (v.value * amount.basisAmount) / 100 }
    })
  }, [amount, link])

  return (
    <div className="space-y-5 pt-1 pb-6">
      <div className="rounded-2xl bg-paper p-4 shadow-[var(--shadow-card)]">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold tracking-wider text-terra uppercase">{SOURCE_LABEL[link.food.source]}</p>
            <h3 className="font-serif text-lg leading-snug font-semibold">{link.food.name}</h3>
            <p className="text-xs text-muted">
              {[link.food.brand, link.food.source === 'ciqual' ? `code ${link.food.id}` : link.food.source === 'off' ? `code-barres ${link.food.id}` : '', link.food.version].filter(Boolean).join(' · ')}
            </p>
          </div>
          <IconButton label={entry?.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'} size="sm" onClick={() => void toggleFoodFavorite(link.food)} aria-pressed={!!entry?.favorite}>
            <Star size={18} className={entry?.favorite ? 'text-gold' : 'text-faint'} fill={entry?.favorite ? 'currentColor' : 'none'} />
          </IconButton>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {MAIN_NUTRIENTS.map((k) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-muted">{LABELS[k]}</dt>
              <dd className={`font-semibold tabular-nums ${link.food.per100[k] == null ? 'text-danger' : ''}`}>
                {link.overrides[k] != null ? `${formatNutrient(k, link.overrides[k]!)} ${UNITS[k]} (corrigé)` : `${formatValue(k, link.food.per100[k])}${link.food.per100[k] == null ? '' : ` ${UNITS[k]}`}`}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-[11px] text-faint">Pour {per}. {link.food.source === 'ciqual' ? CIQUAL_CITATION : link.food.source === 'off' ? OFF_ATTRIBUTION : ''}</p>
        {link.food.notes.map((n) => (
          <p key={n} className="mt-1 text-xs font-medium text-terra-strong">
            {n}
          </p>
        ))}
      </div>

      {needsPieceWeight && ingredient.quantity != null && (
        <div>
          <NumberInput
            label={`Poids d’${unit.kind === 'pinch' ? 'une pincée' : unit.canonical ? `un(e) ${unit.canonical}` : 'une pièce'} (g, partie comestible)`}
            suffix="g"
            value={link.gramsPerUnit}
            onChange={(v) => onChange({ ...link, gramsPerUnit: v && v > 0 ? v : null })}
            hint="Indispensable pour calculer : pesez une pièce ou reportez le poids de l’emballage. Mon Carnet n’invente aucun poids."
          />
        </div>
      )}
      {needsDensity && (
        <NumberInput
          label="Masse volumique (g/ml) — facultatif"
          step={0.01}
          value={link.density}
          onChange={(v) => onChange({ ...link, density: v && v > 0 ? v : null })}
          hint="Sans valeur, 1 ml est compté pour 1 g et le résultat est marqué « estimatif ». Exemples courants : huile ≈ 0,92 ; lait ≈ 1,03 ; miel ≈ 1,4."
        />
      )}

      {contribution && (
        <div className="rounded-2xl bg-sunken p-3 text-sm">
          <p className="font-semibold">
            Pour {formatNumber(ingredient.quantity!, 2)} {ingredient.unit || (ingredient.quantity! > 1 ? 'pièces' : 'pièce')}
            {amount && !('error' in amount) && unit.kind !== 'mass' ? ` (≈ ${formatNumber(amount.grams, 1)} g)` : ''}
          </p>
          <p className="mt-1 tabular-nums text-muted">
            {contribution.map((c) => `${LABELS[c.k].replace('Énergie', '')}${c.k === 'kcal' ? '' : ' '}${c.value == null ? 'inconnu' : formatNutrient(c.k, c.value)} ${UNITS[c.k]}`).join(' · ')}
          </p>
          {amount && !('error' in amount) && amount.approx.map((a) => <p key={a} className="mt-1 text-xs text-terra-strong">{a}</p>)}
        </div>
      )}

      <div>
        <button type="button" className="text-sm font-semibold text-terra" onClick={() => setShowCorrections((v) => !v)} aria-expanded={showCorrections}>
          {showCorrections ? 'Masquer les corrections' : 'Corriger les valeurs (étiquette, valeur manquante…)'}
        </button>
        {showCorrections && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            {MAIN_NUTRIENTS.map((k) => (
              <NumberInput
                key={k}
                label={`${LABELS[k]} / ${per}`}
                suffix={UNITS[k]}
                value={link.overrides[k] ?? null}
                placeholder={typeof link.food.per100[k] === 'number' ? String(link.food.per100[k]) : 'inconnue'}
                onChange={(v) => {
                  const overrides = { ...link.overrides }
                  if (v == null) delete overrides[k]
                  else overrides[k] = v
                  onChange({ ...link, overrides })
                }}
              />
            ))}
            <p className="col-span-2 text-xs text-faint">Une valeur corrigée remplace celle de la source pour cette recette.</p>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <Button block size="lg" icon={<Check size={18} />} disabled={!canSave} onClick={onSave}>
          Associer à « {ingredient.name} »
        </Button>
        {!canSave && <p className="text-center text-xs text-danger">Renseignez le poids d’une pièce pour pouvoir calculer.</p>}
        <Button block variant="secondary" icon={<Search size={16} />} onClick={onChangeFood}>
          Choisir un autre aliment
        </Button>
        {onRemove && (
          <Button block variant="ghost" className="text-danger" icon={<Trash2 size={16} />} onClick={onRemove}>
            Retirer l’association
          </Button>
        )}
      </div>
    </div>
  )
}

function ManualFood({ defaultName, onDone }: { defaultName: string; onDone: (f: Food) => void }) {
  const [name, setName] = useState(defaultName)
  const [basis, setBasis] = useState<Food['basis']>('100g')
  const [values, setValues] = useState<Record<string, number | null>>({ kcal: null, protein: null, carbs: null, fat: null })
  const ok = name.trim() && MAIN_NUTRIENTS.every((k) => values[k] != null)
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Reportez les valeurs d’une étiquette ou d’une source fiable. Elles seront enregistrées dans « Mes aliments ».</p>
      <TextInput label="Nom de l’aliment" value={name} onChange={(e) => setName(e.target.value)} />
      <Segmented
        label="Valeurs pour"
        value={basis}
        onChange={setBasis}
        options={[
          { value: '100g', label: 'pour 100 g' },
          { value: '100ml', label: 'pour 100 ml' },
        ]}
      />
      <div className="grid grid-cols-2 gap-3">
        {MAIN_NUTRIENTS.map((k) => (
          <NumberInput key={k} label={LABELS[k]} suffix={UNITS[k]} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} />
        ))}
      </div>
      <Button
        block
        disabled={!ok}
        onClick={() => {
          const per100: Per100 = { kcal: values.kcal, kj: null, protein: values.protein, carbs: values.carbs, fat: values.fat, fiber: null, sugars: null, satFat: null, salt: null }
          onDone(customFood(name, per100, basis))
        }}
      >
        Utiliser ces valeurs
      </Button>
    </div>
  )
}
