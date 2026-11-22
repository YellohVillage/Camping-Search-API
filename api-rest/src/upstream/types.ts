/** Types des réponses GraphQL Yelloh! Village (annexe A.4). */

export type GqlAvailabilityStatus = 'available' | 'flex' | 'closed' | 'error' | string;

export interface GqlFilter {
  id: string;
  title: string;
  key: string;
  priority: number | null;
  newFilterId: string | null;
  englishTitle: string | null;
}

export interface GqlFilterCategory {
  categoryId: string;
  type: 'camping' | 'accommodation' | string;
  priority: number | null;
  filters: (GqlFilter | null)[];
}

export interface GqlAccommodation {
  code: number;
  accommodationType: 'rental' | 'slot' | string;
  filters: string[] | null;
  technicalInfos?: { capacity?: { value: string | null } | null } | null;
}

export interface GqlCamping {
  campingCode: number;
  contentId: number;
  name: string;
  starCount: number | null;
  city: string;
  department: string | null;
  region: string | null;
  campingUrl: string;
  image: string | null;
  note: number | null;
  isNew: boolean;
  availabilityStatus: GqlAvailabilityStatus | null;
  allFilters: string[] | null;
  coordinates: { latitude: number; longitude: number } | null;
  specialOffer: { description: string | null } | null;
  filterCategories: ({ categoryId: string; filters: ({ key: string } | null)[] | null } | null)[] | null;
  accommodations: (GqlAccommodation | null)[] | null;
}

export interface GqlSearchCampings {
  campings: (GqlCamping | null)[];
  filterCategories: (GqlFilterCategory | null)[];
}

export interface GqlCampingAvailability {
  statusCode: string | null;
  accommodationId: number | null;
  info: { arrivalDate: string; departureDate: string } | null;
}

/** FilterInput GraphQL (§8.2). */
export interface GqlFilterInput {
  categoryId: string;
  value: string;
  webcampId: string;
}

export interface SearchVariables {
  accommodationType: 'rental' | 'slot';
  peopleCount: number;
  campingContentIds: number[];
  startDate?: string;
  endDate?: string;
  filters: GqlFilterInput[];
}

export interface AvailabilityVariables {
  campingCode: number;
  accommodationType: 'rental' | 'slot';
  peopleCount: number;
  startDate: string;
  endDate: string;
  filters: GqlFilterInput[];
  fidelityId: null;
}

/** Résultat de searchAutocomplete (annexe A.4, §9.5). */
export interface GqlAutocompleteResult {
  __typename: 'Suggestion' | 'GeographicSuggestion' | 'CampingSuggestion' | string;
  contentId: number | null;
  name: string | null;
  type: string | null;
  /** Suggestion, GeographicSuggestion */
  campingIds?: (number | null)[] | null;
  /** CampingSuggestion (= contentId du camping) */
  campingId?: number | null;
  /** CampingSuggestion */
  campingCode?: number | null;
}
