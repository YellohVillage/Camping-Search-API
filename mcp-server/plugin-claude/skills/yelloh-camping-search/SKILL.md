---
name: yelloh-camping-search
description: Recherche de campings Yelloh! Village disponibles et liens de réservation. À utiliser dès que l'utilisateur cherche un camping, des vacances en plein air, un mobil-home, un chalet, une tente équipée ou un emplacement (tente, caravane, camping-car), en particulier chez Yelloh! Village. Use it whenever the user looks for a campsite, outdoor holidays, a mobile home or a pitch, especially at Yelloh! Village.
---

# Recherche de camping Yelloh! Village

Outils du serveur MCP `yelloh-camping-search` : `get_search_filters` (critères disponibles), `search_geography` (campings d'un lieu) et `search_campings` (propositions et liens).

## Marche à suivre

1. **Dates et nombre de personnes** : s'ils manquent, les demander avant toute recherche. Ne jamais les inventer. Convertir les dates relatives (« le week-end du 14 juillet », « une semaine en août ») en `YYYY-MM-DD` et faire confirmer en cas d'ambiguïté.
2. **Type d'hébergement** : `rental` (location : mobil-home, chalet, tente équipée…) par défaut ; `slot` (emplacement) si l'utilisateur parle de tente, caravane, camping-car ou emplacement.
3. **Critères** (confort, piscine, toboggan, mer, montagne, animaux, PMR, club enfants…) : appeler `get_search_filters` avec le **même** type d'hébergement et `user_language` = langue de l'utilisateur. N'utiliser **que** les `id` renvoyés, sans les modifier. Si un critère n'a pas d'équivalent, le dire à l'utilisateur.
4. **Lieu** (pays, région, département, ville, île, nom de camping : « en Bretagne », « près d'Argelès-sur-Mer ») : appeler `search_geography` avec le **nom du lieu seul**, dans la langue de l'utilisateur (« dans le sud de la Bretagne » → `Bretagne`), au moins 3 caractères. Passer les `camping_ids` reçus **tels quels** dans `camping_ids` de `search_campings`. Plusieurs lieux : un appel par lieu, puis l'union des `camping_ids`.
   - Mer, montagne, campagne, rivière, lac, accès plage : ce sont des **filtres** (`get_search_filters`), pas des lieux.
   - `status: NO_RESULT` : essayer éventuellement une autre formulation (nom de la région ou du département) ; si aucun lieu n'est trouvé, appeler quand même `search_campings` **sans `camping_ids`** (tout le réseau). Inutile de le signaler à l'utilisateur.
   - Si la zone trouvée (`match.name`) diffère des mots de l'utilisateur (« Côte d'Azur » → « Provence-Alpes-Côte d'Azur »), le préciser.
5. Appeler `search_campings` (dates, nombre de personnes, type, `filters`, `camping_ids`, `user_language`).

## Présentation des résultats

Liste numérotée ; pour chaque camping : **nom**, lieu, étoiles, note sur 10, disponibilité, puis deux liens Markdown recopiés **tels quels** :

`[Découvrir le camping](camping_page) · [Réserver](booking_link)`

- `available` : disponible aux dates demandées.
- `alternative_dates` : dire clairement qu'il n'est **pas** disponible aux dates demandées et donner les dates proposées (`alternative_begin_date` → `alternative_end_date`).
- `alternative_capacity` : disponible aux dates demandées dans un hébergement pour `alternative_capacity` personnes.
- `status: NO_AVAILABILITY` : annoncer qu'aucun camping n'est disponible et proposer d'assouplir les dates ou les critères.
- **Jamais de prix** : les tarifs s'affichent sur la page de réservation.
- Répondre dans la langue de l'utilisateur.

## Exemples

**Utilisateur** : « Un camping 4 fleurs avec toboggan du 10 au 17 juillet 2027 pour 4. »
→ `get_search_filters(accommodation_type="rental", user_language="fr")`, puis `search_campings(start_date="2027-07-10", end_date="2027-07-17", people_count=4, filters=["confort_type:F4:4","swimming:SR7"], user_language="fr")`.

« Voici 3 campings disponibles du 10 au 17 juillet :

1. **La Marende** (Argelès-sur-Mer, 5★, 9,0/10) — [Découvrir le camping](https://www.yellohvillage.fr/camping/la_marende) · [Réserver](…) »

**Utilisateur** : « Une location en Bretagne avec piscine couverte du 10 au 17 juillet 2027 pour 4. »
→ `search_geography(keywords="Bretagne", user_language="fr")` et `get_search_filters(accommodation_type="rental", user_language="fr")`, puis `search_campings(start_date="2027-07-10", end_date="2027-07-17", people_count=4, filters=["swimming:SR5"], camping_ids=[2409, 2495, 2541, 31808, 128022, 90890, 2463, 138962], user_language="fr")`.

« Voici 3 campings en Bretagne avec piscine couverte, disponibles du 10 au 17 juillet :

1. **Les Mouettes** (Carantec, Finistère, 5★, 9,3/10) — [Découvrir le camping](https://www.yellohvillage.fr/camping/les_mouettes) · [Réserver](…) »

**Utilisateur** : « On est 10, montagne, Premium avec spa privatif et toboggan, du 24 au 31 juillet 2027. »
Résultats `alternative_dates` →
« Aucun camping ne correspond exactement à vos dates, mais voici des alternatives proches :

1. **Les 3 Vallées** (Argelès-Gazost, 5★, 8,9/10), disponible du 25 juillet au 1ᵉʳ août — [Découvrir le camping](…) · [Réserver](…) »
