# Serveur MCP « Yelloh-Camping-Search » — Spécifications fonctionnelles et techniques

> **Destinataire** : ce document doit pouvoir être donné tel quel à Claude Code (ou à un développeur) pour générer le code du serveur MCP. Il s'appuie sur l'API REST décrite dans [`specifications.md`](specifications.md) (v2.13), appelée ci-dessous « **l'API REST** ». Les règles métier (filtres, sélection des campings, liens YellohResa) restent de la responsabilité de l'API REST : le serveur MCP ne les réimplémente pas.

| | |
|---|---|
| Version | 0.9 |
| Date | 22/11/2026 |
| Statut | Brouillon ; restent ouverts P4, P5, P6 et P9 (§14) |
| Runtime cible | Node.js 20 LTS, TypeScript, SDK MCP officiel `@modelcontextprotocol/sdk`, déploiement Netlify Functions ou AWS Lambda |
| Protocole | Model Context Protocol, transport **Streamable HTTP**, mode **sans état** |
| Clients cibles | Claude (claude.ai, apps desktop et mobile, Claude Code), sous forme de connecteur et de plugin « Yelloh-Camping-Search » ; ChatGPT, sous forme d'app ou de connecteur MCP |
| Dépendance | API REST Camping Search v2.13 (`/v1/auth/session`, `/v1/search/filters`, `/v1/search/geography`, `/v1/search/campings`) ; v2.14 pour les règles P7 et P8 de la recherche par lieu |

### Historique

| Version | Changements |
|---|---|
| 0.1 | Initialisation : périmètre, outils MCP, contrats d'entrée et de sortie, sécurité, packaging Claude et ChatGPT, déploiement, tests |
| 0.2 | Points ouverts P1, P2, P3, P7 et P8 tranchés |
| 0.3 | Chaque proposition présentée à l'utilisateur comporte deux liens : la page de présentation du camping (`camping_page`) et la réservation (`booking_link`) |
| 0.4 | Exemples de liens alignés sur l'API REST v2.10 (sans paramètre `lang`) |
| 0.5 | Argument obligatoire `user_language` de `search_campings` : `camping_page` pointe vers le site Yelloh! Village de la langue de l'utilisateur (table de l'API REST v2.11, §10.3) |
| 0.6 | Argument obligatoire `user_language` de `get_search_filters` : libellés du catalogue dans la langue de l'utilisateur (API REST v2.12) ; cache et ressource par langue |
| 0.7 | P7 révisé : un seul projet Netlify publie l'API REST et le serveur MCP (`netlify.toml` et points d'entrée à la racine du dépôt) |
| 0.9 | Lieu introuvable : après un ou plusieurs `search_geography` sans résultat, le LLM appelle **quand même** `search_campings`, sans `camping_ids` (tout le réseau), et le dit à l'utilisateur. P10 tranché (règle « le plus d'entrées » seule, alignée sur l'API REST v2.14). |
| 0.8 | **Recherche par lieu** : nouvel outil `search_geography` (appel de `GET /v1/search/geography`, §6 bis) quand l'utilisateur mentionne un lieu ; nouvel argument `camping_ids` de `search_campings`, transmis dans `campingIDs` de l'API REST ; parcours, règles de conversation, erreurs, tests et évals complétés |

---

## Sommaire

