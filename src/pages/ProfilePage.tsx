import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Feedback'
import { TextArea } from '@/components/ui/Fields'
import { Page, TopBar } from '@/components/ui/Layout'
import { type CulinaryProfile, PROFILE_FIELDS } from '@/models/types'
import { getProfile, saveProfile } from '@/services/settings'

/** Profil culinaire : transmis au Chef IA quand c'est pertinent, jamais ailleurs. */
export default function ProfilePage() {
  const toast = useToast()
  const [profile, setProfile] = useState<CulinaryProfile | null>(null)
  useEffect(() => void getProfile().then(setProfile), [])
  if (!profile) return null
  return (
    <>
      <TopBar back="/reglages" title="Profil culinaire" />
      <Page className="pt-4">
        <p className="text-muted">Le Chef IA tient compte de ces préférences dans ses propositions. Elles restent sur ce téléphone et ne sont envoyées qu’avec vos demandes au Chef.</p>
        <p className="mt-2 rounded-2xl bg-terra-soft p-3 text-sm text-terra-strong">
          Les allergènes indiqués sont pris en compte, mais une recette générée par IA ne peut jamais garantir leur absence : vérifiez toujours les ingrédients et les étiquettes.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            await saveProfile(profile)
            toast.success('Profil enregistré')
          }}
        >
          {PROFILE_FIELDS.map((f) => (
            <TextArea key={f.id} label={f.label} placeholder={f.placeholder} rows={2} value={profile[f.id]} onChange={(e) => setProfile({ ...profile, [f.id]: e.target.value })} />
          ))}
          <Button type="submit" block size="lg">
            Enregistrer mon profil
          </Button>
        </form>
      </Page>
    </>
  )
}
