import { Camera, ImagePlus, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { PhotoError, addPhotoFromFile } from '@/services/photos'
import { Photo } from './ui/Layout'
import { Spinner } from './ui/Spinner'
import { useToast } from './ui/Feedback'

/** Bouton d'ajout de photo : appareil photo ou galerie, compression automatique. */
export function usePhotoInput(onAdded: (id: string) => void, multiple = false) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const handle = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    try {
      for (const f of Array.from(files)) onAdded(await addPhotoFromFile(f))
    } catch (e) {
      toast.error(e instanceof PhotoError ? e.message : 'Impossible d’ajouter cette photo.')
    } finally {
      setBusy(false)
      if (cameraRef.current) cameraRef.current.value = ''
      if (galleryRef.current) galleryRef.current.value = ''
    }
  }
  const inputs = (
    <>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void handle(e.target.files)} />
      <input ref={galleryRef} type="file" accept="image/*" multiple={multiple} hidden onChange={(e) => void handle(e.target.files)} />
    </>
  )
  return { busy, inputs, openCamera: () => cameraRef.current?.click(), openGallery: () => galleryRef.current?.click() }
}

/** Photo unique modifiable (photo principale, photo de réalisation, couverture). */
export function SinglePhotoField({ value, onChange, label = 'Photo', aspect = 'aspect-[4/3]' }: { value: string | null; onChange: (id: string | null) => void; label?: string; aspect?: string }) {
  const { busy, inputs, openCamera, openGallery } = usePhotoInput((id) => onChange(id))
  return (
    <div>
      <span className="label">{label}</span>
      {inputs}
      {value ? (
        <div className={`relative overflow-hidden rounded-2xl ${aspect}`}>
          <Photo id={value} alt="" variant="full" className="size-full" />
          <div className="absolute right-2 bottom-2 flex gap-2">
            <button type="button" onClick={openGallery} className="rounded-full bg-black/55 px-3 py-2 text-sm font-semibold text-white backdrop-blur">
              Changer
            </button>
            <button type="button" aria-label="Retirer la photo" onClick={() => onChange(null)} className="grid size-9 place-items-center rounded-full bg-black/55 text-white backdrop-blur">
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className={`grid grid-cols-2 gap-2 ${busy ? 'pointer-events-none opacity-60' : ''}`}>
          <button type="button" onClick={openCamera} className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line bg-paper text-sm text-muted">
            {busy ? <Spinner /> : <Camera size={22} strokeWidth={1.5} />}
            Prendre une photo
          </button>
          <button type="button" onClick={openGallery} className="flex h-24 flex-col items-center justify-center gap-1.5 rounded-2xl border border-dashed border-line bg-paper text-sm text-muted">
            {busy ? <Spinner /> : <ImagePlus size={22} strokeWidth={1.5} />}
            Depuis la galerie
          </button>
        </div>
      )}
    </div>
  )
}
