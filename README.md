# Camping Search — Yelloh! Village

| Répertoire | Contenu |
|---|---|
| [`specs/`](specs/) | Spécifications : [API REST](specs/specifications.md) et [serveur MCP](specs/mcp-specifications.md), exemples de réponses |
| [`api-rest/`](api-rest/) | Code de l'API REST Camping Search ([README](api-rest/README.md)) |
| [`mcp-server/`](mcp-server/) | Code du serveur MCP « Yelloh-Camping-Search » pour Claude et ChatGPT ([README](mcp-server/README.md)) |

Déploiement Netlify : **un seul projet** (`camping-search-api`), décrit par [`netlify.toml`](netlify.toml) à la racine.
Le build installe, vérifie et teste les deux projets ; deux fonctions sont publiées depuis [`netlify/functions/`](netlify/functions/) :

| Fonction | Code | Chemins |
|---|---|---|
| `api.mts` | `api-rest/` | `/v1/*` |
| `mcp.mts` | `mcp-server/` | `/mcp`, `/mcp/*`, `/health` |

Variables d'environnement du projet Netlify (scope « Functions ») : `API_CLIENTS` et `SESSION_SIGNING_SECRET` pour l'API ;
`REST_API_BASE_URL`, `REST_API_KEY_CLAUDE` et `REST_API_KEY_CHATGPT` pour le serveur MCP.
