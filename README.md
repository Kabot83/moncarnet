# Mon Carnet

Carnet de recettes personnel pour Android (PWA installable), hors ligne, sans compte, sans publicité, sans abonnement — avec un assistant culinaire Google Gemini facultatif, utilisé uniquement sur le niveau gratuit.

## Fonctionnalités

- **Catalogue** : grille ou liste, recherche instantanée (titres, ingrédients, notes, tags, catégories, sans accents), filtres combinables, tri, affichage progressif (testé avec 800 recettes).
- **Fiche recette** complète : photos et galerie, temps, portions, difficulté, source, ingrédients groupés, étapes avec durée/température/minuterie/photo, notes personnelles (astuces, modifications, erreurs, idées, conservation, réchauffage).
- **Ajustement intelligent des ingrédients** : − / quantité modifiable / + sur n'importe quel ingrédient, portions, portée « toute la recette » ou « ce groupe ». Calculs toujours repartis des quantités d'origine, arrondis seulement à l'affichage (« pratique » 135 g ou « précis » 133 g), sel/épices/levure exclus, « selon le goût » et fractions gérés. Actions : Réinitialiser, Utiliser pour cette préparation, Enregistrer comme variante, Remplacer l'original (confirmation explicite). L'ajustement survit à la fermeture de l'app ; une nouvelle préparation repart de l'original.
- **Mode cuisine** plein écran : une étape à la fois, gros boutons, balayage, cases à cocher, ajustement en direct, plusieurs minuteries (son, vibration, notification), écran maintenu allumé (Wake Lock), progression conservée.
- **Journal** : réalisations datées avec note, photo, commentaire, modifications, quantités réellement utilisées, cuisson réelle ; « Cuisinée X fois ».
- **Collections** personnalisables (couverture, ordre), **liste de courses** multi-recettes (portions, ajustements en cours, regroupement, addition des unités compatibles seulement, rayons, partage texte).
- **Import** : saisie manuelle avec brouillon automatique, lien (Schema.org/Recipe, via le proxy), photo et texte (Chef IA). Toujours un aperçu éditable avant enregistrement.
- **Mon Chef IA** : conversation libre, idées de recettes, « Surprends-moi », amélioration d'une recette (sans jamais modifier l'original), remplacement d'ingrédient, exploitation du carnet (sélection locale, jamais tout le catalogue), profil culinaire, estimation nutritionnelle signalée comme telle.
- **Nutrition** facultative, qui suit les quantités ajustées.
- **Sauvegarde ZIP** (JSON versionné + photos, sans aucun secret) et **restauration** contrôlée (format, version, SHA-256 des photos, doublons, aperçu, fusion ou remplacement).
- Mode clair/sombre, interface 100 % française, pensée pour une main.

## Démarrer

```bash
npm install
```

```bash
npm run dev
```

Ouvrir http://localhost:5173. Six recettes de démonstration (dont les crêpes de l'exemple) sont installées au premier lancement ; elles portent l'étiquette « Démonstration » et se suppriment depuis **Réglages → Données de démonstration**.

## Tests

```bash
npm test
```

101 tests unitaires (Vitest) : migration PWA → APK, calcul des proportions, unités et fractions, services de données, journal, collections, sessions, recherche sur 800 recettes, liste de courses, sauvegarde/restauration de 300 recettes et 150 photos (dont fichiers corrompus), import Schema.org, validation des réponses IA, quotas, proxy (authentification, routes, SSRF, robots.txt).

```bash
npm run build && npm run test:e2e
```

15 scénarios Playwright sur le build de production, format Pixel 7, avec le Chrome installé : navigation, crêpes 3 → 4 œufs, création/recherche/suppression, mode cuisine et bouton Retour, journal, courses, collections, export/restauration ZIP, **fonctionnement hors ligne**, et Chef IA avec l'API Gemini **simulée** (génération, « enregistre-la », erreur 429 sans nouvelle tentative, réponse invalide écartée, limite locale, import texte).

## Mettre en ligne et installer sur Android

L'application est un site statique (`dist/`), chemins relatifs et routage par `#` : elle fonctionne sur n'importe quel hébergement HTTPS gratuit (GitHub Pages, Cloudflare Pages, Netlify).

```bash
npm run build
```

Publier le contenu de `dist/`, puis sur le téléphone : Chrome → menu ⋮ → **Installer l'application**. Elle s'ouvre en plein écran et fonctionne hors ligne après la première visite. Le partage Android d'un lien vers « Mon Carnet » ouvre directement l'import.

## Mon Chef IA : rester sur le niveau gratuit

