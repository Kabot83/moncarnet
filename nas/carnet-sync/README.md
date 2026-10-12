# Carnet Sync — synchronisation privée de Mon Carnet

Service distinct de Carnet Media. Chaque personne a **son propre carnet** ; il n'y a ni catalogue
familial ni fonction sociale. La seule interaction entre comptes est l'**envoi d'une recette par
copie**, acceptée explicitement par le destinataire.

> **Statut : étape B (préparation).** Le service est testé sur PC et dans GitHub Actions. Il n'est
> pas encore installé sur le NAS, et l'application Android n'est pas modifiée.

## 1. Principes

| Exigence | Réalisation |
|---|---|
| Confidentialité | Le propriétaire de chaque donnée est **déduit de la session** côté serveur ; aucun identifiant de propriétaire n'est lu dans une requête. Chaque requête SQL est filtrée par `owner_id` et les fichiers sont rangés par compte. |
| Aucune perte | Dexie reste la base de l'application et le serveur n'en est qu'une copie. Les conflits ne s'écrasent jamais en silence. Seules les suppressions **volontaires** sont transmises. |
| Hors ligne | L'application ne dépend jamais du serveur ; les modifications sont envoyées au retour du réseau. |
| Envoi par copie | Le contenu est figé à l'envoi. Une copie indépendante est créée à l'acceptation, avec ses fichiers et des identifiants déterministes, sans doublon possible. |
| Simplicité | Un conteneur, une base SQLite et un dossier partagé. Prévu pour 3 à 4 comptes ; un seul compte au départ. |

## 2. Données (SQLite, `data/carnet-sync.sqlite3`, mode WAL)

- **`users`** : comptes, mots de passe hachés en **Argon2id**.
- **`account_invites`** : codes d'invitation à usage unique, valables 7 jours. Il n'y a **aucune inscription publique**.
- **`sessions`** : une par appareil. Elle associe :
  - un jeton d'accès `mca_…` valable 1 h ;
  - un jeton de renouvellement `mcr_…` valable 90 jours, remplacé à chaque usage. Si un ancien jeton est réutilisé, la session est révoquée.
- **`login_failures`** : 5 échecs par identifiant ou 20 par adresse en 15 min entraînent une attente.
- **`records(owner_id, collection, id, rev, deleted, data)`** : un enregistrement Dexie par ligne.
  - `rev` est un compteur croissant qui sert de curseur de synchronisation.
  - Une suppression est conservée comme « pierre tombale ».
- **`blobs(owner_id, sha256)`** : photos adressées par leur contenu, **par compte**.
- **`transfers`** : envois de recettes. L'expéditeur et le destinataire sont fixés par le serveur. Le contenu, les fichiers et le format de la miniature sont figés à l'envoi. Les invitations expirent au bout de 30 jours.

Collections synchronisées (liste fermée) :
- `recipes`
- `photos`
- `journal`
- `collections`
- `shopping`
- `posts`
- `foods`
- `foodMemory`

Ne sont jamais synchronisés :
- réglages ;
- secrets ;
- minuteurs ;
- sessions de cuisine ;
- brouillons ;
- conversations ;
- vidéo locale des publications et état de son téléchargement.

## 3. Synchronisation (application : `src/sync/engine.ts`)

**Détection des modifications.** L'application garde, pour chaque enregistrement, la révision du
serveur et l'empreinte du contenu synchronisé, dans une base annexe `<base>~sync`. Le schéma Dexie
1.4.1 n'est pas modifié. Tout ce qui a changé est envoyé ; cela tient lieu de file d'attente
persistante, qui ne rate aucune modification et survit aux redémarrages comme aux coupures.

**Suppressions volontaires et pertes accidentelles.**

- `trackDeletions(db)` est branché dès l'ouverture de la base. Chaque suppression **faite par
  l'application et validée** laisse une trace, et seules ces suppressions sont transmises.
- Un élément disparu **sans trace** est considéré comme perdu, que la perte d'IndexedDB soit
  partielle ou totale ou que le système ait effacé les données. Il est **re-téléchargé**, et rien
  n'est supprimé sur le serveur.
