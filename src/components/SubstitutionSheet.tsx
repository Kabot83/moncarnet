import { Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { substituteIngredient } from '@/ai/chef'
import type { Substitution } from '@/ai/schemas'
import { AiError, toAiError } from '@/ai/errors'
import type { Ingredient, Recipe } from '@/models/types'
import { AiErrorBox } from './AiErrorBox'
import { Button } from './ui/Button'
import { Sheet } from './ui/Sheet'
import { Spinner } from './ui/Spinner'

/**
 * Remplacement d'un ingrédient (Chef IA). Distinct de l'ajustement des
 * quantités : propose des alternatives avec leurs effets, sans rien modifier.
 */
export function SubstitutionSheet({ open, onClose, recipe, ingredient }: { open: boolean; onClose: () => void; recipe: Recipe; ingredient: Ingredient | null }) {
  const [constraint, setConstraint] = useState('')
  const [result, setResult] = useState<Substitution | null>(null)
  const [error, setError] = useState<AiError | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (open) {
      setResult(null)
      setError(null)
      setConstraint('')
    }
  }, [open, ingredient?.id])

  const ask = async () => {
    if (!ingredient) return
    setLoading(true)
    setError(null)
    try {
      setResult(await substituteIngredient(recipe, ingredient, constraint))
    } catch (e) {
      setError(toAiError(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose} size="tall" title={`Remplacer « ${ingredient?.name ?? ''} »`} description="Le Chef IA propose des alternatives. Votre recette n’est pas modifiée.">
      {!result && (
        <div className="space-y-4 pt-2">
          <div>
            <label className="label" htmlFor="sub-c">
              Une contrainte ? (facultatif)
            </label>
            <input id="sub-c" className="field" placeholder="Ex. : sans lactose, ce que j’ai dans mes placards…" value={constraint} onChange={(e) => setConstraint(e.target.value)} />
          </div>
          <Button block size="lg" icon={<Sparkles size={18} />} loading={loading} onClick={() => void ask()}>
            Demander au Chef IA
          </Button>
          <p className="text-center text-xs text-faint">1 appel IA, uniquement le nom de la recette et ses ingrédients sont envoyés.</p>
        </div>
      )}
      {loading && !result && (
        <div className="flex items-center justify-center gap-2 py-6 text-muted">
          <Spinner /> Le Chef réfléchit…
        </div>
      )}
      {error && <AiErrorBox error={error} onRetry={() => void ask()} />}
      {result && (
        <div className="space-y-3 pt-2 pb-2">
          {result.warning && <p className="rounded-2xl bg-terra-soft p-3 text-sm text-terra-strong">{result.warning}</p>}
          {result.alternatives.map((a, k) => (
            <article key={k} className="rounded-2xl bg-paper p-4 shadow-[var(--shadow-card)]">
              <h3 className="font-serif text-lg font-semibold">{a.name}</h3>
              <p className="text-sm font-semibold text-terra">{a.amount}</p>
              <dl className="mt-2 space-y-1.5 text-sm">
                <div>
                  <dt className="inline font-semibold">Goût : </dt>
                  <dd className="inline text-muted">{a.taste}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Texture : </dt>
                  <dd className="inline text-muted">{a.texture}</dd>
                </div>
                <div>
                  <dt className="inline font-semibold">Cuisson : </dt>
                  <dd className="inline text-muted">{a.cooking}</dd>
                </div>
                {a.notes && <p className="text-muted italic">{a.notes}</p>}
              </dl>
            </article>
          ))}
          <p className="text-center text-xs text-faint">Suggestions générées par IA : vérifiez-les, en particulier en cas d’allergie.</p>
          <Button variant="secondary" block onClick={() => setResult(null)}>
            Nouvelle demande
          </Button>
        </div>
      )}
    </Sheet>
  )
}
