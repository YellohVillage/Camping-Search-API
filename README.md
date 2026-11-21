# Camping Search — Yelloh! Village

| Répertoire | Contenu |
|---|---|
| [`specs/`](specs/) | Spécifications : [API REST](specs/specifications.md) et [serveur MCP](specs/mcp-specifications.md), exemples de réponses |
| [`api-rest/`](api-rest/) | Code de l'API REST Camping Search ([README](api-rest/README.md)) |
| [`mcp-server/`](mcp-server/) | Code du serveur MCP « Yelloh-Camping-Search » pour Claude et ChatGPT ([README](mcp-server/README.md)) |

Déploiements Netlify (deux projets distincts sur ce dépôt) :

- API REST : [`netlify.toml`](netlify.toml) à la racine (répertoire de base `api-rest/`) ;
- serveur MCP : [`mcp-server/netlify.toml`](mcp-server/netlify.toml) (répertoire de base `mcp-server` à régler dans le projet Netlify).