- Un `clear()` (restauration, import « remplacer ») n'est pas une suppression volontaire.
- Si l'application s'arrête entre la suppression et sa trace, l'élément revient. C'est le sens sûr.
- **Photos.** Les suppressions de photos sont envoyées en dernier, et **le serveur refuse de
  supprimer une photo encore utilisée** par une recette, une publication ou le journal. Cela couvre
  le cas « recette perdue, puis nettoyage automatique des photos orphelines » : tout revient.

**Conflits.** Il n'y a jamais d'écrasement silencieux : le serveur refuse toute modification basée
sur une version périmée.

| Cas | Règle |
|---|---|
| Recette, journal, publication | La version du serveur garde l'identifiant. Celle de l'appareil est conservée en copie « (conflit — téléphone 2) ». |
| Collection | Union des recettes |
| Courses, aliments, mémoire, photos | La plus récente gagne. La perdante est inscrite dans le journal des conflits. |
| Modifié ici, supprimé ailleurs | La modification l'emporte. |
| Supprimé ici, modifié ailleurs | La version modifiée est restaurée. |

**Données de démonstration.** Elles ne sont jamais synchronisées sans accord.

## 4. Comptes sur un même téléphone (`src/sync/account.ts`)

| Situation | Base locale |
|---|---|
| Sans compte (comme en 1.4.1) | `mon-carnet`, inchangée |
| Premier compte | Reprend `mon-carnet`, après résumé et accord ; rien n'est déplacé. |
| Autre compte | `mon-carnet@<compte>`, séparée |
| Déconnexion | Rien n'est effacé. L'application ouvre `mon-carnet~hors-compte`, une base vide. |

**Verrou supplémentaire.**
- Chaque base locale est **liée à un compte** par `bindToAccount()`, appelé après l'accord de
  migration.
- Avant tout échange, le moteur vérifie que le compte de la session est bien celui de la base.
- Sinon, il refuse : les données d'une personne ne peuvent pas partir dans le compte d'une autre,
  même en cas d'erreur de l'application.
- Sans liaison, rien n'est synchronisé.

**Jetons.** À l'étape C, ils seront chiffrés par l'Android Keystore, avec une clé distincte de
Carnet Media. Ils ne seront jamais stockés dans IndexedDB ni dans les sauvegardes.

## 5. Migration des données 1.4.1

1. L'application affiche un résumé, par exemple « 42 recettes, 120 photos… ». Les données de
   démonstration sont comptées à part.
2. Vous confirmez ; c'est à ce moment que la base est liée au compte.
3. La synchronisation reprend où elle s'était arrêtée, sans doublon.
4. `verify()` compare chaque élément local au serveur, photos comprises.
5. Les données locales et les copies de sécurité 1.4.1 ne sont jamais supprimées.

## 6. Envoi d'une recette

**Recherche du destinataire.** Elle se fait par identifiant **exact**, sans liste ; le nom affiché
sert de confirmation.

**Lecture de la recette.** Le serveur lit la recette dans l'espace synchronisé de l'expéditeur. Il
est donc impossible d'envoyer la recette de quelqu'un d'autre ou de se faire passer pour un autre
expéditeur.

**Ce qui est transmis :**
- titre et description ;
- catégorie et étiquettes ;
- temps et nombre de parts ;
- difficulté ;
- source ;
- ingrédients, avec leurs quantités et leur nutrition ;
- étapes ;
- photos ;
- astuces, seulement si vous cochez la case.

**Ce qui n'est jamais transmis :**
- les autres notes ;
- le journal ;
- les favoris, notes et réalisations ;
- les collections ;
- les informations de compte.

**Une copie figée.** Le contenu est figé à l'envoi. Si l'original est modifié ou supprimé ensuite,
la copie reçue ne change pas.

**Réception.** Le destinataire choisit « Ajouter à mon carnet » ou « Refuser ». L'invitation
l'attend 30 jours, même s'il est hors ligne. S'il accepte :
- une copie indépendante est créée dans **son** espace, avec la mention « Reçue de … » ;
- une seconde acceptation ne crée pas de doublon.

