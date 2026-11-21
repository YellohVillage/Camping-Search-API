# Camping Search API — Spécification de développement

> **Destinataire** : ce document doit pouvoir être donné tel quel à Claude Code (ou à un développeur) pour générer le code Node.js de l'API. Il est autoporteur : les contrats amont (GraphQL Yelloh! Village, funnel YellohResa), les règles de gestion, les contrats REST, la sécurité, l'architecture et les tests y sont décrits.

| | |
|---|---|
| Version | 2.8 |
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
| 2.2 | Révocation d'un client : ses tokens en cours sont refusés dès que la nouvelle configuration est prise en compte (§4.2, §4.3, P3), sans stockage côté serveur. Rafraîchissement périodique des secrets lus dans AWS Secrets Manager. |
| 2.3 | **Optimisation : un seul appel `searchCampings` par recherche.** Les ids de filtres deviennent autoporteurs (`categorie:code[:webcampId]`, ex. `confort_type:F4:4`) : l'API envoie les filtres hébergement dès le premier appel, puis valide les ids avec le catalogue renvoyé par ce même appel. Nouveau code d'erreur `INVALID_FILTER_FORMAT`. Exemples JSON régénérés. |
| 2.4 | **Aucune liste d'ids de filtres en dur.** Avant l'appel `searchCampings`, seul un contrôle **syntaxique** est fait : le niveau du filtre se déduit du nombre de parties de l'id. Toute la cohérence (catégorie, niveau, code, webcampId) est vérifiée **après** l'appel, avec le catalogue renvoyé par le GraphQL. Suppression de la restriction en dur à `pets`. Test de garde contre les ids en dur. |
| 2.5 | Points ouverts P1, P2 et P4 tranchés : orthographe `availability` confirmée ; paramètre `type` du lien YellohResa (`0` = location, `1` = emplacement) ; `MAX_PEOPLE = 10` et `MAX_STAY_NIGHTS = 90`. |
| 2.6 | Limite de débit paramétrable par client : champ facultatif `rate_limit_per_minute` dans `API_CLIENTS`, avec repli sur `RATE_LIMIT_PER_MINUTE`. |
| 2.7 | Alignement sur le front après vérification : seuls les campings `flex` sont candidats « autres dates » (E2) ; réponse `campingAvailability` exploitable seulement avec `accommodationId` (E3) ; ordre des sections, catégories et filtres du catalogue selon les `priority` GraphQL (E4, E5), exemples JSON régénérés ; traitement du statut `error` documenté comme écart volontaire (E1). |
| 2.8 | Annexe D : exemple commenté d'enchaînement des appels par une application tierce (session, catalogue, recherches R1, R2 et R4, gestion des erreurs), avec des données réelles. |

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
- [Annexe D — Exemple d'enchaînement des appels par l'application tierce](#annexe-d--exemple-denchaînement-des-appels-par-lapplication-tierce)

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
    │ 3. GET /v1/search/campings?… (Bearer)         │  searchCampings ×1                  │
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
| **Disponible à d'autres dates** | Statut GraphQL `flex` : une offre existe à des dates proches. Les dates exactes s'obtiennent avec la requête `campingAvailability`. |
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
  { "client_id": "chatbot-yv", "key_sha256": "3f1c…e9a0", "track": "chatbot",  "enabled": true, "rate_limit_per_minute": 120 },
  { "client_id": "partner-x",  "key_sha256": "a81b…77d2", "track": "partnerx", "enabled": true }
]
```

| Champ | Type | Obligatoire | Description |
|---|---|---|---|
| `client_id` | string | oui | Identifiant de l'application tierce (`[a-z0-9-]{3,40}`). Plusieurs entrées peuvent partager le même `client_id` (rotation de clé). |
| `key_sha256` | string (64 hex) | oui | Empreinte SHA-256 de la clé d'API |
| `track` | string | oui | Valeur du paramètre `track` des liens YellohResa |
| `enabled` | booléen | oui | `false` coupe l'accès du client et refuse ses tokens en cours |
| `rate_limit_per_minute` | entier ≥ 1 | non | Limite de débit de ce client (§4.4). Absent : `RATE_LIMIT_PER_MINUTE`. |

La configuration est validée au démarrage (`config.ts`). Une entrée invalide (champ manquant, `rate_limit_per_minute` non entier ou < 1) arrête le processus avec un message explicite. Si deux entrées d'un même `client_id` déclarent des `rate_limit_per_minute` différents, la valeur la plus élevée s'applique au client.

- Vérification : on calcule `sha256(clé reçue)` et on le compare avec `crypto.timingSafeEqual` à chaque empreinte active.
- Le champ `track` du client sert de valeur au paramètre `track` des liens YellohResa (§10).
- Révocation : passer `enabled: false` ou retirer l'entrée. Le client ne peut plus obtenir de token, et **ses tokens déjà émis sont refusés** dès que la nouvelle configuration est prise en compte, parce que chaque requête vérifie que le client du token est toujours actif (§4.3). Aucune liste de révocation ni aucun stockage côté serveur n'est nécessaire.
- Délai de prise en compte d'une révocation, selon la source de configuration :

  | Source de `API_CLIENTS` | Prise en compte |
  |---|---|
  | Variable d'environnement Netlify | Au prochain déploiement : les fonctions du nouveau déploiement lisent la nouvelle valeur |
  | Variable d'environnement AWS Lambda | Dès la mise à jour de la configuration de la fonction : Lambda démarre de nouveaux environnements d'exécution pour les invocations suivantes |
  | AWS Secrets Manager (`SECRETS_ARN`) | Au plus `SECRETS_REFRESH_SECONDS` (défaut 300 s) : chaque instance relit le secret périodiquement (§14.2) |

- Un client révoqué puis réactivé retrouve l'usage de ses tokens non expirés. Pour les invalider définitivement, il faut lui attribuer un nouveau `client_id`.
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
- client toujours présent et `enabled` dans `API_CLIENTS` : on cherche le client par le `sub` du token. Cette vérification ne lit que la configuration chargée par l'instance ; elle ne nécessite aucun stockage. Client absent ou désactivé → `401 INVALID_TOKEN`.

Échec : `401` avec le code `INVALID_TOKEN` ou `TOKEN_EXPIRED`, et l'en-tête `WWW-Authenticate: Bearer error="invalid_token"`.

### 4.4 Autres mesures

- HTTPS uniquement. Netlify et API Gateway terminent le TLS.
- **CORS** désactivé par défaut. La clé d'API ne doit jamais être exposée dans un navigateur. Si l'app tierce appelle l'API depuis un navigateur avec le token, ses origines sont listées dans `CORS_ALLOWED_ORIGINS`.
- **Limitation de débit** : elle est assurée par la plateforme (AWS API Gateway avec *usage plan* et *throttling* ; Netlify avec la règle *Rate limiting* sur `/v1/*`). En complément, l'application applique une limite **par client** et par instance, en mémoire :
  - la valeur est le champ `rate_limit_per_minute` de l'entrée du client dans `API_CLIENTS` (§4.2), ou à défaut la variable globale `RATE_LIMIT_PER_MINUTE` (défaut 60) ;
  - le compteur porte sur les requêtes des endpoints protégés (`/v1/search/*`), sur une fenêtre glissante d'une minute, identifié par le `client_id` du token ;
  - au-delà, la réponse est `429 RATE_LIMITED`, avec l'en-tête `Retry-After` (secondes) ; chaque réponse protégée porte `X-RateLimit-Limit` et `X-RateLimit-Remaining` ;
  - cette limite est indicative, car elle n'est pas partagée entre instances. Pour une limite stricte par client, il faut la régler dans la plateforme (par exemple un *usage plan* API Gateway par client).
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
3. L'ordre suit les priorités renvoyées par le GraphQL, comme sur le site (fonction de regroupement du front) :
   - les catégories retenues sont triées par `priority` croissante (`null` vaut 0), avec un **tri stable** : à priorité égale, l'ordre du GraphQL est conservé ;
   - une section apparaît à la position de sa première catégorie dans cet ordre ;
   - dans une section, les catégories gardent cet ordre. Seule exception, reprise du front : dans la section `location`, la catégorie `destination` est toujours placée en premier ;
   - dans chaque catégorie, les filtres sont triés par `priority` croissante, avec un tri stable (à priorité égale, ordre du GraphQL).

   Avec les priorités relevées le 21/11/2026, l'ordre obtenu est : Localisation, Clubs enfants, Piscine, Niveau de confort, Hébergement, Services, Activités sur place, Activités à proximité. Il n'est pas codé : il change si les priorités changent dans le back-office.
4. Les filtres dont `newFilterId` est `null` ou vide sont ignorés.

### 6.1 Mapping des catégories GraphQL

C'est la règle de référence, reprise du front du site yellohvillage.fr. La colonne `#` ne sert qu'à numéroter les lignes : l'ordre d'affichage vient des `priority` GraphQL (étape 3 ci-dessus).

| # | `categoryId` GraphQL | `section` API | Libellé FR de la section | `level` | `operator` | Remarque |
|---|---|---|---|---|---|---|
| 1 | `destination` | `location` | Localisation | `camping` | `AND` | |
| 2 | `geo_location` | `location` | Localisation | `camping` | `AND` | |
| 3 | `confort_type` | `comfort` | Niveau de confort | `accommodation` | `OR` | **Filtre hébergement** |
| 4 | `filtered_accommodation_type` | `accommodation` | Hébergement | `accommodation` | `OR` | |
| 5 | `animals_allowed` | `accommodation` | Hébergement | `accommodation` | `AND` | Tous les filtres renvoyés sont exposés (aujourd'hui, le GraphQL ne renvoie que `pets`) |
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
            { "id": "confort_type:F0:0-3", "label": "0-3 fleurs", "label_en": "0-3 flowers" },
            { "id": "confort_type:F4:4",   "label": "4 fleurs",   "label_en": "4 flowers" },
            { "id": "confort_type:F5:-1",  "label": "Premium",    "label_en": "Premium" }
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
          "filters": [ { "id": "swimming:SR7", "label": "Toboggan(s)", "label_en": "Slide(s)" } ]
        }
      ]
    }
  ]
}
```

Règles des champs :

- `id` est un **identifiant autoporteur** : il contient tout ce dont l'API a besoin pour transmettre le filtre au GraphQL sans relire le catalogue. C'est l'identifiant que l'app renvoie dans `filters` lors de la recherche.

  | Niveau du filtre | Format de `id` | Exemples |
  |---|---|---|
  | `camping` | `{categoryId}:{newFilterId}` | `swimming:SR7` (Toboggan(s)), `destination:N305` (Mer), `sports_activities_on_site:SO104` (Mini-golf) |
  | `accommodation` | `{categoryId}:{newFilterId}:{webcampId}` | `confort_type:F4:4` (4 fleurs), `confort_type:F5:-1` (Premium), `animals_allowed:pets:pets`, `filtered_accommodation_type:N16481:13783` (Mobil home), `characteristics:C18:18` (Sanitaire privatif) |

  - `categoryId` est le `categoryId` GraphQL, `newFilterId` le `newFilterId` GraphQL, et `webcampId` le champ `id` GraphQL du filtre. C'est la valeur présente dans `accommodation.filters[]`.
  - Aucune de ces parties ne contient `:` ni `,`. La génération du catalogue le vérifie et ignore, avec un avertissement dans les logs, un filtre qui ne respecterait pas cette règle.
  - Pour l'app tierce, l'`id` est **opaque** : elle le recopie depuis le catalogue sans le construire ni l'interpréter. Ce sont `label` et `label_en` qu'elle affiche à l'utilisateur.
  - Si une recherche répond `400 UNKNOWN_FILTER`, le catalogue en cache de l'app est probablement périmé : elle doit le recharger.
- `label` vient de `title`, et `label_en` de `englishTitle` (`null` si absent).
- Le compteur GraphQL `count` n'est pas exposé : il compte tantôt des campings, tantôt des hébergements, et serait trompeur.

---

## 7. Endpoint `GET /v1/search/campings`

### 7.1 Paramètres

| Paramètre | Alias | Type | Obligatoire | Défaut | Contraintes |
|---|---|---|---|---|---|
| `startDate` | `start_date` | `YYYY-MM-DD` | **oui** | | Date valide, ≥ aujourd'hui (fuseau `Europe/Paris`) |
| `endDate` | `end_date` | `YYYY-MM-DD` | **oui** | | > `startDate`, séjour ≤ `MAX_STAY_NIGHTS` nuits (défaut 90) |
| `peopleCount` | `people_count` | entier | **oui** | | 1 ≤ n ≤ `MAX_PEOPLE` (défaut 10) |
| `accommodationType` | `accommodation_type` | `rental` \| `slot` | non | `rental` | Type d'hébergement recherché. Les ids de `filters` doivent appartenir au catalogue de ce type (§8.7). |
| `filters` | | liste d'ids séparés par des virgules (ou paramètre répété) | non | vide | Ids issus de `/v1/search/filters` (format autoporteur, §6), ex. `confort_type:F4:4,swimming:SR7`. Doublons ignorés, au plus 30 ids. |
| `maxResults` | `max_results` | entier | non | `DEFAULT_MAX_RESULTS` (3) | 1 ≤ n ≤ `MAX_RESULTS_LIMIT` (défaut 10) |
| `locale` | | `fr` | non | `fr` | |

Exemple :

```
GET /v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=confort_type:F4:4,confort_type:F5:-1,animals_allowed:pets:pets,swimming:SR7&maxResults=3
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
    "filters": ["confort_type:F4:4", "confort_type:F5:-1", "animals_allowed:pets:pets", "swimming:SR7"],
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
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4&lang=fr&track=chatbot&type=0"
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
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=03%2F04%2F2027&end=10%2F04%2F2027&sites[]=76&nb_pers=4&lang=fr&track=chatbot&type=0" },
    { "rank": 2, "availability_type": "alternative_dates", "camping_code": 1531, "name": "Les Fontaines", "…": "…",
      "alternative_begin_date_availability": "2027-04-07",
      "alternative_end_date_availability": "2027-04-14",
      "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=07%2F04%2F2027&end=14%2F04%2F2027&sites[]=1531&nb_pers=4&lang=fr&track=chatbot&type=0" },
    { "rank": 3, "availability_type": "alternative_capacity", "camping_code": 23, "name": "Le Brasilia", "…": "…",
      "alternative_begin_date_availability": "2027-04-03",
      "alternative_end_date_availability": "2027-04-10",
      "alternative_capacity": 6,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=03%2F04%2F2027&end=10%2F04%2F2027&sites[]=23&nb_pers=4&lang=fr&track=chatbot&type=0" }
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

1. Contrôle SYNTAXIQUE des ids de filtres (§8.2 a), sans appel GraphQL ni liste de référence
      → id mal formé : 400 INVALID_FILTER_FORMAT
      → id à 3 parties → accFilters (transmis au GraphQL) ; id à 2 parties → campFilters
2. GQL = searchCampings(start, end, type, people, campingContentIds=[],
                        filters = toFilterInput(accFilters))         ← APPEL UNIQUE (§8.3)
         avec SEARCH_QUERY (campings + catalogue filterCategories)
3. Validation de COHÉRENCE des filtres (§8.2 b) avec GQL.filterCategories (catalogue du type demandé)
      → catégorie, niveau, code ou webcampId incohérent : 400 UNKNOWN_FILTER (ids fautifs, §8.7)
        AUCUN appel campingAvailability n'est fait
      → chaque filtre est complété par sa `key` (utile aux filtres d'activités)
4. campings = GQL.campings.filter(c => keepCamping(c, campFilters ∪ accFilters, type))   (§8.4)
5. Classement (§8.5) → AVAILABLE[], ALTERNATIVE[], UNAVAILABLE[]
6. Sélection et complétion (§8.6) → results[] (≤ N)
7. Construction des liens (§10) et de la réponse (§7)
```

### 8.2 Résolution des filtres

> **Principe** : le code ne contient **aucune liste d'ids de filtres** (`F4`, `SR7`, `pets`, `C18`…). Les filtres valides sont ceux du catalogue renvoyé par le GraphQL au moment de la recherche. La vérification de cohérence se fait donc **après** l'appel `searchCampings`. Avant cet appel, on ne fait qu'un contrôle de forme.
>
> Seul le tableau §6.1 est codé : il liste des **catégories** (`categoryId`) et donne leur section, leur libellé, leur niveau et leur opérateur. Il n'est utilisé qu'après l'appel GraphQL, ainsi que pour construire le catalogue de `/v1/search/filters`. Les règles §8.4 citent aussi deux catégories (`sports_activities_on_site`, `sports_activities`), pour le match par `key`.

La résolution se fait en deux temps : un **contrôle syntaxique** avant l'appel GraphQL, puis une **validation de cohérence** avec le catalogue renvoyé par cet appel.

**a) Contrôle syntaxique (avant l'appel)**, sans aucune liste de référence. Chaque id doit respecter l'expression `^([a-z_]+):([^:,]+)(?::([^:,]+))?$` :

- 3 parties `categoryId:code:webcampId` : filtre **présumé hébergement**. Il est transmis au GraphQL (`toFilterInput`).
- 2 parties `categoryId:code` : filtre **présumé camping**. Il n'est pas transmis au GraphQL, qui ignore ces filtres (§8.3).
- Toute autre forme (partie vide, plus de 3 parties, caractères interdits, ancien format `F4`) donne `400 INVALID_FILTER_FORMAT`, avec `details.invalid` qui liste les ids fautifs. Aucun appel GraphQL n'est fait.

La catégorie et le niveau ne sont **pas** vérifiés à ce stade.

**b) Validation de cohérence (après l'appel)** : pour chaque filtre, on vérifie dans l'ordre :

1. la catégorie `categoryId` existe dans `filterCategories` (catalogue du type demandé) **et** dans le tableau §6.1 ;
2. le nombre de parties de l'id correspond au niveau de la catégorie (`type` GraphQL et `level` §6.1, qui doivent concorder) : 3 parties pour `accommodation`, 2 pour `camping` ;
3. la catégorie contient un filtre `f` tel que `f.newFilterId === code` ;
4. pour un filtre hébergement, en plus, `f.id === webcampId`.

Si l'une de ces conditions échoue, la réponse est `400 UNKNOWN_FILTER` (§8.7) avec la liste de tous les ids fautifs. Les campings renvoyés par le GraphQL sont alors ignorés, et aucun appel `campingAvailability` n'est fait. Si tout concorde, on complète le filtre avec `level` et `operator` (§6.1) et `key = f.key`.

Conséquence : un id mal classé, par exemple `swimming:SR7:x` (3 parties pour une catégorie camping), part dans l'appel `searchCampings` et n'est rejeté qu'après. Ce cas coûte 1 appel, ce qui est accepté en échange de l'absence de liste en dur.

Le catalogue renvoyé par `searchCampings` est **le même avec ou sans filtres** (vérifié en production le 21/11/2026 : 8 combinaisons sur 8, `rental` et `slot`, sans filtre, avec `F4`, avec `F4` + `pets`, avec `C18`). On peut donc envoyer les filtres et valider les ids dans le même appel.

Objet résolu :

```ts
interface ResolvedFilter {
  id: string;          // id API complet, ex. "confort_type:F4:4"
  code: string;        // newFilterId, ex. "F4" (valeur cherchée dans camping.allFilters)
  webcampId: string;   // 3e partie de l'id (filtres hébergement), ex. "4" : valeur présente dans accommodation.filters
  key: string;         // f.key, renseigné à la validation, ex. "Mini-golf"
  categoryId: string;  // ex. "confort_type"
  level: 'camping' | 'accommodation';
  operator: 'AND' | 'OR';
}
```

`toFilterInput(f)` produit `{ categoryId: f.categoryId, value: f.code, webcampId: f.webcampId }`. Exemple : `confort_type:F4:4` donne `{"categoryId":"confort_type","value":"F4","webcampId":"4"}`. Les filtres sont triés par `categoryId` puis `value`, pour que les appels soient déterministes.

### 8.3 Particularité des filtres hébergement (dont le niveau de confort)

Le GraphQL **ignore les filtres camping**. En revanche, il recalcule `availabilityStatus` quand on lui passe des **filtres hébergement**.

Mesure réelle (juillet 2027, 4 personnes) : sans filtre, 96 `available` et 4 `flex` ; avec « Premium » (`F5`), 79 `available` et 21 `flex`.

Les filtres de `level = accommodation` doivent donc **obligatoirement** être transmis au GraphQL. Grâce aux ids autoporteurs (§6), ils le sont dès l'**appel unique** `searchCampings`, sans appel préalable pour lire le catalogue. Ces mêmes filtres sont aussi transmis à `campingAvailability` (§8.6).

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
  return c.allFilters?.includes(f.code) ?? false;
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

- **ET entre catégories, et à l'intérieur des catégories `AND`.** Exemple : « Mer » (`destination:N305`) + « Montagne » (`destination:N306`) donne l'intersection.
- **OU à l'intérieur de `confort_type`, `filtered_accommodation_type` et `surface`.** Exemple : `confort_type:F4:4` ou `confort_type:F5:-1`.
- **Mêmes hébergement pour tous les filtres hébergement.** Exemple : 4 fleurs + animaux exige un même hébergement 4 fleurs qui accepte les animaux.
- **Camping écarté** : un camping sans hébergement compatible est écarté de toutes les listes.

### 8.5 Classement

À partir de `availabilityStatus` (issu de l'appel unique `searchCampings`) :

| `availabilityStatus` | Liste |
|---|---|
| `available` | `AVAILABLE` |
| `flex` | `ALTERNATIVE` |
| toute autre valeur : `closed`, `error`, `null`, ou statut non prévu (`flexCapacity`, `full`, `unavailable`…) | `UNAVAILABLE` |

Seuls les campings `flex` sont candidats à la vérification `campingAvailability`, comme sur le site : le front n'appelle `campingAvailability` que pour les statuts `available` et `flex`. Les statuts non prévus n'ont pas été observés en production (seuls `available`, `flex`, `closed` et `error` l'ont été).

**Écart volontaire avec le front (statut `error` ou absent)** : le front range un camping `error`, ou sans statut, dans le carrousel « autres dates », sans appeler `campingAvailability`, et la carte affiche alors une erreur. L'API le classe en `UNAVAILABLE`. Un statut en erreur ne donne aucune information exploitable : le proposer comme « disponible à d'autres dates » serait trompeur, et le vérifier coûterait un appel sans résultat attendu.

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
          "flex"          avec info ET accommodationId → ajouter c (alternative_dates,  dates = r.info)
          "flexCapacity"  avec info ET accommodationId → ajouter c (alternative_capacity, dates = r.info,
                                                capacité = capacité de l'hébergement r.accommodationId)
          "available"     avec info ET accommodationId → ajouter c (available, sans dates alternatives)
          autre statut, info ou accommodationId absent, erreur GraphQL ou timeout
                          → camping écarté, AUCUN remplacement de la réponse ; on passe au suivant du pool
    manquant = N - |results|

// R3 / R4
SI |results| = 0 → status NO_AVAILABILITY, message "aucun camping disponible"
SINON SI |results| < N → status PARTIAL
SINON → status OK

Ordre final : les "available" d'abord, puis les "alternative_dates", puis les "alternative_capacity" (même règle que le front :
`flex` avant `flexCapacity`), dans l'ordre de validation à type égal ; rank = 1..n
```

Précisions :

- **Hasard** : `tirage` et `mélange` sont un mélange de Fisher-Yates avec `crypto.randomInt`. Deux appels identiques peuvent donc renvoyer des campings différents ; c'est voulu, pour répartir les propositions sur le réseau. Le générateur aléatoire est **injectable** (interface `Rng`) pour rendre les tests déterministes. En dehors de la production (`ALLOW_DEBUG_SEED=true`), l'en-tête `X-Debug-Seed` fixe la graine.
- **Réponse exploitable** : comme le front, une réponse `campingAvailability` n'est retenue que si `statusCode`, `accommodationId` et `info` sont tous présents. Sinon, elle est traitée comme une erreur et le camping est écarté.
- **Pourquoi revérifier** : un camping `flex` dans `searchCampings` peut se révéler indisponible avec `campingAvailability`. C'est observé en réel (exemple en annexe C). Le camping est alors écarté et remplacé par le suivant du pool, ce qui garantit que chaque proposition « autres dates » a de vraies dates.
- **Borne de coût** : `MAX_AVAILABILITY_CALLS` (défaut 8) limite le nombre total d'appels `campingAvailability` par recherche. Si la borne est atteinte sans compléter, on renvoie ce qu'on a (`PARTIAL`, ou `NO_AVAILABILITY` si rien).
- **Concurrence** : les appels d'un lot partent en parallèle, sans dépasser `AVAILABILITY_CONCURRENCY` (défaut 4).
- **Pas de chiffrage des disponibles** : un camping `available` issu de `searchCampings` n'est pas revérifié par `campingAvailability`, car les prix sont hors périmètre.
- **Dates alternatives** : `arrivalDate` et `departureDate` sont des instants ISO à minuit UTC (`2027-07-07T00:00:00.000Z`). On en retient la **partie date UTC** (`2027-07-07`).
- **`alternative_capacity`** : on cherche dans `camping.accommodations` l'hébergement dont `code === r.accommodationId`, puis on lit `technicalInfos.capacity.value`, converti en entier (`null` s'il est introuvable).
- `summary.available_count`, `alternative_dates_count` et `unavailable_count` donnent la taille des trois listes **après filtrage et avant sélection**.

---

### 8.7 Filtre incompatible avec le type d'hébergement

**Cas** : l'app envoie un filtre hébergement qui n'existe que pour l'autre type. Par exemple, `accommodation_type=rental` avec `filters=characteristics:C18:18` (« Sanitaire privatif », filtre propre aux emplacements).

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

**Règle retenue** : le GraphQL ne se trompant pas en silence, un contrôle côté API est **nécessaire**. Il ne coûte aucun appel supplémentaire, parce qu'il découle directement de la validation §8.2 b) :

1. l'id est bien formé, donc le filtre part dans l'appel unique `searchCampings` (dont les statuts seront faux) ;
2. la validation, faite avec le catalogue renvoyé par ce même appel (celui du type demandé), ne trouve pas `C18` ;
3. la réponse est `400 UNKNOWN_FILTER`, **avant** tout appel `campingAvailability`, et les campings renvoyés par le GraphQL sont ignorés ;
4. le message précise le type demandé : `"Filtre(s) inconnu(s) pour accommodation_type=rental : characteristics:C18:18."`, avec `details: { "unknown": ["characteristics:C18:18"], "accommodation_type": "rental" }`.

Coût total du cas : 1 appel GraphQL.

Pour éviter ce cas, l'app tierce doit proposer à l'utilisateur les filtres du catalogue correspondant au type d'hébergement choisi (§6).

Les filtres de niveau camping étant communs aux deux types, ils ne sont pas concernés.

### 8.8 Nombre d'appels GraphQL par recherche

Pour un appel `GET /v1/search/campings`, hors relance sur erreur réseau ou 5xx (§9.1) :

| Situation | `searchCampings` | `campingAvailability` | Total |
|---|---|---|---|
| Id de filtre mal formé | 0 | 0 | **0** (`400 INVALID_FILTER_FORMAT`) |
| Id de filtre inconnu pour le type (§8.7) | 1 | 0 | **1** (`400 UNKNOWN_FILTER`) |
| R1 : au moins N disponibles, avec ou sans filtres (hébergement ou camping) | 1 | 0 | **1** |
| R2 / R3 : complétion par des campings « autres dates » | 1 | 1 à `MAX_AVAILABILITY_CALLS` (8) | **2 à 9** |
| R4 : aucun camping disponible ni à d'autres dates | 1 | 0 | **1** |
| R4 bis : les campings « autres dates » se révèlent tous indisponibles | 1 | 1 à 8 | **2 à 9** |

`POST /v1/auth/session` ne fait aucun appel GraphQL. `GET /v1/search/filters` en fait 1, et l'app le met en cache 24 h.

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
https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=08%2F05%2F2027&end=15%2F05%2F2027&sites[]=49&nb_pers=1&lang=fr&track=chatbot&type=0
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
| `type` | `0` si `accommodation_type = rental`, `1` si `accommodation_type = slot` | Présélectionne « Locatif » ou « Emplacement » dans le funnel. Toujours présent. |

Dates utilisées selon le type de résultat :

| `availability_type` | `begin` / `end` |
|---|---|
| `available` | Dates demandées |
| `alternative_dates` | `alternative_begin_date_availability` / `alternative_end_date_availability` |
| `alternative_capacity` | Dates de `info` (égales aux dates demandées) |

Vérifié le 21/11/2026 :

- `sites[]=49` ouvre le funnel sur « Portland », `sites[]=6934` sur « La Marende ». C'est bien le `campingCode` qu'il faut utiliser, et non le `contentId`.
- `type=0` coche « Locatif » et `type=1` coche « Emplacement » dans le choix d'hébergement du funnel.

### 10.2 Implémentation de référence

```ts
const toFr = (iso: string) => { const [y, m, d] = iso.split('-'); return encodeURIComponent(`${d}/${m}/${y}`); };

export function buildBookingEngineLink(p: { campingCode: number; begin: string; end: string;
                                            peopleCount: number; lang: string; track: string;
                                            accommodationType: 'rental' | 'slot' }, baseUrl: string): string {
  const type = p.accommodationType === 'slot' ? 1 : 0;
  return `${baseUrl}?camping=yelloh&begin=${toFr(p.begin)}&end=${toFr(p.end)}`
       + `&sites[]=${p.campingCode}&nb_pers=${p.peopleCount}&lang=${p.lang}&track=${encodeURIComponent(p.track)}`
       + `&type=${type}`;
}
// buildBookingEngineLink({campingCode:49, begin:'2027-05-08', end:'2027-05-15', peopleCount:1, lang:'fr', track:'chatbot', accommodationType:'rental'}, BASE)
// === 'https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=08%2F05%2F2027&end=15%2F05%2F2027&sites[]=49&nb_pers=1&lang=fr&track=chatbot&type=0'
// Même appel avec accommodationType:'slot' → même lien terminé par '&type=1'
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
| 400 | `INVALID_FILTER_FORMAT` | Id de filtre syntaxiquement invalide (§8.2 a) : partie vide, mauvais nombre de séparateurs, ancien format… (`details.invalid: ["F4"]`). Aucun appel GraphQL n'est fait. |
| 400 | `UNKNOWN_FILTER` | Id bien formé mais incohérent avec le catalogue renvoyé par `searchCampings` (§8.2 b) : catégorie inconnue ou non exposée, nombre de parties incohérent avec le niveau de la catégorie, code ou webcampId absent, y compris un filtre propre à l'autre type (§8.7) (`details.unknown: ["characteristics:C18:18"]`, `details.accommodation_type: "rental"`). L'app doit recharger son catalogue. |
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
| `API_CLIENTS` | **oui** | | JSON des clients : `client_id`, `key_sha256`, `track`, `enabled`, et facultativement `rate_limit_per_minute` (§4.2) |
| `SESSION_SIGNING_SECRET` | **oui** | | Secret HS256, ≥ 32 octets, en base64 |
| `SESSION_SIGNING_SECRET_PREVIOUS` | non | | Ancien secret accepté en vérification (rotation) |
| `SESSION_TTL_SECONDS` | non | `14400` | Durée de vie du token (4 h) |
| `SESSION_ISSUER` | non | `camping-search-api` | `iss` / `aud` |
| `SECRETS_ARN` | non | | AWS uniquement : ARN du secret Secrets Manager contenant `API_CLIENTS` et `SESSION_SIGNING_SECRET*` |
| `SECRETS_REFRESH_SECONDS` | non | `300` | AWS uniquement : intervalle de relecture du secret |
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
| `MAX_PEOPLE` | non | `10` | Nombre maximum de personnes |
| `MAX_STAY_NIGHTS` | non | `90` | Durée maximum du séjour, en nuits |
| `RATE_LIMIT_PER_MINUTE` | non | `60` | Limite par défaut, par client et par instance, pour les clients sans `rate_limit_per_minute` |
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
- Secrets : AWS Secrets Manager (`SECRETS_ARN` optionnel), lu au démarrage à froid, gardé en mémoire de l'instance et **relu toutes les `SECRETS_REFRESH_SECONDS`** (défaut 300 s) au moment d'une requête, pour qu'une révocation soit prise en compte sans attendre le recyclage de l'instance (§4.2). En cas d'échec de relecture, l'instance garde la dernière valeur connue et journalise un avertissement. À défaut de Secrets Manager, variables d'environnement chiffrées par KMS.
- Infrastructure as code : `template.yaml` (AWS SAM) avec la fonction, l'API HTTP, le log group (rétention 30 jours) et les variables d'environnement.

### 14.3 Exemples d'utilisation (à reprendre dans le README)

```bash
TOKEN=$(curl -s -X POST https://<host>/v1/auth/session -H "X-API-Key: $YV_API_KEY" | jq -r .access_token)
```

```bash
curl -s https://<host>/v1/search/filters?accommodationType=rental -H "Authorization: Bearer $TOKEN"
```

```bash
curl -s "https://<host>/v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=confort_type:F4:4,swimming:SR7&maxResults=3" -H "Authorization: Bearer $TOKEN"
```

---

## 15. Exigences non fonctionnelles

| Exigence | Cible |
|---|---|
| Latence `/v1/search/campings`, cas R1 sans filtre hébergement (1 appel GraphQL) | p95 < 3 s |
| Latence, cas R1 avec filtre hébergement (toujours 1 appel GraphQL) | p95 < 3,5 s |
| Latence, cas R2 (1 appel + 1 à 2 lots de `campingAvailability`) | p95 < 7 s |
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
| U1 | `bookingLink` | `campingCode=49`, 08/05/2027 → 15/05/2027, 1 personne, `chatbot`, `rental` : lien **identique** à l'exemple §10.1 (terminé par `&type=0`) ; même entrée en `slot` : terminé par `&type=1` |
| U2 | `filterEngine` | `swimming:SR7` seul : seuls les campings avec `SR7` dans `allFilters` sont gardés |
| U3 | `filterEngine` | `sports_activities_on_site:SO104` : match par `key` dans `filterCategories[sports_activities_on_site]`, et non par `allFilters` |
| U4 | `filterEngine` | `confort_type:F4:4,confort_type:F5:-1` : OU dans `confort_type` |
| U5 | `filterEngine` | `confort_type:F4:4` + `animals_allowed:pets:pets` : exige le même hébergement |
| U6 | `filterEngine` | `destination:N305` + `destination:N306` : ET (intersection) |
| U7 | `filterEngine` | Les hébergements d'un autre `accommodationType` sont ignorés |
| U8 | `filterResolver` | Contrôle syntaxique : `confort_type:F4:4` → présumé hébergement, `toFilterInput` = `{categoryId:"confort_type",value:"F4",webcampId:"4"}` ; `swimming:SR7` → présumé camping, non transmis. Validation après appel : `confort_type:F4:4` → `level:"accommodation"`, `operator:"OR"` ; `confort_type:F4:999` (webcampId faux) → `UNKNOWN_FILTER` |
| U9 | `classifier` | `available` → `AVAILABLE` ; `flex` → `ALTERNATIVE` ; `closed`, `error`, `null`, `full`, `flexCapacity`, statut inconnu → `UNAVAILABLE`, et aucun appel `campingAvailability` pour ces campings |
| U30 | `selector` | Réponse `campingAvailability` `flex` avec `info` mais `accommodationId: null` → camping écarté (remplacé par le suivant du pool) |
| U31 | `selector` | Ordre final : `available`, puis `alternative_dates`, puis `alternative_capacity` |
| U32 | `filterCatalog` | Ordre : catégories triées par `priority` avec tri stable ; `destination` en tête de la section `location` ; filtres triés par `priority` avec tri stable. Une permutation des priorités dans la fixture change l'ordre des sections en conséquence. |
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
| U26 | `session` | Token valide émis pour `chatbot-yv`, puis client passé à `enabled:false` dans la configuration → le même token est refusé (`401 INVALID_TOKEN`) ; client retiré de la configuration → refusé |
| U21 | `validation` | Toutes les erreurs 400 du §11 |
| U22 | `mappers` | `note 89.5721` → `rating 9.0` ; dates alternatives `2027-07-07T00:00:00.000Z` → `2027-07-07` |
| U23 | `filterResolver` | `accommodation_type=rental` + `characteristics:C18:18` (filtre du catalogue `slot`) → `400 UNKNOWN_FILTER`, `details.accommodation_type = "rental"` ; `accommodation_type=slot` + `characteristics:C18:18` → validé |
| U27 | `filterResolver` | `400 INVALID_FILTER_FORMAT` **sans appel GraphQL** pour : `F4` (ancien format), `confort_type::4` (partie vide), `a:b:c:d` (4 parties), `Confort:F4` (majuscules dans la catégorie). `400 UNKNOWN_FILTER` **après 1 appel** pour : `confort_type:F4` (2 parties pour une catégorie hébergement), `swimming:SR7:x` (3 parties pour une catégorie camping), `inconnue:X1` (catégorie absente du catalogue), `bathroom:BA1:1` (catégorie du catalogue mais non exposée, §6.1) |
| U28 | garde | Test qui parcourt `src/` (hors `test/`) et échoue s'il trouve un littéral d'id de filtre : chaîne qui correspond à `^(SR|SO|N|C|F|BA|BE)\d+$` ou valant `pets` ou `pmr`. Les ids ne doivent apparaître que dans les fixtures et les tests. |
| U29 | `rateLimit` | Client avec `rate_limit_per_minute: 2` : 3ᵉ requête de la minute → `429 RATE_LIMITED` avec `Retry-After` ; client sans le champ et `RATE_LIMIT_PER_MINUTE=60` : 60 requêtes acceptées, 61ᵉ refusée ; les compteurs de deux clients sont indépendants ; `rate_limit_per_minute: 0` → erreur de configuration au démarrage |
| U24 | `filterCatalog` | À partir des filterCategories brutes, le catalogue produit est **identique** à `specs/exemple-reponse-search-filters-rental.json` et `…-slot.json` (hors `generated_at`) |
| U25 | `validation` | `/v1/search/filters` sans `accommodation_type` → `400 MISSING_PARAMETER` ; `accommodationType=slot` (alias) accepté |

### 16.2 Tests d'intégration (GraphQL simulé)

- **Parcours complet** : `POST /v1/auth/session`, puis `GET /v1/search/filters`, puis `GET /v1/search/campings`, dans les scénarios R1, R2, R3 et R4.
- **Requêtes envoyées à l'amont** :
  - en-têtes `Origin`, `gql-market-site` et `gql-locale` présents ;
  - aucun filtre camping transmis au GraphQL ;
  - filtres hébergement transmis dès l'appel unique `searchCampings` et à `campingAvailability` ;
  - **exactement 1** appel `searchCampings` par recherche, avec ou sans filtre hébergement (§8.8).
- **Erreurs amont** : `errors[]` sur `searchCampings` → `502` ; timeout → `504` ; erreur sur `campingAvailability` → camping écarté, réponse `200`.
- **Filtre incompatible** (§8.7) : `rental` + `characteristics:C18:18` → `400 UNKNOWN_FILTER` après **un seul** appel `searchCampings`, sans `campingAvailability`.
- **Filtre mal formé** : `filters=F4` → `400 INVALID_FILTER_FORMAT`, **aucun** appel GraphQL.
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
2. `GET /v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4` renvoie 3 campings disponibles, différents d'un appel à l'autre, chacun avec un `bookingengine_link` qui ouvre YellohResa sur le bon village, aux bonnes dates, pour 4 personnes et avec « Locatif » présélectionné. La même recherche avec `accommodation_type=slot` ouvre le funnel avec « Emplacement » présélectionné.
3. Une recherche à 10 personnes en juillet 2027 (peu de disponibles) renvoie des résultats `alternative_*` dont les dates alternatives sont renseignées et reprises dans le lien.
4. Une recherche pendant la fermeture du réseau (ex. janvier) renvoie `status: "NO_AVAILABILITY"` et `message: "aucun camping disponible"`.
5. `maxResults=1`, `2` et `4` renvoient au plus 1, 2 et 4 résultats.
6. L'ajout d'un filtre de confort modifie les résultats de façon cohérente avec la page `https://www.yellohvillage.fr/camping/recherche?date_start=…&date_end=…&nb_personnes=…&selectedFilters=F5`.
7. Le même build se déploie sur Netlify et sur AWS Lambda, et passe le parcours ci-dessus sur les deux.
8. `GET /v1/search/filters?accommodation_type=rental` et `…=slot` renvoient la même structure que les fichiers d'exemple de `specs/`. Sans `accommodation_type`, la réponse est `400`.
9. Une recherche `rental` avec « Sanitaire privatif » (`characteristics:C18:18`) renvoie `400 UNKNOWN_FILTER` ; la même recherche en `slot` renvoie des résultats.
10. Une recherche avec un filtre de confort (`confort_type:F5:-1`) donne lieu à un seul appel `searchCampings` (logs : `upstream_calls.search_campings = 1`).

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
7. **Aucune liste d'ids de filtres en dur** dans `src/` : avant l'appel `searchCampings`, seul le contrôle syntaxique §8.2 a) est autorisé ; toute vérification de cohérence se fait après, avec le catalogue renvoyé (§8.2 b). Le seul référentiel codé est le tableau de **catégories** §6.1. Le test de garde U28 doit passer.
8. Livrer avec `npm test` vert et une couverture conforme au §15. Générer `openapi.json`.
9. Documenter dans le README : création d'une clé (`keys:generate`), configuration, déploiement Netlify, déploiement SAM, et les exemples curl du §14.3. Fournir un guide d'intégration pour les applications tierces (`docs/guide-integration.md`), qui reprend l'annexe D.

---

## 18. Points ouverts

| # | Sujet | Hypothèse retenue en attendant |
|---|---|---|
| P1 | Noms des champs de dates alternatives | **Tranché** : orthographe `alternative_begin_date_availability` / `alternative_end_date_availability`. |
| P2 | Paramètre « Locatif / Emplacement » du lien YellohResa | **Tranché** : `&type=0` (rental) et `&type=1` (slot), vérifié dans le funnel (§10.1). |
| P3 | Révocation d'un seul token (et non d'un client entier) | Non prévue : il faudrait une liste de révocation, donc un stockage côté serveur. La révocation se fait par client (§4.2), et ses tokens en cours sont alors refusés. Changer `SESSION_SIGNING_SECRET` invalide tous les tokens de tous les clients. |
| P4 | Bornes de recherche | **Tranché** : `MAX_PEOPLE = 10`, `MAX_STAY_NIGHTS = 90` (§7.1, §13). |
| P5 | Volumétrie et accord avec l'équipe sitemarket | Chaque recherche fait 1 appel `searchCampings` et 0 à 8 appels `campingAvailability` (§8.8) |
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

### A.2 `SEARCH_QUERY` (appel unique de `/v1/search/campings`)

Elle renvoie à la fois les campings (avec les statuts tenant compte des filtres hébergement) et le catalogue `filterCategories` racine, qui sert à valider les ids de filtres (§8.2 b).

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

Relevé du 20/11/2026, marché FR, `rental`. Le catalogue est **dynamique** : l'API le lit toujours en direct, et ce relevé ne sert qu'aux fixtures et aux tests. **Ces ids ne doivent jamais être recopiés dans le code applicatif** (§8.2, test U28). Le catalogue complet de chaque type, au format de l'API, est dans `specs/exemple-reponse-search-filters-rental.json` et `specs/exemple-reponse-search-filters-slot.json`.

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

## Annexe D — Exemple d'enchaînement des appels par l'application tierce

Cette annexe sert de **guide d'utilisation** de l'API. Elle suit une application tierce (un chatbot) qui reçoit trois utilisateurs finaux. Elle montre, à chaque étape, **quel élément de la réponse précédente alimente la requête suivante**.

Les campings, codes, statuts et dates alternatives proviennent d'appels réels au GraphQL de production (21/11/2026), traités avec les règles de cette spécification. Les tokens, horodatages, `request_id` et tirages aléatoires sont illustratifs. Les champs sans intérêt pour l'enchaînement sont remplacés par `…`.

### D.0 Vue d'ensemble

```
                     ┌───────────────────────────────── une fois toutes les 4 h (ou sur 401) ──┐
App tierce ──(1) POST /v1/auth/session ──▶ access_token ───────────────────────────────────────┤
                     │                                                                          │
                     ├──(2) GET /v1/search/filters?accommodation_type=rental ─▶ catalogue ──┐  │
                     ├──(2) GET /v1/search/filters?accommodation_type=slot   ─▶ catalogue ──┤  │ une fois par jour
                     │                                                         (cache 24 h) │  │ (ou sur UNKNOWN_FILTER)
Utilisateur final ──▶ critères + cases cochées (libellés du catalogue)                       │  │
                     │                                    ids des filtres ◀──────────────────┘  │
                     └──(3) GET /v1/search/campings?…&filters=<ids> (Bearer <access_token>) ◀──┘
                                       │
                                       ▼
                     ≤ N propositions → l'utilisateur clique sur bookingengine_link → YellohResa
```

| Donnée | Produite par | Réutilisée dans |
|---|---|---|
| `access_token` | réponse de (1) | en-tête `Authorization: Bearer …` de (2) et (3), pendant `expires_in` secondes |
| `sections[].categories[].filters[].id` | réponse de (2) | paramètre `filters` de (3) |
| `sections[].categories[].filters[].label` | réponse de (2) | texte affiché à l'utilisateur pour qu'il coche ses critères |
| type d'hébergement choisi | utilisateur | `accommodation_type` de (2), pour choisir le catalogue, **et** de (3), avec la même valeur |
| `results[].bookingengine_link` | réponse de (3) | lien présenté à l'utilisateur, à ouvrir tel quel |
| `results[].alternative_*_availability` | réponse de (3) | texte affiché (« disponible du … au … ») |
| `status` / `message` | réponse de (3) | choix de l'affichage : propositions, propositions partielles, ou message « aucun camping disponible » |

### D.1 Ouverture de session (au démarrage de l'app, puis toutes les 4 h)

```http
POST /v1/auth/session
X-API-Key: ysk_live_8fQ2…(secret de l'app, jamais exposé au navigateur)
```

```json
HTTP/1.1 201 Created
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjaGF0Ym90LXl2Iiwi…",
  "token_type": "Bearer",
  "expires_in": 14400,
  "expires_at": "2026-11-21T18:00:00Z",
  "client_id": "chatbot-yv"
}
```

➜ L'app garde `access_token` et `expires_at`. Le **même token sert pour tous ses utilisateurs** jusqu'à son expiration : on n'ouvre pas une session par utilisateur final. Il vaut mieux le renouveler un peu avant `expires_at` (par exemple 5 minutes avant), ou au plus tard dès une réponse `401 TOKEN_EXPIRED` (D.7).

### D.2 Chargement du catalogue des filtres (une fois par jour)

```http
GET /v1/search/filters?accommodation_type=rental
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…      ← access_token de D.1
```

```json
HTTP/1.1 200 OK
Cache-Control: private, max-age=86400

{
  "accommodation_type": "rental",
  "sections": [
    { "section": "location", "label": "Localisation", "categories": [
      { "category_id": "destination", "level": "camping", "operator": "AND", "filters": [
        { "id": "destination:N305", "label": "Mer",       "label_en": "Sea" },
        { "id": "destination:N304", "label": "Campagne",  "label_en": "Country" },
        { "id": "destination:N40597", "label": "Rivière", "label_en": "River" },
        { "id": "destination:N306", "label": "Montagne",  "label_en": "Mountains" } ] },
      "…" ] },
    { "section": "swimming", "label": "Piscine", "categories": [
      { "category_id": "swimming", "level": "camping", "operator": "AND", "filters": [
        "…", { "id": "swimming:SR7", "label": "Toboggan(s)", "label_en": "Slide(s)" }, "…" ] } ] },
    { "section": "comfort", "label": "Niveau de confort", "categories": [
      { "category_id": "confort_type", "level": "accommodation", "operator": "OR", "filters": [
        { "id": "confort_type:F0:0-3", "label": "0-3 fleurs", "label_en": "0-3 flowers" },
        { "id": "confort_type:F4:4",   "label": "4 fleurs",   "label_en": "4 flowers" },
        { "id": "confort_type:F5:-1",  "label": "Premium",    "label_en": "Premium" } ] } ] },
    { "section": "accommodation", "label": "Hébergement", "categories": [
      "…",
      { "category_id": "characteristics", "level": "accommodation", "operator": "AND", "filters": [
        "…", { "id": "characteristics:C160:160", "label": "Spa privatif", "label_en": "Spa/whirlpool bath" }, "…" ] } ] },
    "…"
  ]
}
```

Réponse complète : `specs/exemple-reponse-search-filters-rental.json`. L'app fait le même appel avec `accommodation_type=slot` (`specs/exemple-reponse-search-filters-slot.json`) si elle propose aussi les emplacements.

➜ L'app met les deux catalogues en cache pour 24 h. Elle construit ses questions ou ses cases à cocher à partir de `label` ; pour chaque libellé choisi, elle **garde l'`id` correspondant sans le modifier**. `operator` lui indique comment présenter une catégorie : `OR` = choix multiples alternatifs (« 4 fleurs ou Premium »), `AND` = critères cumulatifs.

### D.3 Utilisateur A : plus de 3 campings disponibles (règle R1)

**Ce que l'utilisateur dit au chatbot** : « Une location du 10 au 17 juillet 2027 pour 4 personnes, en 4 fleurs, avec un toboggan. »

**Correspondance faite par l'app à partir du catalogue rental (D.2)** :

| Choix de l'utilisateur | `label` du catalogue | `id` envoyé |
|---|---|---|
| « 4 fleurs » | 4 fleurs | `confort_type:F4:4` |
| « un toboggan » | Toboggan(s) | `swimming:SR7` |

```http
GET /v1/search/campings?accommodation_type=rental&startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=confort_type:F4:4,swimming:SR7
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
```

`maxResults` n'est pas précisé, donc vaut 3. Les `:` et `,` peuvent être envoyés tels quels ou encodés (`%3A`, `%2C`) : l'API décode la chaîne de requête.

**Traitement par l'API** :
- 1 appel `searchCampings`, auquel est transmis le filtre hébergement `confort_type:F4:4` ;
- sur les 100 campings reçus, le filtrage local garde 74 campings qui ont un toboggan et un hébergement 4 fleurs ;
- parmi eux, 70 sont disponibles et 4 à d'autres dates ;
- 70 ≥ 3, donc tirage de 3 disponibles, sans aucun appel `campingAvailability`.

```json
HTTP/1.1 200 OK
{
  "status": "OK",
  "message": null,
  "search": { "start_date": "2027-07-10", "end_date": "2027-07-17", "nights": 7, "people_count": 4,
              "accommodation_type": "rental", "filters": ["confort_type:F4:4", "swimming:SR7"], "max_results": 3 },
  "summary": { "available_count": 70, "alternative_dates_count": 4, "unavailable_count": 0, "returned_count": 3 },
  "results": [
    { "rank": 1, "availability_type": "available", "camping_code": 6934, "name": "La Marende", "stars": 5, "rating": 9.0,
      "city": "Argelès-sur-Mer", "department": "Pyrénées Orientales", "region": "Languedoc-Roussillon",
      "camping_url": "https://www.yellohvillage.fr/camping/la_marende", "image_url": "https://img.yellohvillage.fr/…/la_marende.jpg",
      "alternative_begin_date_availability": null, "alternative_end_date_availability": null, "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4&lang=fr&track=chatbot&type=0" },
    { "rank": 2, "availability_type": "available", "camping_code": 7714, "name": "Colina do Sol", "stars": 4, "rating": 8.9,
      "city": "São Martinho do Porto", "department": "Leiria District", "…": "…",
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=7714&nb_pers=4&lang=fr&track=chatbot&type=0" },
    { "rank": 3, "availability_type": "available", "camping_code": 6046, "name": "Le Campoloro", "stars": 5, "rating": 9.0,
      "city": "Cervione", "department": "Haute-Corse", "…": "…",
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6046&nb_pers=4&lang=fr&track=chatbot&type=0" }
  ],
  "meta": { "request_id": "2b9c…", "duration_ms": 1710, "upstream_calls": { "search_campings": 1, "camping_availability": 0 } }
}
```

➜ **Affichage par l'app** : `status = "OK"`, donc elle présente les 3 propositions (`name`, `city`, `stars`, `rating`, `image_url`). Chaque proposition porte un bouton « Réserver » qui ouvre `bookingengine_link` **tel quel**, sans le reconstruire. Ce lien ouvre YellohResa sur le camping (`sites[]` = `camping_code`), aux dates et pour le nombre de personnes demandés, avec « Locatif » présélectionné (`type=0`).

Un nouvel appel identique peut renvoyer 3 autres campings parmi les 70, puisque le tirage est aléatoire. L'app peut s'en servir pour un bouton « Voir d'autres propositions ».

### D.4 Utilisateur B : complétion par des dates alternatives (règle R2)

**Ce que l'utilisateur dit au chatbot** : « Pour 10 personnes, du 24 au 31 juillet 2027, à la montagne, en Premium avec spa privatif et toboggan. »

| Choix de l'utilisateur | `label` | `id` envoyé |
|---|---|---|
| « à la montagne » | Montagne | `destination:N306` |
| « Premium » | Premium | `confort_type:F5:-1` |
| « spa privatif » | Spa privatif | `characteristics:C160:160` |
| « toboggan » | Toboggan(s) | `swimming:SR7` |

```http
GET /v1/search/campings?accommodation_type=rental&startDate=2027-07-24&endDate=2027-07-31&peopleCount=10&filters=destination:N306,confort_type:F5:-1,characteristics:C160:160,swimming:SR7
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
```

**Traitement par l'API** :
1. 1 appel `searchCampings`, avec les 2 filtres hébergement (`confort_type:F5:-1`, `characteristics:C160:160`).
2. Le filtrage local garde 5 campings, tous `flex` : **0 disponible** aux dates demandées.
3. Le pool des 5 campings `flex` est mélangé, et les 3 premiers sont vérifiés en parallèle par `campingAvailability` :

   | Camping (`campingCode`) | Réponse `campingAvailability` | Résultat |
   |---|---|---|
   | Les 3 Vallées (53) | `flex`, `info` 25/07 → 01/08/2027 | `alternative_dates` |
   | Le Lavedan (5072) | `flexCapacity`, `info` 24/07 → 31/07/2027, hébergement de capacité 4 | `alternative_capacity` |
   | Le Pré Bas (1102) | `flex`, `info` 21/07 → 28/07/2027 | `alternative_dates` |

4. Les 3 vérifications sont exploitables, donc aucun remplacement n'est nécessaire, et la réponse contient 3 propositions. Elles sont classées `alternative_dates` d'abord, puis `alternative_capacity`.

```json
HTTP/1.1 200 OK
{
  "status": "OK",
  "message": null,
  "search": { "start_date": "2027-07-24", "end_date": "2027-07-31", "nights": 7, "people_count": 10, "accommodation_type": "rental",
              "filters": ["destination:N306", "confort_type:F5:-1", "characteristics:C160:160", "swimming:SR7"], "max_results": 3 },
  "summary": { "available_count": 0, "alternative_dates_count": 5, "unavailable_count": 0, "returned_count": 3 },
  "results": [
    { "rank": 1, "availability_type": "alternative_dates", "camping_code": 53, "name": "Les 3 Vallées", "stars": 5, "rating": 8.9,
      "city": "Argeles-Gazost", "department": "Hautes-Pyrénées", "…": "…",
      "alternative_begin_date_availability": "2027-07-25",
      "alternative_end_date_availability": "2027-08-01",
      "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=25%2F07%2F2027&end=01%2F08%2F2027&sites[]=53&nb_pers=10&lang=fr&track=chatbot&type=0" },
    { "rank": 2, "availability_type": "alternative_dates", "camping_code": 1102, "name": "Le Pré Bas", "stars": 5, "rating": 9.1,
      "city": "Murol", "department": "Puy de Dôme", "…": "…",
      "alternative_begin_date_availability": "2027-07-21",
      "alternative_end_date_availability": "2027-07-28",
      "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=21%2F07%2F2027&end=28%2F07%2F2027&sites[]=1102&nb_pers=10&lang=fr&track=chatbot&type=0" },
    { "rank": 3, "availability_type": "alternative_capacity", "camping_code": 5072, "name": "Le Lavedan", "stars": 4, "rating": 9.3,
      "city": "Argeles-Gazost", "department": "Hautes-Pyrénées", "…": "…",
      "alternative_begin_date_availability": "2027-07-24",
      "alternative_end_date_availability": "2027-07-31",
      "alternative_capacity": 4,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=24%2F07%2F2027&end=31%2F07%2F2027&sites[]=5072&nb_pers=10&lang=fr&track=chatbot&type=0" }
  ],
  "meta": { "request_id": "7f41…", "duration_ms": 3420, "upstream_calls": { "search_campings": 1, "camping_availability": 3 } }
}
```

➜ **Affichage par l'app**, piloté par `availability_type` :

| `availability_type` | Texte suggéré | Champs utilisés |
|---|---|---|
| `available` | « Disponible à vos dates » | — |
| `alternative_dates` | « Pas de disponibilité à vos dates, mais disponible du 25/07/2027 au 01/08/2027 » | `alternative_begin_date_availability`, `alternative_end_date_availability` |
| `alternative_capacity` | « Disponible à vos dates dans un hébergement pour 4 personnes » | `alternative_capacity` |

Le `bookingengine_link` d'une proposition « autres dates » contient déjà les **dates alternatives** (`begin=25%2F07%2F2027…`) : l'app n'a pas à le modifier.

Si l'un des campings vérifiés avait répondu `unavailable`, l'API l'aurait écarté et aurait vérifié le 4ᵉ camping du pool (`meta.upstream_calls.camping_availability` = 4). Si le pool s'était épuisé, la réponse aurait été `status: "PARTIAL"`, avec 1 ou 2 propositions (D.6).

### D.5 Utilisateur C : aucun camping (règle R4)

**Ce que l'utilisateur dit au chatbot** : « Une semaine à la campagne du 6 au 13 février 2027, pour 2. »

```http
GET /v1/search/campings?accommodation_type=rental&startDate=2027-02-06&endDate=2027-02-13&peopleCount=2&filters=destination:N304
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
```

**Traitement par l'API** : 1 appel `searchCampings`. Les 25 campings « Campagne » sont tous `closed` en février, donc il n'y a ni disponible ni « autres dates », et aucun appel `campingAvailability` n'est fait.

```json
HTTP/1.1 200 OK
{
  "status": "NO_AVAILABILITY",
  "message": "aucun camping disponible",
  "search": { "start_date": "2027-02-06", "end_date": "2027-02-13", "people_count": 2, "accommodation_type": "rental",
              "filters": ["destination:N304"], "max_results": 3, "…": "…" },
  "summary": { "available_count": 0, "alternative_dates_count": 0, "unavailable_count": 25, "returned_count": 0 },
  "results": [],
  "meta": { "request_id": "c3d8…", "upstream_calls": { "search_campings": 1, "camping_availability": 0 } }
}
```

➜ **Affichage par l'app** : c'est une réponse **HTTP 200**, pas une erreur. L'app affiche `message` et peut inviter l'utilisateur à changer ses critères, par exemple retirer « Campagne » ou changer de dates.

### D.6 Variante : moins de N propositions (règle R3)

Même structure qu'en D.4, avec `"status": "PARTIAL"`, `"message": "Seulement 2 camping(s) correspondent à vos critères."` et 2 éléments dans `results`. L'app affiche les propositions reçues, éventuellement avec le message.

### D.7 Gestion des erreurs par l'application tierce

| Réponse reçue | Cause | Réaction attendue de l'app |
|---|---|---|
| `401 TOKEN_EXPIRED` ou `401 INVALID_TOKEN` | Token expiré, signature invalide (rotation du secret côté API) ou client désactivé | Refaire **une fois** D.1, puis rejouer la requête. Si la clé est refusée (`401 INVALID_API_KEY`), arrêter et alerter l'exploitant de l'app. |
| `400 UNKNOWN_FILTER` | Le catalogue en cache est périmé, ou l'id ne vient pas du catalogue du bon type d'hébergement (§8.7) | Recharger le catalogue (D.2) pour le bon `accommodation_type`, refaire la correspondance libellé → id, puis rejouer la recherche **une fois**. |
| `400 INVALID_FILTER_FORMAT` | Id modifié ou construit par l'app | Erreur d'intégration : n'utiliser que les `id` du catalogue, sans les modifier. |
| `400 INVALID_DATES`, `INVALID_PEOPLE_COUNT`, `MISSING_PARAMETER`… | Saisie de l'utilisateur hors bornes (ex. plus de 10 personnes, séjour de plus de 90 nuits, date passée) | Expliquer la contrainte à l'utilisateur à partir de `error.message` et `error.details`, puis redemander. |
| `429 RATE_LIMITED` | Quota du client dépassé | Attendre `Retry-After` secondes avant de réessayer. Surveiller `X-RateLimit-Remaining`. |
| `502 UPSTREAM_ERROR`, `504 UPSTREAM_TIMEOUT` | GraphQL Yelloh! Village indisponible ou lent | Message « service momentanément indisponible » ; au plus 1 nouvel essai après quelques secondes. |
| `200` + `status: "NO_AVAILABILITY"` | Aucun camping (D.5) | Afficher `message`, ce n'est pas une erreur. |

Exemple de reprise après expiration du token :

```http
GET /v1/search/campings?…              (Authorization: Bearer <token émis il y a plus de 4 h>)
→ 401 {"error":{"code":"TOKEN_EXPIRED","message":"Le token de session a expiré.","request_id":"…"}}
   WWW-Authenticate: Bearer error="invalid_token"

POST /v1/auth/session                    (X-API-Key)
→ 201 {"access_token":"eyJ…nouveau…","expires_in":14400,…}

GET /v1/search/campings?…              (Authorization: Bearer eyJ…nouveau…)   ← même requête, rejouée
→ 200 {"status":"OK",…}
```

Exemple de catalogue utilisé avec le mauvais type d'hébergement : l'app envoie « Sanitaire privatif », pris dans le catalogue `slot`, dans une recherche `rental`.

```http
GET /v1/search/campings?accommodation_type=rental&startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=characteristics:C18:18
→ 400 {"error":{"code":"UNKNOWN_FILTER",
               "message":"Filtre(s) inconnu(s) pour accommodation_type=rental : characteristics:C18:18.",
               "details":{"unknown":["characteristics:C18:18"],"accommodation_type":"rental"},"request_id":"…"}}
```

➜ L'app doit envoyer `accommodation_type=slot`, ou retirer ce critère. Le paramètre `accommodation_type` de la recherche doit toujours correspondre au catalogue dont viennent les `id`.

### D.8 Récapitulatif des appels de la session d'exemple

| # | Appel de l'app | Appels GraphQL faits par l'API |
|---|---|---|
| 1 | `POST /v1/auth/session` | 0 |
| 2 | `GET /v1/search/filters?accommodation_type=rental` | 1 |
| 3 | `GET /v1/search/filters?accommodation_type=slot` | 1 |
| 4 | Utilisateur A : `GET /v1/search/campings` (R1) | 1 |
| 5 | Utilisateur B : `GET /v1/search/campings` (R2) | 1 + 3 |
| 6 | Utilisateur C : `GET /v1/search/campings` (R4) | 1 |
| | **Total** | **8**, dont 2 pour le catalogue, qui ne sont plus refaits pendant 24 h |
