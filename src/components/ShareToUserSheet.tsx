/**
 * « Partager avec un utilisateur » : envoi d'une COPIE de la recette à un autre compte Carnet Sync.
 * Le destinataire l'accepte ou la refuse ; après acceptation, sa copie est indépendante (aucune
 * modification ne passe plus entre les deux). Identifiant exact uniquement (aucune liste).
 * Jamais transmis : notes personnelles, favori, note, réalisations, journal.
 */
import { Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Feedback'
import { Switch, TextInput } from '@/components/ui/Fields'
import { Sheet } from '@/components/ui/Sheet'
import type { Recipe } from '@/models/types'
import { syncService } from '@/sync/instance'

export function ShareToUserSheet({ recipe, open, onClose }: { recipe: Recipe; open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [login, setLogin] = useState('')
  const [found, setFound] = useState<{ login: string; display_name: string } | null>(null)
  const [tips, setTips] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setLogin('')
      setFound(null)
      setError(null)
      setTips(true)
    }
  }, [open])

  const search = async () => {
    setBusy(true)
    setError(null)
    try {
      const who = await syncService.api.lookupUser(login.trim().toLowerCase())
      setFound(who)
      if (!who) setError('Aucun utilisateur avec cet identifiant.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recherche impossible (connexion ?).')
    } finally {
      setBusy(false)
    }
  }

  const send = async () => {
    if (!found) return
    setBusy(true)
    setError(null)
    try {
      const r = await syncService.shareRecipe(recipe.id, found.login, tips)
      toast.success(`Recette envoyée à ${r.to} : elle la trouvera dans « Recettes reçues »`)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Envoi impossible.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Partager avec un utilisateur"
      description="La personne reçoit une copie de cette recette, qu’elle accepte ou refuse. Ensuite, vos deux recettes restent indépendantes."
      footer={
        found ? (
          <Button block icon={<Send size={17} />} loading={busy} onClick={() => void send()}>
            Envoyer à {found.display_name}
          </Button>
        ) : (
          <Button block loading={busy} disabled={!login.trim()} onClick={() => void search()}>
            Rechercher
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <TextInput
          label="Identifiant exact de la personne"
          value={login}
          onChange={(e) => {
            setLogin(e.target.value)
            setFound(null)
          }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-autofocus
        />
        {found && (
          <p className="rounded-xl bg-sage-soft p-3 text-sm">
            Destinataire : <strong>{found.display_name}</strong> ({found.login})
          </p>
        )}
        <div className="rounded-2xl bg-paper px-4">
          <Switch label="Inclure mes astuces" description="Les astuces de la fiche accompagnent la recette." checked={tips} onChange={setTips} />
        </div>
        <p className="text-xs text-muted">Jamais envoyés : vos notes personnelles, favoris, note, réalisations et journal. La version envoyée est celle enregistrée sur le serveur au moment de l’envoi.</p>
        {error && <p className="rounded-xl bg-danger-soft p-3 text-sm text-danger">{error}</p>}
      </div>
    </Sheet>
  )
}
