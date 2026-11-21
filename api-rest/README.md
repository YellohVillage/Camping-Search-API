# Camping Search API — Yelloh! Village

API REST qui permet à une application tierce (chatbot, app partenaire) de proposer à un utilisateur final
**au plus N campings Yelloh! Village** (3 par défaut) correspondant à ses critères, avec pour chacun un lien
« Découvrir le camping » et un lien « Réserver » vers le funnel YellohResa.

- Spécification fonctionnelle et technique : [`specs/specifications.md`](../specs/specifications.md)
- Guide d'intégration pour les applications tierces : [`docs/guide-integration.md`](docs/guide-integration.md)
- Contrat OpenAPI 3.1 : [`openapi.json`](openapi.json) (également servi sur `GET /v1/openapi.json`)

## Sommaire

1. [Endpoints](#endpoints)
2. [Démarrage local](#démarrage-local)
3. [Créer une clé d'API pour une application tierce](#créer-une-clé-dapi-pour-une-application-tierce)
4. [Configuration](#configuration)
5. [Déploiement Netlify](#déploiement-netlify)
6. [Déploiement AWS Lambda (secondaire)](#déploiement-aws-lambda-secondaire)
7. [Exemples d'appels](#exemples-dappels)
8. [Tests et qualité](#tests-et-qualité)
9. [Architecture du code](#architecture-du-code)

## Endpoints

| Méthode | Chemin                | Authentification | Rôle                                                                                               |
| ------- | --------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `POST`  | `/v1/auth/session`    | `X-API-Key`      | Échange la clé d'API contre un token de session (JWT, 4 h)                                         |
| `GET`   | `/v1/search/filters`  | `Bearer`         | Catalogue des filtres (`accommodation_type` obligatoire, libellés dans la langue de l'utilisateur) |
| `GET`   | `/v1/search/campings` | `Bearer`         | Recherche : au plus N propositions avec liens                                                      |
| `GET`   | `/v1/health`          | aucune           | Supervision (`?deep=true` vérifie le GraphQL Yelloh! Village)                                      |
| `GET`   | `/v1/openapi.json`    | aucune           | Contrat OpenAPI 3.1                                                                                |

## Démarrage local

Prérequis : Node.js 20 ou plus. Toutes les commandes se lancent depuis le répertoire `api-rest/`.

```bash
npm ci
```

```bash
cp .env.example .env
```

Renseigner dans `.env` au moins `API_CLIENTS` (voir la section suivante) et `SESSION_SIGNING_SECRET` :

```bash
openssl rand -base64 32
```

```bash
npm run dev
```

L'API écoute sur `http://localhost:8787` (variable `PORT` pour changer de port) et interroge le GraphQL de production
de yellohvillage.fr.

## Créer une clé d'API pour une application tierce

```bash
npm run keys:generate -- --client chatbot-yv --track chatbot --rate-limit 120
```

Le script affiche :

1. la **clé d'API** (`ysk_live_…`), à transmettre à l'application tierce par un canal sûr. Elle n'est affichée qu'une fois
   et n'est stockée nulle part ;
2. l'**entrée JSON** à ajouter au tableau `API_CLIENTS` : elle ne contient que l'empreinte SHA-256 de la clé.

Exemple de `API_CLIENTS` avec deux applications :

```json
[
  {
    "client_id": "chatbot-yv",
    "key_sha256": "3f1c…e9a0",
    "track": "chatbot",
    "enabled": true,
    "rate_limit_per_minute": 120
  },
  { "client_id": "partner-x", "key_sha256": "a81b…77d2", "track": "partnerx", "enabled": true }
]
```

- `track` devient le paramètre `track` des liens YellohResa de ce client.
- `rate_limit_per_minute` est facultatif (sinon `RATE_LIMIT_PER_MINUTE`, 60 par défaut).
- **Révoquer** un client : `"enabled": false` (ou retirer l'entrée), puis redéployer. Ses tokens en cours sont alors refusés.
- **Changer la clé** d'un client sans coupure : ajouter une seconde entrée avec le même `client_id` et la nouvelle empreinte,
  puis retirer l'ancienne une fois le client passé à la nouvelle clé.

## Configuration

Toutes les variables sont validées au démarrage : une configuration invalide empêche l'instance de démarrer, avec un
message explicite. Liste complète et valeurs par défaut : [`.env.example`](.env.example) et §13 de la spécification.

| Variable                                   | Obligatoire | Rôle                                                       |
| ------------------------------------------ | ----------- | ---------------------------------------------------------- |
| `API_CLIENTS`                              | oui         | Clients autorisés (tableau JSON, voir ci-dessus)           |
| `SESSION_SIGNING_SECRET`                   | oui         | Secret de signature des tokens (base64, 32 octets minimum) |
| `SESSION_SIGNING_SECRET_PREVIOUS`          | non         | Ancien secret accepté pendant une rotation                 |
| `MAX_PEOPLE`, `MAX_STAY_NIGHTS`            | non         | Bornes de recherche (10 personnes, 90 nuits)               |
| `DEFAULT_MAX_RESULTS`, `MAX_RESULTS_LIMIT` | non         | Nombre de propositions (3 par défaut, 10 au plus)          |
| `MAX_AVAILABILITY_CALLS`                   | non         | Vérifications « autres dates » par recherche (8)           |
| `CORS_ALLOWED_ORIGINS`                     | non         | Origines navigateur autorisées (vide par défaut)           |
| `LOG_LEVEL`                                | non         | `debug`, `info` (défaut), `warn`, `error`                  |

## Déploiement Netlify

Netlify est la cible de déploiement principale. Le dépôt contient tout le nécessaire :

- `netlify.toml`, **à la racine du dépôt** : il fixe le répertoire de base `api-rest/`, et sa commande de build vérifie les types et lance les tests (un échec bloque le déploiement) ;
- `api-rest/netlify/functions/api.ts` : une fonction unique, regroupée par Netlify (esbuild) et servie sur `/v1/*` ;
- `api-rest/public/` : page d'accueil statique minimale.

Mise en place :

1. Dans Netlify, **Add new site > Import an existing project**, choisir le dépôt `YellohVillage/Camping-Search-API`
   et la branche à déployer. Laisser **Base directory** vide : le `netlify.toml` de la racine le fixe à `api-rest`.
   Les autres réglages de build (commande, répertoire publié, fonctions) viennent aussi de ce fichier.
2. Dans **Site configuration > Environment variables**, créer `API_CLIENTS` et `SESSION_SIGNING_SECRET`
   (scope « Functions », cocher « Contains secret values »), ainsi que les variables facultatives souhaitées.
3. Déployer, puis vérifier :

```bash
curl -s "https://<site>.netlify.app/v1/health?deep=true"
```

Remarques :

- Le délai maximal d'une fonction synchrone Netlify est de 10 s par défaut. Une recherche R2 (vérification de dates
  alternatives) prend en général 3 à 4 s. Si besoin, demander à Netlify d'augmenter ce délai (26 s au plus).
- La limite de débit applicative est comptée par instance. Pour une limite stricte, ajouter une règle de _Rate limiting_
  Netlify sur `/v1/*`.
- Un changement de `API_CLIENTS` (nouveau client, révocation) s'applique au déploiement suivant.

## Déploiement AWS Lambda (secondaire)

Le cœur de l'API ne dépend pas de la plateforme ; un adaptateur Lambda (API Gateway REST v1, HTTP API v2, Function URL)
et un modèle AWS SAM sont fournis :

```bash
npm ci && npm run build
```

```bash
sam deploy --guided
```

Le build produit `dist/lambda.js` (handler `lambda.handler`, Node.js 20, ESM).

## Exemples d'appels

```bash
TOKEN=$(curl -s -X POST https://<host>/v1/auth/session -H "X-API-Key: $YV_API_KEY" | jq -r .access_token)
```

```bash
curl -s "https://<host>/v1/search/filters?accommodation_type=rental&user_language=fr" -H "Authorization: Bearer $TOKEN"
```

```bash
curl -s "https://<host>/v1/search/campings?startDate=2027-07-10&endDate=2027-07-17&peopleCount=4&filters=confort_type:F4:4,swimming:SR7&maxResults=3&user_language=fr" -H "Authorization: Bearer $TOKEN"
```

Réponse (extrait) :

```json
{
  "status": "OK",
  "message": null,
  "summary": {
    "available_count": 70,
    "alternative_dates_count": 4,
    "unavailable_count": 0,
    "returned_count": 3
  },
  "results": [
    {
      "rank": 1,
      "availability_type": "available",
      "camping_code": 804,
      "name": "Le Ranch",
      "camping_url": "https://www.yellohvillage.fr/camping/le_ranch",
      "bookingengine_link": "https://booking.yellohvillage.com/multi-list.php?camping=yelloh&begin=10%2F07%2F2027&end=17%2F07%2F2027&sites[]=804&nb_pers=4&track=chatbot&type=0"
    }
  ]
}
```

## Tests et qualité

| Commande                          | Rôle                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `npm test`                        | Tests unitaires et d'intégration (GraphQL simulé à partir de réponses réelles enregistrées) |
| `npm run coverage`                | Couverture (seuils : 80 % global, 90 % sur `src/domain` et `src/auth`)                      |
| `npm run typecheck`               | Vérification des types TypeScript                                                           |
| `npm run lint` / `npm run format` | ESLint / Prettier                                                                           |
| `npm run openapi`                 | Régénère `openapi.json`                                                                     |
| `npm run fixtures:record`         | Réenregistre les réponses GraphQL de `test/fixtures` (réseau requis)                        |

Les numéros de test de la spécification (U1 à U35) sont repris dans les intitulés des tests.

## Architecture du code

```
src/
├── app.ts               routeur, authentification, limite de débit, erreurs, journaux
├── bootstrap.ts         création de l'application à partir de l'environnement (une fois par instance)
├── config.ts            lecture et validation des variables d'environnement
├── adapters/            Netlify (Request → Response) et AWS Lambda
├── auth/                clés d'API, tokens JWT, limite de débit
├── domain/              règles métier : catalogue, filtres, classement, sélection, liens, langues
├── routes/              un fichier par endpoint, OpenAPI
├── upstream/            client et requêtes GraphQL Yelloh! Village
├── validation/          contrôle des paramètres
└── observability/       journaux JSON sans secrets
netlify/functions/api.ts point d'entrée Netlify
```

Le code ne contient **aucune liste d'identifiants de filtres** : les filtres valides sont ceux du catalogue renvoyé par
le GraphQL au moment de la recherche (spécification §8.2). Un test de garde le vérifie.
