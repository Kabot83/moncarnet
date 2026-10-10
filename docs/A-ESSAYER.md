# « À essayer » — TikTok et Instagram

Enregistrer en quelques secondes une recette vue sur TikTok ou Instagram, la retrouver dans **Mes recettes → À essayer**, puis la transformer en vraie fiche Mon Carnet.

## Utilisation

- **Depuis l'application Android** : dans TikTok, Instagram (reel ou publication) ou Chrome, touchez **Partager → Mon Carnet**. Mon Carnet s'ouvre sur la fiche, déjà enregistrée ; **Retour à TikTok** (ou Instagram, Chrome) vous ramène à la vidéo.
- **Importer un lien** (APK et PWA) : *Mes recettes → À essayer → Importer un lien*, ou bouton **+ → Depuis TikTok ou Instagram*. Même comportement que le partage.
- **PWA installée** : la cible de partage du manifeste fonctionne aussi (Android Chrome).

L'enregistrement est **immédiat et local** : il n'attend ni TikTok, ni Instagram, ni le Chef IA, et fonctionne hors connexion. Aucun champ n'est obligatoire.

## Liens reconnus

| Plateforme | Formats |
| --- | --- |
| TikTok | `tiktok.com/@auteur/video/ID`, `…/photo/ID`, `www.` / `m.tiktok.com/v/ID.html`, liens courts `vm.tiktok.com/…`, `vt.tiktok.com/…`, `tiktok.com/t/…` |
| Instagram | `instagram.com/reel/CODE`, `/reels/`, `/p/`, `/tv/`, avec ou sans pseudo, `instagr.am`, liens de partage `instagram.com/share/…` |

