# Serveur MCP « Yelloh-Camping-Search » — Spécifications fonctionnelles et techniques

> **Destinataire** : ce document doit pouvoir être donné tel quel à Claude Code (ou à un développeur) pour générer le code du serveur MCP. Il s'appuie sur l'API REST décrite dans [`specifications.md`](specifications.md) (v2.8), appelée ci-dessous « **l'API REST** ». Les règles métier (filtres, sélection des campings, liens YellohResa) restent de la responsabilité de l'API REST : le serveur MCP ne les réimplémente pas.

| | |
|---|---|
| Version | 0.3 |
| Date | 21/11/2026 |
| Statut | Brouillon ; restent ouverts P4, P5 et P6 (§14) |
| Runtime cible | Node.js 20 LTS, TypeScript, SDK MCP officiel `@modelcontextprotocol/sdk`, déploiement Netlify Functions ou AWS Lambda |
| Protocole | Model Context Protocol, transport **Streamable HTTP**, mode **sans état** |
| Clients cibles | Claude (claude.ai, apps desktop et mobile, Claude Code), sous forme de connecteur et de plugin « Yelloh-Camping-Search » ; ChatGPT, sous forme d'app ou de connecteur MCP |
| Dépendance | API REST Camping Search v2.8 (`/v1/auth/session`, `/v1/search/filters`, `/v1/search/campings`) |

### Historique

| Version | Changements |
|---|---|
| 0.1 | Initialisation : périmètre, outils MCP, contrats d'entrée et de sortie, sécurité, packaging Claude et ChatGPT, déploiement, tests |
| 0.2 | Points ouverts P1, P2, P3, P7 et P8 tranchés |
| 0.3 | Chaque proposition présentée à l'utilisateur comporte deux liens : la page de présentation du camping (`camping_page`) et la réservation (`booking_link`) |

---

## Sommaire

