# Mon Carnet sur Android (APK)

L'application Android est la même que la PWA, emballée avec Capacitor 8 : mêmes écrans, mêmes données, même format de sauvegarde. Elle est compilée automatiquement par GitHub Actions à chaque envoi sur `master` : aucun Android Studio n'est nécessaire.

## Récupérer et installer l'APK depuis le téléphone

1. Sur le téléphone, ouvrir **https://github.com/Kabot83/moncarnet/releases/tag/android**.
2. Dans « Assets », toucher **MonCarnet-1.0.0-….apk**. Le téléchargement démarre.
3. Ouvrir le fichier téléchargé. La première fois, Android demande d'autoriser l'installation depuis ce navigateur : **Paramètres → Autoriser depuis cette source**, puis revenir et toucher **Installer**.
4. Samsung peut afficher un avertissement Play Protect (« application inconnue ») : choisir **Plus de détails → Installer quand même**. C'est normal pour une application personnelle hors Play Store.

Les versions suivantes s'installent de la même façon, **par-dessus** la précédente : le carnet est conservé.

Autre voie : onglet **Actions** du dépôt → dernière exécution « APK Android » → section **Artifacts** (ZIP contenant l'APK release et un APK « debug » de diagnostic, qu'il ne faut pas installer).

## Transférer son carnet de la PWA vers l'APK

L'APK a son propre stockage : elle ne voit pas les données de la PWA, et réciproquement. Rien n'est supprimé ni modifié dans la PWA.

1. Dans la **PWA** : Réglages → Sauvegarde → **Sauvegarder mon carnet**. Le fichier `mon-carnet-AAAA-MM-JJ-HHMM.zip` arrive dans Téléchargements.
2. Installer et ouvrir l'**APK** (elle contient d'abord les 6 recettes de démonstration).
3. Dans l'APK : Réglages → Sauvegarde → **Restaurer mon carnet** → choisir le fichier ZIP → vérifier l'aperçu.
4. Choisir **Tout remplacer** (le carnet devient identique à celui de la PWA, démonstrations comprises si elles y étaient) ou **Fusionner**.
5. Le Chef IA : la clé API ou le jeton du proxy ne sont **jamais** dans la sauvegarde, il faut les ressaisir dans l'APK.

Ce transfert est vérifié par un test automatique (`tests/unit/migration-apk.test.ts`) : recettes, ingrédients, étapes, notes, photos (à l'octet près), journal, collections, liste de courses, conversations, profil et préférences sont restaurés à l'identique.

## Ce qui change dans l'APK

| | PWA | APK |
| --- | --- | --- |
| Hors ligne | Service worker | Fichiers embarqués (pas de service worker) |
| Sauvegarde ZIP | Téléchargements | Documents/MonCarnet + partage (Drive, e-mail…) |
| Minuteries | Alerte quand l'app est ouverte | Notification Android programmée, même écran éteint ou app fermée |
| Écran allumé en cuisine | Wake Lock du navigateur | Natif, fiable |
| Import par lien | Proxy nécessaire (CORS) | Direct, sans proxy (robots.txt respecté) |
| Bouton Retour | Historique du navigateur | Ferme les panneaux, puis met l'app en arrière-plan |
| Partage d'un lien vers l'app | Oui | Pas encore |

Le Chef IA fonctionne de la même façon. Avec le proxy, ajouter `https://localhost` à `ALLOWED_ORIGINS` dans `proxy/wrangler.toml` (c'est l'origine de l'APK).

## APK debug ou release ?

- **Debug** : signé avec une clé de débogage jetable, générée par la machine de compilation. Utile au diagnostic, mais deux APK debug compilés à des moments différents peuvent avoir des signatures différentes : Android refuse alors la mise à jour et impose une désinstallation (qui efface le carnet). Il n'est plus publié, seulement conservé dans les artefacts.
- **Release** : signé avec **la clé permanente de Mon Carnet**. Toutes les versions portent la même signature et s'installent par-dessus les précédentes, données conservées. C'est la version publiée.

À chaque compilation, la CI vérifie que l'APK release porte bien l'empreinte de la clé permanente (`8025cb7c…df527639`) et que son numéro de version augmente ; sinon elle échoue au lieu de publier un APK impossible à installer en mise à jour.

## Passage de l'APK de test à la version définitive (une seule fois)

L'APK de test installé avant octobre 2026 est signé avec une autre clé : Android refusera d'installer la version définitive par-dessus (« Conflit avec un package existant »).

1. Dans l'APK de test : Réglages → Sauvegarde → **Sauvegarder mon carnet** (le fichier va dans Documents/MonCarnet).
2. Désinstaller l'APK de test (appui long sur l'icône → Désinstaller).
3. Installer l'APK définitif depuis la page « android ».
4. Réglages → Sauvegarde → **Restaurer mon carnet** → choisir le fichier → **Tout remplacer**.

Ensuite, plus jamais de désinstallation : chaque nouvelle version s'installe par-dessus.

## Mises à jour sans perte de données

Une mise à jour conserve le carnet si et seulement si :

1. **même identifiant** `fr.kabot83.moncarnet` (fixé, ne jamais le changer) ;
2. **même signature** : la clé permanente (vérifiée automatiquement par la CI) ;
3. **versionCode supérieur** : calculé automatiquement (minutes écoulées depuis le 1er janvier 2026) et vérifié par la CI ;
4. **même origine web** `https://localhost` (fixée dans `capacitor.config.ts` : IndexedDB y est rattaché ; ne jamais modifier `hostname` ni `androidScheme`).

Les évolutions de la base passent par les migrations Dexie (`src/db/db.ts`), appliquées automatiquement au premier lancement de la nouvelle version.

## La clé permanente

Elle a été générée sur le PC (RSA 4096 bits, certificat valable 100 ans) et se trouve dans **`Documents\MonCarnet-signature`** :

- `moncarnet-release.p12` : la clé (format PKCS#12) ;
- `A-CONSERVER-mots-de-passe.txt` : alias, mot de passe et empreinte.

Elle est aussi enregistrée, **chiffrée**, dans les secrets GitHub Actions du dépôt (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`). GitHub ne permet jamais de relire un secret : **la copie du PC est la seule récupérable**.

Pour la conserver :

1. Copier le mot de passe du fichier texte dans un gestionnaire de mots de passe (Bitwarden, Samsung Pass, etc.).
2. Copier `moncarnet-release.p12` sur au moins un support hors du PC (clé USB rangée, coffre-fort numérique chiffré). Le fichier seul est inutilisable sans le mot de passe.
3. Supprimer ensuite le fichier texte du PC.
4. Ne jamais déposer ces fichiers sur GitHub, dans un e-mail ou une messagerie non chiffrée.

Si la clé était perdue, l'application continuerait de fonctionner, mais les mises à jour imposeraient une désinstallation (donc une restauration depuis une sauvegarde ZIP).

## Développement

```bash
npm run android:sync
```

Compile la variante Android (`vite build --mode android`, sans service worker) et copie les fichiers dans `android/`. `npm run android:icons` régénère icônes et écrans de lancement depuis le logo. La compilation de l'APK elle-même se fait dans GitHub Actions (`.github/workflows/android.yml`).
