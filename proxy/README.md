# Proxy Mon Carnet (Cloudflare Workers)

Garde la clé Gemini côté serveur et récupère les pages de recettes pour l'import par lien.

## Ce qu'il fait

- Vérifie un **jeton d'accès** (comparaison en temps constant) avant tout.
- Relaie uniquement `GET /v1beta/models` et `POST /v1beta/models/gemini-*:generateContent` ; tout le reste est refusé (fichiers, cache, flux, autres familles de modèles).
- Remplace le jeton par la vraie clé ; ignore tout paramètre `key` venant du client.
- Limite la taille des requêtes (6 Mo) et le nombre d'appels par jour (`DAILY_LIMIT`, compteur KV facultatif), répond en 429 au format Gemini.
- Ne réessaie jamais ; relaie tels quels les refus de quota de Google.
- `/fetch` et `/image` : http(s) uniquement, ports 80/443, pas d'IP ni d'hôte interne, pas d'identifiants dans l'URL, redirections revérifiées (3 max), 10 s, 3 Mo (page) / 8 Mo (image), types de contenu contrôlés, **robots.txt respecté**, codes 401/403/404 du site renvoyés tels quels (aucun contournement).
- CORS limité aux origines listées dans `ALLOWED_ORIGINS`.

## Déployer

```bash
cd proxy && npm install
```

```bash
npx wrangler login
```

Éditer `wrangler.toml` (`ALLOWED_ORIGINS` = l'adresse où Mon Carnet est publié), puis enregistrer les secrets — la clé Gemini d'un projet **sans facturation**, et un jeton long et aléatoire de votre choix :

```bash
npm run secrets
```

```bash
npm run deploy
```

Dans Mon Carnet : **Réglages → Mon Chef IA → Via mon proxy**, saisir l'adresse `https://mon-carnet-proxy.<compte>.workers.dev` et le jeton.

Pour révoquer l'accès d'un téléphone perdu : `npx wrangler secret put ACCESS_TOKEN` avec un nouveau jeton.

L'offre gratuite de Cloudflare Workers suffit largement à un usage personnel aujourd'hui ; ses conditions peuvent changer. Le code n'utilise que l'API `fetch` standard et se porte facilement sur Deno Deploy ou un petit serveur Node.