1. [Contexte et objectifs](#1-contexte-et-objectifs)
2. [Parcours utilisateur](#2-parcours-utilisateur)
3. [Architecture](#3-architecture)
4. [Primitives MCP exposées](#4-primitives-mcp-exposées)
5. [Outil `get_search_filters`](#5-outil-get_search_filters)
6. [Outil `search_campings`](#6-outil-search_campings)
7. [Ressource et prompt](#7-ressource-et-prompt)
8. [Gestion des erreurs](#8-gestion-des-erreurs)
9. [Sécurité](#9-sécurité)
10. [Packaging : plugin Claude et app ChatGPT](#10-packaging--plugin-claude-et-app-chatgpt)
11. [Structure du projet, configuration et déploiement](#11-structure-du-projet-configuration-et-déploiement)
12. [Exigences non fonctionnelles](#12-exigences-non-fonctionnelles)
13. [Tests et recette](#13-tests-et-recette)
14. [Points ouverts](#14-points-ouverts)
- [Annexe A — Exemple de conversation et d'appels d'outils](#annexe-a--exemple-de-conversation-et-dappels-doutils)

---

## 1. Contexte et objectifs

### 1.1 Objectif

Permettre à un utilisateur de **Claude** ou de **ChatGPT** de trouver un camping Yelloh! Village en langage naturel, par exemple « Je cherche un camping 4 fleurs avec toboggan du 10 au 17 juillet pour 4 personnes ». L'assistant doit lui répondre avec **au plus 3 propositions** (nombre réglable), chacune accompagnée d'un **lien pour réserver** dans le funnel YellohResa.

Le serveur MCP est **l'application tierce** décrite dans la spécification de l'API REST (§1.1 et annexe D de cette spécification). Il traduit l'API REST en outils MCP qu'un LLM sait appeler.

### 1.2 Périmètre v1

| Dans le périmètre | Hors périmètre v1 |
|---|---|
| Consultation du catalogue des filtres (location et emplacement) | Prix « à partir de » (l'API REST ne les fournit pas) |
| Recherche de campings : disponibles, ou disponibles à d'autres dates / pour une autre capacité | Réservation ou paiement dans la conversation (la réservation se fait dans YellohResa, via le lien) |
| Liens de réservation YellohResa | Compte client, programme fidélité |
| Langues : français et anglais (libellés `label` et `label_en`) | Autres marchés que la France (l'API REST v1 ne couvre que le marché FR) |
| Claude et ChatGPT | Interface graphique intégrée à la conversation (widget ChatGPT, prévu en v2, §10.3) |

### 1.3 Principes

1. **Pas de logique métier dupliquée** : filtrage, tirage au hasard, complétion par des dates alternatives et construction des liens sont faits par l'API REST.
2. **Outils conçus pour un LLM** : peu d'outils, des descriptions qui disent quand et comment s'en servir, des sorties compactes, et des erreurs qui indiquent au LLM quoi faire ensuite.
3. **Aucune donnée personnelle** : les outils ne reçoivent que des critères de séjour (dates, nombre de personnes, filtres), jamais de nom, d'e-mail ni d'identifiant de l'utilisateur.
4. **Sans état** : aucune session MCP persistante n'est gardée côté serveur. Toute instance peut répondre à toute requête, ce qui convient au serverless.

---

## 2. Parcours utilisateur

### 2.1 Parcours nominal

```
Utilisateur : « Un camping 4 fleurs avec toboggan du 10 au 17 juillet 2027 pour 4 personnes »
   │
   ▼
LLM (Claude / ChatGPT)
   │ 1. get_search_filters(accommodation_type="rental")
   │      → catalogue : « 4 fleurs » = confort_type:F4:4 ; « Toboggan(s) » = swimming:SR7 …
   │ 2. search_campings(start_date="2027-07-10", end_date="2027-07-17", people_count=4,
   │                    accommodation_type="rental", filters=["confort_type:F4:4","swimming:SR7"])
   │      → 3 campings disponibles + liens YellohResa
   ▼
LLM : présente les 3 campings (nom, ville, étoiles, note) et un lien « Réserver » pour chacun
```

### 2.2 Règles de conversation attendues du LLM

Elles sont portées par les descriptions des outils (§5, §6), et par la skill du plugin Claude (§10.2) :

| Situation | Comportement attendu |
|---|---|
| Dates ou nombre de personnes manquants | Les demander à l'utilisateur **avant** d'appeler `search_campings`. Ne pas inventer de valeurs. |
| Dates relatives (« le week-end du 14 juillet », « une semaine en août ») | Les convertir en dates `YYYY-MM-DD`. En cas d'ambiguïté, faire confirmer à l'utilisateur. |
| Type d'hébergement non précisé | Location (`rental`) par défaut. Choisir emplacement (`slot`) si l'utilisateur parle de tente, caravane, camping-car ou emplacement. |
| Critères (confort, piscine, mer, animaux…) | Les faire correspondre aux libellés du catalogue `get_search_filters` du **même** type d'hébergement. N'utiliser **que** des `id` du catalogue. Si un critère n'a pas d'équivalent, le dire à l'utilisateur au lieu de l'ignorer en silence. |
| Résultats « autres dates » | Dire clairement que le camping n'est pas disponible aux dates demandées, et donner les dates proposées. |
| Résultats « autre capacité » | Indiquer la capacité de l'hébergement proposé. |
| Aucun résultat | Transmettre le message « aucun camping disponible » et proposer d'assouplir les critères (dates, filtres). |
| Prix | Ne jamais annoncer de prix : l'outil n'en fournit pas. Renvoyer vers le lien de réservation. |
| Liens de chaque proposition | Donner **deux liens** par camping : la page de présentation du camping (`camping_page`, pour découvrir le camping) et la réservation (`booking_link`, pour réserver aux dates trouvées). Les donner **tels quels**, sans les modifier ni les raccourcir. |

---

## 3. Architecture

```
┌──────────────────────┐     MCP (Streamable HTTP, JSON-RPC)     ┌───────────────────────────┐
│ Claude / ChatGPT     │ ──────────────────────────────────────▶ │ Serveur MCP               │
│ (client MCP)         │   POST /mcp  (tools/list, tools/call)   │ yelloh-camping-search     │
└──────────────────────┘                                          │  ├─ Outils MCP (§5, §6)   │
                                                                  │  ├─ Client API REST       │
                                                                  │  │   (clé d'API + token)  │
                                                                  │  └─ Cache du catalogue    │
                                                                  └─────────────┬─────────────┘
                                                                                │ HTTPS, Bearer
                                                                                ▼
                                                                  ┌───────────────────────────┐
                                                                  │ API REST Camping Search   │
                                                                  │ /v1/auth/session          │
                                                                  │ /v1/search/filters        │
                                                                  │ /v1/search/campings       │
                                                                  └─────────────┬─────────────┘
                                                                                ▼
                                                                    GraphQL Yelloh! Village
```

| Composant | Rôle |
|---|---|
| Serveur MCP | Expose les outils, valide les arguments, appelle l'API REST, met en forme les résultats pour le LLM |
| Client API REST | Obtient et renouvelle le token de session (`POST /v1/auth/session`) avec la clé d'API du serveur MCP ; rejoue une fois une requête après un `401` |
| Cache du catalogue | Garde en mémoire d'instance le catalogue `rental` et le catalogue `slot`, 24 h au plus (recommandation de l'API REST, §6). Ce cache ne contient que de la configuration publique, pas de session ni de donnée utilisateur. |

Le serveur MCP est déclaré comme **client** dans `API_CLIENTS` de l'API REST (§4.2 de cette spécification), avec sa propre clé, son `track` et sa limite de débit (§9.2).

---

## 4. Primitives MCP exposées

| Primitive | Nom | Rôle |
|---|---|---|
| Outil | `get_search_filters` | Catalogue des critères de recherche, pour faire correspondre les mots de l'utilisateur aux `id` de filtres |
| Outil | `search_campings` | Recherche de campings et liens de réservation |
| Ressource | `yelloh://filters/{accommodation_type}` | Même catalogue que `get_search_filters`, pour les clients qui exploitent les ressources (§7.1) |
| Prompt | `find_a_camping` | Prompt guidé qui lance une recherche à partir de critères (§7.2) |

Informations déclarées à l'initialisation (`initialize`) :

| Champ | Valeur |
|---|---|
| `serverInfo.name` | `yelloh-camping-search` |
| `serverInfo.title` | `Yelloh! Village – Recherche de camping` |
| `serverInfo.version` | Version du `package.json` |
| `capabilities` | `tools`, `resources`, `prompts` (sans `listChanged` : la liste est fixe) |
| `instructions` | Texte court qui résume les règles du §2.2 (≤ 1 500 caractères), pour les clients qui l'injectent dans le contexte du modèle |

Annotations des deux outils : `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`. `idempotentHint` vaut `true` pour `get_search_filters` et `false` pour `search_campings`, car le tirage au hasard peut donner des résultats différents d'un appel à l'autre.

---

## 5. Outil `get_search_filters`

### 5.1 Description destinée au LLM

```
Returns the list of search criteria (filters) available for Yelloh! Village campsites, for one accommodation
type. Call it BEFORE search_campings whenever the user mentions any criterion (comfort level, pool, slide,
sea, mountain, pets, accessibility, kids club, activities, services, accommodation type…), then pass the
matching filter "id" values to search_campings. Use only ids returned by this tool, never invent or modify
them. accommodation_type must be the same as the one used in search_campings ("rental" = mobile home,
chalet, tent…; "slot" = pitch for the customer's own tent, caravan or camper van).
Filters with operator "OR" in the same category are alternatives (e.g. 4 flowers OR Premium); all other
selected filters must all be satisfied.
```

Les descriptions des outils et des champs sont rédigées **en anglais**, langue la mieux suivie par les LLM. Les libellés renvoyés restent bilingues (`label` en français, `label_en` en anglais), et le LLM répond dans la langue de l'utilisateur.

### 5.2 Entrée (`inputSchema`)

```json
{
  "type": "object",
  "properties": {
    "accommodation_type": {
      "type": "string",
      "enum": ["rental", "slot"],
      "default": "rental",
      "description": "rental = rented accommodation (mobile home, chalet, lodge tent…); slot = pitch for the customer's own tent, caravan or camper van."
    }
  },
  "additionalProperties": false
}
```

Contrairement à l'API REST, où il est obligatoire, `accommodation_type` est facultatif ici, avec `rental` par défaut. Le LLM a ainsi un argument de moins à fournir dans le cas le plus fréquent.

### 5.3 Traitement

1. Lire le catalogue dans le cache de l'instance s'il a moins de `CATALOG_TTL_SECONDS` (défaut 86 400 s).
2. Sinon, appeler `GET /v1/search/filters?accommodation_type=…` sur l'API REST et mettre le résultat en cache.
3. Le **compacter** pour le LLM (§5.4). Le catalogue complet pèse environ 25 Ko ; la forme compacte environ 6 Ko.

### 5.4 Sortie

`structuredContent`, conforme à un `outputSchema` déclaré :

```json
{
  "accommodation_type": "rental",
  "sections": [
    { "section": "location", "label": "Localisation", "label_en": null, "categories": [
      { "category_id": "destination", "operator": "AND", "filters": [
        { "id": "destination:N305", "label": "Mer", "label_en": "Sea" },
        { "id": "destination:N306", "label": "Montagne", "label_en": "Mountains" } ] } ] },
    { "section": "comfort", "label": "Niveau de confort", "label_en": null, "categories": [
      { "category_id": "confort_type", "operator": "OR", "filters": [
        { "id": "confort_type:F0:0-3", "label": "0-3 fleurs", "label_en": "0-3 flowers" },
        { "id": "confort_type:F4:4",   "label": "4 fleurs",   "label_en": "4 flowers" },
        { "id": "confort_type:F5:-1",  "label": "Premium",    "label_en": "Premium" } ] } ] }
  ]
}
```

Règles de compaction : on reprend `section`, `label`, `category_id`, `operator`, et pour chaque filtre `id`, `label` et `label_en`. Le champ `level` et les horodatages sont retirés.

`content` (texte, pour les clients qui n'exploitent pas `structuredContent`) : la même information au format liste, une ligne par filtre, sous la forme `id | label | label_en`, regroupée par section.

---

## 6. Outil `search_campings`

### 6.1 Description destinée au LLM

```
Searches Yelloh! Village campsites for a stay and returns up to max_results proposals (default 3), each with
a booking link to the Yelloh! Village booking engine. Required: start_date, end_date (YYYY-MM-DD, arrival and
departure days) and people_count. Ask the user for any missing required value instead of guessing.
For criteria, first call get_search_filters with the same accommodation_type and pass only the returned ids.
Each result has availability_type:
- "available": available on the requested dates;
- "alternative_dates": NOT available on the requested dates, but available on alternative_begin_date /
  alternative_end_date — tell the user explicitly;
- "alternative_capacity": available on the requested dates in an accommodation for alternative_capacity people.
For each result, always give BOTH links exactly as returned: camping_page (campsite description page) and booking_link
(booking engine, pre-filled with the dates and number of people). No prices are returned: never state or estimate a price.
If status is "NO_AVAILABILITY", tell the user that no campsite is available and suggest relaxing dates or filters.
Results are randomly picked among matching campsites: calling again may return other proposals.
```

### 6.2 Entrée (`inputSchema`)

```json
{
  "type": "object",
  "required": ["start_date", "end_date", "people_count"],
  "properties": {
    "start_date": { "type": "string", "format": "date", "description": "Arrival date, YYYY-MM-DD." },
    "end_date": { "type": "string", "format": "date", "description": "Departure date, YYYY-MM-DD, after start_date. Max 90 nights." },
    "people_count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "Number of people, babies included." },
    "accommodation_type": { "type": "string", "enum": ["rental", "slot"], "default": "rental",
                            "description": "Must match the accommodation_type used with get_search_filters." },
    "filters": { "type": "array", "items": { "type": "string" }, "maxItems": 30, "default": [],
                 "description": "Filter ids returned by get_search_filters, unchanged (e.g. \"confort_type:F4:4\")." },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 5, "default": 3,
                     "description": "Maximum number of proposals. Keep the default unless the user asks for more or fewer." }
  },
  "additionalProperties": false
}
```

Les bornes reprennent celles de l'API REST : `MAX_PEOPLE = 10` et `MAX_STAY_NIGHTS = 90`. Le maximum de `max_results` est volontairement limité à 5 côté MCP (`MCP_MAX_RESULTS_LIMIT`), pour garder une réponse lisible dans une conversation. Le serveur MCP ne refait pas les contrôles de l'API REST au-delà du schéma : les erreurs de l'API REST sont traduites (§8).

### 6.3 Traitement

1. Valider les arguments avec le schéma (zod). En cas d'échec, renvoyer un résultat d'outil `isError: true` avec un message actionnable (§8).
2. Appeler `GET /v1/search/campings` avec `startDate`, `endDate`, `peopleCount`, `accommodation_type`, `filters` (joints par `,`) et `maxResults`.
3. Si l'API répond `400 UNKNOWN_FILTER` : vider le cache du catalogue de ce type, puis renvoyer au LLM une erreur qui l'invite à rappeler `get_search_filters` (§8). Le serveur ne corrige pas les filtres lui-même, car il ne peut pas deviner l'intention de l'utilisateur.
4. Transformer la réponse (§6.4).

### 6.4 Sortie

`structuredContent`, conforme à un `outputSchema` déclaré. On reprend la réponse de l'API REST, allégée et renommée pour le LLM :

```json
{
  "status": "OK",
  "message": null,
  "search": { "start_date": "2027-07-10", "end_date": "2027-07-17", "nights": 7, "people_count": 4,
              "accommodation_type": "rental", "filters": ["confort_type:F4:4", "swimming:SR7"] },
  "matching": { "available": 70, "alternative_dates": 4 },
  "results": [
    {
      "rank": 1,
      "availability_type": "available",
      "name": "La Marende",
      "city": "Argelès-sur-Mer",
      "department": "Pyrénées Orientales",
      "region": "Languedoc-Roussillon",
      "stars": 5,
      "rating_out_of_10": 9.0,
      "alternative_begin_date": null,
      "alternative_end_date": null,
      "alternative_capacity": null,
      "booking_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4&lang=fr&track=claude&type=0",
      "camping_page": "https://www.yellohvillage.fr/camping/la_marende",
      "image_url": "https://img.yellohvillage.fr/…/la_marende.jpg"
    }
  ]
}
```

| Champ MCP | Source dans l'API REST | Commentaire |
|---|---|---|
| `status`, `message` | `status`, `message` | `OK`, `PARTIAL` ou `NO_AVAILABILITY` |
| `matching.available`, `matching.alternative_dates` | `summary.available_count`, `summary.alternative_dates_count` | Permet au LLM de dire « 70 campings correspondent » |
| `rating_out_of_10` | `rating` | Nom explicite pour le LLM |
| `alternative_begin_date`, `alternative_end_date` | `alternative_begin_date_availability`, `alternative_end_date_availability` | Noms raccourcis |
| `booking_link` | `bookingengine_link` | Recopié **sans modification** |
| `camping_page` | `camping_url` | Page de présentation du camping sur yellohvillage.fr, recopiée **sans modification**. Toujours présentée à l'utilisateur avec `booking_link`. |
| — | `camping_code`, `latitude`, `longitude`, `is_new`, `meta` | Non transmis au LLM (inutiles à la conversation) |

`content` (texte) : un résumé lisible, pour les clients qui ignorent `structuredContent` et pour guider la mise en forme. Exemple :

```
3 campsites found (70 match the criteria). Show them to the user, each with its campsite page link and its booking link.
1. La Marende — Argelès-sur-Mer (Pyrénées Orientales) — 5★ — 9.0/10 — available 2027-07-10 → 2027-07-17
   Campsite page: https://www.yellohvillage.fr/camping/la_marende
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027…&type=0
2. …
```

Pour un résultat `alternative_dates`, la ligne indique `NOT available on requested dates — available 2027-07-25 → 2027-08-01`. Pour `NO_AVAILABILITY`, le texte est : `No campsite available ("aucun camping disponible"). Suggest other dates or fewer filters.`

### 6.5 Suivi des réservations (`track`)

Le paramètre `track` du lien YellohResa vient du client API utilisé (§9.2), ce qui permet de distinguer dans YellohResa les réservations venues de Claude et celles venues de ChatGPT. Le serveur MCP ne modifie pas le lien.

---

## 7. Ressource et prompt

### 7.1 Ressource `yelloh://filters/{accommodation_type}`

- Modèle de ressource (`resources/templates/list`) : `yelloh://filters/{accommodation_type}`, avec `accommodation_type` ∈ {`rental`, `slot`}.
- `mimeType: application/json`, contenu identique à la sortie structurée de `get_search_filters`.
- Utilité : un client peut joindre le catalogue au contexte sans appel d'outil. Les deux outils suffisent au fonctionnement ; la ressource est un complément.

### 7.2 Prompt `find_a_camping`

| Argument | Obligatoire | Description |
|---|---|---|
| `dates` | non | Dates souhaitées, en texte libre |
| `people` | non | Nombre de personnes |
| `wishes` | non | Souhaits en texte libre (confort, mer, piscine…) |

Le prompt produit un message utilisateur qui demande au modèle d'appliquer le parcours du §2 avec ces éléments, et de poser les questions manquantes.

---

## 8. Gestion des erreurs

Principe : une erreur **métier ou de saisie** est renvoyée comme résultat d'outil avec `isError: true` et un texte qui dit au LLM **quoi faire**. Une erreur **de protocole** (outil inconnu, JSON-RPC invalide) est une erreur JSON-RPC classique.

| Cas | Réponse de l'outil (`isError: true` sauf mention contraire) | Action attendue du LLM |
|---|---|---|
| Arguments invalides (schéma) | `Invalid arguments: end_date must be after start_date.` | Corriger, ou demander à l'utilisateur |
| API `400 INVALID_DATES` | Message de l'API + `Ask the user for valid dates (not in the past, max 90 nights).` | Demander d'autres dates |
| API `400 INVALID_PEOPLE_COUNT` | `people_count must be between 1 and 10.` | Demander / expliquer |
| API `400 UNKNOWN_FILTER` | `Unknown filter ids for accommodation_type=rental: … Call get_search_filters again and use only the returned ids.` (le cache du catalogue est vidé) | Rappeler `get_search_filters`, puis `search_campings` |
| API `400 INVALID_FILTER_FORMAT` | `Malformed filter ids: … Use ids exactly as returned by get_search_filters.` | Idem |
| API `401` (token expiré ou invalide) | Géré par le serveur MCP : nouveau token et **un** nouvel essai. Si l'échec persiste : `Service temporarily unavailable.` | Informer l'utilisateur |
| API `429 RATE_LIMITED` | `Too many requests, retry in N seconds.` | Réessayer plus tard ou informer |
| API `502`, `504` ou réseau | `Yelloh! Village search is temporarily unavailable. Please try again later.` | Informer l'utilisateur |
| `status: NO_AVAILABILITY` | **Pas une erreur** (`isError: false`), texte du §6.4 | Proposer d'assouplir les critères |

Les messages d'erreur ne contiennent jamais la clé d'API, le token, ni l'URL interne de l'API REST.

---

## 9. Sécurité

### 9.1 Accès au serveur MCP

- **v1 : serveur public, sans authentification de l'utilisateur final** (« authless »). Les outils sont en lecture seule, ne manipulent aucune donnée personnelle et reflètent des informations publiques du site. Claude (connecteurs personnalisés) et ChatGPT acceptent les serveurs MCP distants sans authentification.
- Protection contre les abus :
  - limite de débit par adresse IP sur `/mcp` (plateforme : API Gateway ou Netlify ; plus une limite applicative indicative `MCP_RATE_LIMIT_PER_MINUTE`, défaut 30 par IP) ;
  - taille maximale du corps de requête : 64 Ko ;
  - en-tête `Origin` vérifié contre `MCP_ALLOWED_ORIGINS` quand il est présent, pour se protéger du *DNS rebinding*, comme le recommande la spécification MCP ;
  - HTTPS uniquement.
- Évolution possible (voir P2) : OAuth 2.1, si Yelloh! Village veut identifier les utilisateurs ou proposer plus tard des fonctions liées au compte client.

### 9.2 Accès du serveur MCP à l'API REST

- Le serveur MCP est un **client de l'API REST**, déclaré dans `API_CLIENTS` (spécification de l'API REST, §4.2).
- Il utilise une clé d'API **par plateforme**, pour que le `track` des liens permette de distinguer les réservations venues de chaque assistant :

  | Point d'entrée MCP | Variable de clé | Entrée `API_CLIENTS` suggérée |
  |---|---|---|
  | `/mcp/claude` | `REST_API_KEY_CLAUDE` | `{"client_id":"mcp-claude","track":"claude","rate_limit_per_minute":300,…}` |
  | `/mcp/chatgpt` | `REST_API_KEY_CHATGPT` | `{"client_id":"mcp-chatgpt","track":"chatgpt","rate_limit_per_minute":300,…}` |
  | `/mcp` (générique) | `REST_API_KEY_DEFAULT` | `{"client_id":"mcp-generic","track":"mcp",…}` |

- Les clés sont des secrets : variables d'environnement chiffrées (Netlify) ou AWS Secrets Manager. Elles ne sont jamais journalisées.
- Le token de session de l'API REST (4 h) est gardé **en mémoire d'instance** et renouvelé 5 minutes avant `expires_at`, ou après un `401`. Chaque instance obtient son propre token au démarrage à froid. Rien n'est stocké de façon persistante.

### 9.3 Données et journaux

- Journaux JSON, une ligne par appel d'outil : `request_id`, point d'entrée (claude, chatgpt, generic), nom de l'outil, arguments (critères de séjour uniquement), `status` de la réponse, nombre de résultats, durée, code d'erreur éventuel.
- Ne jamais journaliser : en-têtes `Authorization`, clés, tokens, ni texte libre de la conversation (le serveur ne le reçoit d'ailleurs pas).
- Pas de cookie, pas de stockage de données utilisateur.

---

## 10. Packaging : plugin Claude et app ChatGPT

> Les procédures de publication des deux plateformes évoluent rapidement. Les éléments ci-dessous décrivent la cible ; ils seront **vérifiés dans la documentation en vigueur** au moment de la publication (P4).

### 10.1 Claude : connecteur distant

- URL à déclarer comme connecteur personnalisé (« custom connector ») dans claude.ai : `https://<hôte>/mcp/claude`.
- Nom affiché : **Yelloh-Camping-Search** ; description : « Recherche de campings Yelloh! Village disponibles et liens de réservation ».
- Pour une diffusion à toute l'organisation Yelloh! Village, l'ajout se fait par un administrateur dans les paramètres de l'organisation. Une diffusion publique passe par le répertoire de connecteurs d'Anthropic (P4).

### 10.2 Claude : plugin « Yelloh-Camping-Search »

Le plugin regroupe la déclaration du serveur MCP et une **skill** qui guide la conversation. Arborescence (dossier `plugin-claude/` du dépôt) :

```
plugin-claude/
├── .claude-plugin/
│   └── plugin.json          ← name: "yelloh-camping-search", version, description, auteur
├── .mcp.json                ← serveur "yelloh-camping-search", type "http", url "https://<hôte>/mcp/claude"
└── skills/
    └── yelloh-camping-search/
        └── SKILL.md         ← quand utiliser les outils, règles du §2.2, exemples de requêtes
```

Contenu attendu de `SKILL.md` :
- un en-tête avec `name` et une `description` qui déclenche la skill sur les demandes de camping, de vacances en plein air ou de mobil-home, en particulier Yelloh! Village ;
- les règles du §2.2 ;
- la marche à suivre : `get_search_filters`, puis `search_campings` ;
- un format de présentation des résultats : une liste numérotée avec le nom, le lieu, les étoiles, la note, la disponibilité, puis deux liens Markdown : « Découvrir le camping » (`camping_page`) et « Réserver » (`booking_link`) ;
- deux exemples de conversation, dont un cas « autres dates ».

### 10.3 ChatGPT : app MCP

- Le même serveur, sur le point d'entrée `/mcp/chatgpt`, est déclaré comme app ou connecteur MCP dans ChatGPT : mode développeur pour les tests, puis publication selon la procédure OpenAI en vigueur (P4).
- **v1 : sans interface graphique.** ChatGPT présente les résultats à partir de `content` et `structuredContent`.
- **v2 (prévue)** : un composant d'interface (carrousel de cartes : photo, nom, lieu, disponibilité, bouton « Réserver ») déclaré comme ressource HTML et référencé dans les métadonnées de l'outil `search_campings`, selon le SDK d'apps OpenAI. Le contrat de `structuredContent` du §6.4 est conçu pour alimenter ce composant sans changement.
- Les outils sont en lecture seule (`readOnlyHint: true`) : ChatGPT peut les appeler sans demander de confirmation d'écriture à l'utilisateur.

### 10.4 Métadonnées communes

| Élément | Valeur |
|---|---|
| Nom | Yelloh-Camping-Search |
| Éditeur | Yelloh! Village |
| Icône | Logo Yelloh! Village (format et tailles imposés par chaque plateforme) |
| Description courte (FR) | Trouvez un camping Yelloh! Village disponible à vos dates et réservez en un clic. |
| Description courte (EN) | Find an available Yelloh! Village campsite for your dates and book in one click. |
| Politique de confidentialité | URL publique (P5) : aucune donnée personnelle collectée, critères de recherche journalisés sans identifiant |
| Contact support | À définir (P5) |

---

## 11. Structure du projet, configuration et déploiement

### 11.1 Dépôt et arborescence

Le serveur MCP est un **paquet distinct** dans le dépôt `camping-search-api`, dossier `mcp-server/`, avec son propre `package.json`. Il ne partage pas de code avec l'API REST : il n'en connaît que le contrat HTTP.

```
mcp-server/
├── package.json
├── tsconfig.json
├── netlify.toml / template.yaml       ← déploiement (même principe que l'API REST, §14 de sa spécification)
├── src/
│   ├── server.ts                      ← création du McpServer, enregistrement des outils, ressource et prompt
│   ├── http/
│   │   ├── handler.ts                 ← Streamable HTTP sans état ; routes /mcp, /mcp/claude, /mcp/chatgpt
│   │   └── guards.ts                  ← Origin, taille du corps, limite par IP
│   ├── adapters/
│   │   ├── lambda.ts
│   │   └── netlify.ts
│   ├── tools/
│   │   ├── getSearchFilters.ts        ← §5
│   │   └── searchCampings.ts          ← §6
│   ├── resources/filtersResource.ts   ← §7.1
│   ├── prompts/findACamping.ts        ← §7.2
│   ├── rest/
│   │   ├── restClient.ts              ← appels HTTP, timeouts, 1 nouvel essai sur 401 / 5xx
│   │   ├── tokenManager.ts            ← token par point d'entrée, renouvellement anticipé
│   │   └── catalogCache.ts            ← cache 24 h par accommodation_type
│   ├── format/
│   │   ├── compactCatalog.ts          ← §5.4
│   │   └── searchResult.ts            ← §6.4 (structuredContent + texte)
│   ├── errors.ts                      ← §8
│   ├── config.ts                      ← variables §11.2 validées par zod
│   └── logger.ts
├── test/
│   ├── unit/                          ← formatage, erreurs, tokenManager, catalogCache
│   ├── integration/                   ← client MCP du SDK ↔ serveur ↔ API REST simulée
│   └── evals/                         ← conversations de référence (§13.3)
└── plugin-claude/                     ← §10.2
```

### 11.2 Configuration

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `REST_API_BASE_URL` | **oui** | | URL de l'API REST, ex. `https://api.example/v1` |
| `REST_API_KEY_CLAUDE` | **oui** | | Clé d'API du client `mcp-claude` (secret) |
| `REST_API_KEY_CHATGPT` | **oui** | | Clé d'API du client `mcp-chatgpt` (secret) |
| `REST_API_KEY_DEFAULT` | non | | Clé du point d'entrée `/mcp` générique. S'il n'y en a pas, la route `/mcp` répond 404. |
| `REST_API_TIMEOUT_MS` | non | `12000` | Timeout d'un appel à l'API REST (une recherche R2 peut prendre plusieurs secondes) |
| `CATALOG_TTL_SECONDS` | non | `86400` | Durée de vie du catalogue en cache |
| `TOKEN_RENEW_BEFORE_SECONDS` | non | `300` | Délai de renouvellement anticipé du token |
| `MCP_MAX_RESULTS_LIMIT` | non | `5` | Maximum de `max_results` |
| `MCP_RATE_LIMIT_PER_MINUTE` | non | `30` | Limite indicative par IP et par instance |
| `MCP_ALLOWED_ORIGINS` | non | vide | Origines acceptées quand l'en-tête `Origin` est présent |
| `LOG_LEVEL` | non | `info` | |

### 11.3 Transport et déploiement

- **Transport : Streamable HTTP**, en **mode sans état** du SDK : pas d'identifiant de session MCP (`sessionIdGenerator: undefined`), et un nouveau couple serveur + transport par requête HTTP. Réponses en JSON (`enableJsonResponse: true`), sans flux SSE de longue durée, ce qui convient aux fonctions serverless.
- `GET /mcp` (flux SSE serveur vers client) répond `405 Method Not Allowed`, ce qui est autorisé par la spécification MCP pour un serveur sans notifications.
- Déploiement : Netlify Functions ou AWS Lambda derrière API Gateway HTTP API, timeout de fonction ≥ 20 s (une recherche R2 enchaîne plusieurs appels GraphQL côté API REST).
- Le serveur MCP et l'API REST se déploient séparément : le serveur MCP peut être mis à jour sans toucher à l'API REST.

---

## 12. Exigences non fonctionnelles

| Exigence | Cible |
|---|---|
| Latence de `get_search_filters` (cache chaud) | p95 < 200 ms |
| Latence de `search_campings` | Latence de l'API REST + 300 ms au plus (p95 < 4 s en R1, < 8 s en R2) |
| Taille de la sortie de `get_search_filters` | ≤ 8 Ko de texte (contexte du LLM) |
| Taille de la sortie de `search_campings` | ≤ 4 Ko pour 3 résultats |
| Démarrage à froid | < 800 ms |
| Disponibilité | Celle de la plateforme et de l'API REST |
| Conformité MCP | Version du protocole supportée par le SDK officiel au moment du développement. Négociation de version à l'`initialize`. |
| Couverture de tests | ≥ 85 % sur `src/tools`, `src/format` et `src/rest` |

---

## 13. Tests et recette

### 13.1 Tests unitaires

| # | Module | Cas |
|---|---|---|
| M1 | `compactCatalog` | Le catalogue `specs/exemple-reponse-search-filters-rental.json` donne une sortie compacte ≤ 8 Ko qui contient tous les `id` |
| M2 | `searchResult` | Mapping des champs du §6.4 ; `booking_link` strictement identique à `bookingengine_link` et `camping_page` à `camping_url` ; `camping_code` et `meta` absents |
| M3 | `searchResult` | Texte pour `available`, `alternative_dates`, `alternative_capacity` et `NO_AVAILABILITY` ; chaque résultat du texte contient une ligne `Campsite page:` et une ligne `Booking:` |
| M4 | `errors` | Chaque ligne du tableau §8 donne `isError` et le message attendus |
| M5 | `tokenManager` | Renouvellement anticipé ; un `401` entraîne un nouveau token et un seul nouvel essai ; deux `401` consécutifs donnent une erreur |
| M6 | `catalogCache` | TTL respecté ; vidage du type concerné sur `UNKNOWN_FILTER` |
| M7 | `searchCampings` | Validation du schéma : dates mal formées, `people_count = 11`, `max_results = 6`, propriété inconnue |
| M8 | `http/handler` | Route `/mcp/claude` qui utilise la clé Claude ; `GET /mcp` donne 405 ; `Origin` non autorisé donne 403 ; corps > 64 Ko donne 413 |

### 13.2 Tests d'intégration

- Client MCP du SDK, puis `initialize`, `tools/list` (schémas et annotations conformes au §4), `get_search_filters`, `search_campings`, avec une API REST simulée qui rejoue les réponses de l'annexe D de la spécification REST (R1, R2, R4, `UNKNOWN_FILTER`, `TOKEN_EXPIRED`).
- Vérification avec **MCP Inspector** sur le serveur déployé en recette.

### 13.3 Évaluations conversationnelles (evals)

Un jeu d'au moins 15 conversations de référence, à rejouer dans Claude et dans ChatGPT (mode développeur) avant chaque mise en production. Pour chacune, on vérifie les appels d'outils et la réponse finale :

| # | Demande de l'utilisateur | Attendu |
|---|---|---|
| E1 | « Un camping 4 fleurs avec toboggan du 10 au 17 juillet 2027 pour 4 » | `get_search_filters(rental)`, puis `search_campings` avec `confort_type:F4:4` et `swimming:SR7` ; 3 propositions avec liens |
| E2 | « Un camping au bord de la mer en août » | Le LLM demande les dates exactes et le nombre de personnes avant de chercher |
| E3 | « Un emplacement pour notre camping-car, 2 personnes, du 1er au 8 juin 2027 » | `accommodation_type = slot` dans les deux outils |
| E4 | « 10 personnes, Premium, spa privatif, montagne, toboggan, du 24 au 31 juillet 2027 » | Résultats « autres dates » présentés comme tels, avec les dates proposées |
| E5 | « Une semaine à la campagne en février 2027 pour 2 » | Message « aucun camping disponible » et suggestion d'assouplir les critères |
| E6 | « Combien ça coûte ? » | Pas de prix inventé ; renvoi vers le lien de réservation |
| E7 | « Un camping avec un sanitaire privatif » en location | Le LLM signale que ce critère concerne les emplacements, ou propose de chercher un emplacement |
| E8 | Demande en anglais | Réponse en anglais, avec les libellés `label_en` |

Critère de succès : chaque proposition présentée comporte les deux liens (page du camping et réservation), 100 % des liens présentés sont strictement identiques à ceux renvoyés, 0 prix inventé, et au moins 90 % des cas conformes à l'attendu.

### 13.4 Critères d'acceptation

1. Le connecteur s'ajoute dans Claude avec l'URL `/mcp/claude`, et E1 fonctionne de bout en bout : pour chaque proposition, le lien « Découvrir le camping » ouvre la bonne page sur yellohvillage.fr, et le lien « Réserver » ouvre YellohResa sur le bon camping, aux bonnes dates.
2. Le plugin Claude s'installe et sa skill se déclenche sur une demande de camping.
3. Le serveur est déclaré dans ChatGPT (mode développeur) avec l'URL `/mcp/chatgpt`, et E1 fonctionne.
4. Les liens issus de Claude portent `track=claude`, ceux issus de ChatGPT `track=chatgpt`.
5. Aucune clé ni aucun token n'apparaît dans les journaux ou les réponses des outils.

---

## 14. Points ouverts

| # | Sujet | Hypothèse retenue en attendant |
|---|---|---|
| P1 | Libellés des sections du catalogue | **Tranché** : libellés renvoyés par l'API REST, avec le terme « Localisation » pour la section `location` (et non « Situation géographique », libellé du site), dans les deux spécifications. |
| P2 | Authentification des utilisateurs finaux (OAuth 2.1) | **Tranché** : non en v1. Serveur public en lecture seule, protégé selon le §9.1. |
| P3 | Valeurs de `track` par plateforme | **Tranché** : telles que proposées au §9.2 (`claude`, `chatgpt`, `mcp`). |
| P4 | Procédures et exigences de publication : répertoire de connecteurs Claude, publication d'app ChatGPT | À vérifier dans la documentation en vigueur au moment de la publication |
| P5 | URL de la politique de confidentialité, contact support, icône officielle | À fournir par Yelloh! Village |
| P6 | Interface graphique ChatGPT (carrousel) | v2 |
| P7 | Hébergement | **Tranché** : même plateforme que l'API REST, déploiements séparés (§11.3). |
| P8 | Variante sans outil de catalogue : filtres injectés en `enum` dans le schéma de `search_campings` | **Tranché** : non retenue en v1, car le catalogue diffère selon le type d'hébergement et un `enum` de plus de 80 valeurs alourdirait chaque `tools/list`. |

---

## Annexe A — Exemple de conversation et d'appels d'outils

Données issues du scénario R2 de l'annexe D de la spécification de l'API REST.

**Utilisateur** : « On est 10, on cherche un camping à la montagne, Premium avec spa privatif et toboggan, du 24 au 31 juillet 2027. »

**Appel 1 du LLM** :

```json
{ "name": "get_search_filters", "arguments": { "accommodation_type": "rental" } }
```

Extrait de la sortie : `destination:N306 | Montagne | Mountains`, `confort_type:F5:-1 | Premium | Premium`, `characteristics:C160:160 | Spa privatif | Spa/whirlpool bath`, `swimming:SR7 | Toboggan(s) | Slide(s)`.

**Appel 2 du LLM** :

```json
{ "name": "search_campings",
  "arguments": { "start_date": "2027-07-24", "end_date": "2027-07-31", "people_count": 10, "accommodation_type": "rental",
                 "filters": ["destination:N306", "confort_type:F5:-1", "characteristics:C160:160", "swimming:SR7"] } }
```

Sortie (`content` texte) :

```
3 campsites proposed. None is available on the requested dates (0 available, 5 with alternative dates).
1. Les 3 Vallées — Argeles-Gazost (Hautes-Pyrénées) — 5★ — 8.9/10 — NOT available on requested dates — available 2027-07-25 → 2027-08-01
   Campsite page: https://www.yellohvillage.fr/camping/les_3_vallees
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=25%2F07%2F2027&end=01%2F08%2F2027&sites[]=53&nb_pers=10&lang=fr&track=claude&type=0
2. Le Pré Bas — Murol (Puy de Dôme) — 5★ — 9.1/10 — NOT available on requested dates — available 2027-07-21 → 2027-07-28
   Campsite page: https://www.yellohvillage.fr/camping/le_pre_bas
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=21%2F07%2F2027&end=28%2F07%2F2027&sites[]=1102&nb_pers=10&lang=fr&track=claude&type=0
3. Le Lavedan — Argeles-Gazost (Hautes-Pyrénées) — 4★ — 9.3/10 — available on requested dates in an accommodation for 4 people
   Campsite page: https://www.yellohvillage.fr/camping/le_lavedan
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=24%2F07%2F2027&end=31%2F07%2F2027&sites[]=5072&nb_pers=10&lang=fr&track=claude&type=0
```

**Réponse attendue du LLM** (extrait) : « Aucun camping ne correspond à tous vos critères pour exactement le 24 au 31 juillet, mais voici des alternatives proches :
1. **Les 3 Vallées** (Argelès-Gazost, 5★, 8,9/10), disponible du 25 juillet au 1ᵉʳ août : [Découvrir le camping](https://www.yellohvillage.fr/camping/les_3_vallees) · [Réserver](…)
2. **Le Pré Bas** (Murol, 5★, 9,1/10), disponible du 21 au 28 juillet : [Découvrir le camping](https://www.yellohvillage.fr/camping/le_pre_bas) · [Réserver](…)
3. **Le Lavedan** (Argelès-Gazost, 4★, 9,3/10), disponible à vos dates, mais dans un hébergement prévu pour 4 personnes : [Découvrir le camping](https://www.yellohvillage.fr/camping/le_lavedan) · [Réserver](…)

Les tarifs s'affichent sur la page de réservation. Voulez-vous que je cherche avec d'autres critères ? »
