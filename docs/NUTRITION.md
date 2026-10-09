# Nutrition — CIQUAL 2025 et Open Food Facts

Mon Carnet calcule calories, protéines, glucides et lipides de chaque recette à partir de ses ingrédients, **pour 100 g**, **par portion** et **pour la recette entière**.

## Utilisation

**Saisissez la recette normalement : les valeurs se calculent toutes seules.** Aucune association n'est nécessaire, et une recette s'enregistre toujours, même si des valeurs manquent.

1. Chaque ingrédient est reconnu automatiquement (voir *Reconnaissance automatique*) et converti en poids : « 1 oignon » ≈ 110 g, « 2 œufs » ≈ 100 g, « 1 c. à soupe d'huile d'olive » ≈ 13,7 g. Ces poids usuels sont **toujours signalés comme des estimations**.
2. Un indicateur discret résume la fiabilité (« 4 vérifiés · 5 estimés · 1 manquant ») ; le toucher ouvre le **détail par ingrédient**.
3. Toucher un ingrédient ouvre sa fiche de correction, en un geste :
   - l'aliment reconnu, avec d'autres aliments proches à choisir d'un toucher ;
   - le poids d'une pièce (ou d'une cuillère), **facultatif** : le poids usuel est pré-rempli ;
   - **Retenir pour mes prochaines recettes** (activé par défaut) : la correspondance et le poids seront appliqués automatiquement aux autres recettes ;
   - **Recherche avancée** : CIQUAL, produits de marque Open Food Facts (nom, marque, code-barres), « Mes aliments », saisie d'étiquette, corrections de valeurs ;
   - **Ne pas compter cet ingrédient** (eau de cuisson, décoration…).
4. **Poids après cuisson** (« Poids cuit ») : peser le plat cuit. Les valeurs « pour 100 g » utilisent alors ce poids comme dénominateur ; sinon le calcul se fait sur le poids des ingrédients crus et il est signalé comme estimation.
5. Dans l'éditeur de recette, un **aperçu en direct** (recette entière et par portion) se met à jour pendant la saisie.

Les valeurs suivent l'ajustement des quantités (− / + d'un ingrédient, portions), toujours recalculées depuis les quantités d'origine.

## Reconnaissance automatique

Ordre de priorité pour chaque ingrédient :

1. l'aliment choisi pour cette recette (fiche de correction ou association d'une version précédente) ;
2. la préférence mémorisée pour ce nom d'ingrédient (« Retenir pour mes prochaines recettes ») ;
3. le **dictionnaire des ingrédients courants** (`src/nutrition/dictionary.ts`, ~180 entrées, codes CIQUAL 2025 vérifiés par les tests) : synonymes culinaires (« cassonade » → sucre roux, « maïzena » → fécule de maïs, « fleur de sel » → sel…) ;
4. une **recherche approchée** dans toute la table CIQUAL.

Normalisation : minuscules, accents, ligatures (œ), pluriels (« bananes », « œufs »), mots vides (« de », « d' »), précisions de préparation sans effet sur les valeurs (épluché, émincé, haché, râpé, frais, gros, petit…). Un mot qui change l'aliment (« farine **de châtaigne** », « pâte **brisée** ») empêche tout raccourci vers un autre aliment.

État : sans précision, l'aliment est cru (valeurs CIQUAL de la partie comestible) ; « carottes **cuites** » est cherché parmi les aliments cuits.

Garde-fous (aucune référence nutritionnellement différente choisie au hasard) :

- nom générique pour lequel une variante est supposée (« lait » → demi-écrémé, « chocolat » → noir 50 %, « huile » → tournesol, « poulet » → filet) : compté, mais signalé « variante courante supposée » ;
- recherche approchée : retenue seulement si l'aliment trouvé porte bien ce nom et si les autres candidats proches ont des teneurs voisines (± 15 % d'énergie, ± 25 % de chaque macronutriment) ; elle est alors signalée « incertaine » ;
- sinon (« fromage » : comté ou fromage frais ?), l'ingrédient est **à confirmer** : il n'est pas compté et le total est indiqué comme partiel ;
- herbes et épices sans quantité ou sans poids connu : apport négligeable, non comptées, et signalées.

## Poids usuels

Toujours des estimations, affichées comme telles, et remplacées par toute valeur saisie :