1. Dans [Google AI Studio](https://aistudio.google.com/apikey), créer une clé API **dans un projet sans compte de facturation**. C'est la seule garantie réelle : sans facturation, un dépassement de quota renvoie une erreur 429, jamais une facture. Ne pas activer la facturation Google Cloud sur ce projet.
2. Dans **Réglages → Mon Chef IA**, choisir le mode puis « Lister les modèles accessibles ». `gemini-3.7-flash` est présélectionné s'il est proposé à votre clé ; sinon le modèle « flash » stable le plus récent. La liste montre les modèles **accessibles**, pas leur gratuité : celle-ci dépend du projet et des quotas publiés par Google, qui évoluent.
3. Fixer la limite locale d'appels par jour. Ce compteur est le vôtre, **pas** le quota restant chez Google.

Garde-fous intégrés : aucune nouvelle tentative automatique (le SDK est configuré avec `attempts: 1`), aucun changement de modèle sans clic (le modèle de repli n'est proposé qu'après une erreur), aucune génération en arrière-plan, contexte minimal envoyé, réponses JSON validées par Zod avant tout affichage.

### Où mettre la clé ?

- **Mode proxy (recommandé)** : la clé reste sur votre serveur. Voir [`proxy/README.md`](proxy/README.md) — un Cloudflare Worker (offre gratuite suffisante pour un usage personnel, sans garantie qu'elle le reste) qui vérifie un jeton d'accès, filtre routes et modèles, limite la taille et le nombre d'appels, et sert aussi à l'import par lien avec protection SSRF.
- **Mode clé sur le téléphone** : plus simple, mais **moins sûr** — la clé est stockée en clair dans les données de l'application et lisible par quiconque accède au navigateur. Ce n'est pas équivalent à un stockage serveur. Utiliser une clé dédiée, restreinte à l'API Gemini, et la révoquer en cas de doute. Elle n'est jamais incluse dans les sauvegardes.

Le carnet reste entièrement utilisable sans Chef IA.

## Sauvegarder ses données

Les recettes sont stockées **uniquement sur le téléphone** (IndexedDB). Elles peuvent disparaître lors d'un changement de téléphone, d'une désinstallation ou d'un effacement des données de Chrome. **Réglages → Sauvegarde → Sauvegarder mon carnet** produit `mon-carnet-AAAA-MM-JJ-HHMM.zip` ; « Envoyer vers… » permet de le déposer sur Drive. Sur un nouveau téléphone : installer l'app, puis **Restaurer mon carnet** (fusion ou remplacement, après aperçu). L'app demande aussi au navigateur un stockage persistant.

## Application Android (APK)

Mon Carnet existe aussi en application Android installable hors Play Store (Capacitor 8, identifiant `fr.kabot83.moncarnet`). L'APK est compilé automatiquement par GitHub Actions à chaque envoi et publié dans la pré-version [android-test](https://github.com/Kabot83/moncarnet/releases/tag/android-test). Installation, transfert du carnet depuis la PWA, APK debug ou release et mises à jour sans perte : voir [docs/ANDROID.md](docs/ANDROID.md).

## Architecture

```
src/
  models/types.ts       Schémas Zod + types (recette, journal, collection, session, IA)
  lib/scaling.ts        Calcul des proportions — module pur, documenté, testé
  lib/units.ts          Unités, fractions, arrondis d'affichage, incréments
  lib/search.ts         Recherche et filtres locaux, « À redécouvrir »
  lib/shopping.ts       Agrégation de la liste de courses
  lib/nutrition.ts      Nutrition (interface prête pour CIQUAL / Open Food Facts)
  db/                   Dexie (migrations versionnées), données de démonstration
  services/             Recettes, photos (compression, nettoyage), sessions et minuteries,
                        courses, brouillons, réglages/secrets, sauvegarde ZIP
  ai/                   Client Gemini (SDK officiel, chargé à la demande), quotas, erreurs,
                        schémas JSON + Zod, conversion, sélection locale du catalogue
  importers/            Schema.org/Recipe (JSON-LD, microdonnées), URL
  components/, pages/   Interface (React 19, Tailwind 4, composants accessibles maison)
proxy/                  Cloudflare Worker (clé serveur, import par lien)
tests/unit, tests/e2e   Vitest, Playwright
```

Choix notable : pas de bibliothèque de composants externe ; les feuilles modales gèrent rôle `dialog`, piège du focus, Échap et **bouton Retour Android** (`useOverlayHistory`).

## Reste à faire / limites connues

- **Nutrition** : la table intégrée est indicative (≈ 25 aliments courants). L'intégration CIQUAL (licence Etalab) ou Open Food Facts (ODbL, attribution) se branche via `NutritionProvider` dans `src/lib/nutrition.ts`.
- **Minuteries écran éteint** : en PWA, Android peut suspendre la page ; l'APK programme une vraie notification Android.
- **Import par lien sans proxy** : la plupart des sites bloquent la lecture (CORS) ; l'app propose alors l'import par texte.
- **Glisser-déposer** pour réordonner : remplacé par des boutons monter/descendre (plus fiables au doigt et accessibles).
- Le modèle `gemini-3.7-flash` n'a pas pu être vérifié contre votre projet : faites « Lister les modèles accessibles » dans les réglages.
