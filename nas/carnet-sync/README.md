# Carnet Sync 0.2.1 — carnet privé par compte, partage par copie

> **Modèle retenu (Mon Carnet 1.6.0).** Chaque compte a son carnet **privé**, synchronisé entre ses
> propres appareils. Une recette se **partage** volontairement avec un autre utilisateur, qui reçoit
> une **copie indépendante** après acceptation. Aucune nouvelle recette collaborative : le catalogue
> familial ci-dessous ne concerne plus que les recettes créées en 1.5.x, jusqu'à leur conversion en
> copies privées (section « Conversion du catalogue familial »).

## Nouveautés 0.2.1 (aucun changement de la base : installable par-dessus la 0.2.0)

- **Repartage d'une nouvelle version.** Chaque envoi porte un identifiant opaque et stable de la
  recette d'origine (`source_key`, sans identifiant interne). Le destinataire qui a déjà une copie
  choisit : **mettre à jour sa recette** (`accept` avec `mode: replace` — contenu de la fiche
  remplacé, **favoris, note, réalisations et notes personnelles conservés** ; uniquement sur sa
  propre copie reçue de la même recette d'origine), **garder les deux** (nouvelle recette), ou
  **refuser**. Rien n'est jamais remplacé automatiquement.
- `GET /v1/health` indique la version ; heure de réception à la milliseconde.
- Commande `family privatize` (simulation par défaut, voir plus bas).
- Compatibilité : l'application 1.6.0 fonctionne aussi avec la 0.2.0 (sans l'option « mettre à
  jour », proposée seulement quand le serveur est en 0.2.1).

## Conversion du catalogue familial en carnets privés (après validation de la 1.6.0)

Rien n'est supprimé ni déplacé automatiquement. Étapes, chacune sur votre accord :