**Publications TikTok et Instagram.** Seuls le lien et les métadonnées sont transmis, jamais le MP4.
Si le destinataire utilise Carnet Media, la vidéo est servie par la bibliothèque du NAS, sans
nouveau téléchargement.

## 7. Sauvegardes (distinctes de la synchronisation)

**Fonctionnement automatique.** Chaque nuit à 03:15, dans `backups/carnet-sync-AAAAMMJJ-HHMMSS/` :
- **la base** est copiée par l'**API de sauvegarde SQLite**. Cet instantané est cohérent, y
  compris en mode WAL, et le service n'est pas arrêté ;
- **les photos** sont sauvegardées : exactement celles que référence cet instantané, plus les
  fichiers des invitations en attente ;
- **l'espace disque** n'est pas multiplié : une photo inchangée est reliée par lien physique à la
  version précédente, ce qui garde chaque version complète ;
- **un manifeste SHA-256** liste chaque fichier. Tout est relu et contrôlé avant que la sauvegarde
  ne devienne visible : une sauvegarde visible est toujours complète.

**Historique.** Le service garde les 14 dernières nuits, plus une version par semaine sur 8
semaines. Hyper Backup en conserve d'autres sur un autre support.

**Suivi.** Le résultat est écrit dans `backups/etat.json` et dans le journal du conteneur.

**Commandes, depuis le terminal du conteneur :**

| Commande | Effet |
|---|---|
| `python -m app.admin backup` | Sauvegarde immédiate |
| `python -m app.admin status` | Dernier résultat et versions disponibles |
| `python -m app.admin check --full` | Cohérence de la base et des fichiers photos (empreintes relues) |
| `python -m app.admin verify <dossier>` | Relit une sauvegarde |
| `python -m app.admin restore-test <dossier>` | **Restauration à blanc** : restaure dans un dossier temporaire, contrôle, efface. Rien n'est modifié. |
| `python -m app.admin restore <dossier>` | Vérifie la sauvegarde puis programme sa restauration. Elle s'applique au **redémarrage** du conteneur. L'ancienne base est conservée dans `data-avant-restauration-…`, jamais effacée. En cas d'échec, l'ancienne base est remise en place. |

## 8. Installation sur le DS920+ (DSM 7.4.1) — réseau local d'abord

Rien n'est modifié pour Carnet Media, son port 8444 ni son dossier. Aucun port n'est ouvert sur la
Freebox à cette étape.

### Étape 1 — Compte technique dédié

**Panneau de configuration → Utilisateur et groupe → Utilisateur → Créer.**

1. Renseignez le compte :
   - Nom : `carnet-sync`
   - Description : `Compte technique Carnet Sync (aucune connexion)`
   - Mot de passe : une longue suite aléatoire. Vous n'en aurez jamais besoin.
   - Cochez « Ne pas autoriser l'utilisateur à modifier le mot de passe du compte ».
2. Groupe : `users` uniquement.
3. Autorisations des dossiers partagés : **Pas d'accès** partout.
4. Applications : **Refuser** pour toutes (DSM, File Station, SMB, FTP…).
5. Terminé.

### Étape 2 — Dossier partagé distinct

**Panneau de configuration → Dossier partagé → Créer.**

1. Renseignez le dossier :
   - Nom : `carnet-sync`
   - Emplacement : Volume 1
   - Cochez « Masquer ce dossier partagé dans "Mes emplacements réseau" ».
   - Décochez la corbeille.
2. Chiffrement : non.
3. Paramètres avancés : cochez « Activer la somme de contrôle des données pour une intégrité avancée ».
4. Autorisations :
   - `carnet-sync` : **Lecture/Écriture** ;
   - votre compte administrateur : **Lecture/Écriture**, pour consulter les sauvegardes ;
   - tous les autres : aucun accès.

Les sous-dossiers `data` et `backups` sont créés automatiquement par le service.

### Étape 3 — Numéro (UID) du compte technique, sans SSH

