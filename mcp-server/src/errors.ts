import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RestApiError } from './rest/restClient.js';

/**
 * Traduction des erreurs en résultats d'outil actionnables pour le LLM (§8).
 * Les messages ne contiennent jamais la clé d'API, le token ni l'URL de l'API REST.
 */
export const toolError = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

const UNAVAILABLE = 'Yelloh! Village search is temporarily unavailable. Please try again later.';

export function restErrorToTool(err: unknown, accommodationType?: string): CallToolResult {
  if (!(err instanceof RestApiError)) return toolError(UNAVAILABLE);
  const d = err.details ?? {};
  switch (err.code) {
    case 'INVALID_DATES':
      return toolError(`${err.message} Ask the user for valid dates (not in the past, max 90 nights).`);
    case 'INVALID_PEOPLE_COUNT':
      return toolError('people_count must be between 1 and 10.');
    case 'UNKNOWN_FILTER': {
      const ids = Array.isArray(d.unknown) ? (d.unknown as string[]).join(', ') : '';
      const type = (d.accommodation_type as string | undefined) ?? accommodationType ?? '';
      return toolError(
        `Unknown filter ids for accommodation_type=${type}: ${ids}. Call get_search_filters again and use only the returned ids.`,
      );
    }
    case 'INVALID_FILTER_FORMAT': {
      const ids = Array.isArray(d.invalid) ? (d.invalid as string[]).join(', ') : '';
      return toolError(`Malformed filter ids: ${ids}. Use ids exactly as returned by get_search_filters.`);
    }
    case 'TOO_MANY_FILTERS':
      return toolError('Too many filters (max 30). Keep only the criteria the user really asked for.');
    case 'INVALID_MAX_RESULTS':
    case 'INVALID_ACCOMMODATION_TYPE':
    case 'MISSING_PARAMETER':
      return toolError(`Invalid arguments: ${err.message}`);
    case 'RATE_LIMITED':
      return toolError(`Too many requests, retry in ${err.retryAfter ?? 60} seconds.`);
    default:
      if (err.status === 401 || err.status === 403) return toolError('Service temporarily unavailable.');
      return toolError(UNAVAILABLE);
  }
}
