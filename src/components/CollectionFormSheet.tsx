import { useEffect, useState } from 'react'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import type { Collection } from '@/models/types'
import { saveCollection } from '@/services/recipes'
import { SinglePhotoField } from './PhotoPicker'
import { Button } from './ui/Button'
import { TextArea, TextInput } from './ui/Fields'
import { useToast } from './ui/Feedback'
import { Sheet } from './ui/Sheet'

/** Création / modification d'une collection (nom, description, couverture). */
export function CollectionFormSheet({ open, onClose, collection, initialName = '' }: { open: boolean; onClose: () => void; collection?: Collection; initialName?: string }) {
  const toast = useToast()
  const navigate = useSafeNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [cover, setCover] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(collection?.name ?? initialName)
    setDescription(collection?.description ?? '')
    setCover(collection?.coverPhotoId ?? null)
    setError(null)
  }, [open, collection, initialName])

  const save = async () => {
    if (!name.trim()) return setError('Donnez un nom à la collection.')
    const saved = await saveCollection({ ...(collection ?? {}), name, description, coverPhotoId: cover })
    toast.success(collection ? 'Collection mise à jour' : 'Collection créée')
    if (!collection) navigate(`/collections/${saved.id}`)
    onClose()
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={collection ? 'Modifier la collection' : 'Nouvelle collection'}
      footer={
        <Button block onClick={() => void save()}>
          {collection ? 'Enregistrer' : 'Créer la collection'}
        </Button>
      }
    >
      <div className="space-y-4 pt-1 pb-2">
        <TextInput label="Nom" value={name} error={error} onChange={(e) => setName(e.target.value)} placeholder="Ex. : Repas rapides" data-autofocus />
        <TextArea label="Description" value={description} onChange={(e) => setDescription(e.target.value)} />
        <SinglePhotoField label="Couverture (facultatif)" value={cover} onChange={setCover} aspect="aspect-[16/9]" />
      </div>
    </Sheet>
  )
}
