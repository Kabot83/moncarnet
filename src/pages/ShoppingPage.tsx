import { useLiveQuery } from 'dexie-react-hooks'
import { Check, Eraser, Plus, Share2, ShoppingBasket, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button, IconButton } from '@/components/ui/Button'
import { useConfirm, useToast } from '@/components/ui/Feedback'
import { EmptyState, Page, TopBar } from '@/components/ui/Layout'
import { db } from '@/db/db'
import { shoppingText } from '@/lib/shopping'
import { shareText } from '@/lib/share'
import { displayQuantity } from '@/lib/units'
import { SHOP_CATEGORIES, type ShoppingItem } from '@/models/types'
import { addManualItem, clearChecked, clearShopping, removeShoppingItem, toggleShoppingItem } from '@/services/shopping'

/** Liste de courses : regroupée par rayon, cochable, partageable, 100 % hors ligne. */
export default function ShoppingPage() {
  const toast = useToast()
  const confirm = useConfirm()
  const items = useLiveQuery(() => db.shopping.orderBy('createdAt').toArray(), [], [] as ShoppingItem[])
  const [text, setText] = useState('')

  const byCategory = useMemo(() => {
    const map = new Map<string, ShoppingItem[]>()
    for (const c of SHOP_CATEGORIES) map.set(c, [])
    for (const i of items) map.get(i.category)!.push(i)
    for (const list of map.values()) list.sort((a, b) => Number(a.checked) - Number(b.checked))
    return [...map.entries()].filter(([, l]) => l.length)
  }, [items])
  const remaining = items.filter((i) => !i.checked).length
  const checkedCount = items.length - remaining

  const share = async () => {
    const res = await shareText('Liste de courses', shoppingText(items))
    if (res === 'copied') toast.success('Liste copiée dans le presse-papiers')
  }

  return (
    <>
      <TopBar
        back
        title="Liste de courses"
        subtitle={items.length ? `${remaining} à acheter` : undefined}
        actions={
          items.length > 0 && (
            <IconButton label="Partager la liste" onClick={() => void share()}>
              <Share2 size={20} />
            </IconButton>
          )
        }
      />
      <Page className="pt-4">
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            await addManualItem(text)
            setText('')
          }}
        >
          <input className="field h-12 rounded-full px-5" placeholder="Ajouter : « 1 kg de pommes »" value={text} onChange={(e) => setText(e.target.value)} aria-label="Ajouter un article" />
          <IconButton label="Ajouter" tone="terra" type="submit" disabled={!text.trim()} className="!size-12">
            <Plus size={22} />
          </IconButton>
        </form>

        {items.length === 0 ? (
          <EmptyState icon={<ShoppingBasket size={28} strokeWidth={1.5} />} title="Liste vide" action={<Link to="/recettes" className="font-semibold text-terra">Choisir des recettes</Link>}>
            Dans « Mes recettes », touchez l’icône de sélection pour générer la liste à partir d’une ou plusieurs recettes, ou ajoutez des articles à la main.
          </EmptyState>
        ) : (
          <>
            {byCategory.map(([cat, list]) => (
              <section key={cat} className="mt-6">
                <h2 className="mb-2 text-xs font-semibold tracking-[0.12em] text-terra uppercase">{cat}</h2>
                <ul className="divide-y divide-line/70 rounded-2xl bg-paper shadow-[var(--shadow-card)]">
                  {list.map((i) => (
                    <Row key={i.id} item={i} />
                  ))}
                </ul>
              </section>
            ))}
            <div className="mt-8 flex flex-wrap gap-2">
              {checkedCount > 0 && (
                <Button variant="secondary" size="sm" icon={<Eraser size={16} />} onClick={() => void clearChecked()}>
                  Retirer les articles cochés ({checkedCount})
                </Button>
              )}
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 size={16} />}
                onClick={async () => {
                  if (await confirm({ title: 'Vider la liste de courses ?', confirmLabel: 'Vider', danger: true })) await clearShopping()
                }}
              >
                Vider la liste
              </Button>
            </div>
          </>
        )}
      </Page>
    </>
  )
}

function Row({ item }: { item: ShoppingItem }) {
  const d = item.quantity != null ? displayQuantity(item.quantity, item.unit, { rounding: 'practical', name: item.name }) : null
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <button
        type="button"
        role="checkbox"
        aria-checked={item.checked}
        aria-label={item.name}
        onClick={() => void toggleShoppingItem(item)}
        className={`grid size-8 shrink-0 place-items-center rounded-full border-2 transition-colors ${item.checked ? 'border-sage bg-sage text-white' : 'border-line'}`}
      >
        {item.checked && <Check size={16} strokeWidth={3} />}
      </button>
      <button type="button" onClick={() => void toggleShoppingItem(item)} className={`min-w-0 flex-1 text-left ${item.checked ? 'text-faint line-through' : ''}`}>
        <span className="block text-[15px]">{item.name}</span>
        {(item.extra || item.recipeTitles.length > 0) && (
          <span className="block truncate text-xs text-muted">{[item.extra, item.recipeTitles.join(', ')].filter(Boolean).join(' · ')}</span>
        )}
      </button>
      {d && <span className={`shrink-0 font-semibold tabular-nums ${item.checked ? 'text-faint' : ''}`}>{`${d.value}${d.unit ? ` ${d.unit}` : ''}`}</span>}
      <IconButton label={`Supprimer ${item.name}`} size="sm" onClick={() => void removeShoppingItem(item.id)} className="text-faint">
        <X size={16} />
      </IconButton>
    </li>
  )
}
