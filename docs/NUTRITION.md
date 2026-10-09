# Nutrition — CIQUAL 2025 et Open Food Facts

Mon Carnet calcule calories, protéines, glucides et lipides de chaque recette à partir de ses ingrédients, **pour 100 g**, **par portion** et **pour la recette entière**.

## Utilisation

1. Sur une fiche recette, section **Nutrition** → **Associer les ingrédients** (ou menu « … » d'un ingrédient → *Associer les valeurs nutritionnelles*).
2. Choisir la source :
   - **CIQUAL** : aliments génériques (farines, œufs, lait, fruits, viandes…), recherche instantanée **hors ligne** ;
   - **Marques** : produits Open Food Facts, recherche par nom, marque ou **code-barres** (connexion nécessaire) ;
   - **Mes aliments** : aliment déjà choisi pour ce nom d'ingrédient, favoris (★) et récents, sans nouvelle recherche ;
   - **Saisie** : valeurs d'une étiquette.
3. Vérifier puis **Associer**. Rien n'est jamais associé automatiquement.
4. Si l'ingrédient est compté en pièces (« 2 œufs »), indiquer le **poids d'une pièce** (partie comestible) : sans lui, le calcul est impossible, aucun poids n'est inventé. Pour les volumes, la **masse volumique** est facultative (sinon 1 ml = 1 g, signalé « estimatif »).
5. Facultatif : **corriger** une valeur (prioritaire sur la source), ou **exclure** un ingrédient (eau de cuisson…).
6. **Poids après cuisson** : peser le plat cuit. Les valeurs « pour 100 g » utilisent alors ce poids comme dénominateur ; les apports des ingrédients sont conservés.

Les valeurs suivent l'ajustement des quantités (− / + d'un ingrédient, portions), toujours recalculées depuis les quantités d'origine.

## Fiabilité affichée

| Indicateur | Signification |
| --- | --- |
| **Calcul complet** | Tous les ingrédients comptés sont associés, convertis en poids et leurs quatre teneurs sont connues. Pour 100 g : poids cuit pesé. |
| **Calcul estimatif** | Approximation signalée : masse volumique supposée, teneur « traces » ou « < seuil » comptée pour 0, énergie déduite des kJ, poids cuit non pesé (calcul sur le poids cru) ou extrapolé après ajustement, pesée à refaire après modification de la recette. |
| **Données incomplètes** | Un ingrédient n'est pas associé, n'a pas de quantité chiffrée ou de poids, ou une teneur est inconnue. Les totaux sont alors précédés de « ≥ » : ce sont des minimums. |

Touchez l'indicateur pour voir les raisons, et **Détail par ingrédient** pour la contribution, le poids et la source de chaque ingrédient.

## Sources et licences

### CIQUAL 2025 (ANSES) — source principale

- Fichier officiel : *Table Ciqual 2025_FR_2025_11_03.xlsx* (https://ciqual.anses.fr/), 3 484 aliments.
- Licence Ouverte (Etalab). Mention obligatoire, affichée dans l'application : **« Anses. 2025. Table de composition nutritionnelle des aliments Ciqual »** — DOI 10.57745/RDMHWY.
- Converti par `npm run ciqual` (`scripts/build-ciqual.mjs`) en `src/data/ciqual-2025.json`, embarqué dans l'application (PWA et APK) : aucune requête réseau. L'empreinte SHA-256 du fichier source est conservée dans le catalogue.
- **Aucune valeur n'est modifiée.** Conventions officielles respectées (documentation § 3.2) : teneurs pour 100 g de partie comestible ; tiret = valeur inconnue (jamais assimilée à zéro) ; « traces » ; « < x » (inférieur au seuil).
- Colonnes retenues : énergie (règlement UE 1169/2011, kcal et kJ), protéines **N × 6,25** (même convention que l'énergie réglementaire et que les étiquettes, donc comparable aux produits Open Food Facts), glucides, lipides, fibres, sucres, acides gras saturés, sel.

### Open Food Facts — produits de marques

- API officielle, sans clé ni proxy : les fiches produit sont ouvertes à toutes les origines (CORS).
- Recherche : dans l'APK, moteur `search.openfoodfacts.org` (requête native) ; dans la PWA, `/cgi/search.pl` (le nouveau moteur refuse les navigateurs). En cas de saturation (erreur 503), **une seule** nouvelle tentative espacée, puis un message.
- Limites respectées : recherche uniquement sur demande (jamais à chaque lettre), au plus 8 recherches et 60 fiches par minute depuis l'appareil ; identification par User-Agent dans l'APK, paramètres `app_name`/`app_version` dans la PWA.
- Un produit choisi est relu par sa fiche complète (code-barres) pour garantir l'unité de référence (100 g ou 100 ml) ; il est ensuite conservé localement.
- `energy_100g` est en kJ : seules `energy-kcal_100g` et `energy-kj_100g` sont lues ; la conversion kJ → kcal (÷ 4,184) est signalée.
- Licence ODbL, © contributeurs Open Food Facts : attribution affichée avec les résultats.

Les données CIQUAL et Open Food Facts restent séparées : chaque référence garde sa source, son identifiant (code CIQUAL / code-barres) et sa version.

## Stockage, sauvegardes, synchronisation future

- Chaque ingrédient associé contient une **copie autonome** de la référence (source, identifiant, valeurs pour 100 g, version, poids d'une pièce, masse volumique, corrections) : la recette reste calculable hors ligne et lisible même si la source évolue.
- Tables locales : `foods` (aliments utilisés, favoris, produits en cache, aliments personnels) et `foodMemory` (nom d'ingrédient → aliment choisi), migration Dexie v3 sans perte.
- Sauvegarde ZIP v2 : recettes avec associations, corrections et poids cuits, aliments et mémoire. Les sauvegardes v1 restent restaurables.
- Préparation de la synchronisation familiale (NAS) : identifiants stables (`ciqual:9435`, `off:3760322501605`, `custom:…`), horodatages `updatedAt`, fusion « la plus récente l'emporte » déjà utilisée par la restauration ; la table CIQUAL n'a pas besoin d'être synchronisée (embarquée).

## Tests

`tests/unit/nutrition.test.ts` utilise les vraies données : catalogue CIQUAL généré depuis le fichier officiel, réponses réelles d'Open Food Facts enregistrées (`tests/fixtures`). Recette de référence : pancakes protéinés (œufs, skyr, flocons d'avoine, farine de sarrasin, whey isolate, lait), totaux vérifiés contre un calcul manuel. `LIVE_OFF=1 npx vitest run tests/unit/off-live.test.ts` vérifie l'API en direct.
