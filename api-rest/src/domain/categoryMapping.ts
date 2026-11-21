/**
 * Tableau §6.1 : seul référentiel codé. Il liste des CATÉGORIES GraphQL (pas des ids de filtres)
 * et donne leur section, le libellé de section, le niveau et l'opérateur.
 * L'ordre d'affichage ne vient pas de ce tableau mais des `priority` GraphQL (§6, étape 3).
 */
export type Level = 'camping' | 'accommodation';
export type Operator = 'AND' | 'OR';

export interface CategoryInfo {
  section: string;
  sectionLabel: string;
  level: Level;
  operator: Operator;
}

export const CATEGORY_MAPPING: Readonly<Record<string, CategoryInfo>> = Object.freeze({
  destination: { section: 'location', sectionLabel: 'Localisation', level: 'camping', operator: 'AND' },
  geo_location: { section: 'location', sectionLabel: 'Localisation', level: 'camping', operator: 'AND' },
  confort_type: {
    section: 'comfort',
    sectionLabel: 'Niveau de confort',
    level: 'accommodation',
    operator: 'OR',
  },
  filtered_accommodation_type: {
    section: 'accommodation',
    sectionLabel: 'Hébergement',
    level: 'accommodation',
    operator: 'OR',
  },
  animals_allowed: {
    section: 'accommodation',
    sectionLabel: 'Hébergement',
    level: 'accommodation',
    operator: 'AND',
  },
  pmr: { section: 'accommodation', sectionLabel: 'Hébergement', level: 'accommodation', operator: 'AND' },
  characteristics: {
    section: 'accommodation',
    sectionLabel: 'Hébergement',
    level: 'accommodation',
    operator: 'AND',
  },
  surface: { section: 'accommodation', sectionLabel: 'Hébergement', level: 'accommodation', operator: 'OR' },
  swimming: { section: 'swimming', sectionLabel: 'Piscine', level: 'camping', operator: 'AND' },
  children_clubs: {
    section: 'children_club',
    sectionLabel: 'Clubs enfants',
    level: 'camping',
    operator: 'AND',
  },
  facilities: { section: 'services', sectionLabel: 'Services', level: 'camping', operator: 'AND' },
  wellness: { section: 'services', sectionLabel: 'Services', level: 'camping', operator: 'AND' },
  sports_activities_on_site: {
    section: 'activities',
    sectionLabel: 'Activités sur place',
    level: 'camping',
    operator: 'AND',
  },
  sports_activities: {
    section: 'nearby_activities',
    sectionLabel: 'Activités à proximité',
    level: 'camping',
    operator: 'AND',
  },
});

/** Catégories dont les filtres se comparent par `key` (§8.4). */
export const KEY_MATCH_CATEGORIES: ReadonlySet<string> = new Set([
  'sports_activities_on_site',
  'sports_activities',
]);

/** Catégorie placée en tête de la section `location` (exception reprise du front, §6 étape 3). */
export const LOCATION_FIRST_CATEGORY = 'destination';

export const categoryInfo = (categoryId: string): CategoryInfo | undefined =>
  Object.prototype.hasOwnProperty.call(CATEGORY_MAPPING, categoryId)
    ? CATEGORY_MAPPING[categoryId]
    : undefined;
