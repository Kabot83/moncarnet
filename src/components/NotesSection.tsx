import { PenLine } from 'lucide-react'
import { useState } from 'react'
import { NOTE_FIELDS, type Notes, type Recipe } from '@/models/types'
import { patchRecipe } from '@/services/recipes'
import { Button } from './ui/Button'
import { TextArea } from './ui/Fields'
import { useToast } from './ui/Feedback'
import { Sheet } from './ui/Sheet'

/** Notes personnelles, modifiables à tout moment, sans passer par l'éditeur complet. */
export function NotesSection({ recipe }: { recipe: Recipe }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Notes>(recipe.notes)
  const filled = NOTE_FIELDS.filter((f) => recipe.notes[f.id]?.trim())

  return (
    <>
      {filled.length ? (
        <div className="space-y-3">
          {filled.map((f) => (
            <div key={f.id} className="rounded-2xl border-l-4 border-sage bg-paper p-4 shadow-[var(--shadow-card)]">
              <h3 className="text-xs font-semibold tracking-wider text-sage uppercase">{f.label}</h3>
              <p className="mt-1 text-[15px] leading-relaxed whitespace-pre-line">{recipe.notes[f.id]}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted">Astuces, erreurs à éviter, conservation… Gardez ici tout ce que vous avez appris.</p>
      )}
      <Button
        variant="secondary"
        className="mt-3"
        icon={<PenLine size={16} />}
        onClick={() => {
          setDraft(recipe.notes)
          setOpen(true)
        }}
      >
        {filled.length ? 'Modifier mes notes' : 'Ajouter des notes'}
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        dismissible={false}
        size="tall"
        title="Mes notes"
        footer={
          <Button
            block
            onClick={async () => {
              await patchRecipe(recipe.id, { notes: draft })
              setOpen(false)
              toast.success('Notes enregistrées')
            }}
          >
            Enregistrer
          </Button>
        }
      >
        <div className="space-y-4 pt-1">
          {NOTE_FIELDS.map((f) => (
            <TextArea key={f.id} label={f.label} value={draft[f.id]} onChange={(e) => setDraft((d) => ({ ...d, [f.id]: e.target.value }))} />
          ))}
        </div>
      </Sheet>
    </>
  )
}
