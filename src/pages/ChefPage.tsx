import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowUp, BookOpen, ChefHat, Clock3, MessageSquarePlus, Paperclip, Settings2, Sparkles, Trash2, WifiOff } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { CATALOG_SCOPES, type CatalogScope, selectCatalogContext } from '@/ai/catalog'
import { IMPROVE_PROMPTS, SURPRISE_PROMPT, chat } from '@/ai/chef'
import { type AiError, toAiError } from '@/ai/errors'
import { useAiUsage } from '@/ai/quota'
import { AiErrorBox } from '@/components/AiErrorBox'
import { AiRecipeCard, openAiRecipeInEditor } from '@/components/AiRecipeCard'
import { Button, IconButton } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/Feedback'
import { EmptyState, Photo, TopBar } from '@/components/ui/Layout'
import { Sheet } from '@/components/ui/Sheet'
import { Spinner } from '@/components/ui/Spinner'
import { db } from '@/db/db'
import { useOnline } from '@/hooks/useOnline'
import { useSafeNavigate } from '@/hooks/useOverlayHistory'
import { relativeDays } from '@/lib/format'
import { newId } from '@/lib/id'
import type { AiRecipe, ChatMessage, Conversation } from '@/models/types'
import { useSettings } from '@/services/settings'

const STARTERS = [
  { label: 'Surprends-moi', icon: Sparkles, text: SURPRISE_PROMPT, scope: 'none' as CatalogScope },
  { label: 'Avec ce que j’ai', icon: ChefHat, text: 'J’ai du poulet, des courgettes et du parmesan. Je veux trois idées de plats riches en protéines, prêts en moins de 30 minutes.', scope: 'none' as CatalogScope, edit: true },
  { label: 'Un plat oublié', icon: Clock3, text: 'Propose-moi un repas parmi les recettes que je n’ai pas cuisinées depuis longtemps.', scope: 'forgotten' as CatalogScope },
  { label: 'Rapide parmi mes favorites', icon: BookOpen, text: 'Trouve quelque chose de rapide parmi mes recettes favorites.', scope: 'favorites' as CatalogScope },
]

