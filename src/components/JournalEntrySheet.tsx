import { useEffect, useState } from 'react'
import { isAdjusted, scaledQuantity } from '@/lib/scaling'
import type { JournalEntry, Recipe, ScaleState } from '@/models/types'
import { saveJournalEntry } from '@/services/recipes'
import { SinglePhotoField } from './PhotoPicker'
import { Button } from './ui/Button'
import { NumberInput, Stars, Switch, TextArea } from './ui/Fields'
import { useToast } from './ui/Feedback'
import { Sheet } from './ui/Sheet'

const toDateInput = (ts: number) => {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Ajout / modification d'une réalisation. Les quantités ajustées de la
 * préparation en cours peuvent y être consignées sans toucher à la recette.
 */
export function JournalEntrySheet({
  open,
  onClose,
  recipe,
  entry,
  scale,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  recipe: Recipe
  entry?: JournalEntry | null
  /** Ajustement de la préparation en cours, s'il y en a un. */
  scale?: ScaleState | null
  onSaved?: (e: JournalEntry) => void
}) {
  const toast = useToast()
  const [date, setDate] = useState(toDateInput(Date.now()))
  const [rating, setRating] = useState(0)
  const [photoId, setPhotoId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [modifications, setModifications] = useState('')
  const [cookTime, setCookTime] = useState<number | null>(null)
  const [temp, setTemp] = useState<number | null>(null)
  const [keepQuantities, setKeepQuantities] = useState(true)
  const [busy, setBusy] = useState(false)
  const adjusted = !!scale && isAdjusted(scale)

  useEffect(() => {
    if (!open) return
    setDate(toDateInput(entry?.date ?? Date.now()))
    setRating(entry?.rating ?? 0)
    setPhotoId(entry?.photoId ?? null)
    setComment(entry?.comment ?? '')
    setModifications(entry?.modifications ?? '')
    setCookTime(entry?.actualCookTime ?? null)
    setTemp(entry?.temperatureC ?? null)
    setKeepQuantities(true)
  }, [open, entry])

  const save = async () => {
    setBusy(true)
    try {
      const [y, m, d] = date.split('-').map(Number)
      const when = new Date(y, m - 1, d, 12).getTime()
      const quantitiesUsed =
        entry?.quantitiesUsed ??
        (adjusted && keepQuantities && scale
          ? recipe.ingredients.map((i) => ({ ingredientId: i.id, name: i.name, quantity: scaledQuantity(i, scale), unit: i.unit }))
          : [])
      const saved = await saveJournalEntry({
        id: entry?.id,
        recipeId: recipe.id,
        date: Number.isFinite(when) ? when : Date.now(),
        rating,
        photoId,
        comment: comment.trim(),
        modifications: modifications.trim(),
        quantitiesUsed,
        factor: entry?.factor ?? (adjusted && keepQuantities && scale ? scale.global : null),
        actualCookTime: cookTime,
        temperatureC: temp,
        isDemo: entry?.isDemo ?? false,
      })
      toast.success(entry ? 'Réalisation mise à jour' : 'Réalisation ajoutée au journal')
      onSaved?.(saved)
      onClose()
    } catch {
      toast.error('Impossible d’enregistrer cette réalisation.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      dismissible={false}
      size="tall"
      title={entry ? 'Modifier la réalisation' : 'J’ai cuisiné cette recette'}
      description={recipe.title}
      footer={
        <Button block size="lg" loading={busy} onClick={() => void save()}>
          Enregistrer dans le journal
        </Button>
      }
    >
      <div className="space-y-5 pt-1">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label" htmlFor="j-date">
              Date
            </label>
            <input id="j-date" type="date" className="field" value={date} max={toDateInput(Date.now())} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <span className="label">Résultat</span>
            <Stars value={rating} onChange={setRating} size={22} label="Note de la réalisation" />
          </div>
        </div>
        <SinglePhotoField label="Photo du résultat" value={photoId} onChange={setPhotoId} />
        <TextArea label="Commentaire" placeholder="Résultat excellent. La prochaine fois, mettre moins de vin." value={comment} onChange={(e) => setComment(e.target.value)} />
        <TextArea label="Modifications effectuées" placeholder="Ex. : 40 cl de vin au lieu de 50, ajout de champignons" value={modifications} onChange={(e) => setModifications(e.target.value)} />
        <div className="grid grid-cols-2 gap-3">
          <NumberInput label="Cuisson réelle" suffix="min" value={cookTime} onChange={setCookTime} />
          <NumberInput label="Température" suffix="°C" value={temp} onChange={setTemp} />
        </div>
        {adjusted && !entry && (
          <div className="rounded-2xl bg-paper px-4">
            <Switch
              label="Consigner les quantités ajustées"
              description="Les quantités réellement utilisées sont enregistrées dans cette réalisation. La recette d’origine n’est pas modifiée."
              checked={keepQuantities}
              onChange={setKeepQuantities}
            />
          </div>
        )}
      </div>
    </Sheet>
  )
}