| Source | Exemples |
| --- | --- |
| Portions de référence USDA FoodData Central (domaine public) | oignon moyen 110 g ; œuf 50 g sans coquille (jaune 17 g, blanc 33 g) ; banane 118 g ; pomme 182 g ; tomate 123 g ; carotte 61 g ; gousse d'ail 3 g ; pincée 0,4 g |
| Masses volumiques déduites des poids USDA par cuillère | huile 0,91 g/ml (1 c. à soupe ≈ 13,7 g) ; farine 0,53 ; sucre 0,85 ; miel 1,42 ; lait 1,03 |
| Contenances usuelles en France | sachet de levure chimique 11 g ; sachet de sucre vanillé 7,5 g ; feuille de gélatine 2 g ; cube de bouillon 10 g ; pot de yaourt 125 g ; boîte de tomates 400 g ; rouleau de pâte 230 g ; baguette 250 g |
| Ordre de grandeur (faute de référence publiée) | crème épaisse 1 g/ml ; rouleau de pâte à pizza 260 g |

Poids usuel inconnu : l'ingrédient n'est pas compté, rien ne bloque, et le total est indiqué comme partiel. Une tasse est comptée 240 ml (signalé).

## Fiabilité affichée

Par ingrédient :

| Indicateur | Signification |
| --- | --- |
| **Vérifié** | Aliment sûr (choisi, mémorisé ou reconnu sans ambiguïté) et poids connu (grammes, ou poids saisi). |
| **Estimé** | Poids usuel, masse volumique usuelle, variante courante supposée, teneur « traces » comptée 0… |
| **Incertain** | Correspondance approchée dans la table CIQUAL. |
| **Manquant** | Non reconnu, à confirmer, quantité non chiffrée, poids inconnu ou teneur inconnue. |

Pour la recette :

| Indicateur | Signification |
| --- | --- |
| **Calcul vérifié** | Tous les ingrédients comptés sont vérifiés. Pour 100 g : poids cuit pesé. |
| **Estimation** | Au moins une estimation (poids usuel, correspondance approchée, poids cuit non pesé…). |
| **Partiel** | Au moins un ingrédient n'est pas compté ou une teneur est inconnue : les totaux sont précédés de « ≥ » (minimums). Jamais un résultat incomplet présenté comme exact. |

Touchez l'indicateur pour voir les raisons, et **Détail** pour la contribution, le poids, la source et l'origine (reconnu, votre choix, variante supposée…) de chaque ingrédient.

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

- Les correspondances automatiques sont recalculées à l'affichage (elles profitent des améliorations du dictionnaire) ; rien n'est écrit dans la recette tant que l'utilisateur ne valide pas une correction.
- Chaque ingrédient corrigé contient une **copie autonome** de la référence (source, identifiant, valeurs pour 100 g, version, poids d'une pièce, masse volumique, corrections) : la recette reste calculable hors ligne et lisible même si la source évolue.
- Tables locales : `foods` (aliments utilisés, favoris, produits en cache, aliments personnels) et `foodMemory` (nom d'ingrédient → aliment choisi), migration Dexie v3 sans perte.
- Sauvegarde ZIP v2 : recettes avec associations, corrections et poids cuits, aliments et mémoire. Les sauvegardes v1 restent restaurables.
- Préparation de la synchronisation familiale (NAS) : identifiants stables (`ciqual:9435`, `off:3760322501605`, `custom:…`), horodatages `updatedAt`, fusion « la plus récente l'emporte » déjà utilisée par la restauration ; la table CIQUAL n'a pas besoin d'être synchronisée (embarquée).

## Tests

`tests/unit/nutrition.test.ts` utilise les vraies données : catalogue CIQUAL généré depuis le fichier officiel, réponses réelles d'Open Food Facts enregistrées (`tests/fixtures`). Recette de référence : pancakes protéinés (œufs, skyr, flocons d'avoine, farine de sarrasin, whey isolate, lait), totaux vérifiés contre un calcul manuel. `tests/unit/autonutrition.test.ts` : « 1 oignon, 2 œufs, 150 g de farine, 1 cuillère à soupe d'huile d'olive » calculé sans aucune association (830,6 kcal), pièces / grammes / cuillères / millilitres, pluriels et accents, cru / cuit, ambiguïtés, assaisonnements, apprentissage. `LIVE_OFF=1 npx vitest run tests/unit/off-live.test.ts` vérifie l'API en direct.