- Les paramètres de suivi (`?is_from_webapp=…`, `?igsh=…`, `utm_*`) sont retirés ; l'identifiant n'est jamais modifié. Le lien reçu et le lien nettoyé (canonique quand l'identifiant est connu) sont tous deux conservés.
- **Doublons** : une même publication (même vidéo, même code Instagram, quel que soit le lien) n'est enregistrée qu'une fois. Un lien court résolu plus tard vers une publication déjà présente est **fusionné** dans la fiche existante (notes, tags, favori et statut conservés).
- Un partage peut contenir du texte et plusieurs liens : chaque publication est enregistrée ; un lien d'un autre site ouvre l'import de recette habituel ; un texte seul ouvre l'import par texte.

## Informations récupérées (voies officielles uniquement)

| | TikTok | Instagram |
| --- | --- | --- |
| Source | API **oEmbed** officielle (`tiktok.com/oembed`), sans compte ni clé | oEmbed officiel (`graph.facebook.com/instagram_oembed`) |
| Titre / légende | ✓ (légende publiée) | ✗ — non fourni sans compte développeur Meta |
| Auteur | ✓ | seulement s'il figure dans le texte de l'intégration |
| Miniature | ✓, **copiée localement** (le lien de TikTok expire en quelques jours) | ✗ |
| Identifiant | ✓ (liens courts résolus) | ✓ (présent dans le lien) |
| Lecteur intégré | lecteur officiel `tiktok.com/player/v1/ID` | intégration officielle `…/embed/captioned/` |
| Publication privée / supprimée | signalée (« privée, supprimée ou introuvable ») | signalée de même |

- Aucune vidéo n'est téléchargée, aucune page n'est « aspirée », aucune connexion à TikTok / Instagram n'est demandée, aucune restriction n'est contournée.
- Le HTML renvoyé par les oEmbed n'est **jamais inséré** dans l'application : seul le texte d'un champ précis peut être lu, après analyse inerte (DOMParser).
- Le lecteur n'est chargé qu'à la demande (bouton « Lire la vidéo ici ») et nécessite Internet ; le reste de la fiche est consultable hors ligne, même si la vidéo disparaît.
- Liens courts : dans l'APK, la redirection publique est suivie (comme un navigateur). Dans la PWA, les navigateurs l'interdisent : l'oEmbed est tenté avec le lien court ; à défaut, le lien est conservé et s'ouvre normalement.
- Hors ligne ou service injoignable : nouvel essai automatique au retour du réseau. **Les champs corrigés à la main (titre, description, auteur) ne sont jamais écrasés.**

## Bibliothèque et fiche

- Cartes (miniature, titre, plateforme, auteur, date, favori), recherche (titre, auteur, notes, tags, texte partagé), filtres TikTok / Instagram / favoris, statuts **À essayer / Testée / Recette créée**.
- Fiche : titre modifiable, miniature, lecteur, « Voir sur TikTok / Instagram » (ouvre l'application si elle est installée), description, texte reçu avec le partage, notes, tags, date d'ajout, lien vers la recette créée.
- Accueil : rangée « À essayer ». Navigation : onglet de « Mes recettes » (la barre inférieure n'est pas alourdie).

## Transformer en recette

1. **Créer la fiche** (sans IA) : titre, miniature, source et lien repris ; ingrédients et étapes extraits **seulement s'ils sont écrits** dans le texte (listes, lignes avec quantités, étapes numérotées). Les quantités absentes restent vides et sont signalées.
2. **Extraire avec le Chef IA** (facultatif, si configuré) : écran de consentement montrant **exactement** le texte envoyé (titre + texte de la publication) ; ni la vidéo, ni l'image, ni les notes. Consigne : retranscrire sans rien inventer et signaler les manques.
3. La fiche s'ouvre dans l'éditeur habituel (avertissements « À vérifier »), puis s'enregistre comme toute recette : nutrition automatique CIQUAL / Open Food Facts, ajustement des quantités, etc. Elle garde le lien vers sa publication ; la publication passe à « Recette créée ».

Instagram ne transmettant pas la légende, on peut la copier depuis Instagram et la coller dans « Texte de la publication » : elle est alors conservée dans la fiche. La vidéo elle-même (son, images) n'est jamais analysée.

## Données, sauvegardes, synchronisation future

- Table Dexie `posts` (migration v4, aucune donnée existante modifiée) ; champ `sourcePostId` sur les recettes.
- Sauvegarde ZIP **v3** : publications, notes, tags, statuts, miniatures (avec les photos). Les sauvegardes v1 / v2 restent restaurables. Fusion : même publication (identifiant ou clé d'unicité) → la plus récente l'emporte, sans doublon.
- Préparé pour la synchronisation familiale (NAS) : identifiants stables, `updatedAt`, clé d'unicité `dedupeKey`, champs corrigés à la main (`edited`).

## Android : fonctionnement natif

- `AndroidManifest.xml` : filtre `ACTION_SEND` + `text/plain` sur l'activité principale (`singleTask`).
- `ShareReceiverPlugin.java` : chaque partage est écrit dans une **file persistante** (écriture synchrone) avant toute autre étape ; l'interface le lit, l'enregistre dans sa base, puis seulement le retire de la file. Application fermée, en démarrage ou déjà ouverte (`onNewIntent`) : aucun partage perdu. La file est relue au lancement, à chaque partage et au retour dans l'application.
- Méthodes : `getPending`, `ack`, `moveToBack` (retour à l'application d'origine), `openExternal` (ouvrir la publication dans TikTok / Instagram).

## Tests

- `tests/unit/social.test.ts` : formats de liens, paramètres de suivi, liens courts, liens invalides, partage multi-liens, oEmbed TikTok et Instagram (réponses réelles enregistrées dans `tests/fixtures`), privé / supprimé, hors ligne, serveur injoignable, corrections préservées, doublons et fusion, extraction locale, conversion, sauvegarde.
- `tests/unit/db-migration.test.ts` : migration v3 → v4 sans perte (recettes, associations nutritionnelles, mémoire).
- `tests/unit/android.test.ts` : configuration native du partage.
- `tests/e2e/a-essayer.spec.ts` : import d'un lien, cible de partage PWA, doublon, lien invalide, hors ligne puis retour du réseau, transformation en recette, navigation.

### À vérifier sur le téléphone (non testable sans appareil Android)

1. Installer l'APK par-dessus la version actuelle. Vérifier que recettes et valeurs nutritionnelles sont intactes.
2. **TikTok** : une vidéo de recette → Partager → (Plus / Autres applications si besoin) → **Mon Carnet**. La fiche s'ouvre avec « Enregistrée », titre et miniature arrivent en 1 à 2 secondes. Toucher **Retour à TikTok**.
3. Recommencer avec la **même vidéo** : « Déjà dans « À essayer » », aucun doublon.
4. **Instagram** : un **Reel**, puis une **publication** → Partager → Mon Carnet (lien seul, sans miniature : c'est normal).
5. **Chrome** : une page TikTok ou une page de recette → Partager → Mon Carnet (page de recette → import de recette habituel).
6. **Mon Carnet fermé** (balayé des applications récentes) puis partage : la fiche doit s'ouvrir quand même.
7. **Mode avion** : partager une vidéo → enregistrée ; réactiver le réseau → les informations arrivent.
8. Une vidéo **privée ou supprimée** (si vous en avez une) : message clair, lien conservé.
9. Fiche → **Lire la vidéo ici**, **Voir sur TikTok** (ouvre l'application TikTok), **Transformer en recette** → enregistrer.
10. Réglages → Sauvegarde → exporter, puis restaurer (fusion) : publications toujours là, sans doublon.