1. [Contexte et objectifs](#1-contexte-et-objectifs)
2. [Parcours utilisateur](#2-parcours-utilisateur)
3. [Architecture](#3-architecture)
4. [Primitives MCP exposées](#4-primitives-mcp-exposées)
5. [Outil `get_search_filters`](#5-outil-get_search_filters)
6. [Outil `search_campings`](#6-outil-search_campings)
6 bis. [Outil `search_geography`](#6-bis-outil-search_geography)
7. [Ressource et prompt](#7-ressource-et-prompt)
8. [Gestion des erreurs](#8-gestion-des-erreurs)
9. [Sécurité](#9-sécurité)
10. [Packaging : plugin Claude et app ChatGPT](#10-packaging--plugin-claude-et-app-chatgpt)
11. [Structure du projet, configuration et déploiement](#11-structure-du-projet-configuration-et-déploiement)
12. [Exigences non fonctionnelles](#12-exigences-non-fonctionnelles)
13. [Tests et recette](#13-tests-et-recette)
14. [Points ouverts](#14-points-ouverts)
- [Annexe A — Exemple de conversation et d'appels d'outils](#annexe-a--exemple-de-conversation-et-dappels-doutils)
- [Annexe B — Exemple de recherche par lieu](#annexe-b--exemple-de-recherche-par-lieu)

---

## 1. Contexte et objectifs

### 1.1 Objectif

Permettre à un utilisateur de **Claude** ou de **ChatGPT** de trouver un camping Yelloh! Village en langage naturel, par exemple « Je cherche un camping 4 fleurs avec toboggan du 10 au 17 juillet pour 4 personnes » ou « un camping en Bretagne avec piscine couverte du 10 au 17 juillet pour 4 ». L'assistant doit lui répondre avec **au plus 3 propositions** (nombre réglable), chacune accompagnée d'un **lien pour réserver** dans le funnel YellohResa.

Le serveur MCP est **l'application tierce** décrite dans la spécification de l'API REST (§1.1 et annexe D de cette spécification). Il traduit l'API REST en outils MCP qu'un LLM sait appeler.

### 1.2 Périmètre v1

| Dans le périmètre | Hors périmètre v1 |
|---|---|
| Consultation du catalogue des filtres (location et emplacement) | Prix « à partir de » (l'API REST ne les fournit pas) |
| Recherche de campings : disponibles, ou disponibles à d'autres dates / pour une autre capacité | Réservation ou paiement dans la conversation (la réservation se fait dans YellohResa, via le lien) |
| Recherche par lieu nommé : pays, région, département, ville, nom de camping (outil `search_geography`) | Recherche par rayon ou par distance (« à moins de 50 km de Nantes ») |
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
   │ 1. get_search_filters(accommodation_type="rental", user_language="fr")
   │      → catalogue : « 4 fleurs » = confort_type:F4:4 ; « Toboggan(s) » = swimming:SR7 …
   │ 2. search_campings(start_date="2027-07-10", end_date="2027-07-17", people_count=4,
   │                    accommodation_type="rental", filters=["confort_type:F4:4","swimming:SR7"])
   │      → 3 campings disponibles + liens YellohResa
   ▼
LLM : présente les 3 campings (nom, ville, étoiles, note) et un lien « Réserver » pour chacun
```

**Parcours avec un lieu** : quand la demande contient une notion géographique, le LLM isole les mots clés du lieu, appelle `search_geography` pour obtenir la liste des campings de la zone, puis passe cette liste à `search_campings` avec les éventuels filtres détectés dans la demande.

```
Utilisateur : « Une location en Bretagne avec piscine couverte du 10 au 17 juillet 2027 pour 4 personnes »
   │
   ▼
LLM (Claude / ChatGPT)
   │ 1. search_geography(keywords="Bretagne", user_language="fr")
   │      → match « Bretagne » ; camping_ids = [2409, 2495, 2541, 31808, 128022, 90890, 2463, 138962]
   │ 2. get_search_filters(accommodation_type="rental", user_language="fr")    (peut être appelé en parallèle de 1)
   │      → « Piscine couverte » = swimming:SR5
   │ 3. search_campings(start_date="2027-07-10", end_date="2027-07-17", people_count=4,
   │                    accommodation_type="rental", filters=["swimming:SR5"],
   │                    camping_ids=[2409, 2495, 2541, 31808, 128022, 90890, 2463, 138962], user_language="fr")
   │      → 3 campings bretons disponibles + liens
   ▼
LLM : « Voici 3 campings en Bretagne… », avec les deux liens par camping
```

### 2.2 Règles de conversation attendues du LLM

Elles sont portées par les descriptions des outils (§5, §6), et par la skill du plugin Claude (§10.2) :

| Situation | Comportement attendu |
|---|---|
| Dates ou nombre de personnes manquants | Les demander à l'utilisateur **avant** d'appeler `search_campings`. Ne pas inventer de valeurs. |
| Dates relatives (« le week-end du 14 juillet », « une semaine en août ») | Les convertir en dates `YYYY-MM-DD`. En cas d'ambiguïté, faire confirmer à l'utilisateur. |
| Type d'hébergement non précisé | Location (`rental`) par défaut. Choisir emplacement (`slot`) si l'utilisateur parle de tente, caravane, camping-car ou emplacement. |
| Critères (confort, piscine, mer, animaux…) | Les faire correspondre aux libellés du catalogue `get_search_filters` du **même** type d'hébergement. N'utiliser **que** des `id` du catalogue. Si un critère n'a pas d'équivalent, le dire à l'utilisateur au lieu de l'ignorer en silence. |
| Lieu nommé (pays, région, département, ville, île, nom de camping : « en Bretagne », « près d'Argelès-sur-Mer », « en Espagne », « à La Marende ») | Appeler `search_geography` avec le **nom du lieu seul**, dans la langue de l'utilisateur, sans préposition ni qualificatif (« dans le sud de la Bretagne » → `Bretagne` ; « près d'Argelès-sur-Mer » → `Argelès-sur-Mer`), au moins 3 caractères. Passer les `camping_ids` reçus **tels quels** dans l'argument `camping_ids` de `search_campings`. |
| Type de paysage (mer, montagne, campagne, rivière, lac, accès direct à la plage…) | **Pas** de `search_geography` : ce sont des filtres du catalogue (`destination:…`, `geo_location:…`). Un lieu **et** un paysage (« la mer en Bretagne ») : `search_geography` pour le lieu, filtre pour le paysage. |
| Plusieurs lieux (« en Bretagne ou en Vendée ») | Un appel `search_geography` par lieu, puis **un seul** `search_campings` avec l'union des `camping_ids` (sans doublon). Un lieu introuvable est laissé de côté, et signalé à l'utilisateur ; si **aucun** lieu n'est trouvé, voir la ligne « Lieu introuvable ». |
| Zone trouvée différente des mots de l'utilisateur (`match.name` « Provence-Alpes-Côte d'Azur » pour « Côte d'Azur » ; `match.type` autre que `geographique`) | Le dire à l'utilisateur en présentant les résultats (« campings en Provence-Alpes-Côte d'Azur »). |
| Lieu introuvable (`status: NO_RESULT`) | Le LLM peut essayer une autre formulation évidente (nom de la région ou du département, orthographe officielle). Si un ou plusieurs appels `search_geography` ne renvoient aucun résultat, il appelle **quand même** `search_campings`, **sans `camping_ids`** (recherche sur tout le réseau), avec les autres critères. En présentant les résultats, il dit que le lieu n'a pas été reconnu et que les propositions couvrent l'ensemble du réseau Yelloh! Village. |
| Résultats « autres dates » | Dire clairement que le camping n'est pas disponible aux dates demandées, et donner les dates proposées. |
| Résultats « autre capacité » | Indiquer la capacité de l'hébergement proposé. |
| Aucun résultat | Transmettre le message « aucun camping disponible » et proposer d'assouplir les critères (dates, filtres). |
| Prix | Ne jamais annoncer de prix : l'outil n'en fournit pas. Renvoyer vers le lien de réservation. |
| Liens de chaque proposition | Donner **deux liens** par camping : la page de présentation du camping (`camping_page`, pour découvrir le camping) et la réservation (`booking_link`, pour réserver aux dates trouvées). Les donner **tels quels**, sans les modifier ni les raccourcir. |
| Langue | Toujours transmettre `user_language` = langue dans laquelle l'utilisateur écrit, **à tous les outils**. Pour `search_geography`, les mots clés doivent être dans cette même langue (« Brittany » avec `en`, « Bretagne » avec `fr`). Les libellés du catalogue sont alors dans cette langue, et le lien « Découvrir le camping » pointe vers le site Yelloh! Village de cette langue (§6.5). |

---

## 3. Architecture

```
┌──────────────────────┐     MCP (Streamable HTTP, JSON-RPC)     ┌───────────────────────────┐
│ Claude / ChatGPT     │ ──────────────────────────────────────▶ │ Serveur MCP               │
│ (client MCP)         │   POST /mcp  (tools/list, tools/call)   │ yelloh-camping-search     │
└──────────────────────┘                                          │  ├─ Outils (§5, §6, 6 bis)│
                                                                  │  ├─ Client API REST       │
                                                                  │  │   (clé d'API + token)  │
                                                                  │  └─ Caches (catalogue,    │
                                                                  │     recherche par lieu)   │
                                                                  └─────────────┬─────────────┘
                                                                                │ HTTPS, Bearer
                                                                                ▼
                                                                  ┌───────────────────────────┐
                                                                  │ API REST Camping Search   │
                                                                  │ /v1/auth/session          │
                                                                  │ /v1/search/filters        │
                                                                  │ /v1/search/geography      │
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
| Cache de la recherche par lieu | Garde en mémoire d'instance les réponses de `/v1/search/geography`, par couple (mots clés normalisés, langue), `GEO_CACHE_TTL_SECONDS` au plus (défaut 24 h, comme le `Cache-Control` de l'API REST), `GEO_CACHE_MAX_ENTRIES` entrées au plus (défaut 500, les plus anciennes sont retirées en premier). Il ne contient que des noms de lieux et des identifiants publics. |

Le serveur MCP est déclaré comme **client** dans `API_CLIENTS` de l'API REST (§4.2 de cette spécification), avec sa propre clé, son `track` et sa limite de débit (§9.2).

---

## 4. Primitives MCP exposées

| Primitive | Nom | Rôle |
|---|---|---|
| Outil | `get_search_filters` | Catalogue des critères de recherche, pour faire correspondre les mots de l'utilisateur aux `id` de filtres |
| Outil | `search_geography` | Recherche par lieu : mots clés d'un lieu → identifiants des campings de la zone, à passer à `search_campings` |
| Outil | `search_campings` | Recherche de campings et liens de réservation, éventuellement restreinte aux campings d'un lieu |
| Ressource | `yelloh://filters/{accommodation_type}/{language}` | Même catalogue que `get_search_filters`, pour les clients qui exploitent les ressources (§7.1) |
| Prompt | `find_a_camping` | Prompt guidé qui lance une recherche à partir de critères (§7.2) |

Informations déclarées à l'initialisation (`initialize`) :

| Champ | Valeur |
|---|---|
| `serverInfo.name` | `yelloh-camping-search` |
| `serverInfo.title` | `Yelloh! Village – Recherche de camping` |
| `serverInfo.version` | Version du `package.json` |
| `capabilities` | `tools`, `resources`, `prompts` (sans `listChanged` : la liste est fixe) |
| `instructions` | Texte court qui résume les règles du §2.2 (≤ 1 500 caractères), pour les clients qui l'injectent dans le contexte du modèle |

Annotations des trois outils : `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`. `idempotentHint` vaut `true` pour `get_search_filters` et `search_geography`, et `false` pour `search_campings`, car le tirage au hasard peut donner des résultats différents d'un appel à l'autre.

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
selected filters must all be satisfied. Pass user_language = the language the user is writing in: labels are
returned in that language (ids are the same in every language).
```

Les descriptions des outils et des champs sont rédigées **en anglais**, langue la mieux suivie par les LLM. Les libellés renvoyés (`label`) sont dans la langue de l'utilisateur (`user_language`), traduits par le GraphQL. Le catalan reçoit les libellés espagnols, et une langue non gérée reçoit l'anglais (table de l'API REST, §10.3). `label_en` reste toujours en anglais.

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
    },
    "user_language": {
      "type": "string",
      "pattern": "^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$",
      "description": "Language the user is writing in, as an ISO 639-1 / BCP 47 code (e.g. \"fr\", \"en\", \"de\"). Labels are returned in this language."
    }
  },
  "required": ["user_language"],
  "additionalProperties": false
}
```

Contrairement à l'API REST, où il est obligatoire, `accommodation_type` est facultatif ici, avec `rental` par défaut. Le LLM a ainsi un argument de moins à fournir dans le cas le plus fréquent.

### 5.3 Traitement

1. Normaliser `user_language` en sous-étiquette principale, en minuscules (`de-AT` → `de`). Lire le catalogue dans le cache de l'instance, avec la clé **(accommodation_type, langue normalisée)**, s'il a moins de `CATALOG_TTL_SECONDS` (défaut 86 400 s).
2. Sinon, appeler `GET /v1/search/filters?accommodation_type=…&user_language=…` sur l'API REST et mettre le résultat en cache. C'est l'API REST qui choisit `gql-locale` : le serveur MCP n'a aucune table de langues.
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
If the user names a place (country, region, department, city, island, campsite name), first call search_geography
and pass its camping_ids unchanged in camping_ids (union of the lists if the user names several places). If no place
is found (status "NO_RESULT"), still search, without camping_ids (whole network), and say so to the user.
Each result has availability_type:
- "available": available on the requested dates;
- "alternative_dates": NOT available on the requested dates, but available on alternative_begin_date /
  alternative_end_date — tell the user explicitly;
- "alternative_capacity": available on the requested dates in an accommodation for alternative_capacity people.
Always pass user_language = the language the user is writing in (e.g. "fr", "en", "de").
For each result, always give BOTH links exactly as returned: camping_page (campsite description page) and booking_link
(booking engine, pre-filled with the dates and number of people). No prices are returned: never state or estimate a price.
If status is "NO_AVAILABILITY", tell the user that no campsite is available and suggest relaxing dates or filters.
Results are randomly picked among matching campsites: calling again may return other proposals.
```

### 6.2 Entrée (`inputSchema`)

```json
{
  "type": "object",
  "required": ["start_date", "end_date", "people_count", "user_language"],
  "properties": {
    "start_date": { "type": "string", "format": "date", "description": "Arrival date, YYYY-MM-DD." },
    "end_date": { "type": "string", "format": "date", "description": "Departure date, YYYY-MM-DD, after start_date. Max 90 nights." },
    "people_count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "Number of people, babies included." },
    "accommodation_type": { "type": "string", "enum": ["rental", "slot"], "default": "rental",
                            "description": "Must match the accommodation_type used with get_search_filters." },
    "filters": { "type": "array", "items": { "type": "string" }, "maxItems": 30, "default": [],
                 "description": "Filter ids returned by get_search_filters, unchanged (e.g. \"confort_type:F4:4\")." },
    "max_results": { "type": "integer", "minimum": 1, "maximum": 5, "default": 3,
                     "description": "Maximum number of proposals. Keep the default unless the user asks for more or fewer." },
    "camping_ids": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "maxItems": 200, "default": [],
                     "description": "Campsite ids returned by search_geography (camping_ids), unchanged, to restrict the search to a place. Empty = whole Yelloh! Village network. Never invent ids." },
    "user_language": { "type": "string", "pattern": "^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$",
                       "description": "Language the user writes in, as an ISO 639-1 / BCP 47 code (e.g. \"fr\", \"en\", \"de\", \"es\", \"ca\", \"nl\", \"it\"). Selects the language of the camping_page link." }
  },
  "additionalProperties": false
}
```

Les bornes reprennent celles de l'API REST : `MAX_PEOPLE = 10`, `MAX_STAY_NIGHTS = 90` et `MAX_CAMPING_IDS = 200`. Le maximum de `max_results` est volontairement limité à 5 côté MCP (`MCP_MAX_RESULTS_LIMIT`), pour garder une réponse lisible dans une conversation. Le serveur MCP ne refait pas les contrôles de l'API REST au-delà du schéma : les erreurs de l'API REST sont traduites (§8).

### 6.3 Traitement

1. Valider les arguments avec le schéma (zod). En cas d'échec, renvoyer un résultat d'outil `isError: true` avec un message actionnable (§8).
2. Appeler `GET /v1/search/campings` avec `startDate`, `endDate`, `peopleCount`, `accommodation_type`, `filters` (joints par `,`), `maxResults`, `user_language` et, si `camping_ids` n'est pas vide, `campingIDs` (identifiants dédoublonnés, joints par `,`). Le serveur MCP ne vérifie pas que les identifiants viennent de `search_geography` : c'est l'API REST qui les applique (spécification REST, §8.9).
3. Si l'API répond `400 UNKNOWN_FILTER` : vider le cache du catalogue de ce type (toutes langues), puis renvoyer au LLM une erreur qui l'invite à rappeler `get_search_filters` (§8). Le serveur ne corrige pas les filtres lui-même, car il ne peut pas deviner l'intention de l'utilisateur.
4. Transformer la réponse (§6.4).

### 6.4 Sortie

`structuredContent`, conforme à un `outputSchema` déclaré. On reprend la réponse de l'API REST, allégée et renommée pour le LLM :

```json
{
  "status": "OK",
  "message": null,
  "search": { "start_date": "2027-07-10", "end_date": "2027-07-17", "nights": 7, "people_count": 4,
              "accommodation_type": "rental", "filters": ["confort_type:F4:4", "swimming:SR7"], "camping_ids_count": 0 },
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
      "booking_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4&track=claude&type=0",
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
| `search.camping_ids_count` | nombre d'éléments de `search.camping_ids` | `0` = tout le réseau. La liste elle-même n'est pas renvoyée au LLM (jusqu'à 200 nombres sans intérêt pour la conversation) |
| `rating_out_of_10` | `rating` | Nom explicite pour le LLM |
| `alternative_begin_date`, `alternative_end_date` | `alternative_begin_date_availability`, `alternative_end_date_availability` | Noms raccourcis |
| `booking_link` | `bookingengine_link` | Recopié **sans modification** |
| `camping_page` | `camping_url` | Page de présentation du camping, sur le site Yelloh! Village de la langue de l'utilisateur (`user_language`, voir §6.5), recopiée **sans modification**. Toujours présentée à l'utilisateur avec `booking_link`. |
| — | `camping_code`, `latitude`, `longitude`, `is_new`, `meta` | Non transmis au LLM (inutiles à la conversation) |

`content` (texte) : un résumé lisible, pour les clients qui ignorent `structuredContent` et pour guider la mise en forme. Exemple :

```
3 campsites found (70 match the criteria). Show them to the user, each with its campsite page link and its booking link.
1. La Marende — Argelès-sur-Mer (Pyrénées Orientales) — 5★ — 9.0/10 — available 2027-07-10 → 2027-07-17
   Campsite page: https://www.yellohvillage.fr/camping/la_marende
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027…&type=0
2. …
```

Pour un résultat `alternative_dates`, la ligne indique `NOT available on requested dates — available 2027-07-25 → 2027-08-01`. Pour `NO_AVAILABILITY`, le texte est : `No campsite available ("aucun camping disponible"). Suggest other dates or fewer filters.` Si la recherche était restreinte à un lieu (`camping_ids` non vide), il ajoute : `The search was restricted to the place found by search_geography: also suggest a wider or nearby area.`

### 6.5 Langue de la page du camping (`user_language`)

Le serveur MCP ne voit pas le navigateur de l'utilisateur. La langue dans laquelle l'utilisateur écrit à l'assistant sert donc d'indicateur : le LLM la transmet dans `user_language`, et le serveur MCP la passe telle quelle à l'API REST. L'API choisit alors la base du lien selon sa table de correspondance (spécification REST, §10.3) :

| Langue de la conversation | Exemple de `camping_page` |
|---|---|
| français (`fr`) | `https://www.yellohvillage.fr/camping/la_marende` |
| anglais (`en`) | `https://www.yellohvillage.co.uk/camping/la_marende` |
| allemand (`de`) | `https://www.yellohvillage.de/camping/la_marende` |
| espagnol (`es`) ou catalan (`ca`) | `https://www.yellohvillage.es/camping/la_marende` |
| néerlandais (`nl`) | `https://www.yellohvillage.nl/camping/la_marende` |
| italien (`it`) | `https://www.yellohvillage.it/camping/la_marende` |
| autre langue | `https://www.yellohvillage.co.uk/camping/la_marende` |

L'argument est obligatoire dans le schéma MCP, pour que le LLM le fournisse toujours. Le serveur MCP ne garde pas de copie de la table : elle n'existe que dans l'API REST.

Le lien de réservation n'est pas concerné : YellohResa suit directement la langue du navigateur.

### 6.6 Suivi des réservations (`track`)

Le paramètre `track` du lien YellohResa vient du client API utilisé (§9.2), ce qui permet de distinguer dans YellohResa les réservations venues de Claude et celles venues de ChatGPT. Le serveur MCP ne modifie pas le lien.

---

## 6 bis. Outil `search_geography`

Appelé par le LLM quand il détecte une **notion géographique** dans la demande de l'utilisateur (un lieu nommé). Il isole les mots clés du lieu, obtient avec cet outil la liste des campings de la zone, puis passe cette liste et les éventuels filtres détectés dans la demande à `search_campings` (parcours du §2.1).

### 6 bis.1 Description destinée au LLM

```
Finds the Yelloh! Village campsites located in a place named by the user (country, region, department, city,
island, or a campsite name) and returns their ids (camping_ids). Call it whenever the user mentions a place,
BEFORE search_campings, then pass camping_ids unchanged in the camping_ids argument of search_campings, together
with the filters matching the other criteria of the request.
keywords: the place name only, in the user's language, without prepositions or qualifiers ("Bretagne",
"Argelès-sur-Mer", "Espagne"; not "dans le sud de la Bretagne"); at least 3 characters.
Do NOT use it for landscape types (sea, mountain, countryside, river, lake, beach access): they are filters of
get_search_filters. If the user names several places, call it once per place and merge the camping_ids.
The result gives the matched place (match.name, match.type): tell the user which area was searched if it differs
from their words. If status is "NO_RESULT", the place is unknown: you may try another obvious wording (region or
department name, official spelling); if no place is found, STILL call search_campings, without camping_ids (whole
Yelloh! Village network), and tell the user that the place was not recognized and the proposals are not limited to it.
Pass user_language = the language the user is writing in: place names are searched in that language.
```

### 6 bis.2 Entrée (`inputSchema`)

```json
{
  "type": "object",
  "required": ["keywords", "user_language"],
  "properties": {
    "keywords": { "type": "string", "minLength": 3, "maxLength": 100,
                  "description": "Place name only, in the user's language (e.g. \"Bretagne\", \"Argelès-sur-Mer\", \"Spain\"). At least 3 characters." },
    "user_language": { "type": "string", "pattern": "^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$",
                       "description": "Language the user writes in, as an ISO 639-1 / BCP 47 code (e.g. \"fr\", \"en\", \"de\"). Place names are searched in this language." }
  },
  "additionalProperties": false
}
```

Le schéma refuse aussi une chaîne de moins de 3 caractères **après suppression des espaces** en début et en fin (`"  ab "`), pour reprendre la règle de l'API REST (`GEO_MIN_KEYWORDS_LENGTH`).

### 6 bis.3 Traitement

1. Valider les arguments (zod). Normaliser `keywords` comme l'API REST (espaces en début et en fin supprimés, espaces multiples réduits à un seul) et `user_language` en sous-étiquette principale en minuscules.
2. Lire le cache de recherche par lieu (§3) avec la clé (mots clés normalisés en minuscules, langue normalisée). S'il a moins de `GEO_CACHE_TTL_SECONDS`, renvoyer la sortie en cache.
3. Sinon, appeler `GET /v1/search/geography?keywords=…&user_language=…` sur l'API REST :
   - `200` : mettre en cache, puis transformer (§6 bis.4) ;
   - `404 NO_RESULT` : mettre aussi en cache (la réponse est stable), puis renvoyer la sortie `NO_RESULT` (§6 bis.4), **sans** `isError` ;
   - autre erreur : §8.
4. Le serveur MCP n'applique **aucune** règle de sélection : il recopie le choix de l'API REST (résultat qui a le plus de campings).

### 6 bis.4 Sortie

`structuredContent`, conforme à un `outputSchema` déclaré.

Lieu trouvé (données réelles, 22/11/2026) :

```json
{
  "status": "OK",
  "keywords": "Bretagne",
  "match": { "name": "Bretagne", "type": "geographique", "camping_count": 8 },
  "camping_ids": [2409, 2495, 2541, 31808, 128022, 90890, 2463, 138962],
  "other_matches": [
    { "name": "Où partir en camping en Bretagne en 2026 ?", "type": "poi", "camping_count": 5 },
    { "name": "Ile de Batz", "type": "poi", "camping_count": 1 }
  ]
}
```

Lieu introuvable :

```json
{ "status": "NO_RESULT", "keywords": "Bretagne sud", "match": null, "camping_ids": [], "other_matches": [] }
```

| Champ MCP | Source dans l'API REST | Commentaire |
|---|---|---|
| `status` | `OK` en `200` ; `NO_RESULT` en `404 NO_RESULT` | |
| `keywords` | `keywords` | Mots clés normalisés |
| `match.name`, `match.type`, `match.camping_count` | `match.*` | `content_id` n'est pas transmis |
| `camping_ids` | `camping_ids` | Recopiés **sans modification**, dans l'ordre |
| `other_matches` | `other_matches` (sans `content_id`), **au plus 5** | Permet au LLM de proposer une zone voisine |
| — | `user_language`, `locale`, `meta` | Non transmis |

`content` (texte) :

```
Place found: Bretagne (geographique) — 8 campsites.
Pass these camping_ids unchanged to search_campings: [2409,2495,2541,31808,128022,90890,2463,138962]
Other matches: "Où partir en camping en Bretagne en 2026 ?" (poi, 5), "Ile de Batz" (poi, 1)
```

Pour `NO_RESULT` : `No place found for "Bretagne sud" ("no result"). You may try another wording (region or department name). If no place is found, still call search_campings without camping_ids (whole network) and tell the user the place was not recognized.`

Taille : « France » donne 91 identifiants, soit environ 600 caractères ; la sortie reste sous 2 Ko.

---

## 7. Ressource et prompt

### 7.1 Ressource `yelloh://filters/{accommodation_type}/{language}`

- Modèle de ressource (`resources/templates/list`) : `yelloh://filters/{accommodation_type}/{language}`, avec `accommodation_type` ∈ {`rental`, `slot`} et `language` un code de langue (ex. `fr`, `de`).
- `mimeType: application/json`, contenu identique à la sortie structurée de `get_search_filters`.
- Utilité : un client peut joindre le catalogue au contexte sans appel d'outil. Les outils suffisent au fonctionnement ; la ressource est un complément.

### 7.2 Prompt `find_a_camping`

| Argument | Obligatoire | Description |
|---|---|---|
| `dates` | non | Dates souhaitées, en texte libre |
| `people` | non | Nombre de personnes |
| `wishes` | non | Souhaits en texte libre (confort, mer, piscine…) |
| `place` | non | Lieu souhaité, en texte libre (« Bretagne », « Espagne »…) : le prompt demande alors d'appeler `search_geography` (§6 bis) |

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
| API `400 INVALID_KEYWORDS` (`search_geography`) | `The place keywords must be 3 to 100 characters long. Use the place name only.` | Reformuler le nom du lieu |
| API `404 NO_RESULT` (`search_geography`) | **Pas une erreur** (`isError: false`) : sortie `status: "NO_RESULT"` et texte du §6 bis.4 | Éventuellement une autre formulation ; sinon `search_campings` sans `camping_ids` (tout le réseau), en prévenant l'utilisateur |
| API `400 INVALID_CAMPING_IDS` (`search_campings`) | `Invalid camping_ids: … Pass the camping_ids returned by search_geography, unchanged.` | Rappeler `search_geography` |
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

- Journaux JSON, une ligne par appel d'outil : `request_id`, point d'entrée (claude, chatgpt, generic), nom de l'outil, arguments (critères de séjour uniquement), `status` de la réponse, nombre de résultats, durée, code d'erreur éventuel. Pour `search_geography` : mots clés, `match.name` et `camping_count` (un nom de lieu n'est pas une donnée personnelle) ; servi depuis le cache ou non. Pour `search_campings` : nombre d'éléments de `camping_ids`, pas la liste.
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
- la marche à suivre : `search_geography` si un lieu est nommé et `get_search_filters` si des critères sont donnés, puis `search_campings` ;
- un format de présentation des résultats : une liste numérotée avec le nom, le lieu, les étoiles, la note, la disponibilité, puis deux liens Markdown : « Découvrir le camping » (`camping_page`) et « Réserver » (`booking_link`) ;
- trois exemples de conversation, dont un cas « autres dates » et un cas avec un lieu (annexe B).

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
│                                      (déploiement : netlify.toml et netlify/functions/mcp.mts à la racine du dépôt, §11.3)
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
│   │   ├── searchCampings.ts          ← §6
│   │   └── searchGeography.ts         ← §6 bis
│   ├── resources/filtersResource.ts   ← §7.1
│   ├── prompts/findACamping.ts        ← §7.2
│   ├── rest/
│   │   ├── restClient.ts              ← appels HTTP, timeouts, 1 nouvel essai sur 401 / 5xx
│   │   ├── tokenManager.ts            ← token par point d'entrée, renouvellement anticipé
│   │   ├── catalogCache.ts            ← cache 24 h par (accommodation_type, langue)
│   │   └── geographyCache.ts          ← cache 24 h par (mots clés, langue), taille bornée
│   ├── format/
│   │   ├── compactCatalog.ts          ← §5.4
│   │   ├── searchResult.ts            ← §6.4 (structuredContent + texte)
│   │   └── geographyResult.ts         ← §6 bis.4
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
| `GEO_CACHE_TTL_SECONDS` | non | `86400` | Durée de vie d'une recherche par lieu en cache (`0` désactive le cache) |
| `GEO_CACHE_MAX_ENTRIES` | non | `500` | Nombre maximum de recherches par lieu en cache, par instance |
| `TOKEN_RENEW_BEFORE_SECONDS` | non | `300` | Délai de renouvellement anticipé du token |
| `MCP_MAX_RESULTS_LIMIT` | non | `5` | Maximum de `max_results` |
| `MCP_RATE_LIMIT_PER_MINUTE` | non | `30` | Limite indicative par IP et par instance |
| `MCP_ALLOWED_ORIGINS` | non | vide | Origines acceptées quand l'en-tête `Origin` est présent |
| `LOG_LEVEL` | non | `info` | |

### 11.3 Transport et déploiement

- **Transport : Streamable HTTP**, en **mode sans état** du SDK : pas d'identifiant de session MCP (`sessionIdGenerator: undefined`), et un nouveau couple serveur + transport par requête HTTP. Réponses en JSON (`enableJsonResponse: true`), sans flux SSE de longue durée, ce qui convient aux fonctions serverless.
- `GET /mcp` (flux SSE serveur vers client) répond `405 Method Not Allowed`, ce qui est autorisé par la spécification MCP pour un serveur sans notifications.
- Déploiement : Netlify Functions ou AWS Lambda derrière API Gateway HTTP API, timeout de fonction ≥ 20 s (une recherche R2 enchaîne plusieurs appels GraphQL côté API REST).
- Le serveur MCP et l'API REST sont publiés par le **même projet Netlify** (v0.7) : un seul `netlify.toml` à la racine du dépôt, deux fonctions (`netlify/functions/api.mts` sur `/v1/*`, `netlify/functions/mcp.mts` sur `/mcp`, `/mcp/*` et `/health`). Chaque déploiement republie donc les deux, après les tests des deux projets. Le code reste dans deux paquets distincts (`api-rest/`, `mcp-server/`).

---

## 12. Exigences non fonctionnelles

| Exigence | Cible |
|---|---|
| Latence de `get_search_filters` (cache chaud) | p95 < 200 ms |
| Latence de `search_campings` | Latence de l'API REST + 300 ms au plus (p95 < 4 s en R1, < 8 s en R2) |
| Latence de `search_geography` | p95 < 2 s (cache froid), < 200 ms (cache chaud) |
| Taille de la sortie de `search_geography` | ≤ 2 Ko |
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
| M6 | `catalogCache` | TTL respecté ; clés distinctes par (type, langue), `de-AT` et `de` partageant la même entrée ; vidage de toutes les langues du type concerné sur `UNKNOWN_FILTER` |
| M10 | `getSearchFilters` | `user_language` transmis à l'API REST ; absent ou mal formé → erreur de validation du schéma |
| M7 | `searchCampings` | Validation du schéma : dates mal formées, `people_count = 11`, `max_results = 6`, `user_language` absent ou mal formé, propriété inconnue |
| M9 | `restClient` | `user_language` transmis tel quel à l'API REST ; `camping_page` recopié depuis `camping_url` sans modification |
| M11 | `searchGeography` | `keywords` de moins de 3 caractères (y compris `"  ab "`), de plus de 100, ou `user_language` absent → erreur de validation, sans appel à l'API REST ; `keywords` et `user_language` transmis à `GET /v1/search/geography` ; `404 NO_RESULT` → `status: "NO_RESULT"` avec `isError: false` ; `400 INVALID_KEYWORDS` → `isError: true` |
| M12 | `geographyResult` | Mapping du §6 bis.4 : `camping_ids` strictement identiques à ceux de l'API REST, dans le même ordre ; `content_id`, `locale` et `meta` absents ; `other_matches` limité à 5 ; le texte contient la liste des identifiants |
| M13 | `geographyCache` | Deuxième appel avec `Bretagne` puis ` bretagne ` (même langue) → un seul appel à l'API REST ; `Bretagne` en `fr` et en `en` → deux entrées ; `NO_RESULT` mis en cache ; TTL et `GEO_CACHE_MAX_ENTRIES` respectés ; `GEO_CACHE_TTL_SECONDS=0` → aucun cache |
| M14 | `searchCampings` | `camping_ids: [2409, 2495, 2409]` → `campingIDs=2409,2495` transmis à l'API REST ; `camping_ids` absent ou vide → pas de `campingIDs` ; 201 identifiants ou identifiant ≤ 0 → erreur de validation ; `search.camping_ids_count` renseigné ; texte `NO_AVAILABILITY` avec la phrase sur la zone si `camping_ids` est non vide ; `400 INVALID_CAMPING_IDS` traduit (§8) |
| M8 | `http/handler` | Route `/mcp/claude` qui utilise la clé Claude ; `GET /mcp` donne 405 ; `Origin` non autorisé donne 403 ; corps > 64 Ko donne 413 |

### 13.2 Tests d'intégration

- Client MCP du SDK, puis `initialize`, `tools/list` (trois outils, schémas et annotations conformes au §4), `get_search_filters`, `search_geography`, `search_campings`, avec une API REST simulée qui rejoue les réponses de l'annexe D de la spécification REST (R1, R2, R4, `UNKNOWN_FILTER`, `TOKEN_EXPIRED`, recherche par lieu D.9, `NO_RESULT`).
- Enchaînement `search_geography` → `search_campings` : les `camping_ids` de la première sortie, passés tels quels, arrivent à l'API REST dans `campingIDs`, sans modification.
- Vérification avec **MCP Inspector** sur le serveur déployé en recette.

### 13.3 Évaluations conversationnelles (evals)

Un jeu d'au moins 15 conversations de référence, à rejouer dans Claude et dans ChatGPT (mode développeur) avant chaque mise en production. Pour chacune, on vérifie les appels d'outils et la réponse finale :

| # | Demande de l'utilisateur | Attendu |
|---|---|---|
| E1 | « Un camping 4 fleurs avec toboggan du 10 au 17 juillet 2027 pour 4 » | `get_search_filters(rental, fr)`, puis `search_campings` avec `confort_type:F4:4` et `swimming:SR7` ; 3 propositions avec liens |
| E2 | « Un camping au bord de la mer en août » | Le LLM demande les dates exactes et le nombre de personnes avant de chercher |
| E3 | « Un emplacement pour notre camping-car, 2 personnes, du 1er au 8 juin 2027 » | `accommodation_type = slot` dans les deux outils |
| E4 | « 10 personnes, Premium, spa privatif, montagne, toboggan, du 24 au 31 juillet 2027 » | Résultats « autres dates » présentés comme tels, avec les dates proposées |
| E5 | « Une semaine à la campagne en février 2027 pour 2 » | Message « aucun camping disponible » et suggestion d'assouplir les critères |
| E6 | « Combien ça coûte ? » | Pas de prix inventé ; renvoi vers le lien de réservation |
| E7 | « Un camping avec un sanitaire privatif » en location | Le LLM signale que ce critère concerne les emplacements, ou propose de chercher un emplacement |
| E8 | Demande en anglais | Réponse en anglais ; `user_language = "en"` dans les deux outils, libellés du catalogue en anglais ; liens « Discover the campsite » vers `www.yellohvillage.co.uk` |
| E9 | Demande en allemand, puis en catalan | `user_language` = `de`, puis `ca`, dans les deux outils ; libellés du catalogue en allemand (« Rutsche(n) »), puis en espagnol (« Tobogan(es) ») ; `camping_page` vers `www.yellohvillage.de`, puis `www.yellohvillage.es` |
| E10 | « Un camping en Bretagne avec piscine couverte du 10 au 17 juillet 2027 pour 4 » | `search_geography(keywords="Bretagne", user_language="fr")`, `get_search_filters`, puis `search_campings` avec `camping_ids` reçus et `swimming:SR5` ; 3 campings bretons avec leurs deux liens |
| E11 | « Un camping au bord de la mer en Vendée du 10 au 17 juillet 2027 pour 4 » | `search_geography(keywords="Vendée")` pour le lieu **et** filtre `destination:N305` (Mer) pour le paysage ; pas de `search_geography("mer")` |
| E12 | « Un camping à la montagne du 10 au 17 juillet 2027 pour 2 » | **Pas** de `search_geography` : filtre `destination:N306` seulement |
| E13 | « En Bretagne ou en Vendée, du 10 au 17 juillet 2027, pour 4 » | Deux `search_geography`, puis un seul `search_campings` avec l'union des `camping_ids` |
| E14 | « Un camping dans le sud de la Bretagne… » puis « Un camping à Paris du 10 au 17 juillet 2027 pour 2 » | `keywords = "Bretagne"` (nom de lieu seul) ; pour Paris : `search_geography` → `NO_RESULT` (éventuellement une 2ᵉ formulation, sans résultat non plus), puis **`search_campings` sans `camping_ids`** ; le LLM présente les propositions en précisant que Paris n'a pas été reconnu et qu'elles couvrent tout le réseau |
| E15 | « A campsite in Brittany from 10 to 17 July 2027 for 4 » | `search_geography(keywords="Brittany", user_language="en")` ; mêmes campings que E10 ; réponse en anglais |
| E16 | « Un camping sur la Côte d'Azur… » | Le LLM précise que la recherche porte sur la région Provence-Alpes-Côte d'Azur (`match.name`) |
| E17 | « En Bretagne ou à Paris, du 10 au 17 juillet 2027, pour 4 » | `search_geography` pour les deux lieux ; Paris → `NO_RESULT` ; `search_campings` avec les seuls `camping_ids` de la Bretagne ; le LLM signale que Paris n'a pas été reconnu |

Critère de succès : chaque proposition présentée comporte les deux liens (page du camping et réservation), 100 % des liens présentés sont strictement identiques à ceux renvoyés, 0 prix inventé, 0 identifiant de camping inventé (les `camping_ids` passés à `search_campings` viennent tous d'un appel `search_geography`), et après un `NO_RESULT`, toujours un appel `search_campings` sur tout le réseau, et au moins 90 % des cas conformes à l'attendu.

### 13.4 Critères d'acceptation

1. Le connecteur s'ajoute dans Claude avec l'URL `/mcp/claude`, et E1 fonctionne de bout en bout : pour chaque proposition, le lien « Découvrir le camping » ouvre la bonne page sur yellohvillage.fr, et le lien « Réserver » ouvre YellohResa sur le bon camping, aux bonnes dates.
2. Le plugin Claude s'installe et sa skill se déclenche sur une demande de camping.
3. Le serveur est déclaré dans ChatGPT (mode développeur) avec l'URL `/mcp/chatgpt`, et E1 fonctionne.
4. Les liens issus de Claude portent `track=claude`, ceux issus de ChatGPT `track=chatgpt`.
5. Aucune clé ni aucun token n'apparaît dans les journaux ou les réponses des outils.
6. E10 fonctionne de bout en bout dans Claude et dans ChatGPT : les 3 propositions sont des campings bretons, et les journaux montrent `search_geography` puis `search_campings` avec 8 identifiants.

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
| P7 | Hébergement | **Tranché (révisé en v0.7)** : même projet Netlify que l'API REST (`camping-search-api`). Un seul `netlify.toml` à la racine du dépôt construit et teste les deux projets ; deux fonctions sont publiées (`/v1/*` pour l'API, `/mcp/*` pour le MCP), sur le même domaine (§11.3). |
| P8 | Variante sans outil de catalogue : filtres injectés en `enum` dans le schéma de `search_campings` | **Tranché** : non retenue en v1, car le catalogue diffère selon le type d'hébergement et un `enum` de plus de 80 valeurs alourdirait chaque `tools/list`. |
| P9 | Variante sans outil dédié : mots clés de lieu passés directement à `search_campings` (argument `place`), le serveur MCP appelant lui-même `/v1/search/geography` | Non retenue : l'outil séparé permet au LLM de voir la zone trouvée (`match.name`), de reformuler en cas de `NO_RESULT` et de réunir plusieurs lieux. À revoir si les évals montrent des appels oubliés. |
| P10 | Résultats non géographiques de la recherche par lieu (thème « Mer », article de blog, événement, camping) | **Tranché (v0.9)**, comme les points P7 et P8 de la spécification REST v2.14 : « le plus d'entrées » est la seule règle, appliquée par l'API REST ; un camping n'est retenu que s'il est le seul résultat. La description de l'outil interdit `search_geography` pour les types de paysage, et le LLM indique la zone trouvée (`match.name`) quand elle diffère des mots de l'utilisateur. |

---

## Annexe A — Exemple de conversation et d'appels d'outils

Données issues du scénario R2 de l'annexe D de la spécification de l'API REST.

**Utilisateur** : « On est 10, on cherche un camping à la montagne, Premium avec spa privatif et toboggan, du 24 au 31 juillet 2027. »

**Appel 1 du LLM** :

```json
{ "name": "get_search_filters", "arguments": { "accommodation_type": "rental", "user_language": "fr" } }
```

Extrait de la sortie : `destination:N306 | Montagne | Mountains`, `confort_type:F5:-1 | Premium | Premium`, `characteristics:C160:160 | Spa privatif | Spa/whirlpool bath`, `swimming:SR7 | Toboggan(s) | Slide(s)`.

**Appel 2 du LLM** :

```json
{ "name": "search_campings",
  "arguments": { "start_date": "2027-07-24", "end_date": "2027-07-31", "people_count": 10, "accommodation_type": "rental",
                 "filters": ["destination:N306", "confort_type:F5:-1", "characteristics:C160:160", "swimming:SR7"],
                 "user_language": "fr" } }
```

Sortie (`content` texte) :

```
3 campsites proposed. None is available on the requested dates (0 available, 5 with alternative dates).
1. Les 3 Vallées — Argeles-Gazost (Hautes-Pyrénées) — 5★ — 8.9/10 — NOT available on requested dates — available 2027-07-25 → 2027-08-01
   Campsite page: https://www.yellohvillage.fr/camping/les_3_vallees
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=25%2F07%2F2027&end=01%2F08%2F2027&sites[]=53&nb_pers=10&track=claude&type=0
2. Le Pré Bas — Murol (Puy de Dôme) — 5★ — 9.1/10 — NOT available on requested dates — available 2027-07-21 → 2027-07-28
   Campsite page: https://www.yellohvillage.fr/camping/le_pre_bas
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=21%2F07%2F2027&end=28%2F07%2F2027&sites[]=1102&nb_pers=10&track=claude&type=0
3. Le Lavedan — Argeles-Gazost (Hautes-Pyrénées) — 4★ — 9.3/10 — available on requested dates in an accommodation for 4 people
   Campsite page: https://www.yellohvillage.fr/camping/le_lavedan
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=24%2F07%2F2027&end=31%2F07%2F2027&sites[]=5072&nb_pers=10&track=claude&type=0
```

**Réponse attendue du LLM** (extrait) : « Aucun camping ne correspond à tous vos critères pour exactement le 24 au 31 juillet, mais voici des alternatives proches :
1. **Les 3 Vallées** (Argelès-Gazost, 5★, 8,9/10), disponible du 25 juillet au 1ᵉʳ août : [Découvrir le camping](https://www.yellohvillage.fr/camping/les_3_vallees) · [Réserver](…)
2. **Le Pré Bas** (Murol, 5★, 9,1/10), disponible du 21 au 28 juillet : [Découvrir le camping](https://www.yellohvillage.fr/camping/le_pre_bas) · [Réserver](…)
3. **Le Lavedan** (Argelès-Gazost, 4★, 9,3/10), disponible à vos dates, mais dans un hébergement prévu pour 4 personnes : [Découvrir le camping](https://www.yellohvillage.fr/camping/le_lavedan) · [Réserver](…)

Les tarifs s'affichent sur la page de réservation. Voulez-vous que je cherche avec d'autres critères ? »

## Annexe B — Exemple de recherche par lieu

Données réelles du 22/11/2026, scénario D.9 de la spécification de l'API REST.

**Utilisateur** : « On cherche une location en Bretagne avec piscine couverte, du 10 au 17 juillet 2027, pour 4 personnes. »

Le LLM détecte un lieu (« Bretagne ») et un critère (« piscine couverte »). Il peut lancer les deux premiers appels en parallèle.

**Appel 1 du LLM** :

```json
{ "name": "search_geography", "arguments": { "keywords": "Bretagne", "user_language": "fr" } }
```

Sortie (`content` texte) :

```
Place found: Bretagne (geographique) — 8 campsites.
Pass these camping_ids unchanged to search_campings: [2409,2495,2541,31808,128022,90890,2463,138962]
Other matches: "Où partir en camping en Bretagne en 2026 ?" (poi, 5), "Ile de Batz" (poi, 1)
```

**Appel 2 du LLM** :

```json
{ "name": "get_search_filters", "arguments": { "accommodation_type": "rental", "user_language": "fr" } }
```

Extrait de la sortie : `swimming:SR5 | Piscine couverte | Covered pool`.

**Appel 3 du LLM** :

```json
{ "name": "search_campings",
  "arguments": { "start_date": "2027-07-10", "end_date": "2027-07-17", "people_count": 4, "accommodation_type": "rental",
                 "filters": ["swimming:SR5"], "camping_ids": [2409, 2495, 2541, 31808, 128022, 90890, 2463, 138962],
                 "user_language": "fr" } }
```

Sortie (`content` texte) :

```
3 campsites found (8 match the criteria). Show them to the user, each with its campsite page link and its booking link.
1. Les Mouettes — Carantec (Finistère) — 5★ — 9.3/10 — available 2027-07-10 → 2027-07-17
   Campsite page: https://www.yellohvillage.fr/camping/les_mouettes
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=40&nb_pers=4&track=claude&type=0
2. L’Atlantique — Fouesnant (Finistère) — 5★ — 8.6/10 — available 2027-07-10 → 2027-07-17
   Campsite page: https://www.yellohvillage.fr/camping/l_atlantique
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=1630&nb_pers=4&track=claude&type=0
3. Les Pins — Erquy (Côtes-d'Armor) — 4★ — 8.0/10 — available 2027-07-10 → 2027-07-17
   Campsite page: https://www.yellohvillage.fr/camping/les_pins
   Booking: https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=26&nb_pers=4&track=claude&type=0
```

**Réponse attendue du LLM** (extrait) : « Voici 3 campings en Bretagne avec piscine couverte, disponibles du 10 au 17 juillet 2027 pour 4 personnes :
1. **Les Mouettes** (Carantec, Finistère, 5★, 9,3/10) : [Découvrir le camping](https://www.yellohvillage.fr/camping/les_mouettes) · [Réserver](…)
2. **L'Atlantique** (Fouesnant, Finistère, 5★, 8,6/10) : [Découvrir le camping](https://www.yellohvillage.fr/camping/l_atlantique) · [Réserver](…)
3. **Les Pins** (Erquy, Côtes-d'Armor, 4★, 8/10) : [Découvrir le camping](https://www.yellohvillage.fr/camping/les_pins) · [Réserver](…)

8 campings bretons correspondent à vos critères : voulez-vous d'autres propositions ? »

**Variante, lieu introuvable** : « …à Paris… ». `search_geography(keywords="Paris")` renvoie `status: "NO_RESULT"`. Le LLM appelle quand même `search_campings` avec les mêmes critères, **sans `camping_ids`**, puis répond : « Je n'ai pas trouvé de camping Yelloh! Village à Paris ; voici des propositions sur l'ensemble du réseau : … ».

**Variante** : « …en Bretagne, à la montagne… ». Le LLM ajoute `destination:N306` (Montagne) aux filtres. L'API REST répond « aucun camping disponible », et le texte de l'outil précise que la recherche était limitée à la Bretagne. Le LLM l'explique et propose une autre zone, ou la mer à la place de la montagne.
