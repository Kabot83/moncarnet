import { Camera, ClipboardPaste, FileText, ImagePlus, Link2, PenLine } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { importFromImage, importFromText } from '@/ai/chef'
import { aiRecipeToRecipe } from '@/ai/convert'
import { type AiError, toAiError } from '@/ai/errors'
import { AiErrorBox } from '@/components/AiErrorBox'
import { Button } from '@/components/ui/Button'
import { TextArea } from '@/components/ui/Fields'
import { TopBar } from '@/components/ui/Layout'
import { Spinner } from '@/components/ui/Spinner'
import { useOnline } from '@/hooks/useOnline'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { UrlImportError, importFromUrl, importImage } from '@/importers/url'
import { createDraft } from '@/services/drafts'
import { useSettings } from '@/services/settings'
import { isNative } from '@/platform/native'

type Mode = 'lien' | 'photo' | 'texte'

const TITLES: Record<Mode, string> = { lien: 'Importer depuis un lien', photo: 'Importer une photo', texte: 'Importer un texte' }

export default function ImportPage() {
  const { mode = 'lien' } = useParams() as { mode: Mode }
  const [params] = useSearchParams()
  const navigate = useSafeNavigate()
  const online = useOnline()
  const settings = useSettings()
  const aiReady = settings.aiMode !== 'off'

  const [url, setUrl] = useState(params.get('url') ?? '')
  const [text, setText] = useState(params.get('text') ?? '')
  const [image, setImage] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [aiError, setAiError] = useState<AiError | null>(null)
  const [pageText, setPageText] = useState<string | null>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const autoStarted = useRef(false)

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])

  const reset = () => {
    setError(null)
    setAiError(null)
    setPageText(null)
  }

  const fromUrl = async () => {
    reset()
    setBusy('Lecture de la page…')
    try {
      const { recipe, imageUrl, warnings } = await importFromUrl(url)
      if (imageUrl) {
        setBusy('Récupération de la photo…')
        recipe.mainPhotoId = await importImage(imageUrl)
        if (!recipe.mainPhotoId) warnings.push('La photo du site n’a pas pu être récupérée.')
      }
      const id = await createDraft(recipe, 'url', warnings)
      navigate(`/recettes/nouvelle?draft=${id}`, { replace: true })
    } catch (e) {
      if (e instanceof UrlImportError) {
        setError(e.message)
        if (e.pageText) setPageText(e.pageText)
      } else setError('Import impossible. Vérifiez le lien et votre connexion.')
    } finally {
      setBusy(null)
    }
  }

  // Lien reçu par le partage Android : import lancé automatiquement (aucun appel IA).
  useEffect(() => {
    if (mode === 'lien' && params.get('url') && !autoStarted.current) {
      autoStarted.current = true
      void fromUrl()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const fromText = async (raw: string, origin: 'text' | 'url' = 'text') => {
    reset()
    setBusy('Le Chef IA analyse le texte…')
    try {
      const res = await importFromText(raw)
      const { recipe, warnings } = aiRecipeToRecipe(res.recipe, origin === 'url' ? { sourceUrl: url } : {})
      const id = await createDraft(recipe, 'text', [...res.warnings, ...warnings])
      navigate(`/recettes/nouvelle?draft=${id}`, { replace: true })
    } catch (e) {
      setAiError(toAiError(e))
    } finally {
      setBusy(null)
    }
  }

  const fromPhoto = async () => {
    if (!image) return
    reset()
    setBusy('Le Chef IA lit la photo…')
    try {
      const res = await importFromImage(image)
      const { recipe, warnings } = aiRecipeToRecipe(res.recipe)
      const id = await createDraft(recipe, 'photo', [...res.warnings, ...warnings])
      navigate(`/recettes/nouvelle?draft=${id}`, { replace: true })
    } catch (e) {
      setAiError(toAiError(e))
    } finally {
      setBusy(null)
    }
  }

  const pickImage = (f: File | undefined) => {
    if (!f) return
    if (preview) URL.revokeObjectURL(preview)
    setImage(f)
    setPreview(URL.createObjectURL(f))
    reset()
  }

  return (
    <>
      <TopBar back title={TITLES[mode]} />
      <main className="mx-auto max-w-2xl px-4 pt-4 pb-24">
        <nav className="mb-6 flex gap-2" aria-label="Mode d’import">
          {(
            [
              ['lien', 'Lien', Link2],
              ['photo', 'Photo', Camera],
              ['texte', 'Texte', FileText],
            ] as const
          ).map(([m, label, Icon]) => (
            <Link
              key={m}
              to={`/importer/${m}`}
              replace
              aria-current={mode === m ? 'page' : undefined}
              className={`inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full text-sm font-semibold ${mode === m ? 'bg-terra text-white dark:text-[#1b1916]' : 'bg-paper text-muted'}`}
            >
              <Icon size={16} /> {label}
            </Link>
          ))}
        </nav>

        {mode === 'lien' && (
          <section className="space-y-4">
            <p className="text-muted">Collez le lien d’une page de recette. Mon Carnet lit les données de recette publiées par le site (format Schema.org) ; vous vérifiez tout avant d’enregistrer.</p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void fromUrl()
              }}
              className="space-y-3"
            >
              <label className="label" htmlFor="url">
                Adresse de la recette
              </label>
              <div className="flex gap-2">
                <input id="url" type="url" inputMode="url" className="field" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
                <Button
                  variant="secondary"
                  icon={<ClipboardPaste size={18} />}
                  aria-label="Coller"
                  onClick={async () => {
                    try {
                      setUrl((await navigator.clipboard.readText()).trim())
                    } catch {
                      /* presse-papiers refusé */
                    }
                  }}
                />
              </div>
              <Button type="submit" block size="lg" disabled={!url.trim() || !online} loading={!!busy}>
                Importer la recette
              </Button>
            </form>
            {!settings.proxyUrl && !isNative && (
              <p className="rounded-2xl bg-sunken p-3 text-sm text-muted">
                Sans proxy configuré, la plupart des sites bloquent la lecture depuis une application web (CORS). Vous pouvez configurer votre proxy dans{' '}
                <Link to="/reglages/ia" className="font-semibold text-terra">
                  Réglages
                </Link>{' '}
                ou utiliser le partage Android puis l’import par texte.
              </p>
            )}
            {!isNative && <p className="text-xs text-faint">Astuce : depuis Chrome, « Partager » → « Mon Carnet » ouvre directement cet écran.</p>}
          </section>
        )}

        {mode === 'photo' && (
          <section className="space-y-4">
            <p className="text-muted">Photographiez une recette imprimée ou manuscrite. Le Chef IA la transforme en fiche que vous corrigez avant d’enregistrer.</p>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pickImage(e.target.files?.[0])} />
            <input ref={galleryRef} type="file" accept="image/*" hidden onChange={(e) => pickImage(e.target.files?.[0])} />
            {preview ? (
              <img src={preview} alt="Photo de la recette à importer" className="max-h-[50vh] w-full rounded-2xl object-contain bg-sunken" />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <button type="button" onClick={() => cameraRef.current?.click()} className="flex h-36 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-paper text-muted">
                  <Camera size={28} strokeWidth={1.4} /> Prendre une photo
                </button>
                <button type="button" onClick={() => galleryRef.current?.click()} className="flex h-36 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line bg-paper text-muted">
                  <ImagePlus size={28} strokeWidth={1.4} /> Choisir une image
                </button>
              </div>
            )}
            {preview && (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => galleryRef.current?.click()}>
                  Changer
                </Button>
                <Button block size="lg" disabled={!aiReady || !online} loading={!!busy} onClick={() => void fromPhoto()}>
                  Analyser avec le Chef IA
                </Button>
              </div>
            )}
            <p className="text-xs text-faint">L’image est réduite avant envoi (1 appel IA). Rien n’est enregistré sans votre validation.</p>
          </section>
        )}

        {mode === 'texte' && (
          <section className="space-y-4">
            <p className="text-muted">Collez le texte d’une recette (message, page web, document). Le Chef IA détecte les ingrédients, quantités, étapes et temps de cuisson.</p>
            <TextArea label="Texte de la recette" rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder="Collez ici la recette…" />
            <Button block size="lg" disabled={text.trim().length < 20 || !aiReady || !online} loading={!!busy} onClick={() => void fromText(text)}>
              Analyser avec le Chef IA
            </Button>
          </section>
        )}

        {busy && (
          <p className="mt-4 flex items-center justify-center gap-2 text-muted" role="status">
            <Spinner size={18} className="text-terra" /> {busy}
          </p>
        )}
        {error && (
          <div className="mt-4 rounded-2xl bg-danger-soft p-4 text-sm" role="alert">
            <p>{error}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {pageText && aiReady && (
                <Button size="sm" variant="secondary" onClick={() => void fromText(pageText, 'url')}>
                  Analyser le texte de la page (Chef IA)
                </Button>
              )}
              <Button size="sm" variant="secondary" icon={<FileText size={15} />} onClick={() => navigate('/importer/texte', { replace: true })}>
                Coller le texte
              </Button>
              <Button size="sm" variant="ghost" icon={<PenLine size={15} />} onClick={() => navigate('/recettes/nouvelle', { replace: true })}>
                Saisie manuelle
              </Button>
            </div>
          </div>
        )}
        {aiError && <AiErrorBox error={aiError} onRetry={() => void (mode === 'photo' ? fromPhoto() : fromText(pageText ?? text))} />}
        {(mode === 'photo' || mode === 'texte') && !aiReady && (
          <div className="mt-4 rounded-2xl bg-sunken p-4 text-sm text-muted">
            Cette fonction utilise le Chef IA, qui n’est pas configuré.{' '}
            <Link to="/reglages/ia" className="font-semibold text-terra">
              Configurer
            </Link>{' '}
            — ou{' '}
            <Link to="/recettes/nouvelle" className="font-semibold text-terra">
              saisir la recette à la main
            </Link>
            .
          </div>
        )}
      </main>
    </>
  )
}
