import { Page, TopBar } from '@/components/ui/Layout'

export default function AboutPage() {
  return (
    <>
      <TopBar back="/reglages" title="À propos" />
      <Page className="pt-4">
        <div className="space-y-6 text-[15px] leading-relaxed">
          <section>
            <h1 className="font-serif text-3xl font-semibold">Mon Carnet</h1>
            <p className="text-muted">Version {__APP_VERSION__} — votre livre de recettes personnel.</p>
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
              Les valeurs sont calculées ingrédient par ingrédient, à partir des aliments que vous associez vous-même : aucune association automatique, aucune valeur inventée. Une teneur inconnue n’est jamais comptée comme zéro ; le résultat est alors signalé « incomplet ». Les estimations du Chef IA restent présentées comme approximatives.
            </p>
            <h3 className="mt-4 font-semibold">Table CIQUAL 2025</h3>
            <p className="text-muted">
              Anses. 2025. Table de composition nutritionnelle des aliments Ciqual. Données du 3 novembre 2025 (3 484 aliments), intégrées sans modification et consultables hors ligne. Réutilisées selon la Licence Ouverte (Etalab).{' '}
              <a className="text-terra underline-offset-2 hover:underline" href="https://ciqual.anses.fr/" target="_blank" rel="noopener noreferrer">
                ciqual.anses.fr
              </a>{' '}
              · DOI 10.57745/RDMHWY
            </p>
            <h3 className="mt-4 font-semibold">Open Food Facts</h3>
            <p className="text-muted">
              Produits de marque issus de la base collaborative Open Food Facts, sous licence Open Database License (ODbL) ; © contributeurs Open Food Facts.{' '}
              <a className="text-terra underline-offset-2 hover:underline" href="https://world.openfoodfacts.org/" target="_blank" rel="noopener noreferrer">
                openfoodfacts.org
              </a>
              . Les produits choisis sont conservés sur ce téléphone.
            </p>
          </section>
        </div>
      </Page>
    </>
  )
}
