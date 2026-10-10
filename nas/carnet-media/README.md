# Carnet Media — service vidéo du NAS pour Mon Carnet

Service Docker pour Synology DS920+ (DSM 7.4, Container Manager). À partir d'un lien TikTok ou Instagram envoyé par Mon Carnet (« Partager → Mon Carnet »), il récupère automatiquement :

- les **métadonnées** publiques : légende complète, créateur, miniature ; titre tiré de la première phrase utile de la légende (jamais un pseudo) ;
- le **fichier MP4** public, vérifié par ffmpeg (décodage complet) avant d'être déclaré prêt ;
- et conserve vidéos et métadonnées sur le NAS (base de la future bibliothèque familiale).

Usage strictement personnel et familial : aucune republication, aucune diffusion publique.

## Garde-fous (verrouillés dans le code)

- Aucun identifiant TikTok / Instagram, aucun cookie, aucune imitation de navigateur (`curl_cffi` absent de l'image, vérifié en intégration continue), aucun contenu privé, aucun DRM contourné.
- Liste fermée : publications TikTok / Instagram précises uniquement (pas de profils, listes, directs, ni autres sites). Fichiers seulement depuis les CDN des plateformes, et **uniquement vers des adresses IP publiques** (contrôle à chaque connexion : impossible d'atteindre le réseau local ou le NAS, même par redirection).
- Limites : 10 min et 200 Mo par vidéo, espace total plafonné (200 Go par défaut), 30 demandes / heure / appareil, une tâche à la fois.
- Jeton individuel par appareil (stocké haché, révocable). Journal technique sans jetons ni adresses de fichiers.
- Conteneur non privilégié : utilisateur non-root, système de fichiers en lecture seule, toutes les capacités Linux retirées, `no-new-privileges`, mémoire (1,5 Go) et processeur (2 cœurs) plafonnés.

## Comment la vidéo est obtenue

| | Métadonnées | Vidéo |
| --- | --- | --- |
| TikTok | API **oEmbed officielle** (légende, créateur, miniature, identifiant) | MP4 public du **lecteur intégré officiel** (`embed/v2`) |
| Instagram | yt-dlp, accès anonyme | yt-dlp, accès anonyme |

Si la vidéo ne peut pas être récupérée, la fiche et ses métadonnées restent, avec la raison ; Mon Carnet proposera l'import depuis la galerie. Liens courts TikTok : redirections suivies sans cookies ; si TikTok renvoie vers sa page d'accueil, c'est signalé (`short_link_unresolved`).

## API (HTTPS, `Authorization: Bearer mc_…`)

| Méthode | Route | Rôle |
| --- | --- | --- |
| GET | `/v1/health` | État (sans jeton) |
| POST | `/v1/jobs` `{"url": "…", "retry": false}` | Import d'une publication (aucun doublon ; `retry` : nouvel essai d'une vidéo indisponible) |
| GET | `/v1/jobs/{id}` | `queued` → `metadata` → `downloading` (progression 0–1) → `verifying` → `done` / `failed` |
| GET | `/v1/media` `?since=` | Bibliothèque du NAS (synchronisation future) |
| GET | `/v1/media/{plateforme}/{id}` | Métadonnées et statut vidéo : `ready`, `downloading`, `not_available`, `failed` (réessayable) |
| GET | `/v1/media/{plateforme}/{id}/video` | MP4, lecture partielle (Range) |
| GET | `/v1/media/{plateforme}/{id}/thumbnail` | Miniature |
| DELETE | `/v1/media/{plateforme}/{id}` | Supprime fichiers et fiche |
| GET | `/v1/storage` | Espace occupé |

Erreurs : `invalid_url`, `short_link_unresolved`, `private_or_removed`, `unavailable_logged_out` (introuvable, privée ou réservée aux comptes connectés — cause ambiguë annoncée comme telle), `rate_limited`, `not_available`, `too_long`, `too_large`, `incomplete`, `verification_failed`, `blocked_address`, `storage_full`, `network`.

## Installation sur le DS920+ (réseau local uniquement)

L'image est construite et testée par GitHub Actions, puis publiée sur `ghcr.io/kabot83/carnet-media`. Le NAS la télécharge : aucun fichier à copier.

1. **Container Manager** : Centre de paquets → installer « Container Manager ».
2. **Dossier** : File Station → `docker` → créer `carnet-media`, puis dedans `data`.
3. **Droits du dossier `data`** : clic droit → Propriétés → Autorisation → Créer → Utilisateur ou groupe : votre compte → Lecture/Écriture → Appliquer à ce dossier, sous-dossiers et fichiers.
4. **Projet** : Container Manager → Projet → Créer
   - Nom : `carnet-media` ; Chemin : `/docker/carnet-media` ; Source : « Créer docker-compose.yml » ;
   - coller le contenu de `docker-compose.yml` en remplaçant `192.168.1.20` par l'adresse IP locale du NAS (Panneau de configuration → Réseau → Interface réseau) ;
   - Suivant → Terminé : le conteneur démarre (sans certificat, il le signale dans son journal).
   - Si le journal indique « Écriture impossible dans /data » : remplacer `1026:100` par l'UID:GID de votre compte (commande `id` en SSH), ou donner l'accès Lecture/Écriture au groupe « users » sur `data`.
5. **Certificat HTTPS du réseau local** : Container Manager → Conteneur → `carnet-media` → Action → Ouvrir le terminal → Créer → commande :
   `python -m app.admin cert create --ip 192.168.1.20 --name ds920.local`
   puis Action → Redémarrer. L'empreinte affichée sera épinglée dans Mon Carnet (seul ce certificat sera accepté).
6. **Jeton du téléphone** : même terminal, `python -m app.admin token create "Téléphone"` → le jeton s'affiche **une seule fois** (à garder pour Mon Carnet ; révocable avec `token revoke`).
7. **Test** : depuis le téléphone en Wi-Fi, ouvrir `https://192.168.1.20:8443/v1/health` → avertissement de certificat (normal : certificat propre au NAS) → `{"status":"ok"}`.

Rien n'est exposé sur Internet : le port est lié à l'adresse locale du NAS, sans redirection sur la box. Si le pare-feu DSM est activé, autoriser le port 8443 depuis le réseau local seulement. L'administration DSM n'est jamais concernée.

Mises à jour (yt-dlp évolue souvent ; Instagram et TikTok peuvent changer) : nouvelle image publiée par GitHub Actions → Projet → Action → Construire / Récupérer l'image → Redémarrer.

## Accès depuis l'extérieur (4G/5G) — étude, rien n'est configuré

Objectif : Mon Carnet joint le service partout, sans VPN à activer, sans exposer DSM.

| Solution | Principe | Coût | Vidéos | Limites / risques |
| --- | --- | --- | --- | --- |
| **A. Cloudflare Tunnel + R2** (recommandée) | Tunnel sortant depuis le NAS pour l'API ; vidéos copiées par le NAS dans un stockage **Cloudflare R2**, téléchargées par le téléphone via des liens temporaires signés | Domaine ≈ 10 €/an ; R2 gratuit jusqu'à 10 Go stockés, sortie gratuite, puis 0,015 $/Go/mois (≈ 0,15 €/mois pour 20 Go) | Conforme aux conditions de Cloudflare (R2 est prévu pour les gros fichiers) | Les vidéos sont aussi hébergées chez Cloudflare (privé, chiffré au repos) ; à supprimer de R2 une fois copiées sur le téléphone si souhaité |
| B. Cloudflare Tunnel seul | Tout passe par le tunnel, vidéos comprises | Domaine seulement | ⚠️ Conditions Cloudflare : la diffusion de vidéo par le CDN gratuit est réservée aux offres payantes (Stream, R2…) ; risque de limitation du compte | Variante sûre : vidéos copiées sur le téléphone seulement à la maison |
| C. Redirection de port 443 + certificat Let's Encrypt | La box redirige 443 vers un relais HTTPS (conteneur) qui ne sert que Carnet Media | Domaine ou DDNS gratuit | Aucune limite de tiers | Adresse IP de la maison visible, surface d'attaque (un seul service durci, DSM non exposé) ; IPv4 partagée chez certains opérateurs |
| D. Tailscale Funnel | Adresse publique HTTPS fournie par Tailscale, sans application côté téléphone | Gratuit | Bande passante non garantie | Dépend d'un service tiers ; écarté si vous ne voulez pas de Tailscale |

Dans tous les cas : authentification propre à Mon Carnet (jetons d'appareils) ; en option avec Cloudflare, **Access + jeton de service** (gratuit) pour bloquer toute requête sans en-têtes Mon Carnet avant qu'elle n'atteigne le NAS. Cloudflare déchiffre le trafic qui passe chez lui. Envois vers le NAS limités à 100 Mo par requête par Cloudflare (sans effet : seuls des liens sont envoyés).

## Tests

- `pytest tests/test_service.py` — 15 tests, réseau **simulé** : jetons, liens refusés, adresses du réseau local refusées, transfert incomplet détecté, fichier corrompu jamais déclaré prêt, lecture partielle, doublons, suppression, espace plein, limite de débit, traduction des erreurs.
- `python tests/live_smoke.py https://<ip>:8443 <jeton> <cert.pem> [liens…]` — test **réel** de bout en bout (certificat épinglé).
