/** Requêtes GraphQL de l'annexe A. Ne pas ajouter de champ amont qui n'y figure pas. */

export const CATALOG_QUERY = `query apiFilterCatalog($accommodationType: String!, $peopleCount: Int!, $campingContentIds: [Int], $filters: [FilterInput!]) {
  searchCampings(peopleCount: $peopleCount, accommodationType: $accommodationType,
                 campingContentIds: $campingContentIds, filters: $filters) {
    filterCategories { categoryId type priority filters { id title key priority newFilterId englishTitle } }
  }
}`;

export const SEARCH_QUERY = `query apiSearchCampings($startDate: Date, $endDate: Date, $accommodationType: String!, $peopleCount: Int!,
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
}`;

export const AVAILABILITY_QUERY = `query apiCampingAvailability($campingCode: Int!, $startDate: Date!, $endDate: Date!, $accommodationType: String!,
                             $peopleCount: Int!, $filters: [FilterInput!], $fidelityId: ID) {
  campingAvailability(campingCode: $campingCode, peopleCount: $peopleCount, accommodationType: $accommodationType,
                      startDate: $startDate, endDate: $endDate, filters: $filters, fidelityId: $fidelityId) {
    statusCode
    accommodationId
    info { arrivalDate departureDate }
  }
}`;