1. **Panneau de configuration → Planificateur de tâches → Créer → Tâche planifiée → Script défini
   par l'utilisateur.**
   - Général :
     - Nom : `UID carnet-sync`
     - Utilisateur : `root`
     - **Décochez « Activé »**.
   - Paramètres de tâche, Script : `id carnet-sync > /volume1/carnet-sync/uid.txt`
2. Sélectionnez la tâche → **Exécuter**.
3. Dans File Station, ouvrez `carnet-sync/uid.txt`. Il contient par exemple
   `uid=1030(carnet-sync) gid=100(users)`. **Notez le premier nombre.**
4. Supprimez la tâche et le fichier `uid.txt`.

### Étape 4 — Projet Container Manager

**Container Manager → Projet → Créer.**

1. Renseignez le projet :
   - Nom : `carnet-sync`
   - Chemin : `/carnet-sync`
   - Source : « Créer docker-compose.yml »
2. Collez le contenu de `docker-compose.yml`, en remplaçant **`1030`** par l'UID noté à
   l'étape 3 (gardez `:100`).
3. Suivant. Ne configurez **pas** de portail Web Station.
4. Terminé : l'image `ghcr.io/kabot83/carnet-sync:0.1.0` est téléchargée et le conteneur démarre.
5. **Conteneur → carnet-sync → Journal** doit afficher :
   - `Carnet Sync 0.1.0`
   - `Sauvegarde nocturne programmée à 03:15`

### Étape 5 — Votre compte, en mode interactif

Ouvrez DSM en **HTTPS** (port 5001) pour cette étape.

**Container Manager → Conteneur → `carnet-sync` → Action → Ouvrir le terminal → Créer.**
Dans le terminal qui s'ouvre :

1. Créez votre compte :

   ```
   python -m app.admin setup
   ```

   Saisissez votre identifiant, votre nom affiché, puis votre mot de passe deux fois. Il fait
   **au moins 10 caractères** ; une phrase est idéale. Rien ne s'affiche pendant la saisie, et il
   n'est ni affiché, ni enregistré en clair, ni journalisé.
2. Essayez la connexion :

   ```
   python -m app.admin selftest
   ```

   La commande vérifie le service et le refus sans session. Elle vous connecte, lit le carnet, puis
   ferme la session d'essai.
3. Faites une première sauvegarde, puis une restauration à blanc :

   ```
   python -m app.admin backup
   python -m app.admin status
   python -m app.admin restore-test /srv/carnet/backups/<nom affiché par status>
   ```

### Étape 6 — Accès HTTPS par le reverse proxy (port 8445)

1. **Panneau de configuration → Portail de connexion → Avancé → Proxy inversé → Créer.**
   - Nom : `Carnet Sync`
   - Source :
     - Protocole : HTTPS
     - Nom d'hôte : `carnetmedia.synology.me`
     - Port : **8445**
   - Destination :
     - Protocole : HTTP
     - Nom d'hôte : `localhost`
     - Port : **8090**
   - Ne touchez pas à la règle existante de Carnet Media (8444).
2. **Panneau de configuration → Sécurité → Certificat → Paramètres.** Pour le service
   `carnetmedia.synology.me:8445`, choisissez le certificat Let's Encrypt `carnetmedia.synology.me`
   existant.
3. Si le pare-feu DSM est activé, autorisez le port 8445 **depuis le réseau local seulement**.
4. Sur la **Freebox** : rien pour l'instant.

### Étape 7 — Test sur le réseau local, depuis un PC Windows de la maison

Dans PowerShell, en remplaçant `192.168.1.20` par l'adresse locale du NAS :

```
curl.exe --resolve carnetmedia.synology.me:8445:192.168.1.20 https://carnetmedia.synology.me:8445/v1/health
```

Résultat attendu : `{"status":"ok","service":"carnet-sync"}`, sans avertissement de certificat.

