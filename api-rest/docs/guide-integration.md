# Guide d'intégration — Camping Search API

Ce guide s'adresse aux équipes qui intègrent l'API dans une application tierce (chatbot, app partenaire).
Il reprend l'annexe D de la spécification ([`specs/specifications.md`](../../specs/specifications.md)), qui fait foi en cas d'écart.

Points essentiels :

- obtenir un token avec `POST /v1/auth/session` (en-tête `X-API-Key`), le réutiliser pour tous les utilisateurs pendant 4 h ;
- charger le catalogue des filtres une fois par jour et par couple (type d'hébergement, langue) ;
- ne jamais construire ni modifier un identifiant de filtre : le recopier depuis le catalogue ;
- transmettre `user_language` (langue du navigateur de l'utilisateur) ;
- présenter les liens `camping_url` (« Découvrir le camping ») et `bookingengine_link` (« Réserver ») tels quels ;
- `status: "NO_AVAILABILITY"` n'est pas une erreur : afficher `message`.

Le contrat technique complet est servi par l'API sur `GET /v1/openapi.json`.

Les exemples suivent une application tierce (un chatbot) qui reçoit trois utilisateurs finaux. Elle montre, à chaque étape, **quel élément de la réponse précédente alimente la requête suivante**.

Les campings, codes, statuts et dates alternatives proviennent d'appels réels au GraphQL de production (21/11/2026), traités avec les règles de cette spécification. Les tokens, horodatages, `request_id` et tirages aléatoires sont illustratifs. Les champs sans intérêt pour l'enchaînement sont remplacés par `…`.

## 0. Vue d'ensemble

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

| Donnée                                    | Produite par                                           | Réutilisée dans                                                                                       |
| ----------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `access_token`                            | réponse de (1)                                         | en-tête `Authorization: Bearer …` de (2) et (3), pendant `expires_in` secondes                        |
| `sections[].categories[].filters[].id`    | réponse de (2)                                         | paramètre `filters` de (3)                                                                            |
| `sections[].categories[].filters[].label` | réponse de (2)                                         | texte affiché à l'utilisateur pour qu'il coche ses critères                                           |
| type d'hébergement choisi                 | utilisateur                                            | `accommodation_type` de (2), pour choisir le catalogue, **et** de (3), avec la même valeur            |
| langue du navigateur de l'utilisateur     | navigateur de l'utilisateur (ex. `navigator.language`) | paramètre `user_language` de (3)                                                                      |
| `results[].camping_url`                   | réponse de (3)                                         | lien « Découvrir le camping », dans la langue de l’utilisateur (spécification §10.3)                  |
| `results[].bookingengine_link`            | réponse de (3)                                         | lien présenté à l'utilisateur, à ouvrir tel quel                                                      |
| `results[].alternative_*_availability`    | réponse de (3)                                         | texte affiché (« disponible du … au … »)                                                              |
| `status` / `message`                      | réponse de (3)                                         | choix de l'affichage : propositions, propositions partielles, ou message « aucun camping disponible » |

## 1. Ouverture de session (au démarrage de l'app, puis toutes les 4 h)

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

➜ L'app garde `access_token` et `expires_at`. Le **même token sert pour tous ses utilisateurs** jusqu'à son expiration : on n'ouvre pas une session par utilisateur final. Il vaut mieux le renouveler un peu avant `expires_at` (par exemple 5 minutes avant), ou au plus tard dès une réponse `401 TOKEN_EXPIRED` (§7).

## 2. Chargement du catalogue des filtres (une fois par jour)

```http
GET /v1/search/filters?accommodation_type=rental
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…      ← access_token de §1
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

## 3. Utilisateur A : plus de 3 campings disponibles (règle R1)

**Ce que l'utilisateur dit au chatbot** : « Une location du 10 au 17 juillet 2027 pour 4 personnes, en 4 fleurs, avec un toboggan. »

**Correspondance faite par l'app à partir du catalogue rental (§2)** :

| Choix de l'utilisateur | `label` du catalogue | `id` envoyé         |
| ---------------------- | -------------------- | ------------------- |
| « 4 fleurs »           | 4 fleurs             | `confort_type:F4:4` |
| « un toboggan »        | Toboggan(s)          | `swimming:SR7`      |

```http
GET /v1/search/campings?accommodation_type=rental&startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=confort_type:F4:4,swimming:SR7&user_language=fr
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
```

`user_language=fr` vient de la langue du navigateur de l'utilisateur (`navigator.language` = `fr-FR`) : les `camping_url` pointent vers `www.yellohvillage.fr`. Un utilisateur au navigateur en allemand aurait reçu `https://www.yellohvillage.de/camping/la_marende`. `maxResults` n'est pas précisé, donc vaut 3. Les `:` et `,` peuvent être envoyés tels quels ou encodés (`%3A`, `%2C`) : l'API décode la chaîne de requête.

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
              "accommodation_type": "rental", "filters": ["confort_type:F4:4", "swimming:SR7"], "max_results": 3,
              "user_language": "fr", "site_base_url": "https://www.yellohvillage.fr" },
  "summary": { "available_count": 70, "alternative_dates_count": 4, "unavailable_count": 0, "returned_count": 3 },
  "results": [
    { "rank": 1, "availability_type": "available", "camping_code": 6934, "name": "La Marende", "stars": 5, "rating": 9.0,
      "city": "Argelès-sur-Mer", "department": "Pyrénées Orientales", "region": "Languedoc-Roussillon",
      "camping_url": "https://www.yellohvillage.fr/camping/la_marende", "image_url": "https://img.yellohvillage.fr/…/la_marende.jpg",
      "alternative_begin_date_availability": null, "alternative_end_date_availability": null, "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6934&nb_pers=4&track=chatbot&type=0" },
    { "rank": 2, "availability_type": "available", "camping_code": 7714, "name": "Colina do Sol", "stars": 4, "rating": 8.9,
      "city": "São Martinho do Porto", "department": "Leiria District", "…": "…",
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=7714&nb_pers=4&track=chatbot&type=0" },
    { "rank": 3, "availability_type": "available", "camping_code": 6046, "name": "Le Campoloro", "stars": 5, "rating": 9.0,
      "city": "Cervione", "department": "Haute-Corse", "…": "…",
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=6046&nb_pers=4&track=chatbot&type=0" }
  ],
  "meta": { "request_id": "2b9c…", "duration_ms": 1710, "upstream_calls": { "search_campings": 1, "camping_availability": 0 } }
}
```

➜ **Affichage par l'app** : `status = "OK"`, donc elle présente les 3 propositions (`name`, `city`, `stars`, `rating`, `image_url`). Chaque proposition porte un bouton « Réserver » qui ouvre `bookingengine_link` **tel quel**, sans le reconstruire. Ce lien ouvre YellohResa sur le camping (`sites[]` = `camping_code`), aux dates et pour le nombre de personnes demandés, avec « Locatif » présélectionné (`type=0`).

Un nouvel appel identique peut renvoyer 3 autres campings parmi les 70, puisque le tirage est aléatoire. L'app peut s'en servir pour un bouton « Voir d'autres propositions ».

## 4. Utilisateur B : complétion par des dates alternatives (règle R2)

**Ce que l'utilisateur dit au chatbot** : « Pour 10 personnes, du 24 au 31 juillet 2027, à la montagne, en Premium avec spa privatif et toboggan. »

| Choix de l'utilisateur | `label`      | `id` envoyé                |
| ---------------------- | ------------ | -------------------------- |
| « à la montagne »      | Montagne     | `destination:N306`         |
| « Premium »            | Premium      | `confort_type:F5:-1`       |
| « spa privatif »       | Spa privatif | `characteristics:C160:160` |
| « toboggan »           | Toboggan(s)  | `swimming:SR7`             |

```http
GET /v1/search/campings?accommodation_type=rental&startDate=2027-07-24&endDate=2027-07-31&peopleCount=10&filters=destination:N306,confort_type:F5:-1,characteristics:C160:160,swimming:SR7&user_language=fr
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…
```

**Traitement par l'API** :

1. 1 appel `searchCampings`, avec les 2 filtres hébergement (`confort_type:F5:-1`, `characteristics:C160:160`).
2. Le filtrage local garde 5 campings, tous `flex` : **0 disponible** aux dates demandées.
3. Le pool des 5 campings `flex` est mélangé, et les 3 premiers sont vérifiés en parallèle par `campingAvailability` :

   | Camping (`campingCode`) | Réponse `campingAvailability`                                        | Résultat               |
   | ----------------------- | -------------------------------------------------------------------- | ---------------------- |
   | Les 3 Vallées (53)      | `flex`, `info` 25/07 → 01/08/2027                                    | `alternative_dates`    |
   | Le Lavedan (5072)       | `flexCapacity`, `info` 24/07 → 31/07/2027, hébergement de capacité 4 | `alternative_capacity` |
   | Le Pré Bas (1102)       | `flex`, `info` 21/07 → 28/07/2027                                    | `alternative_dates`    |

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
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=25%2F07%2F2027&end=01%2F08%2F2027&sites[]=53&nb_pers=10&track=chatbot&type=0" },
    { "rank": 2, "availability_type": "alternative_dates", "camping_code": 1102, "name": "Le Pré Bas", "stars": 5, "rating": 9.1,
      "city": "Murol", "department": "Puy de Dôme", "…": "…",
      "alternative_begin_date_availability": "2027-07-21",
      "alternative_end_date_availability": "2027-07-28",
      "alternative_capacity": null,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=21%2F07%2F2027&end=28%2F07%2F2027&sites[]=1102&nb_pers=10&track=chatbot&type=0" },
    { "rank": 3, "availability_type": "alternative_capacity", "camping_code": 5072, "name": "Le Lavedan", "stars": 4, "rating": 9.3,
      "city": "Argeles-Gazost", "department": "Hautes-Pyrénées", "…": "…",
      "alternative_begin_date_availability": "2027-07-24",
      "alternative_end_date_availability": "2027-07-31",
      "alternative_capacity": 4,
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=24%2F07%2F2027&end=31%2F07%2F2027&sites[]=5072&nb_pers=10&track=chatbot&type=0" }
  ],
  "meta": { "request_id": "7f41…", "duration_ms": 3420, "upstream_calls": { "search_campings": 1, "camping_availability": 3 } }
}
```

➜ **Affichage par l'app**, piloté par `availability_type` :

| `availability_type`    | Texte suggéré                                                                     | Champs utilisés                                                            |
| ---------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `available`            | « Disponible à vos dates »                                                        | —                                                                          |
| `alternative_dates`    | « Pas de disponibilité à vos dates, mais disponible du 25/07/2027 au 01/08/2027 » | `alternative_begin_date_availability`, `alternative_end_date_availability` |
| `alternative_capacity` | « Disponible à vos dates dans un hébergement pour 4 personnes »                   | `alternative_capacity`                                                     |

Le `bookingengine_link` d'une proposition « autres dates » contient déjà les **dates alternatives** (`begin=25%2F07%2F2027…`) : l'app n'a pas à le modifier.

Si l'un des campings vérifiés avait répondu `unavailable`, l'API l'aurait écarté et aurait vérifié le 4ᵉ camping du pool (`meta.upstream_calls.camping_availability` = 4). Si le pool s'était épuisé, la réponse aurait été `status: "PARTIAL"`, avec 1 ou 2 propositions (§6).

## 5. Utilisateur C : aucun camping (règle R4)

**Ce que l'utilisateur dit au chatbot** : « Une semaine à la campagne du 6 au 13 février 2027, pour 2. »

```http
GET /v1/search/campings?accommodation_type=rental&startDate=2027-02-06&endDate=2027-02-13&peopleCount=2&filters=destination:N304&user_language=fr
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

## 6. Variante : moins de N propositions (règle R3)

Même structure qu'en §4, avec `"status": "PARTIAL"`, `"message": "Seulement 2 camping(s) correspondent à vos critères."` et 2 éléments dans `results`. L'app affiche les propositions reçues, éventuellement avec le message.

## 7. Gestion des erreurs par l'application tierce

| Réponse reçue                                                     | Cause                                                                                                   | Réaction attendue de l'app                                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `401 TOKEN_EXPIRED` ou `401 INVALID_TOKEN`                        | Token expiré, signature invalide (rotation du secret côté API) ou client désactivé                      | Refaire **une fois** §1, puis rejouer la requête. Si la clé est refusée (`401 INVALID_API_KEY`), arrêter et alerter l'exploitant de l'app.    |
| `400 UNKNOWN_FILTER`                                              | Le catalogue en cache est périmé, ou l'id ne vient pas du catalogue du bon type d'hébergement (§8.7)    | Recharger le catalogue (§2) pour le bon `accommodation_type`, refaire la correspondance libellé → id, puis rejouer la recherche **une fois**. |
| `400 INVALID_FILTER_FORMAT`                                       | Id modifié ou construit par l'app                                                                       | Erreur d'intégration : n'utiliser que les `id` du catalogue, sans les modifier.                                                               |
| `400 INVALID_DATES`, `INVALID_PEOPLE_COUNT`, `MISSING_PARAMETER`… | Saisie de l'utilisateur hors bornes (ex. plus de 10 personnes, séjour de plus de 90 nuits, date passée) | Expliquer la contrainte à l'utilisateur à partir de `error.message` et `error.details`, puis redemander.                                      |
| `429 RATE_LIMITED`                                                | Quota du client dépassé                                                                                 | Attendre `Retry-After` secondes avant de réessayer. Surveiller `X-RateLimit-Remaining`.                                                       |
| `502 UPSTREAM_ERROR`, `504 UPSTREAM_TIMEOUT`                      | GraphQL Yelloh! Village indisponible ou lent                                                            | Message « service momentanément indisponible » ; au plus 1 nouvel essai après quelques secondes.                                              |
| `200` + `status: "NO_AVAILABILITY"`                               | Aucun camping (§5)                                                                                      | Afficher `message`, ce n'est pas une erreur.                                                                                                  |

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

## 8. Récapitulatif des appels de la session d'exemple

| #   | Appel de l'app                                     | Appels GraphQL faits par l'API                                         |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `POST /v1/auth/session`                            | 0                                                                      |
| 2   | `GET /v1/search/filters?accommodation_type=rental` | 1                                                                      |
| 3   | `GET /v1/search/filters?accommodation_type=slot`   | 1                                                                      |
| 4   | Utilisateur A : `GET /v1/search/campings` (R1)     | 1                                                                      |
| 5   | Utilisateur B : `GET /v1/search/campings` (R2)     | 1 + 3                                                                  |
| 6   | Utilisateur C : `GET /v1/search/campings` (R4)     | 1                                                                      |
|     | **Total**                                          | **8**, dont 2 pour le catalogue, qui ne sont plus refaits pendant 24 h |