1. Sauvegarde : `python -m app.admin backup`, puis `restore-test` sur cette sauvegarde.
2. Simulation : `python -m app.admin family privatize` → nombre de copies par membre (rien n'est écrit).
3. Application : `python -m app.admin family privatize --apply` → chaque membre reçoit, dans son
   carnet privé, une **copie indépendante** de chaque recette familiale (photos copiées), avec SES
   favoris, note et notes personnelles ; son journal, ses collections et ses publications sont
   rattachés à sa copie. Rejouable sans doublon. Le catalogue familial reste intact.
4. Vérification sur chaque téléphone (« Vérifier avec le serveur », recettes présentes, photos).
5. Seulement ensuite, sur décision séparée : retrait du catalogue familial (membres retirés,
   recettes familiales à la corbeille, restaurables 30 jours).

---

# Carnet Sync 0.2 — catalogue familial et carnet personnel (historique)

Synchronisation privée de Mon Carnet sur le Synology. C'est un service distinct de Carnet Media.

- Un **catalogue familial** est commun aux membres : chaque recette ajoutée y apparaît chez tous,
  et ses modifications sont synchronisées.
- Chaque compte garde un **espace personnel** pour ses favoris, ses notes sur 5, ses commentaires,
  son journal, ses collections, sa liste de courses, ses préférences, ses aliments mémorisés, ses
  publications « À essayer » et ses recettes gardées privées.

> **Statut : étape B.** Le service est testé sur PC et dans GitHub Actions, et l'image 0.2.0 est
> publiée. Rien n'est installé sur le NAS, et l'application Android n'est pas modifiée.

## 1. Ce qui est partagé, ce qui reste personnel

| Espace familial (tous les membres) | Espace personnel (vous seul) |
|---|---|
| Recettes complètes : titre, description, catégorie, étiquettes, temps, parts, difficulté | Favoris |
| Ingrédients et quantités | Note sur 5 étoiles |
| Étapes de préparation | Commentaires et notes personnelles (modifications, erreurs, idées, conservation, réchauffage) |
| Photos des recettes | Journal de cuisine et réalisations |
| Nutrition (associations CIQUAL/OFF, poids cuit, totaux) | Collections, liste de courses |
| Astuces culinaires de la fiche | Préférences, aliments mémorisés |
| Source et lien d'origine (ex. « TikTok · Chef », lien de la vidéo) | Publications TikTok / Instagram enregistrées et leurs **MP4** |
| Auteur, dernier modificateur, historique | Recettes gardées privées, recettes reçues d'un autre compte |

- **Tri imposé par le serveur.** Une recette familiale est enregistrée en deux parties : la partie
  commune va dans l'espace familial ; votre partie personnelle (favori, note, commentaires…) va
  dans votre espace. C'est le **serveur** qui fait ce tri : même un téléphone défaillant ne peut
  pas publier vos notes personnelles dans la famille.
- **Publications TikTok et Instagram.** Une recette créée à partir d'une publication garde dans la
  fiche commune sa source et son lien. La publication elle-même, son MP4 et le lien vers votre
  liste « À essayer » restent personnels.

## 2. Droits (vérifiés par le serveur à chaque requête)

| Action | Membre | Administrateur |
|---|---|---|
| Ajouter une recette au catalogue, modifier une recette commune | ✓ | ✓ |
| Mettre à la corbeille, restaurer (30 jours) | ✓ | ✓ |
| Revenir à une version (50 dernières), résoudre un conflit | ✓ | ✓ |
| Verrouiller **sa** recette (seuls l'auteur et l'administrateur la modifient ensuite) | auteur | ✓ |
| Retirer une recette du catalogue (vers son espace personnel) | auteur | ✓ |
| Suppression définitive (depuis la corbeille) | — | ✓ |
| Ajouter, retirer un membre, changer un rôle | — | ✓ (en ligne de commande sur le NAS) |
| Voir l'espace personnel d'un autre | jamais | jamais |

- **Auteur et dates.** L'auteur et le dernier modificateur sont **fixés par le serveur**, jamais
  fournis par le téléphone.
- **Confirmation.** Une action qui concerne les autres membres exige une confirmation explicite,
  que le serveur vérifie lui-même. C'est le cas d'un déplacement vers le catalogue ou hors du
  catalogue.

## 3. Nouvelles recettes et déplacements

- **Création.** Une nouvelle recette va **dans le catalogue familial par défaut**. L'éditeur
  proposera « Garder privée ».
- **Déplacement de votre carnet vers le catalogue.** La partie commune devient visible de tous.
  Vos favoris et vos notes restent les vôtres. Les photos sont déplacées, ou copiées si une autre
  de vos recettes les utilise.
- **Déplacement du catalogue vers votre carnet.** Réservé à l'auteur ou à l'administrateur, avec
  confirmation. Vous récupérez une recette personnelle complète. Pour les autres membres, la
  recette passe dans la **corbeille familiale** : n'importe qui peut la restaurer pendant 30 jours.

## 4. Modifications simultanées : rien n'est perdu en silence

| Situation | Résultat |
|---|---|
| Deux membres modifient des champs différents (titre, étapes, étiquettes, astuces…) | **Fusion automatique**, par le serveur |
| Ingrédients et étapes : lignes différentes ajoutées, retirées ou modifiées | Fusion ligne par ligne |
| **Même** ingrédient, étape ou champ modifié différemment | La version déjà enregistrée reste. L'autre est **conservée intégralement** et un **conflit à résoudre** est signalé (« 1 modification à revoir »). Vous choisissez la version à garder. |
| Ligne supprimée par l'un, modifiée par l'autre | La ligne modifiée est gardée, et le cas est signalé à revoir. |
| Recette mise à la corbeille par l'un, modifiée par l'autre | La modification l'emporte et la recette sort de la corbeille. |
| Recette verrouillée modifiée par un autre membre hors ligne | Sa version devient une recette **personnelle**, « (ma version) ». |
| Version d'origine trop ancienne (plus de 50 versions) | Tout désaccord est conservé et signalé à revoir. |
| Votre partie personnelle, modifiée sur deux de vos appareils | Les règles habituelles s'appliquent, et la version écartée reste dans le journal des conflits. |

L'historique conserve chaque version : les modifications, les passages en corbeille, les
restaurations, les versions écartées par un conflit et les résolutions.

## 5. Suppressions et pertes de données

- **Suppressions volontaires.** Seules les suppressions faites **par vous dans l'application**
  sont transmises. Une recette familiale part alors en corbeille ; elle est restaurable 30 jours,
  puis supprimée automatiquement.
- **Pertes accidentelles.** Une recette disparue du téléphone **sans** suppression de votre part
  est re-téléchargée. C'est le cas d'une perte de données IndexedDB, partielle ou totale, ou d'un
  effacement par le système. Rien n'est jamais effacé sur le serveur.
- **Photos.** Le serveur refuse de supprimer une photo encore utilisée par une recette, y compris
  une recette en corbeille.
- **Restauration d'une sauvegarde ZIP.** Elle ne supprime rien sur le serveur. Ce qui ne figurait
  pas dans le ZIP revient du serveur. L'espace de chaque recette (famille ou personnel) est
  conservé dans la sauvegarde ZIP.

## 6. Retrait d'un membre : politique de conservation

1. **Côté serveur, effet immédiat.** L'accès au catalogue familial est coupé, même si une session
   est ouverte. Il n'y a plus aucune synchronisation familiale, ni lecture ni écriture.
2. **Ses données personnelles restent à lui** : favoris, notes, journal, recettes privées.
3. **Aucune conversion automatique.** Le catalogue familial n'est **pas** transformé en recettes
   personnelles. Seules ses propres créations jamais envoyées lui restent, dans son carnet personnel.
4. **Sur ses appareils.** À la prochaine connexion, l'application **retire de l'appareil** les
   recettes et photos familiales. Le serveur annonce explicitement le retrait, ce qui évite qu'une
   simple panne ne déclenche ce nettoyage.
5. **Limite à connaître.** Une copie déjà téléchargée **ne peut pas être effacée à distance de
   façon garantie**. Ce retrait au mieux ne s'applique pas dans ces cas :
   - un appareil qui ne se reconnecte jamais ;
   - une sauvegarde ZIP déjà exportée ;
   - une capture d'écran ;
   - une copie faite autrement.
6. Un membre **réintégré** retrouve le catalogue à sa synchronisation suivante.

## 7. Première connexion : migration de vos recettes 1.4.1

1. L'application liste les recettes du téléphone. **Aucune n'est présélectionnée** ; un bouton
   « Tout sélectionner » est proposé. Les recettes de démonstration sont à part et ne sont jamais
   envoyées sans votre accord.
2. Une **sauvegarde complète** est faite **avant** tout envoi. Si elle échoue, la migration est
   annulée et rien n'est envoyé.
3. Les recettes cochées vont au catalogue familial, les autres restent personnelles. Les
   favoris, notes, journal, collections et courses vont dans votre espace personnel.
4. La synchronisation reprend où elle s'était arrêtée en cas de coupure, sans doublon. Ensuite,
   chaque élément est vérifié par rapport au serveur, photos comprises.
5. **Aucune donnée locale n'est supprimée**, ni pendant ni après.

## 8. Sécurité, comptes, sauvegardes

**Comptes**
- Les mots de passe sont hachés en Argon2id.
- Les sessions sont renouvelables et révocables par appareil.
- Les tentatives de connexion sont limitées.
- Il n'y a aucune inscription publique : les comptes sont créés en ligne de commande, ou par une
  invitation à usage unique, éventuellement familiale.
- Le premier compte et la famille sont créés **en mode interactif** : le mot de passe est saisi deux
  fois et masqué, jamais généré ni affiché.

**Conteneur**
- Il tourne sous un utilisateur non-root, avec un système de fichiers en lecture seule et sans
  capacités système.
- La mémoire et le nombre de processus sont plafonnés. Il n'y a **aucune limite CPU**, car le noyau
  Synology ne gère pas l'ordonnanceur CFS.
- Il écoute **uniquement sur 127.0.0.1** : seul le reverse proxy DSM, en HTTPS sur le port 8445,
  le joint. La base SQLite n'est jamais exposée.

**Sauvegardes nocturnes (03:15)**
- La base est copiée par l'**API de sauvegarde SQLite** : l'instantané est cohérent même en mode
  WAL, sans arrêter le service.
- Toutes les photos des deux espaces sont sauvegardées, avec un manifeste SHA-256 relu avant
  validation.
- L'historique garde 14 nuits et 8 semaines. Une photo inchangée est reliée à la version
  précédente, sans copie en double.
- La corbeille de plus de 30 jours est vidée par la même tâche.
- Le service vérifie la **cohérence entre la base et les fichiers photos** (`check --full`).

**Restauration**
- La restauration à blanc (`restore-test`) se fait dans un dossier temporaire, est contrôlée, puis
  effacée.
- La restauration réelle (`restore`) s'applique au redémarrage du conteneur. L'ancienne base est
  conservée à côté, jamais effacée ; en cas d'échec, elle est remise en place.

### Commandes (Container Manager → Conteneur → carnet-sync → Terminal)

| Commande | Rôle |
|---|---|
| `python -m app.admin setup` | Votre compte, puis le catalogue familial dont vous êtes administrateur |
| `python -m app.admin selftest` | Essai réel : connexion, famille, lecture, déconnexion |
| `python -m app.admin family show` | Membres et rôles |
| `python -m app.admin family add <login>` / `remove <login>` / `role <login> admin\|member` | Gestion des membres |
| `python -m app.admin user create` | Autre compte, en mode interactif, puis `family add` |
| `python -m app.admin invite create --family` | Invitation à usage unique, valable 7 jours, qui fait rejoindre la famille |
| `python -m app.admin backup` / `status` / `check --full` | Sauvegarde immédiate, état, cohérence |
| `python -m app.admin verify <dossier>` / `restore-test <dossier>` / `restore <dossier>` | Vérification et restauration |

## 9. Installation sur le DS920+ (DSM 7.4.1)

Nous la ferons **une étape à la fois**, à commencer par le réseau local. Carnet Media, son port 8444
et son dossier ne sont pas touchés, et aucun port n'est ouvert sur la Freebox.

| Étape | Contenu |
|---|---|
| 1 | Compte technique `carnet-sync`, sans aucun droit de connexion |
| 2 | Dossier partagé `carnet-sync`, distinct de Carnet Media |
| 3 | Numéro (UID) du compte technique, via le Planificateur de tâches (sans SSH) |
| 4 | Projet Container Manager à partir de `docker-compose.yml` (image `ghcr.io/kabot83/carnet-sync:0.2.1`) |
| 5 | `setup` : votre compte, puis le catalogue familial ; puis `selftest`, `backup`, `restore-test` |
| 6 | Reverse proxy HTTPS sur `carnetmedia.synology.me:8445` vers `localhost:8090`, avec le certificat Let's Encrypt existant |
| 7 | Tests sur le réseau local depuis le PC (`curl.exe --resolve …`) |
| 8 | Hyper Backup du dossier `carnet-sync/backups` uniquement |

## 10. Tests

- **`tests/test_server.py`** (17 tests) couvre :
  - l'isolation et les accès croisés ;
  - les comptes et les sessions ;
  - la création interactive du compte ;
  - les conflits ;
  - les envois de recettes ;
  - les sauvegardes WAL avec liens physiques ;
  - la vérification, la restauration à blanc, la restauration au redémarrage et la rotation ;
  - la cohérence entre la base et les fichiers ;
  - la tâche nocturne.
- **`tests/test_family.py`** (18 tests) couvre :
  - le catalogue commun et les données personnelles jamais partagées ;
  - les non-membres et les tentatives d'usurpation ;
  - la règle d'un identifiant par espace ;
  - la fusion des champs indépendants ;
  - le même ingrédient modifié, avec résolution manuelle ;
  - la version d'origine trop ancienne ;
  - la corbeille, la restauration, la suppression définitive et le vidage à 30 jours ;
  - la modification contre la mise en corbeille ;
  - l'historique et le retour à une version ;
  - le verrou ;
  - les déplacements dans les deux sens ;
  - le retrait d'un membre ;
  - l'invitation familiale ;
  - l'envoi depuis le catalogue ;
  - la sauvegarde ;
  - le refus d'une base 0.1.
- **`tests/unit/sync-live.test.ts`** (21 scénarios) fait tourner le moteur de l'application contre
  le vrai serveur. Il couvre :
  - la migration avec choix des recettes, sauvegarde préalable, coupure et reprise ;
  - deux appareils ;
  - le travail hors ligne et les conflits ;
  - les pertes d'IndexedDB ;
  - les suppressions volontaires ;
  - le nouveau téléphone ;
  - côté famille : apparition chez les membres, données personnelles séparées, « Garder privée »,
    fusion automatique, conflit manuel, corbeille, verrou, déplacements, publication TikTok sans
    MP4, sauvegarde ZIP aller-retour, retrait d'un membre ;
  - le second compte et les envois.
- **GitHub Actions** exécute ces suites puis vérifie l'image. Il démarre aussi le conteneur avec le
  `docker-compose.yml` réel, sans limite CPU et avec toutes les protections actives.
