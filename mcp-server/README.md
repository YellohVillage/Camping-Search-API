# Serveur MCP « Yelloh-Camping-Search »

Serveur [Model Context Protocol](https://modelcontextprotocol.io) qui permet à **Claude** et à **ChatGPT** de chercher
un camping Yelloh! Village en langage naturel et de proposer, pour chaque camping, un lien « Découvrir le camping » et un
lien « Réserver » (funnel YellohResa). Il s'appuie sur l'[API REST Camping Search](../api-rest/README.md) ; il ne
réimplémente aucune règle métier.

- Spécification : [`../specs/mcp-specifications.md`](../specs/mcp-specifications.md) (v0.9)
- Évaluations conversationnelles : [`test/evals/conversations.md`](test/evals/conversations.md)
- Plugin Claude : [`plugin-claude/`](plugin-claude/)

## Ce que le serveur expose

| Primitive | Nom                                                | Rôle                                                                                                                  |
| --------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Outil     | `get_search_filters`                               | Catalogue des critères (ids, libellés dans la langue de l'utilisateur)                                                |
| Outil     | `search_geography`                                 | Campings d'un lieu nommé (`camping_ids`), via `/v1/search/geography`                                                  |
| Outil     | `search_campings`                                  | Au plus N campings (3 par défaut, 5 au plus), avec les deux liens, éventuellement limités aux `camping_ids` d'un lieu |
| Ressource | `yelloh://filters/{accommodation_type}/{language}` | Même catalogue, en JSON                                                                                               |
| Prompt    | `find_a_camping`                                   | Lance une recherche guidée                                                                                            |

| Point d'entrée      | Usage                       | Clé d'API REST utilisée                       | `track` des liens |
| ------------------- | --------------------------- | --------------------------------------------- | ----------------- |
| `POST /mcp/claude`  | Connecteur et plugin Claude | `REST_API_KEY_CLAUDE` (client `mcp-claude`)   | `claude`          |
| `POST /mcp/chatgpt` | App ChatGPT                 | `REST_API_KEY_CHATGPT` (client `mcp-chatgpt`) | `chatgpt`         |
| `POST /mcp`         | Générique (facultatif)      | `REST_API_KEY_DEFAULT` ; sans elle, 404       | selon le client   |
| `GET /health`       | Supervision                 | —                                             | —                 |

Transport **Streamable HTTP sans état** : pas de session MCP, réponses JSON, `GET /mcp/*` répond 405.
Serveur public en lecture seule (pas d'authentification des utilisateurs en v1), protégé par une limite par adresse IP,
une taille maximale de requête (64 Ko) et le contrôle de l'en-tête `Origin`.

## Démarrage local

Prérequis : Node.js 20 ou plus ; commandes à lancer depuis `mcp-server/`.

```bash
npm ci
```

```bash
cp .env.example .env
```

Renseigner dans `.env` l'URL de l'API REST et les clés des clients `mcp-claude` et `mcp-chatgpt`, puis :

```bash
npm run dev
```

Le serveur écoute sur `http://localhost:8788/mcp/claude`. Pour l'explorer avec MCP Inspector (navigateur), ajouter
l'origine de l'Inspector dans `MCP_ALLOWED_ORIGINS` (ex. `http://localhost:6274`) :

```bash
npx @modelcontextprotocol/inspector
```

## Configuration

| Variable                     | Obligatoire | Défaut  | Rôle                                                               |
| ---------------------------- | ----------- | ------- | ------------------------------------------------------------------ |
| `REST_API_BASE_URL`          | oui         |         | URL de l'API REST, ex. `https://camping-search-api.netlify.app/v1` |
| `REST_API_KEY_CLAUDE`        | oui         |         | Clé du client `mcp-claude` (secret)                                |
| `REST_API_KEY_CHATGPT`       | oui         |         | Clé du client `mcp-chatgpt` (secret)                               |
| `REST_API_KEY_DEFAULT`       | non         |         | Clé du point d'entrée `/mcp` générique                             |
| `REST_API_TIMEOUT_MS`        | non         | `12000` | Délai d'un appel à l'API REST                                      |
| `CATALOG_TTL_SECONDS`        | non         | `86400` | Durée du cache du catalogue                                        |
| `GEO_CACHE_TTL_SECONDS`      | non         | `86400` | Durée du cache de la recherche par lieu (`0` le désactive)         |
| `GEO_CACHE_MAX_ENTRIES`      | non         | `500`   | Nombre maximum de recherches par lieu en cache, par instance       |
| `TOKEN_RENEW_BEFORE_SECONDS` | non         | `300`   | Renouvellement anticipé du token                                   |
| `MCP_MAX_RESULTS_LIMIT`      | non         | `5`     | Maximum de `max_results`                                           |
| `MCP_RATE_LIMIT_PER_MINUTE`  | non         | `30`    | Limite indicative par IP et par instance                           |
| `MCP_ALLOWED_ORIGINS`        | non         | vide    | Origines navigateur autorisées                                     |
| `LOG_LEVEL`                  | non         | `info`  |                                                                    |

Une configuration invalide empêche le serveur de répondre (erreur 500 générique, détail dans les journaux).

## Déploiement Netlify

Le serveur MCP est déployé par le **même projet Netlify que l'API REST** (`camping-search-api`), décrit par le
[`netlify.toml`](../netlify.toml) de la racine du dépôt :

- le build installe, vérifie les types et teste `api-rest/` puis `mcp-server/` ;
- le point d'entrée [`netlify/functions/mcp.mts`](../netlify/functions/mcp.mts) (racine du dépôt) est regroupé par
  Netlify avec le code de `mcp-server/src` et servi sur `/mcp`, `/mcp/*` et `/health`.

Mise en place, dans le projet Netlify existant :

1. **Variables d'environnement** (scope « Functions ») : `REST_API_BASE_URL` =
   `https://camping-search-api.netlify.app/v1`, puis `REST_API_KEY_CLAUDE` et `REST_API_KEY_CHATGPT` en
   « Contains secret values » (clés des clients `mcp-claude` et `mcp-chatgpt` de `API_CLIENTS`).
2. Redéployer, puis vérifier :

```bash
curl -s https://camping-search-api.netlify.app/health
```

L'API et le serveur MCP partagent ainsi le domaine : `…/v1/*` pour l'API, `…/mcp/claude` et `…/mcp/chatgpt` pour le MCP.

Le délai d'une fonction Netlify est de 10 s par défaut ; une recherche avec dates alternatives prend 3 à 6 s.

## Brancher le serveur dans Claude et ChatGPT

- **Claude, connecteur** : _Paramètres > Connecteurs > Ajouter un connecteur personnalisé_, URL
  `https://camping-search-api.netlify.app/mcp/claude`, nom « Yelloh-Camping-Search ».
- **Claude, plugin** : dossier [`plugin-claude/`](plugin-claude/) (déclaration du serveur et skill de conduite de la
  conversation).
- **ChatGPT** : mode développeur, connecteur ou app MCP avec l'URL `https://camping-search-api.netlify.app/mcp/chatgpt`.

Les procédures de publication publiques (répertoire de connecteurs Claude, publication d'app ChatGPT) sont à vérifier
dans la documentation en vigueur (spécification MCP, point ouvert P4).

## Tests

| Commande                             | Rôle                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `npm test`                           | Tests unitaires et d'intégration : client MCP officiel du SDK ↔ serveur ↔ API REST simulée |
| `npm run coverage`                   | Couverture (seuils : 85 % sur `tools`, `format`, `rest`)                                   |
| `npm run typecheck` / `npm run lint` | Types et lint                                                                              |

Les numéros de test de la spécification (M1 à M10) sont repris dans les intitulés des tests.
