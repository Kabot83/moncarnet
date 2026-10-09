import { Page, TopBar } from '@/components/ui/Layout'

export default function AboutPage() {
  return (
    <>
      <TopBar back="/reglages" title="À propos" />
      <Page className="pt-4">
        <div className="space-y-6 text-[15px] leading-relaxed">
          <section>
            <h1 className="font-serif text-3xl font-semibold">Mon Carnet</h1>
            <p className="text-muted">Version 1.0.0 — votre livre de recettes personnel.</p>
          </section>
          <section>
            <h2 className="font-serif text-xl font-semibold">Installer sur Android</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
              <li>Ouvrez Mon Carnet dans Chrome.</li>
              <li>Menu ⋮ → « Installer l’application » (ou « Ajouter à l’écran d’accueil »).</li>
              <li>Lancez Mon Carnet depuis son icône : il s’ouvre en plein écran et fonctionne hors ligne.</li>
            </ol>
          </section>
          <section>
            <h2 className="font-serif text-xl font-semibold">Vos données</h2>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
              <li>Aucun compte, aucune publicité, aucun traceur, aucun abonnement.</li>
              <li>Recettes, photos, journal et préférences sont stockés uniquement sur ce téléphone (IndexedDB).</li>
              <li>Rien ne quitte l’appareil, sauf ce que vous envoyez volontairement au Chef IA (Google Gemini) ou les pages que vous importez par lien.</li>
              <li>Le Chef IA ne reçoit que le nécessaire : votre message, la ou les recettes concernées, votre profil culinaire.</li>
              <li>Les sauvegardes ZIP ne contiennent jamais votre clé API.</li>
            </ul>
          </section>
          <section>
            <h2 className="font-serif text-xl font-semibold">Hors ligne</h2>
            <p className="mt-2 text-muted">
              Après la première ouverture, l’application entière est en cache : consultation, recherche, ajustement des quantités, mode cuisine, minuteries, journal, collections, liste de courses et sauvegardes fonctionnent sans réseau. Seuls le Chef IA et l’import par lien nécessitent une connexion.
            </p>
          </section>
          <section>
            <h2 className="font-serif text-xl font-semibold">Informations nutritionnelles</h2>
            <p className="mt-2 text-muted">
              Les valeurs calculées utilisent une table indicative de valeurs moyennes ; les estimations du Chef IA sont signalées comme telles. Pour des valeurs de référence, l’architecture prévoit l’intégration de la table CIQUAL (ANSES) ou d’Open Food Facts, dans le respect de leurs licences.
            </p>
          </section>
        </div>
      </Page>
    </>
  )
}
