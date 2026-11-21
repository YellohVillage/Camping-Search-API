# Camping Search API — Spécification de développement

> **Destinataire** : ce document doit pouvoir être donné tel quel à Claude Code (ou à un développeur) pour générer le code Node.js de l'API. Il est autoporteur : les contrats amont (GraphQL Yelloh! Village, funnel YellohResa), les règles de gestion, les contrats REST, la sécurité, l'architecture et les tests y sont décrits.

| | |
|---|---|
| Version | 2.1 |
| Date | 21/11/2026 |
| Statut | Prête pour développement |
| Runtime cible | Node.js 20 LTS, TypeScript, déploiement **Netlify Functions** et **AWS Lambda** (même code) |
| Backend amont | GraphQL `https://api.sitemarket.prod.yellohvillage.fr/graphql` (site marchand yellohvillage.fr) |
| Funnel de réservation | YellohResa `https://booking.yellohvillage.com/multi-list.php` |
| Marché v1 | France (`fr`) |

| Version | Changements |
|---|---|
| 2.0 | Version initiale |
| 2.1 | `accommodation_type` **obligatoire** sur `/v1/search/filters`  (alias `accommodationType`) ; facultatif sur `/v1/search/campings` (défaut `rental`). Exemples complets de réponse `/v1/search/filters` dans `specs/`. Règle et test de robustesse « filtre incompatible avec le type d'hébergement » (§8.7). |

Fichiers du répertoire `specs/` :

| Fichier | Contenu |
|---|---|
| `specifications.md` | Ce document |
| `exemple-reponse-search-filters-rental.json` | Réponse complète réelle de `GET /v1/search/filters?accommodation_type=rental` |
| `exemple-reponse-search-filters-slot.json` | Réponse complète réelle de `GET /v1/search/filters?accommodation_type=slot` |

---

## Sommaire

