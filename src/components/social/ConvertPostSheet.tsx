/**
 * « Transformer en recette » : crée une vraie fiche Mon Carnet (brouillon à vérifier) à partir
 * d'une publication.
 *
 * - Sans IA : reprend le titre, la miniature, la source et ce que le texte contient vraiment
 *   (lignes d'ingrédients, étapes numérotées). Rien n'est inventé ; ce qui manque est signalé.
 * - Avec le Chef IA (facultatif) : seulement après accord explicite, en montrant exactement le
 *   texte envoyé. Ni la vidéo, ni l'image, ni les notes ne sont transmises.
 * La fiche garde le lien vers la publication (sourcePostId) et passe ensuite par l'éditeur
 * habituel : corrections avant enregistrement, nutrition CIQUAL / Open Food Facts automatique.
 */
import { FileText, Send, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { importFromText } from '@/ai/chef'
import { aiRecipeToRecipe } from '@/ai/convert'
import { type AiError, toAiError } from '@/ai/errors'
import { useOnline } from '@/hooks/useOnline'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import type { SocialPost } from '@/models/types'
import { createDraft } from '@/services/drafts'
import { useSettings } from '@/services/settings'
import { extractFromCaption, postSourceText, recipeBaseFromPost, recipeFromPostLocally } from '@/social/extract'
import { updatePost } from '@/social/posts'
import { AiErrorBox } from '../AiErrorBox'
import { Button } from '../ui/Button'
import { TextArea } from '../ui/Fields'
import { Sheet } from '../ui/Sheet'

const NOT_ANALYZED = 'La vidéo elle-même (son, images) n’a pas été analysée : seul le texte de la publication a été utilisé.'

export function ConvertPostSheet({ open, onClose, post }: { open: boolean; onClose: () => void; post: SocialPost }) {
  const navigate = useSafeNavigate()
  const settings = useSettings()
  const online = useOnline()
  const [text, setText] = useState('')
  const [step, setStep] = useState<'choose' | 'consent'>('choose')
  const [busy, setBusy] = useState(false)
  const [aiError, setAiError] = useState<AiError | null>(null)
  const aiReady = settings.aiMode !== 'off'

  useEffect(() => {
    if (!open) return
    setText(postSourceText(post))
    setStep('choose')
    setAiError(null)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const found = useMemo(() => extractFromCaption(text), [text])
  const aiText = `Titre : ${post.title}\n\n${text.trim()}`.slice(0, 20000)

  /** Légende collée à la main (Instagram) : conservée dans la publication. */
  const keepPastedText = async () => {
    if (text.trim() && !post.description.trim() && text.trim() !== post.sharedText.trim()) await updatePost(post.id, { description: text.trim().slice(0, 5000) })
  }

  const openDraft = async (draftId: string) => {
    onClose()
    navigate(`/recettes/nouvelle?draft=${draftId}`)
  }

  const createLocal = async () => {
    setBusy(true)
    try {
      await keepPastedText()
      const { recipe, warnings } = recipeFromPostLocally(post, text)
      await openDraft(await createDraft(recipe, 'social', [...warnings, NOT_ANALYZED]))
    } finally {
      setBusy(false)
    }
  }

  const createWithAi = async () => {
    setBusy(true)
    setAiError(null)
    try {
      await keepPastedText()
      const res = await importFromText(aiText)
      const { title, tags = [], ...base } = recipeBaseFromPost(post)
      const { recipe, warnings } = aiRecipeToRecipe(res.recipe, base)
      // Titre proposé par le Chef IA, sauf si celui de la publication a été corrigé à la main.
      if (post.edited.includes('title') && title) recipe.title = title
      recipe.tags = [...new Set([...tags, ...recipe.tags])].slice(0, 40)
      await openDraft(await createDraft(recipe, 'ai', [...res.warnings, ...warnings, NOT_ANALYZED]))
    } catch (e) {
      setAiError(toAiError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} size="tall" title="Transformer en recette" description="Une fiche à vérifier s’ouvre dans l’éditeur : rien n’est enregistré sans vous.">
      {step === 'choose' ? (
        <div className="space-y-4 pt-1 pb-4">
          <TextArea
            label="Texte de la publication"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              post.platform === 'instagram'
                ? 'Instagram ne transmet pas la légende. Copiez-la depuis Instagram et collez-la ici pour en extraire ingrédients et étapes.'
                : 'Aucun texte disponible. Collez ici la recette si elle figure en commentaire ou en légende.'
            }
          />
          <p className="rounded-2xl bg-sunken p-3 text-sm text-muted">
            {text.trim()
              ? found.ingredients.length || found.steps.length
                ? `Repéré dans ce texte : ${found.ingredients.length} ingrédient${found.ingredients.length > 1 ? 's' : ''} et ${found.steps.length} étape${found.steps.length > 1 ? 's' : ''}.`
                : 'Aucune liste d’ingrédients ou d’étapes n’a été repérée dans ce texte.'
              : 'Sans texte, la fiche reprend le titre, la miniature et le lien : vous la complétez.'}{' '}
            Seul ce qui est écrit est repris ; les quantités absentes restent vides.
          </p>
          <Button block size="lg" icon={<FileText size={18} />} loading={busy && step === 'choose'} onClick={() => void createLocal()}>
            Créer la fiche
          </Button>
          {aiReady ? (
            <Button block variant="secondary" icon={<Sparkles size={17} />} disabled={!online || text.trim().length < 20 || busy} onClick={() => setStep('consent')}>
              Extraire avec le Chef IA
            </Button>
          ) : (
            <p className="text-center text-xs text-faint">
              Option : le Chef IA peut structurer le texte (
              <Link to="/reglages/ia" className="font-semibold text-terra">
                à configurer
              </Link>
              ).
            </p>
          )}
          {aiReady && text.trim().length < 20 && <p className="text-center text-xs text-faint">Le Chef IA a besoin d’un texte de recette (au moins quelques lignes).</p>}
        </div>
      ) : (
        <div className="space-y-4 pt-1 pb-4">
          <p className="text-sm">
            Avec votre accord, <strong>uniquement le texte ci-dessous</strong> est envoyé au Chef IA (Gemini, Google). Ni la vidéo, ni la miniature, ni vos notes ne sont transmises.
          </p>
          <pre className="max-h-64 overflow-auto rounded-2xl bg-sunken p-3 font-sans text-xs whitespace-pre-wrap text-muted">{aiText}</pre>
          <p className="text-xs text-muted">Consigne donnée au Chef IA : retranscrire fidèlement, sans inventer d’ingrédient ni de quantité, et signaler ce qui manque.</p>
          {aiError && <AiErrorBox error={aiError} onRetry={() => void createWithAi()} />}
          <Button block size="lg" icon={<Send size={17} />} loading={busy} disabled={!online} onClick={() => void createWithAi()}>
            Envoyer au Chef IA
          </Button>
          <Button block variant="ghost" disabled={busy} onClick={() => setStep('choose')}>
            Annuler
          </Button>
        </div>
      )}
    </Sheet>
  )
}