```
curl.exe -s -o NUL -w "%{http_code}`n" --resolve carnetmedia.synology.me:8445:192.168.1.20 https://carnetmedia.synology.me:8445/v1/sync/changes
```

Résultat attendu : `401`, c'est-à-dire accès refusé sans session.

Photos de 3 Mo à travers le proxy :

```
[IO.File]::WriteAllBytes("$env:TEMP\essai.bin", (New-Object byte[] 3000000))
curl.exe -s -o NUL -w "%{http_code}`n" --resolve carnetmedia.synology.me:8445:192.168.1.20 -X PUT -H "Content-Type: image/jpeg" --data-binary "@$env:TEMP\essai.bin" https://carnetmedia.synology.me:8445/v1/blobs/0000000000000000000000000000000000000000000000000000000000000000
```

Résultat attendu : `401`. Le proxy laisse passer le fichier et le service le refuse faute de
session. Le résultat `413` signalerait une taille limitée par le proxy.

Carnet Media doit toujours répondre sur `https://carnetmedia.synology.me:8444/v1/health`.

### Étape 8 — Hyper Backup

**Hyper Backup → Créer → Tâche de sauvegarde de données.**

1. Destination : disque USB, autre NAS ou C2.
2. Dossier : cochez **`carnet-sync/backups` uniquement**. N'incluez **pas** `data`, la base en
   service ; les sauvegardes nocturnes en sont des copies cohérentes.
3. Horaire : chaque jour à **04:30**, après la sauvegarde de 03:15.
4. Cochez « Activer la vérification de l'intégrité des sauvegardes ».
5. Rotation : « Smart Recycle », 30 versions par exemple.

### Restauration en cas de besoin

1. **Conteneur → Terminal.** Les deux premières commandes permettent de choisir puis de contrôler la version :

   ```
   python -m app.admin status
   python -m app.admin restore-test /srv/carnet/backups/<version>
   python -m app.admin restore /srv/carnet/backups/<version>
   ```

2. **Action → Redémarrer.** Le journal indique « Restauration appliquée ». L'ancienne base reste
   dans `carnet-sync/data-avant-restauration-…`.

Si le NAS lui-même est perdu :
1. Restaurez le dossier `backups` avec Hyper Backup.
2. Refaites les étapes 1 à 4.
3. Lancez `restore` puis redémarrez le conteneur.

## 9. Tests

- **`nas/carnet-sync/tests/test_server.py`** (17 tests) couvre :
  - l'isolation et les tentatives d'accès croisé ;
  - les comptes et les sessions ;
  - la création interactive du compte (mot de passe jamais affiché) ;
  - les conflits et l'idempotence ;
  - les envois de recettes : copie indépendante, notes privées, format de la miniature, refus, expiration ;
  - le refus de supprimer une photo encore utilisée ;
  - la sauvegarde pendant des écritures simultanées (WAL), avec liens physiques ;
  - la vérification et la restauration à blanc ;
  - la restauration au redémarrage, l'ancienne base étant conservée ;
  - la rotation des versions ;
  - la cohérence entre la base et les fichiers ;
  - la tâche nocturne.
- **`tests/unit/sync-live.test.ts`** (11 tests, de bout en bout, moteur de l'application et vrai
  serveur) couvre :
  - la migration non liée, puis liée, interrompue puis reprise ;
  - deux appareils sur le même compte ;
  - la modification hors ligne et les conflits ;
  - la fusion de collections ;
  - les pertes partielles et totales, y compris le nettoyage des photos orphelines ;
  - les suppressions volontaires ;
  - le nouveau téléphone ;
  - le jeton expiré ;
  - le second compte, avec refus du mauvais compte ;
  - l'envoi, le refus et la double acceptation.
- **GitHub Actions (`carnet-sync.yml`)** exécute les deux suites. Il construit ensuite l'image et
  vérifie le conteneur dans les conditions du NAS :
  - utilisateur non-root, système de fichiers en lecture seule, capacités retirées ;
  - aucun accès sans session ;
  - compte interactif et `selftest` ;
  - photo de 3 Mo ;
  - sauvegarde, `check --full`, `verify` et restauration à blanc ;
  - restauration réelle au redémarrage ;
  - aucun secret dans le journal.

  L'image n'est publiée que depuis `master`, ou sur demande explicite.