1. [Contexte et cas d'usage](#1-contexte-et-cas-dusage)
2. [Glossaire](#2-glossaire)
3. [Vue d'ensemble de l'API](#3-vue-densemble-de-lapi)
4. [Sécurité : clé d'API et token de session](#4-sécurité--clé-dapi-et-token-de-session)
5. [Endpoint `POST /v1/auth/session`](#5-endpoint-post-v1authsession)
6. [Endpoint `GET /v1/search/filters`](#6-endpoint-get-v1searchfilters)
7. [Endpoint `GET /v1/search/campings`](#7-endpoint-get-v1searchcampings)
8. [Règles de gestion de la recherche](#8-règles-de-gestion-de-la-recherche)
9. [Contrat amont : GraphQL Yelloh! Village](#9-contrat-amont--graphql-yelloh-village)
10. [Contrat aval : lien YellohResa](#10-contrat-aval--lien-yellohresa)
11. [Erreurs](#11-erreurs)
12. [Architecture et structure du projet](#12-architecture-et-structure-du-projet)
13. [Configuration](#13-configuration)
14. [Déploiement Netlify et AWS Lambda](#14-déploiement-netlify-et-aws-lambda)
15. [Exigences non fonctionnelles](#15-exigences-non-fonctionnelles)
16. [Tests et critères d'acceptation](#16-tests-et-critères-dacceptation)
17. [Instructions de génération pour Claude Code](#17-instructions-de-génération-pour-claude-code)
18. [Points ouverts](#18-points-ouverts)
- [Annexe A — Requêtes GraphQL](#annexe-a--requêtes-graphql)
- [Annexe B — Catalogue des filtres observé](#annexe-b--catalogue-des-filtres-observé)
- [Annexe C — Exemples de réponses GraphQL réelles](#annexe-c--exemples-de-réponses-graphql-réelles)

---

## 1. Contexte et cas d'usage

Une **application tierce** (par exemple un chatbot ou une app partenaire) permet à un utilisateur final de saisir ses critères de séjour. Elle lui affiche **au plus N propositions de campings** Yelloh! Village (N = 3 par défaut), chacune avec un **lien pour commencer la réservation** dans le funnel YellohResa.

### 1.1 Enchaînement des appels par l'application tierce

```
App tierce                                   Camping Search API                     GraphQL Yelloh!
    │ 0. POST /v1/auth/session (X-API-Key)          │                                     │
    │──────────────────────────────────────────────▶│                                     │
    │◀──────── access_token (valable 4 h) ──────────│                                     │
    │                                               │                                     │
    │ 1. GET /v1/search/filters?accommodation_type= │  searchCampings (catalogue)         │
    │    rental puis slot (Bearer)                  │                                     │
    │──────────────────────────────────────────────▶│────────────────────────────────────▶│
    │◀──── catalogue des filtres (cache app : 24 h) │                                     │
    │                                               │                                     │
    │ 2. L'app collecte : dates, nb de personnes,   │                                     │
    │    0..n filtres                               │                                     │
    │                                               │                                     │
    │ 3. GET /v1/search/campings?… (Bearer)         │  searchCampings ×1 ou ×2            │
    │──────────────────────────────────────────────▶│────────────────────────────────────▶│
    │                                               │  campingAvailability ×k (si besoin) │
    │                                               │────────────────────────────────────▶│
    │◀──── ≤ N propositions + liens YellohResa ─────│                                     │
```

### 1.2 Règles métier résumées (détail en §8)

| # | Situation après recherche et filtrage | Réponse |
|---|---|---|
| R1 | Au moins N campings **disponibles** aux dates demandées | N campings disponibles **tirés au hasard** |
| R2 | Moins de N disponibles (0 compris), mais des campings **disponibles à d'autres dates** | Tous les disponibles, **complétés** par des campings « autres dates » tirés au hasard. Pour ces derniers, l'API rappelle le GraphQL afin d'obtenir leurs **dates alternatives**. |
| R3 | Disponibles + autres dates < N | Tous ceux qui ont pu être proposés (1 à N−1) |
| R4 | Aucun camping disponible ni disponible à d'autres dates | Réponse fonctionnelle « **aucun camping disponible** » |

---

## 2. Glossaire

| Terme | Définition |
|---|---|
| **Camping** | Un village Yelloh! Village. Il est identifié par son `campingCode` (entier, ex. `6934` pour La Marende), qui est aussi l'identifiant attendu par YellohResa. |
| **Hébergement** | Une location (`rental` : mobil-home, chalet…) ou un emplacement (`slot`), proposé par un camping. Un camping a plusieurs hébergements. |
| **Filtre camping** | Un critère porté par le camping : piscine, clubs enfants, activités, services, destination. Il est appliqué **localement** par l'API. |
| **Filtre hébergement** | Un critère porté par l'hébergement : **niveau de confort**, animaux, PMR, type d'hébergement, caractéristiques. Il est **transmis au GraphQL**, qui recalcule les disponibilités, puis aussi appliqué localement. |
| **Disponible** | Statut GraphQL `available` : il existe une offre aux dates et pour le nombre de personnes demandés. |
| **Disponible à d'autres dates** | Statut GraphQL `flex` (ou tout statut autre que `available`, `closed` et `error`) : une offre existe à des dates proches. Les dates exactes s'obtiennent avec la requête `campingAvailability`. |
| **Indisponible** | Statut GraphQL `closed` (camping fermé sur la période) ou `error`. |
| **N** | Nombre maximum de propositions renvoyées (paramètre `maxResults`, défaut 3). |

---

## 3. Vue d'ensemble de l'API

| Méthode | Chemin | Authentification | Rôle |
|---|---|---|---|
| `POST` | `/v1/auth/session` | `X-API-Key` | Échanger la clé d'API contre un token de session (JWT, 4 h par défaut) |
| `GET` | `/v1/search/filters` | `Bearer` | Catalogue des filtres de recherche |
| `GET` | `/v1/search/campings` | `Bearer` | Recherche : au plus N propositions de campings avec lien YellohResa |
| `GET` | `/v1/health` | aucune | Supervision |
| `GET` | `/v1/openapi.json` | aucune | Contrat OpenAPI 3.1 généré |

Conventions :

- **Encodage** : tout est en JSON UTF-8 (`application/json; charset=utf-8`).
- **Dates** : les dates de l'API sont au format `YYYY-MM-DD`, sans heure. Le format `JJ/MM/AAAA` n'apparaît que dans les liens YellohResa.
- **Nommage** : les champs JSON sont en `snake_case`. Les paramètres de requête sont en `camelCase` ; la variante `snake_case` est acceptée en alias.
- **Traçabilité** : chaque réponse porte l'en-tête `X-Request-Id`. S'il est fourni en entrée, il est repris ; sinon un UUID v4 est généré.
- **Version** : préfixe `/v1`. Une rupture de contrat impose de passer à `/v2`.

---

## 4. Sécurité : clé d'API et token de session

### 4.1 Principe

1. Chaque application tierce reçoit une **clé d'API** secrète et un identifiant client (`client_id`). La clé se transmet hors bande et ne s'utilise que côté serveur de l'app tierce.
2. L'application échange sa clé contre un **token de session** via `POST /v1/auth/session`.
3. Les endpoints métier exigent ce token dans `Authorization: Bearer <token>`.
4. Le token expire après **4 heures** (paramétrable avec `SESSION_TTL_SECONDS`). Passé ce délai, l'app redemande un token.

Ce modèle est **sans état** : rien n'est stocké côté serveur, ce qui convient au serverless. Une instance Lambda ou Netlify valide le token avec le seul secret de signature.

### 4.2 Clés d'API

- Format d'une clé : `ysk_live_` suivi de 40 caractères base62 aléatoires (≥ 238 bits d'entropie). Le script `npm run keys:generate -- --client <client_id>` génère la clé et son empreinte.
- Seule l'**empreinte SHA-256 (hex)** de la clé est stockée côté API, dans la variable d'environnement `API_CLIENTS`. Elle contient un tableau JSON :

```json
[
  { "client_id": "chatbot-yv", "key_sha256": "3f1c…e9a0", "track": "chatbot", "enabled": true },
  { "client_id": "partner-x",  "key_sha256": "a81b…77d2", "track": "partnerx", "enabled": true }
]
```

- Vérification : on calcule `sha256(clé reçue)` et on le compare avec `crypto.timingSafeEqual` à chaque empreinte active.
- Le champ `track` du client sert de valeur au paramètre `track` des liens YellohResa (§10).
- Révocation : passer `enabled: false` ou retirer l'entrée, puis redéployer ou recharger la configuration. Les tokens déjà émis restent valides jusqu'à leur expiration, soit au plus `SESSION_TTL_SECONDS` (voir §18).
- Rotation : un client peut avoir deux entrées actives en même temps, l'ancienne et la nouvelle clé.

### 4.3 Token de session (JWT)

| Propriété | Valeur |
|---|---|
| Format | JWT compact signé **HS256** (bibliothèque `jose`) |
| Secret | `SESSION_SIGNING_SECRET` (≥ 32 octets aléatoires, en base64). Un second secret, `SESSION_SIGNING_SECRET_PREVIOUS`, est accepté en vérification pendant les rotations. |
| `iss` | `camping-search-api` (configurable : `SESSION_ISSUER`) |
| `aud` | `camping-search-api` |
| `sub` | `client_id` |
| `iat`, `nbf`, `exp` | `exp = iat + SESSION_TTL_SECONDS` (défaut `14400` = 4 h) |
| `jti` | UUID v4 |
| Claim privé `trk` | `track` du client |

Validation sur chaque requête protégée :

- en-tête `Authorization` au format `Bearer <jwt>` ;
- signature valide ;
- `iss`, `aud`, `exp` et `nbf` respectés, avec une tolérance d'horloge de 30 s ;
- client toujours présent et `enabled` dans `API_CLIENTS`.

Échec : `401` avec le code `INVALID_TOKEN` ou `TOKEN_EXPIRED`, et l'en-tête `WWW-Authenticate: Bearer error="invalid_token"`.

### 4.4 Autres mesures

- HTTPS uniquement. Netlify et API Gateway terminent le TLS.
- **CORS** désactivé par défaut. La clé d'API ne doit jamais être exposée dans un navigateur. Si l'app tierce appelle l'API depuis un navigateur avec le token, ses origines sont listées dans `CORS_ALLOWED_ORIGINS`.
- **Limitation de débit** : elle est assurée par la plateforme (AWS API Gateway avec *usage plan* et *throttling* ; Netlify avec la règle *Rate limiting* sur `/v1/*`). En complément, l'application applique une limite par client et par instance en mémoire (`RATE_LIMIT_PER_MINUTE`, défaut 60). Cette limite est indicative, car elle n'est pas partagée entre instances.
- **Journaux** : jamais de clé d'API, de token ni d'en-tête `Authorization`. Le client est identifié par son seul `client_id`.
- En-têtes de sécurité sur toutes les réponses : `Cache-Control: no-store` (sauf §6), `X-Content-Type-Options: nosniff`, `Strict-Transport-Security: max-age=31536000`.

---

## 5. Endpoint `POST /v1/auth/session`

### Requête

```
POST /v1/auth/session
X-API-Key: ysk_live_…
Content-Type: application/json

{}
```

Le corps est vide ou vaut `{}`. La clé passe exclusivement par l'en-tête : elle n'est jamais acceptée en paramètre de requête.

### Réponse `201`

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "token_type": "Bearer",
  "expires_in": 14400,
  "expires_at": "2026-11-21T16:32:00Z",
  "client_id": "chatbot-yv"
}
```

### Erreurs

| HTTP | Code | Cas |
|---|---|---|
| 401 | `MISSING_API_KEY` | En-tête absent |
| 401 | `INVALID_API_KEY` | Clé inconnue ou client désactivé. Le message est générique et ne précise pas lequel des deux cas s'applique. |
| 429 | `RATE_LIMITED` | Plus de 10 demandes de token par minute pour une même clé |

---

## 6. Endpoint `GET /v1/search/filters`

Renvoie la liste des filtres que l'app peut proposer à l'utilisateur, **pour un type d'hébergement donné**. Ce résultat est destiné à être **mis en cache côté application tierce** (24 h recommandé). L'API renvoie `Cache-Control: private, max-age=86400`, mais ne garde **aucun cache serveur**.

L'app tierce qui propose les deux types d'hébergement appelle l'endpoint deux fois, une fois avec `rental` et une fois avec `slot`, et met les deux catalogues en cache. Elle présente ensuite à l'utilisateur le catalogue qui correspond au type d'hébergement qu'il a choisi.

### Paramètres

| Paramètre | Alias acceptés | Type | Obligatoire | Défaut | Description |
|---|---|---|---|---|---|
| `accommodation_type` | `accommodationType` | `rental` \| `slot` | **oui** | | Location ou emplacement. Les deux catalogues diffèrent (§6.2). |
| `locale` | | `fr` | non | `fr` | Réservé à l'extension multi-marchés |

Erreurs : paramètre absent → `400 MISSING_PARAMETER` (`details.missing: ["accommodation_type"]`) ; valeur autre que `rental` ou `slot` → `400 INVALID_ACCOMMODATION_TYPE`.

### Traitement

1. Appel GraphQL `searchCampings` **sans dates**, avec `accommodationType` = valeur du paramètre, `peopleCount: 1`, `campingContentIds: []`, `filters: []` et la requête `CATALOG_QUERY` (annexe A).
2. On garde `data.searchCampings.filterCategories`, puis on applique le mapping du tableau §6.1. Les catégories absentes de ce tableau sont ignorées.
3. Les sections sont triées selon l'ordre du tableau §6.1. Dans chaque catégorie, les filtres sont triés par `priority` croissante, puis par `title`.
4. Les filtres dont `newFilterId` est `null` ou vide sont ignorés.

### 6.1 Mapping des catégories GraphQL

C'est la règle de référence, reprise du front du site yellohvillage.fr.

| Ordre | `categoryId` GraphQL | `section` API | Libellé FR de la section | `level` | `operator` | Remarque |
|---|---|---|---|---|---|---|
| 1 | `destination` | `location` | Localisation | `camping` | `AND` | |
| 2 | `geo_location` | `location` | Localisation | `camping` | `AND` | |
| 3 | `confort_type` | `comfort` | Niveau de confort | `accommodation` | `OR` | **Filtre hébergement** |
| 4 | `filtered_accommodation_type` | `accommodation` | Hébergement | `accommodation` | `OR` | |
| 5 | `animals_allowed` | `accommodation` | Hébergement | `accommodation` | `AND` | Seul le filtre d'id `pets` est retenu |
| 6 | `pmr` | `accommodation` | Hébergement | `accommodation` | `AND` | |
| 7 | `characteristics` | `accommodation` | Hébergement | `accommodation` | `AND` | |
| 8 | `surface` | `accommodation` | Hébergement | `accommodation` | `OR` | Peut être absent |
| 9 | `swimming` | `swimming` | Piscine | `camping` | `AND` | |
| 10 | `children_clubs` | `children_club` | Clubs enfants | `camping` | `AND` | |
| 11 | `facilities` | `services` | Services | `camping` | `AND` | |
| 12 | `wellness` | `services` | Services | `camping` | `AND` | Peut être absent |
| 13 | `sports_activities_on_site` | `activities` | Activités sur place | `camping` | `AND` | Match par `key` (§8.4) |
| 14 | `sports_activities` | `nearby_activities` | Activités à proximité | `camping` | `AND` | Match par `key` (§8.4) |

Les catégories `accomodation_type`, `bathroom` et `bedroom` ne sont **pas** exposées, comme sur le site.

### 6.2 Différences entre les catalogues `rental` et `slot`

Relevé réel du 21/11/2026 :

| Section | `rental` | `slot` |
|---|---|---|
| `location` | `destination` (4), `geo_location` (3) | identique |
| `comfort` | `confort_type` (3) : F0, F4, F5 | identique |
| `accommodation` | `filtered_accommodation_type` (9), `animals_allowed` (1), `pmr` (1), `characteristics` (7 : climatisation, télévision, spa…) | **pas** de `filtered_accommodation_type` ; `animals_allowed` (1), `pmr` (1), `characteristics` (13 : électricité, surfaces, raccordement à l'eau, évacuation des eaux usées, **sanitaire privatif**, barbecue…) |
| `swimming`, `children_club`, `services`, `activities`, `nearby_activities` | 9, 5, 6, 17, 19 filtres | identique |

Les filtres de niveau camping sont communs aux deux types. Seuls les filtres hébergement diffèrent.

### Réponse `200`

Les réponses complètes et réelles (générées depuis le GraphQL de production avec les règles de ce chapitre) sont fournies dans :

- [`exemple-reponse-search-filters-rental.json`](exemple-reponse-search-filters-rental.json) : 8 sections, 84 filtres ;
- [`exemple-reponse-search-filters-slot.json`](exemple-reponse-search-filters-slot.json) : 8 sections, 81 filtres.

Ces fichiers servent de **référence de format et de fixtures** pour les tests. Le catalogue réel est dynamique et peut évoluer.

Extrait (structure) :

```json
{
  "accommodation_type": "rental",
  "locale": "fr",
  "generated_at": "2026-11-21T12:50:16Z",
  "sections": [
    {
      "section": "comfort",
      "label": "Niveau de confort",
      "categories": [
        {
          "category_id": "confort_type",
          "level": "accommodation",
          "operator": "OR",
          "filters": [
            { "id": "F0", "label": "0-3 fleurs", "label_en": "0-3 flowers" },
            { "id": "F4", "label": "4 fleurs",   "label_en": "4 flowers" },
            { "id": "F5", "label": "Premium",    "label_en": "Premium" }
          ]
        }
      ]
    },
    {
      "section": "swimming",
      "label": "Piscine",
      "categories": [
        {
          "category_id": "swimming",
          "level": "camping",
          "operator": "AND",
          "filters": [ { "id": "SR7", "label": "Toboggan(s)", "label_en": "Slide(s)" } ]
        }
      ]
    }
  ]
}
```

Règles des champs :

- `id` reprend le `newFilterId` GraphQL. C'est l'identifiant que l'app renvoie dans `filters` lors de la recherche.
- `label` vient de `title`, et `label_en` de `englishTitle` (`null` si absent).
- Le compteur GraphQL `count` n'est pas exposé : il compte tantôt des campings, tantôt des hébergements, et serait trompeur.

---

## 7. Endpoint `GET /v1/search/campings`

### 7.1 Paramètres

| Paramètre | Alias | Type | Obligatoire | Défaut | Contraintes |
|---|---|---|---|---|---|
| `startDate` | `start_date` | `YYYY-MM-DD` | **oui** | | Date valide, ≥ aujourd'hui (fuseau `Europe/Paris`) |
| `endDate` | `end_date` | `YYYY-MM-DD` | **oui** | | > `startDate`, séjour ≤ `MAX_STAY_NIGHTS` nuits (défaut 28) |
| `peopleCount` | `people_count` | entier | **oui** | | 1 ≤ n ≤ `MAX_PEOPLE` (défaut 12) |
| `accommodationType` | `accommodation_type` | `rental` \| `slot` | non | `rental` | Type d'hébergement recherché. Les ids de `filters` doivent appartenir au catalogue de ce type (§8.7). |
| `filters` | | liste d'ids séparés par des virgules (ou paramètre répété) | non | vide | Ids issus de `/v1/search/filters`. Doublons ignorés, au plus 30 ids. |
| `maxResults` | `max_results` | entier | non | `DEFAULT_MAX_RESULTS` (3) | 1 ≤ n ≤ `MAX_RESULTS_LIMIT` (défaut 10) |
| `locale` | | `fr` | non | `fr` | |

Exemple :

```
GET /v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=F4,F5,pets,SR7&maxResults=3
Authorization: Bearer eyJ…
```

### 7.2 Réponse `200`, cas nominal

```json
{
  "status": "OK",
  "message": null,
  "search": {
    "start_date": "2027-07-10",
    "end_date": "2027-07-17",
    "nights": 7,
    "people_count": 4,
    "accommodation_type": "rental",
    "filters": ["F4", "F5", "pets", "SR7"],
    "max_results": 3
  },
  "summary": {
    "available_count": 54,
    "alternative_dates_count": 12,
    "unavailable_count": 0,
    "returned_count": 3
  },
  "results": [
    {
      "rank": 1,
      "availability_type": "available",
      "camping_code": 6934,
      "name": "La Marende",
      "stars": 5,
      "rating": 9.0,
      "city": "Argelès-sur-Mer",
      "department": "Pyrénées Orientales",
      "region": "Languedoc-Roussillon",
      "latitude": 42.573152,
      "longitude": 3.042505,
      "image_url": "https://img.yellohvillage.fr/var/plain_site/storage/images/_aliases/react_thumb_retina/site_marchand/camping/la_marende/2447035-225-fre-FR/la_marende.jpg",
      "camping_url": "https://www.yellohvillage.fr/camping/la_marende",
      "is_new": false,
      "special_offer": null,
      "alternative_begin_date_availability": null,
      "alternative_end_date_availability": null,
      "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4&lang=fr&track=chatbot"
    }
  ],
  "meta": {
    "request_id": "6d0f3b7e-…",
    "generated_at": "2026-11-21T12:00:02Z",
    "duration_ms": 1830,
    "upstream_calls": { "search_campings": 2, "camping_availability": 0 }
  }
}
```

### 7.3 Réponse `200`, complétée par des campings « autres dates » (R2)

```json
{
  "status": "OK",
  "message": null,
  "summary": { "available_count": 1, "alternative_dates_count": 9, "unavailable_count": 52, "returned_count": 3 },
  "results": [
    { "rank": 1, "availability_type": "available", "camping_code": 76, "name": "Domaine de Drancourt", "…": "…",
      "alternative_begin_date_availability": null, "alternative_end_date_availability": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=03%2F04%2F2027&end=10%2F04%2F2027&sites[]=76&nb_pers=4&lang=fr&track=chatbot" },
    { "rank": 2, "availability_type": "alternative_dates", "camping_code": 1531, "name": "Les Fontaines", "…": "…",
      "alternative_begin_date_availability": "2027-04-07",
      "alternative_end_date_availability": "2027-04-14",
      "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=07%2F04%2F2027&end=14%2F04%2F2027&sites[]=1531&nb_pers=4&lang=fr&track=chatbot" },
    { "rank": 3, "availability_type": "alternative_capacity", "camping_code": 23, "name": "Le Brasilia", "…": "…",
      "alternative_begin_date_availability": "2027-04-03",
      "alternative_end_date_availability": "2027-04-10",
      "alternative_capacity": 6,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=03%2F04%2F2027&end=10%2F04%2F2027&sites[]=23&nb_pers=4&lang=fr&track=chatbot" }
  ]
}
```

### 7.4 Réponse `200`, moins de N résultats (R3)

Même structure, avec `status: "PARTIAL"`, `message: "Seulement 2 camping(s) correspondent à vos critères."` et 1 à N−1 éléments dans `results`.

### 7.5 Réponse `200`, aucun camping (R4)

```json
{
  "status": "NO_AVAILABILITY",
  "message": "aucun camping disponible",
  "search": { "…": "…" },
  "summary": { "available_count": 0, "alternative_dates_count": 0, "unavailable_count": 100, "returned_count": 0 },
  "results": [],
  "meta": { "…": "…" }
}
```

> **Choix de conception** : « aucun camping disponible » est un résultat **fonctionnel**, pas une erreur technique. Il est renvoyé en HTTP `200` avec `status: "NO_AVAILABILITY"`. Les erreurs techniques ou de saisie restent en `4xx` et `5xx` (§11). L'app tierce peut ainsi afficher le message tel quel, sans le confondre avec une panne.

### 7.6 Dictionnaire des champs d'un résultat

| Champ | Type | Source / règle |
|---|---|---|
| `rank` | entier | Position 1..n dans `results` |
| `availability_type` | `available` \| `alternative_dates` \| `alternative_capacity` | §8.6 |
| `camping_code` | entier | `campingCode` |
| `name` | string | `name` |
| `stars` | entier \| null | `starCount` |
| `rating` | nombre \| null | `round(note / 10, 1)` (note GraphQL sur 100) |
| `city` | string | `city` (après `trim`) |
| `department`, `region` | string \| null | `department`, `region` |
| `latitude`, `longitude` | nombre \| null | `coordinates` |
| `image_url` | string \| null | `image` |
| `camping_url` | string | `SITE_BASE_URL` + `campingUrl` |
| `is_new` | booléen | `isNew` |
| `special_offer` | string \| null | `specialOffer.description` (HTML retiré) |
| `alternative_begin_date_availability` | `YYYY-MM-DD` \| null | Renseigné seulement si `availability_type` ≠ `available` : `info.arrivalDate` de `campingAvailability` (§9.4) |
| `alternative_end_date_availability` | `YYYY-MM-DD` \| null | Idem, avec `info.departureDate` |
| `alternative_capacity` | entier \| null | Renseigné seulement si `alternative_capacity` : capacité de l'hébergement proposé (§8.6) |
| `bookingengine_link` | string | §10 |

`status` de la réponse :

| Valeur | Condition |
|---|---|
| `OK` | `results.length === maxResults` |
| `PARTIAL` | `1 ≤ results.length < maxResults` |
| `NO_AVAILABILITY` | `results.length === 0` |

---

## 8. Règles de gestion de la recherche

### 8.1 Algorithme général

```
ENTRÉE : critères validés (start, end, people, type, filterIds, N)

1. GQL#1 = searchCampings(start, end, type, people, campingContentIds=[], filters=[])
           avec SEARCH_QUERY_WITH_CATALOG
2. Résolution des filtres (§8.2) à partir de GQL#1.filterCategories (catalogue du type demandé)
      → si un id est inconnu pour ce type : 400 UNKNOWN_FILTER (liste des ids fautifs, §8.7)
        AUCUN appel GQL#2 ni campingAvailability n'est fait
      → accFilters (level = accommodation), campFilters (level = camping)
3. SI accFilters non vide :
      GQL#2 = searchCampings(…, filters = toFilterInput(accFilters)) avec SEARCH_QUERY
      campings = GQL#2.campings                      ← particularité « niveau de confort » (§8.3)
   SINON
      campings = GQL#1.campings
4. campings = campings.filter(c => keepCamping(c, campFilters ∪ accFilters, type))   (§8.4)
5. Classement (§8.5) → AVAILABLE[], ALTERNATIVE[], UNAVAILABLE[]
6. Sélection et complétion (§8.6) → results[] (≤ N)
7. Construction des liens (§10) et de la réponse (§7)
```

### 8.2 Résolution des filtres

Pour chaque id reçu, on cherche dans `filterCategories` de GQL#1 (donc dans le catalogue **du type d'hébergement demandé**) la catégorie mappée (§6.1) et le filtre `f` tel que `f.newFilterId === id`. Un id absent de ce catalogue est rejeté (§8.7).

Objet résolu :

```ts
interface ResolvedFilter {
  id: string;          // newFilterId, ex. "F4"
  webcampId: string;   // f.id GraphQL, ex. "4" : valeur présente dans accommodation.filters
  key: string;         // f.key, ex. "Mini-golf" ou "4 fleurs##4"
  categoryId: string;  // ex. "confort_type"
  level: 'camping' | 'accommodation';
  operator: 'AND' | 'OR';
}
```

`toFilterInput(f)` produit `{ categoryId: f.categoryId, value: f.id, webcampId: f.webcampId }`. Exemple : `{"categoryId":"confort_type","value":"F4","webcampId":"4"}`. Les filtres sont triés par `categoryId` puis `value`, pour que les appels soient déterministes.

### 8.3 Particularité des filtres hébergement (dont le niveau de confort)

Le GraphQL **ignore les filtres camping**. En revanche, il recalcule `availabilityStatus` quand on lui passe des **filtres hébergement**.

Mesure réelle (juillet 2027, 4 personnes) : sans filtre, 96 `available` et 4 `flex` ; avec « Premium » (`F5`), 79 `available` et 21 `flex`.

Il est donc **obligatoire** de faire l'appel GQL#2 dès qu'au moins un filtre de `level = accommodation` est demandé. Ces mêmes filtres sont aussi transmis à `campingAvailability` (§8.6).

### 8.4 Filtrage local

C'est l'algorithme exact du site, à reproduire à l'identique :

```ts
function matchAll(filters: ResolvedFilter[], pred: (f: ResolvedFilter) => boolean): boolean {
  const andOk = filters.filter(f => f.operator === 'AND').every(pred);
  const orGroups = groupBy(filters.filter(f => f.operator === 'OR'), f => f.categoryId);
  return andOk && Object.values(orGroups).every(group => group.some(pred));
}

function campingHas(c: GqlCamping, f: ResolvedFilter): boolean {
  if (f.categoryId === 'sports_activities_on_site' || f.categoryId === 'sports_activities') {
    return c.filterCategories?.find(fc => fc?.categoryId === f.categoryId)
             ?.filters?.some(x => x?.key === f.key) ?? false;
  }
  return c.allFilters?.includes(f.id) ?? false;
}

function keepCamping(c: GqlCamping, filters: ResolvedFilter[], type: 'rental' | 'slot'): boolean {
  const acc  = filters.filter(f => f.level === 'accommodation');
  const camp = filters.filter(f => f.level === 'camping');
  return matchAll(camp, f => campingHas(c, f))
      && (acc.length === 0
          || (c.accommodations ?? []).some(a => !!a && a.accommodationType === type
                && matchAll(acc, f => a.filters?.includes(f.webcampId) ?? false)));
}
```

Conséquences à couvrir par les tests :

- **ET entre catégories, et à l'intérieur des catégories `AND`.** Exemple : « Mer » (`N305`) + « Montagne » (`N306`) donne l'intersection.
- **OU à l'intérieur de `confort_type`, `filtered_accommodation_type` et `surface`.** Exemple : `F4` ou `F5`.
- **Mêmes hébergement pour tous les filtres hébergement.** Exemple : `F4` + `pets` exige un même hébergement 4 fleurs qui accepte les animaux.
- **Camping écarté** : un camping sans hébergement compatible est écarté de toutes les listes.

### 8.5 Classement

À partir de `availabilityStatus` (issu de GQL#2 s'il a eu lieu, sinon de GQL#1) :

| `availabilityStatus` | Liste |
|---|---|
| `available` | `AVAILABLE` |
| `closed`, `error`, `null` | `UNAVAILABLE` |
| toute autre valeur (`flex`, `flexCapacity`, `full`, `unavailable`…) | `ALTERNATIVE` |

Si **tous** les campings reçus du GraphQL (avant filtrage local) sont `error`, l'API répond `502 UPSTREAM_ERROR`. C'est le signe d'un problème amont, par exemple des dates invalides côté serveur.

### 8.6 Sélection aléatoire et complétion

```
N = maxResults
results = []

// R1 : assez de disponibles
SI |AVAILABLE| ≥ N :
    results = tirage(AVAILABLE, N)            → availability_type = "available"
    FIN

// R2 / R3 : compléter avec des campings "autres dates"
results  = mélange(AVAILABLE)                 → tous les disponibles (0..N-1)
manquant = N - |results|
pool     = mélange(ALTERNATIVE)
tentatives = 0
TANT QUE manquant > 0 ET pool non vide ET tentatives < MAX_AVAILABILITY_CALLS :
    lot = retirer min(manquant, |pool|) campings de la tête de pool
    réponses = EN PARALLÈLE pour c ∈ lot : campingAvailability(c.campingCode, start, end, type,
                                             people, filters = toFilterInput(accFilters), fidelityId = null)
    tentatives += |lot|
    POUR chaque (c, r) dans l'ordre du lot :
        SELON r.statusCode :
          "flex"          et r.info présent → ajouter c (alternative_dates,  dates = r.info)
          "flexCapacity"  et r.info présent → ajouter c (alternative_capacity, dates = r.info,
                                                capacité = capacité de l'hébergement r.accommodationId)
          "available"     et r.info présent → ajouter c (available, sans dates alternatives)
          autre statut, info absente, erreur GraphQL ou timeout
                          → camping écarté, AUCUN remplacement de la réponse ; on passe au suivant du pool
    manquant = N - |results|

// R3 / R4
SI |results| = 0 → status NO_AVAILABILITY, message "aucun camping disponible"
SINON SI |results| < N → status PARTIAL
SINON → status OK

Ordre final : les "available" d'abord, puis les autres dans l'ordre de validation ; rank = 1..n
```

Précisions :

- **Hasard** : `tirage` et `mélange` sont un mélange de Fisher-Yates avec `crypto.randomInt`. Deux appels identiques peuvent donc renvoyer des campings différents ; c'est voulu, pour répartir les propositions sur le réseau. Le générateur aléatoire est **injectable** (interface `Rng`) pour rendre les tests déterministes. En dehors de la production (`ALLOW_DEBUG_SEED=true`), l'en-tête `X-Debug-Seed` fixe la graine.
- **Pourquoi revérifier** : un camping `flex` dans `searchCampings` peut se révéler indisponible avec `campingAvailability`. C'est observé en réel (exemple en annexe C). Le camping est alors écarté et remplacé par le suivant du pool, ce qui garantit que chaque proposition « autres dates » a de vraies dates.
- **Borne de coût** : `MAX_AVAILABILITY_CALLS` (défaut 8) limite le nombre total d'appels `campingAvailability` par recherche. Si la borne est atteinte sans compléter, on renvoie ce qu'on a (`PARTIAL`, ou `NO_AVAILABILITY` si rien).
- **Concurrence** : les appels d'un lot partent en parallèle, sans dépasser `AVAILABILITY_CONCURRENCY` (défaut 4).
- **Pas de chiffrage des disponibles** : un camping `available` issu de `searchCampings` n'est pas revérifié par `campingAvailability`, car les prix sont hors périmètre.
- **Dates alternatives** : `arrivalDate` et `departureDate` sont des instants ISO à minuit UTC (`2027-07-07T00:00:00.000Z`). On en retient la **partie date UTC** (`2027-07-07`).
- **`alternative_capacity`** : on cherche dans `camping.accommodations` l'hébergement dont `code === r.accommodationId`, puis on lit `technicalInfos.capacity.value`, converti en entier (`null` s'il est introuvable).
- `summary.available_count`, `alternative_dates_count` et `unavailable_count` donnent la taille des trois listes **après filtrage et avant sélection**.

---

### 8.7 Filtre incompatible avec le type d'hébergement

**Cas** : l'app envoie un filtre hébergement qui n'existe que pour l'autre type. Par exemple, `accommodation_type=rental` avec `filters=C18` (« Sanitaire privatif », filtre propre aux emplacements).

**Test de robustesse du GraphQL** (production, 21/11/2026, 10→17/07/2027, 4 personnes). On a envoyé directement au GraphQL le `FilterInput` de « Sanitaire privatif » (`{"categoryId":"characteristics","value":"C18","webcampId":"18"}`) avec `accommodationType: "rental"` :

| Appel | Résultat |
|---|---|
| `searchCampings` rental sans filtre | 100 campings : 96 `available`, 4 `flex` |
| `searchCampings` rental + C18 | 100 campings : **0 `available`, 100 `flex`** |
| `searchCampings` rental + C18 + F4 | 100 campings : 0 `available`, 100 `flex` |
| `campingAvailability` rental + C18 (La Marende 6934, Drancourt 76) | `unavailable` (alors que `available` sans le filtre) |
| `searchCampings` **slot** + C18 (pour comparaison) | 91 campings : 50 `available`, 41 `flex` (filtre bien appliqué) |
| Hébergements `rental` portant `18` dans `filters` | 0 sur les 100 campings |

**Constat** : le GraphQL n'ignore **pas** le filtre en silence. Il ne renvoie pas non plus d'erreur. Il bascule **tous** les campings en `flex` (« disponible à d'autres dates »), ce qui est trompeur, puisque `campingAvailability` répond ensuite `unavailable`.

Sans contrôle, l'API :

- proposerait des campings « autres dates » qui n'en ont pas ;
- ou, avec la revérification du §8.6, ferait jusqu'à `MAX_AVAILABILITY_CALLS` appels inutiles avant de répondre « aucun camping disponible ».

**Règle retenue** : le GraphQL ne se trompant pas en silence, un contrôle côté API est **nécessaire**. Il ne coûte aucun appel supplémentaire, parce qu'il découle directement de §8.2 :

1. les ids de `filters` sont résolus **uniquement** dans le catalogue du type demandé (lu dans GQL#1) ;
2. un id absent de ce catalogue (inexistant, ou propre à l'autre type) est rejeté par `400 UNKNOWN_FILTER`, **avant** tout appel GQL#2 ou `campingAvailability` ;
3. le message précise le type demandé : `"Filtre(s) inconnu(s) pour accommodation_type=rental : C18."`, avec `details: { "unknown": ["C18"], "accommodation_type": "rental" }`.

Pour éviter ce cas, l'app tierce doit proposer à l'utilisateur les filtres du catalogue correspondant au type d'hébergement choisi (§6).

Les filtres de niveau camping étant communs aux deux types, ils ne sont pas concernés.

## 9. Contrat amont : GraphQL Yelloh! Village

### 9.1 Transport

```
POST https://api.sitemarket.prod.yellohvillage.fr/graphql
Content-Type: application/json
Origin: https://www.yellohvillage.fr
gql-market-site: 1
gql-locale: fr
User-Agent: camping-search-api/1.0

{"operationName":"…","variables":{…},"query":"…"}
```

- Les en-têtes `Origin`, `gql-market-site` et `gql-locale` sont **obligatoires**. Sans eux, le serveur répond `errors[0].message = "Context creation failed: Invalid camping code undefined from origin"`.
- Aucune authentification n'est requise côté amont.
- Le serveur accepte des requêtes personnalisées (pas de liste blanche de requêtes). On utilise les requêtes réduites de l'annexe A : environ 360 Ko de réponse, contre 2,7 Mo pour la requête du site.
- L'en-tête `gql-bypass-cache: true`, envoyé par le navigateur, **n'est pas envoyé** par défaut. On l'active avec `GQL_BYPASS_CACHE=true`.
- Timeout `GQL_TIMEOUT_MS` (défaut 8000). **Une** nouvelle tentative après 300 ms, uniquement sur erreur réseau ou HTTP 502, 503 ou 504.
- Erreur amont : HTTP différent de 200, ou présence de `errors[]` dans le corps. Pour `searchCampings`, elle donne `502 UPSTREAM_ERROR` ; un timeout donne `504 UPSTREAM_TIMEOUT`. Pour `campingAvailability`, le camping est simplement écarté (§8.6).

### 9.2 Format des dates envoyées

`startDate` et `endDate` sont envoyées en ISO à minuit UTC : `"2027-07-10T00:00:00.000Z"` pour le 10/07/2027.

### 9.3 `searchCampings`

Variables :

```json
{
  "accommodationType": "rental",
  "peopleCount": 4,
  "campingContentIds": [],
  "startDate": "2027-07-10T00:00:00.000Z",
  "endDate": "2027-07-17T00:00:00.000Z",
  "filters": [ { "categoryId": "confort_type", "value": "F4", "webcampId": "4" } ]
}
```

Réponse : environ 100 campings (le réseau entier), chacun avec `availabilityStatus` ∈ {`available`, `flex`, `closed`, `error`}, plus `filterCategories` à la racine. Sans dates, tous les statuts valent `error` (cas du catalogue §6).

### 9.4 `campingAvailability`

Variables :

```json
{
  "campingCode": 1531,
  "accommodationType": "rental",
  "peopleCount": 4,
  "startDate": "2027-07-10T00:00:00.000Z",
  "endDate": "2027-07-17T00:00:00.000Z",
  "filters": [],
  "fidelityId": null
}
```

Réponse :

```json
{ "data": { "campingAvailability": {
  "statusCode": "flex",
  "accommodationId": 118531,
  "info": { "arrivalDate": "2027-07-07T00:00:00.000Z", "departureDate": "2027-07-14T00:00:00.000Z", "stock": 10,
            "priceInfo": { "title": "Tarif 4 fleurs - avec vue", "fullPrice": 2110, "discountedPrice": 2110, "discount": null } } } } }
```

| `statusCode` | Sens |
|---|---|
| `available` | Disponible aux dates demandées |
| `flex` | Disponible à d'autres dates (`info.arrivalDate` / `info.departureDate`) |
| `flexCapacity` | Disponible aux dates demandées, dans un hébergement d'une autre capacité |
| `unavailable`, `full`, `closed`, `outPeriod`, `pastPeriod`, `error` | Pas d'offre (`info` à `null`) |

Latence observée : 0,4 s en moyenne, jusqu'à environ 2 s (davantage avec des filtres de confort).

---

## 10. Contrat aval : lien YellohResa

### 10.1 Format

```
https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=08%2F05%2F2027&end=15%2F05%2F2027&sites[]=49&nb_pers=1&lang=fr&track=chatbot
```

| Paramètre | Valeur | Règle |
|---|---|---|
| `camping` | `yelloh` | Constante |
| `begin` | `JJ/MM/AAAA` encodé (`/` → `%2F`) | Date de début du séjour **proposé** |
| `end` | `JJ/MM/AAAA` encodé | Date de fin du séjour **proposé** |
| `sites[]` | `camping_code` | Les crochets sont écrits tels quels, non encodés |
| `nb_pers` | `people_count` | Nombre de participants demandé |
| `lang` | `fr` | Langue du marché |
| `track` | claim `trk` du token (= `track` du client), sinon `BOOKING_ENGINE_DEFAULT_TRACK` (`chatbot`) | Encodé avec `encodeURIComponent` |

Dates utilisées selon le type de résultat :

| `availability_type` | `begin` / `end` |
|---|---|
| `available` | Dates demandées |
| `alternative_dates` | `alternative_begin_date_availability` / `alternative_end_date_availability` |
| `alternative_capacity` | Dates de `info` (égales aux dates demandées) |

Vérifié le 21/11/2026 : `sites[]=49` ouvre le funnel sur « Portland », `sites[]=6934` sur « La Marende ». C'est bien le `campingCode` qu'il faut utiliser, et non le `contentId`.

### 10.2 Implémentation de référence

```ts
const toFr = (iso: string) => { const [y, m, d] = iso.split('-'); return encodeURIComponent(`${d}/${m}/${y}`); };

export function buildBookingEngineLink(p: { campingCode: number; begin: string; end: string;
                                            peopleCount: number; lang: string; track: string }, baseUrl: string): string {
  return `${baseUrl}?camping=yelloh&begin=${toFr(p.begin)}&end=${toFr(p.end)}`
       + `&sites[]=${p.campingCode}&nb_pers=${p.peopleCount}&lang=${p.lang}&track=${encodeURIComponent(p.track)}`;
}
// buildBookingEngineLink({campingCode:49, begin:'2027-05-08', end:'2027-05-15', peopleCount:1, lang:'fr', track:'chatbot'}, BASE)
// === 'https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=08%2F05%2F2027&end=15%2F05%2F2027&sites[]=49&nb_pers=1&lang=fr&track=chatbot'
```

---

## 11. Erreurs

Format commun à toutes les erreurs `4xx` et `5xx` :

```json
{
  "error": {
    "code": "INVALID_DATES",
    "message": "endDate doit être postérieure à startDate.",
    "details": { "startDate": "2027-07-17", "endDate": "2027-07-10" },
    "request_id": "6d0f3b7e-…"
  }
}
```

| HTTP | `code` | Cas |
|---|---|---|
| 400 | `MISSING_PARAMETER` | `startDate`, `endDate` ou `peopleCount` absent sur `/v1/search/campings` ; `accommodation_type` absent sur `/v1/search/filters` (`details.missing: [...]`) |
| 400 | `INVALID_DATES` | Format invalide, date passée, `endDate` ≤ `startDate`, séjour > `MAX_STAY_NIGHTS` |
| 400 | `INVALID_PEOPLE_COUNT` | Hors bornes |
| 400 | `INVALID_ACCOMMODATION_TYPE` | Ni `rental` ni `slot` |
| 400 | `INVALID_MAX_RESULTS` | Hors de 1..`MAX_RESULTS_LIMIT` |
| 400 | `UNKNOWN_FILTER` | Id de filtre inconnu pour le type d'hébergement demandé, y compris un filtre propre à l'autre type (§8.7) (`details.unknown: ["C18"]`, `details.accommodation_type: "rental"`) |
| 400 | `TOO_MANY_FILTERS` | Plus de 30 filtres |
| 401 | `MISSING_API_KEY`, `INVALID_API_KEY` | `/v1/auth/session` |
| 401 | `MISSING_TOKEN`, `INVALID_TOKEN`, `TOKEN_EXPIRED` | Endpoints protégés |
| 404 | `NOT_FOUND` | Route inconnue |
| 405 | `METHOD_NOT_ALLOWED` | Méthode non supportée |
| 429 | `RATE_LIMITED` | Quota dépassé (en-tête `Retry-After`) |
| 500 | `INTERNAL_ERROR` | Erreur non gérée. Le message est générique, sans pile d'appels. |
| 502 | `UPSTREAM_ERROR` | `searchCampings` en erreur |
| 504 | `UPSTREAM_TIMEOUT` | `searchCampings` au-delà du timeout |

« Aucun camping disponible » **n'est pas** une erreur : voir §7.5.

---

## 12. Architecture et structure du projet

### 12.1 Principes

- **Cœur indépendant de la plateforme** : les handlers métier reçoivent une requête normalisée (`{ method, path, query, headers, body }`) et renvoient `{ statusCode, headers, body }`.
- **Adaptateurs minces** : un pour AWS Lambda (événements API Gateway REST v1 et HTTP API v2, ainsi que Function URL), un pour Netlify Functions.
- **Aucun framework web lourd**. Un petit routeur interne suffit pour 5 routes, ce qui limite le démarrage à froid.
- **Aucune dépendance native.** `fetch` natif de Node 20 avec `AbortController` pour les timeouts.
- **Dépendances** : `zod` (validation), `jose` (JWT). En développement : `typescript`, `vitest`, `esbuild`, `tsx`, `eslint`, `prettier`, `msw` ou `undici` `MockAgent` pour simuler le GraphQL.
- **Aucun cache serveur.** Chaque recherche interroge le GraphQL. Le catalogue est mis en cache par l'app tierce.
- **Injection de dépendances** par paramètres de fabrique : `createApp({ config, gqlClient, rng, clock, logger })`, pour que tout reste testable.

### 12.2 Arborescence

```
camping-search-api/
├── specs/
│   ├── specifications.md             ← ce document
│   ├── exemple-reponse-search-filters-rental.json
│   └── exemple-reponse-search-filters-slot.json
├── README.md                         ← démarrage, variables, déploiement, exemples curl
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .env.example
├── netlify.toml
├── template.yaml                     ← AWS SAM (Lambda + HTTP API)
├── scripts/
│   └── generate-api-key.ts           ← npm run keys:generate -- --client <id>
├── netlify/
│   └── functions/
│       └── api.ts                    ← adaptateur Netlify → src/adapters/netlify.ts
├── src/
│   ├── adapters/
│   │   ├── lambda.ts                 ← export handler (API GW v1/v2, Function URL)
│   │   └── netlify.ts
│   ├── app.ts                        ← createApp(), routeur, middlewares (requestId, auth, erreurs, logs)
│   ├── config.ts                     ← lecture et validation (zod) des variables d'environnement
│   ├── http/
│   │   ├── router.ts
│   │   ├── types.ts                  ← HttpRequest, HttpResponse
│   │   ├── errors.ts                 ← ApiError + mapping vers le format §11
│   │   └── responses.ts
│   ├── auth/
│   │   ├── apiKeys.ts                ← hash + timingSafeEqual
│   │   ├── session.ts                ← sign/verify JWT (jose)
│   │   └── rateLimit.ts              ← limite en mémoire par client
│   ├── routes/
│   │   ├── authSession.ts            ← POST /v1/auth/session
│   │   ├── searchFilters.ts          ← GET /v1/search/filters
│   │   ├── searchCampings.ts         ← GET /v1/search/campings
│   │   ├── health.ts
│   │   └── openapi.ts
│   ├── domain/
│   │   ├── categoryMapping.ts        ← tableau §6.1
│   │   ├── filterCatalog.ts          ← GraphQL filterCategories → catalogue API
│   │   ├── filterResolver.ts         ← §8.2
│   │   ├── filterEngine.ts           ← §8.4 (matchAll, campingHas, keepCamping)
│   │   ├── classifier.ts             ← §8.5
│   │   ├── selector.ts               ← §8.6
│   │   ├── bookingLink.ts            ← §10
│   │   ├── mappers.ts                ← camping GraphQL → résultat API (§7.6)
│   │   └── rng.ts                    ← interface Rng, implémentation crypto, implémentation à graine
│   ├── upstream/
│   │   ├── gqlClient.ts              ← POST, en-têtes, timeout, retry, erreurs
│   │   ├── queries.ts                ← requêtes de l'annexe A
│   │   └── types.ts                  ← types des réponses GraphQL
│   ├── validation/
│   │   └── schemas.ts                ← schémas zod des paramètres (§7.1)
│   └── observability/
│       └── logger.ts                 ← logs JSON (niveau via LOG_LEVEL), sans secrets
└── test/
    ├── fixtures/                     ← réponses GraphQL réelles anonymisées (voir §16.3)
    ├── unit/                         ← filterEngine, selector, bookingLink, session, apiKeys, validation
    └── integration/                  ← createApp() + GraphQL simulé, scénarios R1 à R4
```

### 12.3 Scripts npm

| Script | Rôle |
|---|---|
| `dev` | Serveur HTTP local (`tsx src/dev-server.ts`) sur le port 8787, qui branche `createApp` sur `node:http` |
| `build` | `tsc --noEmit` puis `esbuild` : bundles `dist/lambda.js` et `netlify/functions/api.js` (ESM, node20) |
| `test` / `test:watch` / `coverage` | Vitest |
| `lint` / `format` | ESLint / Prettier |
| `keys:generate` | Génère une clé d'API et son empreinte SHA-256 |
| `openapi` | Écrit `openapi.json` à partir des schémas zod |

---

## 13. Configuration

Toutes les variables sont validées au démarrage (`config.ts`). Si la configuration est invalide, le processus s'arrête avec un message explicite.

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `API_CLIENTS` | **oui** | | JSON des clients : `client_id`, `key_sha256`, `track`, `enabled` (§4.2) |
| `SESSION_SIGNING_SECRET` | **oui** | | Secret HS256, ≥ 32 octets, en base64 |
| `SESSION_SIGNING_SECRET_PREVIOUS` | non | | Ancien secret accepté en vérification (rotation) |
| `SESSION_TTL_SECONDS` | non | `14400` | Durée de vie du token (4 h) |
| `SESSION_ISSUER` | non | `camping-search-api` | `iss` / `aud` |
| `GQL_ENDPOINT` | non | `https://api.sitemarket.prod.yellohvillage.fr/graphql` | |
| `GQL_ORIGIN` | non | `https://www.yellohvillage.fr` | En-tête `Origin` |
| `GQL_MARKET_SITE` | non | `1` | En-tête `gql-market-site` |
| `GQL_LOCALE` | non | `fr` | En-tête `gql-locale` |
| `GQL_BYPASS_CACHE` | non | `false` | Envoie `gql-bypass-cache: true` |
| `GQL_TIMEOUT_MS` | non | `8000` | |
| `SITE_BASE_URL` | non | `https://www.yellohvillage.fr` | Construction de `camping_url` |
| `BOOKING_ENGINE_URL` | non | `https://booking.yellohvillage.com/multi-list.php` | |
| `BOOKING_ENGINE_DEFAULT_TRACK` | non | `chatbot` | |
| `DEFAULT_MAX_RESULTS` | non | `3` | |
| `MAX_RESULTS_LIMIT` | non | `10` | |
| `MAX_AVAILABILITY_CALLS` | non | `8` | Borne d'appels `campingAvailability` par recherche |
| `AVAILABILITY_CONCURRENCY` | non | `4` | |
| `MAX_PEOPLE` | non | `12` | |
| `MAX_STAY_NIGHTS` | non | `28` | |
| `RATE_LIMIT_PER_MINUTE` | non | `60` | Par client et par instance |
| `CORS_ALLOWED_ORIGINS` | non | vide | Liste séparée par des virgules |
| `ALLOW_DEBUG_SEED` | non | `false` | Autorise l'en-tête `X-Debug-Seed` (interdit en production) |
| `LOG_LEVEL` | non | `info` | `debug` \| `info` \| `warn` \| `error` |
| `TZ_BUSINESS` | non | `Europe/Paris` | Fuseau du calcul de « aujourd'hui » |

Les secrets (`API_CLIENTS`, `SESSION_SIGNING_SECRET*`) sont stockés dans les variables d'environnement chiffrées de Netlify, ou dans AWS Secrets Manager / SSM Parameter Store (SecureString) injectés dans la Lambda. Ils ne sont jamais commités. Le fichier `.env.example` ne contient que des valeurs factices.

---

## 14. Déploiement Netlify et AWS Lambda

### 14.1 Netlify

`netlify.toml` :

```toml
[build]
  command = "npm ci && npm run build"
  publish = "public"            # dossier vide ou page d'accueil statique minimale

[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"

[[redirects]]
  from = "/v1/*"
  to = "/.netlify/functions/api/:splat"
  status = 200
  force = true
```

- L'adaptateur `netlify/functions/api.ts` exporte un `handler(event, context)` (format compatible Lambda des Netlify Functions). Il reconstruit `path` en retirant le préfixe `/.netlify/functions/api`.
- Timeout : le timeout synchrone par défaut des Netlify Functions est de 10 s. Le budget de §15 tient dans cette limite ; demander à Netlify une hausse à 26 s si besoin.
- Les variables d'environnement se configurent dans l'UI ou la CLI Netlify, avec le scope « Functions ».

### 14.2 AWS Lambda

- Handler : `dist/lambda.handler`, runtime `nodejs20.x`, architecture `arm64`, 512 Mo, timeout **25 s**.
- Exposition : **API Gateway HTTP API** (recommandé, événement v2). API Gateway REST (v1) et Lambda Function URL sont aussi supportés par l'adaptateur.
- Limitation de débit : *throttling* API Gateway (ex. 20 requêtes/s, burst 40).
- Secrets : AWS Secrets Manager, lu au démarrage à froid et gardé en mémoire de l'instance (`SECRETS_ARN` optionnel). À défaut, variables d'environnement chiffrées par KMS.
- Infrastructure as code : `template.yaml` (AWS SAM) avec la fonction, l'API HTTP, le log group (rétention 30 jours) et les variables d'environnement.

### 14.3 Exemples d'utilisation (à reprendre dans le README)

```bash
TOKEN=$(curl -s -X POST https://<host>/v1/auth/session -H "X-API-Key: $YV_API_KEY" | jq -r .access_token)
```

```bash
curl -s https://<host>/v1/search/filters?accommodationType=rental -H "Authorization: Bearer $TOKEN"
```

```bash
curl -s "https://<host>/v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=F4,SR7&maxResults=3" -H "Authorization: Bearer $TOKEN"
```

---

## 15. Exigences non fonctionnelles

| Exigence | Cible |
|---|---|
| Latence `/v1/search/campings`, cas R1 sans filtre hébergement (1 appel GraphQL) | p95 < 3 s |
| Latence, cas R1 avec filtre hébergement (2 appels séquentiels) | p95 < 5 s |
| Latence, cas R2 (2 appels + 1 à 2 lots de `campingAvailability`) | p95 < 8 s |
| Latence `/v1/search/filters` | p95 < 3 s |
| Latence `/v1/auth/session` | p95 < 100 ms (hors démarrage à froid) |
| Démarrage à froid | < 500 ms (bundle esbuild < 1 Mo) |
| Disponibilité | Celle de la plateforme, plus dépendance au GraphQL amont |
| Journaux | JSON, une ligne par requête : `request_id`, `client_id`, route, statut, `duration_ms`, nombre d'appels amont, `status` métier, nombres `available` / `alternative` |
| Données personnelles | Aucune n'est traitée ni journalisée |
| Couverture de tests | ≥ 90 % sur `src/domain` et `src/auth`, ≥ 80 % au global |

`GET /v1/health` renvoie `200 {"status":"ok","version":"<package.json version>","upstream":"not_checked"}`. Avec `?deep=true`, il fait un appel `searchCampings` sans dates et renvoie `upstream: "ok" | "error"` ; ce mode répond `503` si l'amont est en échec.

---

## 16. Tests et critères d'acceptation

### 16.1 Tests unitaires obligatoires

| # | Module | Cas |
|---|---|---|
| U1 | `bookingLink` | `campingCode=49`, 08/05/2027 → 15/05/2027, 1 personne, `chatbot` : lien **identique** à l'exemple §10.1 |
| U2 | `filterEngine` | `SR7` seul : seuls les campings avec `SR7` dans `allFilters` sont gardés |
| U3 | `filterEngine` | `SO104` : match par `key` dans `filterCategories[sports_activities_on_site]`, et non par `allFilters` |
| U4 | `filterEngine` | `F4,F5` : OU dans `confort_type` |
| U5 | `filterEngine` | `F4` + `pets` : exige le même hébergement |
| U6 | `filterEngine` | `N305` + `N306` : ET (intersection) |
| U7 | `filterEngine` | Les hébergements d'un autre `accommodationType` sont ignorés |
| U8 | `filterResolver` | Id inconnu → `UNKNOWN_FILTER` ; `toFilterInput(F4)` = `{categoryId:"confort_type",value:"F4",webcampId:"4"}` |
| U9 | `classifier` | `available` / `flex` / `closed` / `error` / statut inconnu → bonne liste |
| U10 | `selector` | R1 : 10 disponibles, N=3 → 3 résultats distincts, tous `available`, aucun appel `campingAvailability` |
| U11 | `selector` | R2 : 1 disponible, 5 `flex`, N=3 → 1 `available` + 2 `alternative_dates` avec dates ; exactement 2 appels si les 2 premiers répondent `flex` |
| U12 | `selector` | R2 avec remplacement : le 1er candidat `flex` répond `unavailable` → il est écarté et un autre candidat est appelé |
| U13 | `selector` | `flexCapacity` → `alternative_capacity` avec `alternative_capacity` issue de l'hébergement `accommodationId` |
| U14 | `selector` | Borne `MAX_AVAILABILITY_CALLS` respectée |
| U15 | `selector` | R3 : 1 disponible + 1 `flex` valide, N=3 → 2 résultats, `PARTIAL` |
| U16 | `selector` | R4 : uniquement `closed` → `NO_AVAILABILITY`, message `aucun camping disponible` |
| U17 | `selector` | R4 bis : uniquement des `flex` qui répondent tous `unavailable` → `NO_AVAILABILITY` |
| U18 | `selector` | N=1, 2 et 4 sont respectés |
| U19 | `session` | Token valide accepté ; expiré → `TOKEN_EXPIRED` ; mauvaise signature → `INVALID_TOKEN` ; `exp − iat = SESSION_TTL_SECONDS` |
| U20 | `apiKeys` | Bonne clé acceptée ; mauvaise clé refusée ; client `enabled:false` refusé |
| U21 | `validation` | Toutes les erreurs 400 du §11 |
| U22 | `mappers` | `note 89.5721` → `rating 9.0` ; dates alternatives `2027-07-07T00:00:00.000Z` → `2027-07-07` |
| U23 | `filterResolver` | `accommodation_type=rental` + `C18` (filtre du catalogue `slot`) → `400 UNKNOWN_FILTER`, `details.accommodation_type = "rental"` ; `accommodation_type=slot` + `C18` → résolu en `{categoryId:"characteristics",value:"C18",webcampId:"18"}` |
| U24 | `filterCatalog` | À partir des filterCategories brutes, le catalogue produit est **identique** à `specs/exemple-reponse-search-filters-rental.json` et `…-slot.json` (hors `generated_at`) |
| U25 | `validation` | `/v1/search/filters` sans `accommodation_type` → `400 MISSING_PARAMETER` ; `accommodationType=slot` (alias) accepté |

### 16.2 Tests d'intégration (GraphQL simulé)

- **Parcours complet** : `POST /v1/auth/session`, puis `GET /v1/search/filters`, puis `GET /v1/search/campings`, dans les scénarios R1, R2, R3 et R4.
- **Requêtes envoyées à l'amont** :
  - en-têtes `Origin`, `gql-market-site` et `gql-locale` présents ;
  - aucun filtre camping transmis au GraphQL ;
  - filtres hébergement transmis à GQL#2 et à `campingAvailability` ;
  - exactement 1 appel `searchCampings` sans filtre hébergement, et exactement 2 avec.
- **Erreurs amont** : `errors[]` sur `searchCampings` → `502` ; timeout → `504` ; erreur sur `campingAvailability` → camping écarté, réponse `200`.
- **Filtre incompatible** (§8.7) : `rental` + `C18` → `400 UNKNOWN_FILTER` après **un seul** appel `searchCampings` (GQL#1), sans GQL#2 ni `campingAvailability`.
- **Sécurité** : appels sans token → `401` ; aucune clé ni aucun token dans les logs (assertion sur le logger simulé).

### 16.3 Fixtures

Les fixtures sont générées par le script `scripts/record-fixtures.ts` (hors CI, réseau requis). Il enregistre de vraies réponses GraphQL réduites :

| Fixture | Requête | Usage |
|---|---|---|
| `search-jul-4p-nofilter.json` | juillet 2027, 4 pers. | R1 |
| `search-jul-4p-F5.json` | idem, avec Premium | Particularité confort |
| `search-apr-4p.json` | avril 2027 | Mélange `closed`, `available` et `flex` |
| `catalog-rental.json`, `catalog-slot.json` | sans dates | Catalogue |
| `availability-*.json` | quelques campings | `flex`, `flexCapacity`, `unavailable` |

Les tests de §16.1 et §16.2 peuvent aussi utiliser des fixtures construites à la main et minimales.

### 16.4 Critères d'acceptation (recette)

1. Avec une clé valide, un token est obtenu. Il est refusé 4 h et 1 s après son émission (horloge simulée).
2. `GET /v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4` renvoie 3 campings disponibles, différents d'un appel à l'autre, chacun avec un `bookingengine_link` qui ouvre YellohResa sur le bon village, aux bonnes dates et pour 4 personnes.
3. Une recherche à 10 personnes en juillet 2027 (peu de disponibles) renvoie des résultats `alternative_*` dont les dates alternatives sont renseignées et reprises dans le lien.
4. Une recherche pendant la fermeture du réseau (ex. janvier) renvoie `status: "NO_AVAILABILITY"` et `message: "aucun camping disponible"`.
5. `maxResults=1`, `2` et `4` renvoient au plus 1, 2 et 4 résultats.
6. L'ajout d'un filtre de confort modifie les résultats de façon cohérente avec la page `https://www.yellohvillage.fr/camping/recherche?date_start=…&date_end=…&nb_personnes=…&selectedFilters=F5`.
7. Le même build se déploie sur Netlify et sur AWS Lambda, et passe le parcours ci-dessus sur les deux.
8. `GET /v1/search/filters?accommodation_type=rental` et `…=slot` renvoient la même structure que les fichiers d'exemple de `specs/`. Sans `accommodation_type`, la réponse est `400`.
9. Une recherche `rental` avec « Sanitaire privatif » (`C18`) renvoie `400 UNKNOWN_FILTER` ; la même recherche en `slot` renvoie des résultats.

---

## 17. Instructions de génération pour Claude Code

1. Initialiser le projet selon l'arborescence §12.2, en TypeScript `strict`, ESM, Node 20.
2. Implémenter dans l'ordre :
   - `config` → `upstream` → `domain` (avec ses tests unitaires) → `auth` → `routes` → `app` → `adapters` → `dev-server` ;
   - puis `netlify.toml`, `template.yaml`, `README.md`, `.env.example` et les scripts.
3. **Ne pas inventer de champ amont** : utiliser exclusivement les requêtes de l'annexe A et les formats des §9 et annexe C.
4. Recopier fidèlement l'algorithme de filtrage §8.4 et la sélection §8.6. Ce sont des règles métier validées.
5. Respecter les noms de champs de réponse du §7.6 à l'identique : `bookingengine_link`, `alternative_begin_date_availability`, `alternative_end_date_availability`…
6. Aucun secret en dur ; aucun cache serveur ; aucun appel `campingAvailability` pour les campings `available`.
7. Livrer avec `npm test` vert et une couverture conforme au §15. Générer `openapi.json`.
8. Documenter dans le README : création d'une clé (`keys:generate`), configuration, déploiement Netlify, déploiement SAM, et les exemples curl du §14.3.

---

## 18. Points ouverts

| # | Sujet | Hypothèse retenue en attendant |
|---|---|---|
| P1 | Noms des champs de dates alternatives : la demande initiale écrivait `availybility` | Orthographe corrigée en `alternative_begin_date_availability` / `alternative_end_date_availability`. À confirmer avec l'équipe de l'app tierce avant la mise en production. |
| P2 | Le lien YellohResa n'a pas de paramètre « Locatif / Emplacement » | Le lien est identique pour `rental` et `slot`. Un paramètre éventuel est à demander à l'équipe YellohResa. |
| P3 | Révocation immédiate d'un token | Pas de liste de révocation : désactiver le client invalide les nouveaux tokens, mais un token déjà émis reste valable jusqu'à son expiration (au plus 4 h). Changer `SESSION_SIGNING_SECRET` invalide tous les tokens. |
| P4 | Bornes `MAX_PEOPLE` (12) et `MAX_STAY_NIGHTS` (28) | À valider avec le métier |
| P5 | Volumétrie et accord avec l'équipe sitemarket | Chaque recherche fait 1 à 2 appels `searchCampings` et 0 à 8 appels `campingAvailability` |
| P6 | Multi-marchés (.co.uk, .de, .nl, .es, .it, .cat) | v1 FR uniquement. La configuration (`GQL_MARKET_SITE`, `GQL_LOCALE`, `lang`) est déjà paramétrable par variable. |

---

## Annexe A — Requêtes GraphQL

### A.1 `CATALOG_QUERY` (utilisée par `/v1/search/filters`)

```graphql
query apiFilterCatalog($accommodationType: String!, $peopleCount: Int!, $campingContentIds: [Int], $filters: [FilterInput!]) {
  searchCampings(peopleCount: $peopleCount, accommodationType: $accommodationType,
                 campingContentIds: $campingContentIds, filters: $filters) {
    filterCategories { categoryId type priority filters { id title key priority newFilterId englishTitle } }
  }
}
```

Variables : `{"accommodationType":"rental","peopleCount":1,"campingContentIds":[],"filters":[]}`

### A.2 `SEARCH_QUERY_WITH_CATALOG` (GQL#1) et `SEARCH_QUERY` (GQL#2)

`SEARCH_QUERY` est identique à `SEARCH_QUERY_WITH_CATALOG`, sans le bloc `filterCategories` racine.

```graphql
query apiSearchCampings($startDate: Date, $endDate: Date, $accommodationType: String!, $peopleCount: Int!,
                        $campingContentIds: [Int], $filters: [FilterInput!]) {
  searchCampings(peopleCount: $peopleCount, accommodationType: $accommodationType, startDate: $startDate,
                 endDate: $endDate, campingContentIds: $campingContentIds, filters: $filters) {
    campings {
      campingCode contentId name starCount city department region campingUrl image note isNew
      availabilityStatus allFilters
      coordinates { latitude longitude }
      specialOffer { description }
      filterCategories { categoryId filters { key } }
      accommodations {
        ... on Rental { code accommodationType filters technicalInfos { capacity { value } } }
        ... on Slot   { code accommodationType filters technicalInfos { capacity { value } } }
      }
    }
    filterCategories { categoryId type priority filters { id title key priority newFilterId englishTitle } }
  }
}
```

### A.3 `AVAILABILITY_QUERY`

```graphql
query apiCampingAvailability($campingCode: Int!, $startDate: Date!, $endDate: Date!, $accommodationType: String!,
                             $peopleCount: Int!, $filters: [FilterInput!], $fidelityId: ID) {
  campingAvailability(campingCode: $campingCode, peopleCount: $peopleCount, accommodationType: $accommodationType,
                      startDate: $startDate, endDate: $endDate, filters: $filters, fidelityId: $fidelityId) {
    statusCode
    accommodationId
    info { arrivalDate departureDate }
  }
}
```

### A.4 Types TypeScript amont (extrait)

```ts
export type GqlAvailabilityStatus = 'available' | 'flex' | 'closed' | 'error' | string;

export interface GqlFilter { id: string; title: string; key: string; priority: number | null;
                             newFilterId: string | null; englishTitle: string | null; }
export interface GqlFilterCategory { categoryId: string; type: 'camping' | 'accommodation';
                                     priority: number | null; filters: GqlFilter[]; }
export interface GqlAccommodation { code: number; accommodationType: 'rental' | 'slot'; filters: string[] | null;
                                    technicalInfos?: { capacity?: { value: string | null } | null } | null; }
export interface GqlCamping {
  campingCode: number; contentId: number; name: string; starCount: number | null; city: string;
  department: string | null; region: string | null; campingUrl: string; image: string | null; note: number | null;
  isNew: boolean; availabilityStatus: GqlAvailabilityStatus | null; allFilters: string[] | null;
  coordinates: { latitude: number; longitude: number } | null; specialOffer: { description: string | null } | null;
  filterCategories: { categoryId: string; filters: { key: string }[] | null }[] | null;
  accommodations: (GqlAccommodation | null)[] | null;
}
export interface GqlCampingAvailability {
  statusCode: 'available' | 'flex' | 'flexCapacity' | 'unavailable' | 'full' | 'closed' | 'outPeriod' | 'pastPeriod' | 'error' | string;
  accommodationId: number | null;
  info: { arrivalDate: string; departureDate: string } | null;
}
```

---

## Annexe B — Catalogue des filtres observé

Relevé du 20/11/2026, marché FR, `rental`. Le catalogue est **dynamique** : l'API le lit toujours en direct, et ce relevé ne sert qu'aux fixtures et aux tests. Le catalogue complet de chaque type, au format de l'API, est dans `specs/exemple-reponse-search-filters-rental.json` et `specs/exemple-reponse-search-filters-slot.json`.

Filtres `characteristics` propres au type `slot` (`newFilterId` → `id`) : C20 → `20` Electricité · C1 → `1` Moins de 80 m² · C2 → `2` 80 m² et plus · C555 → `555` 100 m² · C3 → `3` 100 m² et plus · C4 → `4` 130 m² et plus · C5 → `5` 150 m² et plus · C10 → `10` Raccordement à l'eau · C11 → `11` Evacuation des eaux usées · C18 → `18` Sanitaire privatif · C12 → `12` Salon de jardin · C13 → `13` Barbecue · C552 → `552` Barbecue à gaz.

| categoryId | Filtres (`newFilterId` → `id`/webcampId : libellé) |
|---|---|
| `destination` | N304 → `#20` Campagne · N305 → `#10` Mer · N306 → `#50` Montagne · N40597 → `#30` Rivière |
| `geo_location` | SR162 Accès direct mer · SR163 Accès direct rivière · SR254 Accès direct lac |
| `confort_type` | **F0 → `0-3` 0-3 fleurs · F4 → `4` 4 fleurs · F5 → `-1` Premium** |
| `filtered_accommodation_type` | N131012 → `125944` Insolite · N133161 → `128114` Chambre · N16478 → `13780` Cabane dans les arbres · N16479 → `13781` Chalet · N16480 → `13782` Maison de vacances · N16481 → `13783` Mobil home · N16482 → `13784` Tente meublée · N17216 → `14545` Studio · N81769 → `78102` Roulotte |
| `animals_allowed` | pets → `pets` Animaux acceptés (€) |
| `pmr` | pmr → `pmr` Accès PMR |
| `characteristics` | C160 → `160` Spa privatif · C21 → `21` Quartier piétonnier · C30 → `30` Télévision · C314 → `314` Climatisation · C462 → `462` Piscine réservée au quartier · C493 → `493` Piscine réservée au cottage · C700 → `700` Piscine chauffée réservée au quartier |
| `swimming` | SR12 Pataugeoire couverte et chauffée · SR13 Aire de jeux aquatique couverte · SR275 Piscine couverte et chauffée · SR2 Aire de jeux aquatique · SR230 Bassin de nage · SR4 Piscine extérieure chauffée · SR5 Piscine couverte · SR6 Pataugeoire extérieure chauffée · SR7 Toboggan(s) |
| `children_clubs` | SR161 Club Kids & Juniors 5-12 ans · SR25 Special Babies 0-4 ans · SR26 Club Kids 5-7 ans · SR27 Club Juniors 8-12 ans · SR28 Club Teens 13-17 ans |
| `facilities` | SR152 Borne de recharge VE · SR218 Services All Season · SR253 Label Yelloh! Restaurant · SR74 Location de réfrigérateurs · SR92 Offre demi-pension · SR93 Location barbecue/plancha |
| `sports_activities_on_site` | SO104 Mini-golf · SO105 Fitness · SO106 Multisports · SO110 Tennis · SO113 Club nautique · SO184 Mini ferme · SO198 Padel · SO236 Accrobranche · SO35 Cheval/poney · SO44 Surf · SO45 Plongée · SO46 Natation · SO62 Pêche · SO63 Canoë kayak · SO67 Salle de jeux · SO82 Location de vélos · SO89 Discothèque |
| `sports_activities` | SR104 Mini-golf · SR105 Fitness · SR106 Multisports · SR109 Golf · SR110 Tennis · SR113 Club nautique · SR184 Mini ferme · SR198 Padel · SR236 Accrobranche · SR35 Cheval/poney · SR41 Ski · SR44 Surf · SR45 Plongée · SR46 Natation · SR62 Pêche · SR63 Canoë kayak · SR67 Salle de jeux · SR82 Location de vélos · SR89 Discothèque |

Pour les filtres camping, l'`id` GraphQL est le libellé (ex. `Toboggan(s)`), et c'est `newFilterId` qui figure dans `camping.allFilters`.

## Annexe C — Exemples de réponses GraphQL réelles

Les exemples proviennent de la production, relevés le 20/11/2026 pour un séjour du 10/07/2027 au 17/07/2027, 4 personnes, en location.

Extrait d'un camping de `searchCampings` :

```json
{
  "campingCode": 6934, "contentId": 58552, "name": "La Marende", "starCount": 5,
  "city": "Argelès-sur-Mer", "department": "Pyrénées Orientales", "region": "Languedoc-Roussillon",
  "campingUrl": "/camping/la_marende", "note": 89.5721, "isNew": false,
  "availabilityStatus": "available",
  "allFilters": ["SR63","SR82","SR62","SR45","SR35","SR104","SR110","SR236","SR6","SR4","SR7","SR27","SR26","SR28","SO106","SR152","SR74","SR218","N305"],
  "coordinates": { "latitude": 42.573152, "longitude": 3.042505 },
  "accommodations": [
    { "code": 131684, "accommodationType": "rental", "title": "Cottage Romarin",
      "filters": ["pets","13783","13783","4","314"], "technicalInfos": { "capacity": { "value": "6" } } }
  ]
}
```

Résultats de `campingAvailability` pour des campings `flex` dans `searchCampings` :

```json
{ "campingCode": 1531, "statusCode": "flex", "accommodationId": 118531,
  "info": { "arrivalDate": "2027-07-07T00:00:00.000Z", "departureDate": "2027-07-14T00:00:00.000Z" } }

{ "campingCode": 23, "statusCode": "unavailable", "accommodationId": null, "info": null }
```

Le second exemple, Le Brasilia, est `flex` dans `searchCampings` mais `unavailable` au détail. C'est ce cas qui justifie la revérification du §8.6.

Statuts de `searchCampings` selon les critères (100 campings) :

| Critères | available | flex | closed |
|---|---|---|---|
| 10→17/07/2027, 4 pers. | 96 | 4 | 0 |
| idem + `F5` (Premium) | 79 | 21 | 0 |
| idem, 10 pers. | 13 | 87 | 0 |
| 03→10/04/2027, 4 pers. | 33 | 15 | 52 |
