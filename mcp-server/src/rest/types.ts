/** Contrat de l'API REST Camping Search (spécification REST §6, §7, §7 bis, §11). */

export type AccommodationType = 'rental' | 'slot';

export interface RestCatalog {
  accommodation_type: AccommodationType;
  locale: string;
  generated_at: string;
  sections: {
    section: string;
    label: string;
    categories: {
      category_id: string;
      level: 'camping' | 'accommodation';
      operator: 'AND' | 'OR';
      filters: { id: string; label: string; label_en: string | null }[];
    }[];
  }[];
}

export interface RestCampingResult {
  rank: number;
  availability_type: 'available' | 'alternative_dates' | 'alternative_capacity';
  camping_code: number;
  name: string;
  stars: number | null;
  rating: number | null;
  city: string;
  department: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  image_url: string | null;
  camping_url: string;
  is_new: boolean;
  special_offer: string | null;
  alternative_begin_date_availability: string | null;
  alternative_end_date_availability: string | null;
  alternative_capacity: number | null;
  bookingengine_link: string;
}

export interface RestSearchResponse {
  status: 'OK' | 'PARTIAL' | 'NO_AVAILABILITY';
  message: string | null;
  search: {
    start_date: string;
    end_date: string;
    nights: number;
    people_count: number;
    accommodation_type: AccommodationType;
    filters: string[];
    max_results: number;
    /** Absent des versions de l'API REST antérieures à la v2.13. */
    camping_ids?: number[];
    user_language: string | null;
    site_base_url: string;
  };
  summary: {
    available_count: number;
    alternative_dates_count: number;
    unavailable_count: number;
    returned_count: number;
  };
  results: RestCampingResult[];
  meta?: unknown;
}

export interface SearchParams {
  startDate: string;
  endDate: string;
  peopleCount: number;
  accommodationType: AccommodationType;
  filters: string[];
  maxResults: number;
  userLanguage: string;
  /** Identifiants de contenu des campings (campingIDs) ; vide = tout le réseau. */
  campingIds?: number[];
}

export interface RestGeographyMatch {
  name: string;
  type: string | null;
  content_id: number | null;
  camping_count: number;
}

/** Réponse 200 de GET /v1/search/geography (spécification REST §7 bis.3). */
export interface RestGeographyResponse {
  status: 'OK';
  keywords: string;
  user_language: string | null;
  locale: string;
  match: RestGeographyMatch;
  camping_ids: number[];
  other_matches: RestGeographyMatch[];
  meta?: unknown;
}