export default function ChefPage() {
  const { conversationId } = useParams()
  const [params] = useSearchParams()
  const navigate = useSafeNavigate()
  const settings = useSettings()
  const online = useOnline()
  const usage = useAiUsage()
  const confirm = useConfirm()
  const pinnedId = params.get('recette')

  const conversation = useLiveQuery(async () => (conversationId ? ((await db.conversations.get(conversationId)) ?? null) : null), [conversationId])
  const conversations = useLiveQuery(() => db.conversations.orderBy('updatedAt').reverse().limit(30).toArray(), [], [])
  const pinnedRecipe = useLiveQuery(async () => {
    const rid = conversation?.recipeId ?? pinnedId
    return rid ? ((await db.recipes.get(rid)) ?? null) : null
  }, [conversation?.recipeId, pinnedId])

  const [input, setInput] = useState('')
  const [scope, setScope] = useState<CatalogScope>('auto')
  const [scopeOpen, setScopeOpen] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<{ err: AiError; text: string; scope: CatalogScope } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [conversation?.messages.length, pending, error])
  useEffect(() => () => abortRef.current?.abort(), [])

  const messages = useMemo(() => conversation?.messages ?? [], [conversation])
  const enabled = settings.aiMode !== 'off'

  const send = async (text: string, useScope: CatalogScope = scope, model?: string) => {
    const t = text.trim()
    if (!t || pending) return
    setError(null)
    setInput('')
    setPending(t)
    const recipes = await db.recipes.toArray()
    // Recherche locale d'abord : seules les recettes pertinentes sont jointes, jamais tout le carnet.
    const ctx = pinnedRecipe ? null : selectCatalogContext(t, recipes, useScope)
    const contextIds = ctx ? [...ctx.detailed, ...ctx.summaries].map((r) => r.id) : []
    const userMsg: ChatMessage = { id: newId('m_'), role: 'user', text: t, contextRecipeIds: contextIds, createdAt: Date.now() }
    abortRef.current = new AbortController()
    try {
      const res = await chat(messages, t, ctx, { signal: abortRef.current.signal, model, pinnedRecipe })
      const modelMsg: ChatMessage = {
        id: newId('m_'),
        role: 'model',
        text: res.reply + (res.rejected ? `\n\n(${res.rejected} proposition(s) incomplète(s) ont été écartées.)` : ''),
        recipes: res.recipes,
        createdAt: Date.now(),
      }
      const now = Date.now()
      const conv: Conversation = conversation
        ? { ...conversation, messages: [...conversation.messages, userMsg, modelMsg], updatedAt: now }
        : {
            id: newId('cv_'),
            title: pinnedRecipe ? `${pinnedRecipe.title} — ${t}`.slice(0, 80) : t.slice(0, 80),
            messages: [userMsg, modelMsg],
            recipeId: pinnedRecipe?.id ?? null,
            createdAt: now,
            updatedAt: now,
          }
      await db.conversations.put(conv)
      if (!conversation) navigate(`/chef/${conv.id}`, { replace: true })
      // « Parfait, enregistre-la » : fiche préremplie à valider.
      if (res.saveRequested) {
        const last = res.recipes.at(-1) ?? [...messages].reverse().find((m) => m.recipes?.length)?.recipes?.at(-1)
        if (last) await openAiRecipeInEditor(navigate, last, { source: 'Mon Chef IA', variantOf: pinnedRecipe?.id ?? null })
      }
    } catch (e) {
      const err = toAiError(e)
      if (!abortRef.current?.signal.aborted) setError({ err, text: t, scope: useScope })
      setInput(t)
    } finally {
      setPending(null)
    }
  }

  const variant = (r: AiRecipe) => void send(`Propose une variante de « ${r.title} », différente mais dans le même esprit.`, 'none')

  if (!enabled)
    return (
      <>
        <TopBar title="Mon Chef IA" />
        <main className="mx-auto max-w-2xl px-4 pb-32">
          <EmptyState icon={<ChefHat size={30} strokeWidth={1.5} />} title="Mon Chef IA n’est pas activé" action={<Button onClick={() => navigate('/reglages/ia')}>Configurer le Chef IA</Button>}>
            Le Chef IA utilise l’API Google Gemini, avec un niveau gratuit et sans facturation. Votre carnet fonctionne entièrement sans lui.
          </EmptyState>
        </main>
      </>
    )

  const showWelcome = !conversationId && !pending

  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar
        back={!!conversationId || !!pinnedId}
        title={conversationId ? conversation?.title : 'Mon Chef IA'}
        subtitle={`${usage}/${settings.aiDailyLimit || '∞'} appels aujourd’hui (limite locale)`}
        actions={
          <>
            {conversationId && (
              <IconButton label="Nouvelle conversation" onClick={() => navigate('/chef')}>
                <MessageSquarePlus size={20} />
              </IconButton>
            )}
            <IconButton label="Réglages du Chef IA" onClick={() => navigate('/reglages/ia')}>
              <Settings2 size={20} />
            </IconButton>
          </>
        }
      />

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-4 pb-56">
        {pinnedRecipe && (
          <Link to={`/recettes/${pinnedRecipe.id}`} className="mb-4 flex items-center gap-3 rounded-2xl bg-paper p-2.5 shadow-[var(--shadow-card)]">
            <Photo id={pinnedRecipe.mainPhotoId} alt="" className="size-12 shrink-0 rounded-xl" fallback={<span className="size-12 rounded-xl bg-sunken" />} />
            <span className="min-w-0 flex-1">
              <span className="block text-xs text-muted">À propos de ma recette</span>
              <span className="block truncate font-semibold">{pinnedRecipe.title}</span>
            </span>
          </Link>
        )}

        {showWelcome && (
          <div className="animate-fade-up">
            {!pinnedRecipe && (
              <>
                <h1 className="font-serif text-[2rem] leading-tight font-semibold">
                  Que cuisine-t-on <span className="text-terra italic">aujourd’hui</span> ?
                </h1>
                <p className="mt-2 text-muted">Inventer une recette, adapter un plat, trouver une idée avec vos ingrédients ou parmi vos recettes.</p>
              </>
            )}
            <div className="mt-5 grid grid-cols-2 gap-2.5">
              {(pinnedRecipe ? IMPROVE_PROMPTS.map((p) => ({ label: p, icon: Sparkles, text: p, scope: 'none' as CatalogScope, edit: false })) : STARTERS).map((s) => (
                <button
                  key={s.label}
                  type="button"
                  disabled={!online}
                  onClick={() => ('edit' in s && s.edit ? setInput(s.text) : void send(s.text, s.scope))}
                  className="flex min-h-[4.5rem] items-start gap-2.5 rounded-2xl bg-paper p-3.5 text-left text-sm font-medium shadow-[var(--shadow-card)] transition-transform active:scale-[.98] disabled:opacity-50"
                >
                  <s.icon size={18} className="mt-0.5 shrink-0 text-terra" strokeWidth={1.75} />
                  {s.label}
                </button>
              ))}
            </div>
            {!pinnedRecipe && conversations.length > 0 && (
              <section className="mt-8">
                <h2 className="label">Conversations récentes</h2>
                <ul className="divide-y divide-line rounded-2xl bg-paper shadow-[var(--shadow-card)]">
                  {conversations.map((c) => (
                    <li key={c.id} className="flex items-center">
                      <Link to={`/chef/${c.id}`} className="min-w-0 flex-1 px-4 py-3">
                        <span className="block truncate font-medium">{c.title}</span>
                        <span className="text-xs text-muted">{relativeDays(c.updatedAt)}</span>
                      </Link>
                      <IconButton
                        label="Supprimer la conversation"
                        size="sm"
                        className="mr-2 text-faint"
                        onClick={async () => {
                          if (await confirm({ title: 'Supprimer cette conversation ?', confirmLabel: 'Supprimer', danger: true })) await db.conversations.delete(c.id)
                        }}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        <div className="space-y-5">
          {messages.map((m) => (
            <Message key={m.id} m={m} onVariant={variant} variantOf={conversation?.recipeId ?? null} />
          ))}
          {pending && (
            <>
              <Message m={{ id: 'p', role: 'user', text: pending, createdAt: Date.now() }} />
              <div className="flex items-center gap-2 text-muted" role="status">
                <Spinner size={18} className="text-terra" /> Le Chef réfléchit…
                <button type="button" className="ml-2 text-sm underline" onClick={() => abortRef.current?.abort()}>
                  Annuler
                </button>
              </div>
            </>
          )}
          {error && (
            <AiErrorBox
              error={error.err}
              onRetry={() => void send(error.text, error.scope)}
              fallbackModel={settings.aiFallbackModel || undefined}
              onFallback={() => void send(error.text, error.scope, settings.aiFallbackModel)}
            />
          )}
        </div>
        <div ref={bottomRef} />
      </main>

      <div className="safe-bottom fixed inset-x-0 bottom-[calc(4.25rem+var(--sab))] z-30 bg-gradient-to-t from-bg via-bg to-bg/0 pt-6">
        <div className="mx-auto max-w-2xl px-4 pb-3">
          {!online && (
            <p className="mb-2 flex items-center gap-2 rounded-xl bg-sunken px-3 py-2 text-sm text-muted">
              <WifiOff size={16} /> Hors ligne : le Chef IA reviendra avec la connexion.
            </p>
          )}
          {!pinnedRecipe && (
            <button type="button" onClick={() => setScopeOpen(true)} className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-sunken px-3 py-1.5 text-xs font-medium text-muted">
              <Paperclip size={13} /> Mon carnet : {CATALOG_SCOPES.find((s) => s.id === scope)?.label}
            </button>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send(input)
            }}
            className="flex items-end gap-2 rounded-[1.6rem] border border-line bg-paper p-1.5 pl-4 shadow-[var(--shadow-float)]"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
                  e.preventDefault()
                  void send(input)
                }
              }}
              rows={Math.min(5, Math.max(1, input.split('\n').length))}
              placeholder={pinnedRecipe ? 'Votre question sur cette recette…' : 'Une envie, des ingrédients, une question…'}
              aria-label="Message pour le Chef IA"
              className="max-h-40 flex-1 resize-none bg-transparent py-2.5 outline-none placeholder:text-faint"
            />
            <IconButton label="Envoyer" tone="terra" type="submit" disabled={!input.trim() || !!pending || !online}>
              <ArrowUp size={20} />
            </IconButton>
          </form>
        </div>
      </div>

      <Sheet open={scopeOpen} onClose={() => setScopeOpen(false)} title="Utiliser mon carnet" description="Les recettes sont choisies sur votre téléphone ; seul un court extrait est envoyé, jamais tout le carnet.">
        <div className="space-y-1 pb-2" role="radiogroup" aria-label="Recettes jointes">
          {CATALOG_SCOPES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={scope === s.id}
              onClick={() => {
                setScope(s.id)
                setScopeOpen(false)
              }}
              className={`w-full rounded-xl px-4 py-3 text-left ${scope === s.id ? 'bg-terra-soft' : ''}`}
            >
              <span className="block font-medium">{s.label}</span>
              <span className="block text-sm text-muted">{s.hint}</span>
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  )
}

function Message({ m, onVariant, variantOf }: { m: ChatMessage; onVariant?: (r: AiRecipe) => void; variantOf?: string | null }) {
  if (m.role === 'user')
    return (
      <div className="flex flex-col items-end animate-fade-up">
        <p className="max-w-[85%] rounded-[1.25rem] rounded-br-md bg-terra px-4 py-2.5 text-[15px] whitespace-pre-line text-white dark:text-[#1b1916]">{m.text}</p>
        {m.contextRecipeIds && m.contextRecipeIds.length > 0 && (
          <span className="mt-1 inline-flex items-center gap-1 text-xs text-muted">
            <Paperclip size={11} /> {m.contextRecipeIds.length} recette{m.contextRecipeIds.length > 1 ? 's' : ''} de mon carnet jointe{m.contextRecipeIds.length > 1 ? 's' : ''}
          </span>
        )}
      </div>
    )
  return (
    <div className="space-y-3 animate-fade-up">
      <div className="flex gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sage-soft text-sage">
          <ChefHat size={16} />
        </span>
        <p className="min-w-0 flex-1 pt-1 text-[15px] leading-relaxed whitespace-pre-line">{m.text}</p>
      </div>
      {m.recipes?.map((r, k) => (
        <AiRecipeCard key={k} recipe={r} onVariant={onVariant} variantOf={variantOf} />
      ))}
    </div>
  )
}
