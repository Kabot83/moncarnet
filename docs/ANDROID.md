# Mon Carnet sur Android (APK)

L'application Android est la même que la PWA, emballée avec Capacitor 8 : mêmes écrans, mêmes données, même format de sauvegarde. Elle est compilée automatiquement par GitHub Actions à chaque envoi sur `master` : aucun Android Studio n'est nécessaire.

## Récupérer et installer l'APK depuis le téléphone

1. Sur le téléphone, ouvrir **https://github.com/Kabot83/moncarnet/releases/tag/android-test**.
2. Dans « Assets », toucher **MonCarnet-…-test.apk** (ou **MonCarnet-….apk** sans « test » quand la clé permanente sera en place). Le téléchargement démarre.
3. Ouvrir le fichier téléchargé. La première fois, Android demande d'autoriser l'installation depuis ce navigateur : **Paramètres → Autoriser depuis cette source**, puis revenir et toucher **Installer**.
4. Samsung peut afficher un avertissement Play Protect (« application inconnue ») : choisir **Plus de détails → Installer quand même**. C'est normal pour une application personnelle hors Play Store.

Autre voie : onglet **Actions** du dépôt → dernière exécution « APK Android » → section **Artifacts**. L'artefact est un ZIP contenant l'APK (il faut être connecté à GitHub et décompresser avec « Mes fichiers »).

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

- **Debug (« -test.apk »)** : signé avec une clé de débogage générée par GitHub. Parfait pour essayer. Cette clé est conservée dans le cache de GitHub Actions, mais **le cache est effacé après 7 jours sans compilation**. Une nouvelle clé produit une signature différente : Android refuse alors d'installer la mise à jour par-dessus (« conflit avec un package existant »), et il faut désinstaller, ce qui **efface le carnet de l'APK**.
- **Release** : signé avec **votre clé permanente**. Toutes les versions futures portent la même signature et s'installent par-dessus les précédentes, données conservées. C'est la voie à suivre pour un usage quotidien.

Tant que la clé permanente n'existe pas : **faire une sauvegarde ZIP avant chaque nouvelle installation**.

## Mises à jour sans perte de données

Une mise à jour conserve le carnet si et seulement si :

1. **même identifiant** `fr.kabot83.moncarnet` (fixé, ne jamais le changer) ;
2. **même signature** (d'où la clé permanente) ;
3. **versionCode supérieur** : calculé automatiquement par la CI (minutes écoulées depuis le 1er janvier 2026), donc toujours croissant ;
4. **même origine web** `https://localhost` (fixée dans `capacitor.config.ts` : IndexedDB y est rattaché ; ne jamais modifier `hostname` ni `androidScheme`).

Les évolutions de la base passent par les migrations Dexie (`src/db/db.ts`), appliquées automatiquement au premier lancement de la nouvelle version.

## Créer la clé permanente (à faire une seule fois, avec votre accord)

La clé est un fichier `.jks` protégé par un mot de passe. **Si elle est perdue, plus aucune mise à jour n'est possible sans réinstallation** : la conserver précieusement (gestionnaire de mots de passe + copie hors ligne). Elle ne doit **jamais** être envoyée dans le dépôt.

1. Générer la clé (Java 17+ requis, une fois) :

   ```bash
   keytool -genkeypair -v -keystore moncarnet-release.jks -alias moncarnet -keyalg RSA -keysize 4096 -validity 36500
   ```

2. Encoder le fichier pour GitHub :

   ```bash
   base64 -w0 moncarnet-release.jks > moncarnet-release.b64
   ```

3. Sur GitHub : **Settings → Secrets and variables → Actions → New repository secret**, créer :
   - `ANDROID_KEYSTORE_BASE64` : contenu de `moncarnet-release.b64` ;
   - `ANDROID_KEYSTORE_PASSWORD` : mot de passe du fichier ;
   - `ANDROID_KEY_ALIAS` : `moncarnet` ;
   - `ANDROID_KEY_PASSWORD` : mot de passe de la clé.
4. Supprimer `moncarnet-release.b64`. Relancer le workflow (Actions → APK Android → Run workflow) : un `MonCarnet-….apk` signé apparaît à côté de l'APK de test.
5. Passage debug → release : les signatures diffèrent, il faut **une dernière fois** sauvegarder le carnet, désinstaller l'APK de test, installer l'APK release, restaurer.

## Développement

```bash
npm run android:sync
```

Compile la variante Android (`vite build --mode android`, sans service worker) et copie les fichiers dans `android/`. `npm run android:icons` régénère icônes et écrans de lancement depuis le logo. La compilation de l'APK elle-même se fait dans GitHub Actions (`.github/workflows/android.yml`).
