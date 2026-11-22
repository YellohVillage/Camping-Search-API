import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restErrorToTool, toolError } from '../errors.js';
import { searchText, toMcpSearchResult } from '../format/searchResult.js';
import { RestApiError } from '../rest/restClient.js';
import { accommodationTypeSchema, logToolCall, userLanguageSchema, type ToolContext } from './context.js';

export const SEARCH_CAMPINGS_DESCRIPTION = `Searches Yelloh! Village campsites for a stay and returns up to max_results proposals (default 3), each with
a booking link to the Yelloh! Village booking engine. Required: start_date, end_date (YYYY-MM-DD, arrival and
departure days) and people_count. Ask the user for any missing required value instead of guessing.
For criteria, first call get_search_filters with the same accommodation_type and pass only the returned ids.
If the user names a place (country, region, department, city, island, campsite name), first call search_geography
and pass its camping_ids unchanged in camping_ids (union of the lists if the user names several places). If no place
is found (status "NO_RESULT"), still search, without camping_ids (whole network); no need to tell the user.
Each result has availability_type:
- "available": available on the requested dates;
- "alternative_dates": NOT available on the requested dates, but available on alternative_begin_date /
  alternative_end_date — tell the user explicitly;
- "alternative_capacity": available on the requested dates in an accommodation for alternative_capacity people.
Always pass user_language = the language the user is writing in (e.g. "fr", "en", "de").
For each result, always give BOTH links exactly as returned: camping_page (campsite description page) and booking_link
(booking engine, pre-filled with the dates and number of people). No prices are returned: never state or estimate a price.
If status is "NO_AVAILABILITY", tell the user that no campsite is available and suggest relaxing dates or filters.
Results are randomly picked among matching campsites: calling again may return other proposals.`;

/** MAX_CAMPING_IDS de l'API REST (§6.2). */
export const MAX_CAMPING_IDS = 200;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date YYYY-MM-DD');

export function searchCampingsInput(maxResultsLimit: number) {
  return z
    .object({
      start_date: date.describe('Arrival date, YYYY-MM-DD.'),
      end_date: date.describe('Departure date, YYYY-MM-DD, after start_date. Max 90 nights.'),
      people_count: z.number().int().min(1).max(10).describe('Number of people, babies included.'),
      accommodation_type: accommodationTypeSchema
        .default('rental')
        .describe('Must match the accommodation_type used with get_search_filters.'),
      filters: z
        .array(z.string())
        .max(30)
        .default([])
        .describe('Filter ids returned by get_search_filters, unchanged (e.g. "confort_type:F4:4").'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(maxResultsLimit)
        .default(3)
        .describe('Maximum number of proposals. Keep the default unless the user asks for more or fewer.'),
      user_language: userLanguageSchema.describe(
        'Language the user writes in, as an ISO 639-1 / BCP 47 code (e.g. "fr", "en", "de", "es", "ca", "nl", "it"). Selects the language of the camping_page link.',
      ),
      camping_ids: z
        .array(z.number().int().min(1))
        .max(MAX_CAMPING_IDS)
        .default([])
        .describe(
          'Campsite ids returned by search_geography (camping_ids), unchanged, to restrict the search to a place. Empty = whole Yelloh! Village network. Never invent ids.',
        ),
    })
    .strict();
}

const nullableStr = z.string().nullable();

export const searchCampingsOutput = z.object({
  status: z.enum(['OK', 'PARTIAL', 'NO_AVAILABILITY']),
  message: nullableStr,
  search: z.object({
    start_date: z.string(),
    end_date: z.string(),
    nights: z.number(),
    people_count: z.number(),
    accommodation_type: accommodationTypeSchema,
    filters: z.array(z.string()),
    camping_ids_count: z.number(),
  }),
  matching: z.object({ available: z.number(), alternative_dates: z.number() }),
  results: z.array(
    z.object({
      rank: z.number(),
      availability_type: z.enum(['available', 'alternative_dates', 'alternative_capacity']),
      name: z.string(),
      city: z.string(),
      department: nullableStr,
      region: nullableStr,
      stars: z.number().nullable(),
      rating_out_of_10: z.number().nullable(),
      alternative_begin_date: nullableStr,
      alternative_end_date: nullableStr,
      alternative_capacity: z.number().nullable(),
      booking_link: z.string(),
      camping_page: z.string(),
      image_url: nullableStr,
    }),
  ),
});

export function registerSearchCampings(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_campings',
    {
      title: 'Search Yelloh! Village campsites',
      description: SEARCH_CAMPINGS_DESCRIPTION,
      inputSchema: searchCampingsInput(ctx.config.maxResultsLimit),
      outputSchema: searchCampingsOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      const started = Date.now();
      const criteria = {
        start_date: args.start_date,
        end_date: args.end_date,
        people_count: args.people_count,
        accommodation_type: args.accommodation_type,
        filters: args.filters,
        max_results: args.max_results,
        user_language: args.user_language,
        camping_ids_count: new Set(args.camping_ids).size,
      };
      if (args.end_date <= args.start_date) {
        logToolCall(ctx, 'search_campings', started, {
          ...criteria,
          status: 'ERROR',
          error_code: 'INVALID_ARGUMENTS',
        });
        return toolError('Invalid arguments: end_date must be after start_date.');
      }
      try {
        const rest = await ctx.rest.searchCampings({
          startDate: args.start_date,
          endDate: args.end_date,
          peopleCount: args.people_count,
          accommodationType: args.accommodation_type,
          filters: args.filters,
          maxResults: args.max_results,
          userLanguage: args.user_language,
          campingIds: args.camping_ids,
        });
        const out = toMcpSearchResult(rest);
        logToolCall(ctx, 'search_campings', started, {
          ...criteria,
          status: out.status,
          results: out.results.length,
        });
        return {
          content: [{ type: 'text', text: searchText(out) }],
          structuredContent: out as unknown as Record<string, unknown>,
        };
      } catch (err) {
        // Catalogue en cache probablement périmé : on le vide pour ce type, toutes langues (§6.3).
        if (err instanceof RestApiError && err.code === 'UNKNOWN_FILTER')
          ctx.cache.invalidateType(args.accommodation_type);
        logToolCall(ctx, 'search_campings', started, {
          ...criteria,
          status: 'ERROR',
          error_code: (err as { code?: string }).code ?? 'UNKNOWN',
        });
        return restErrorToTool(err, args.accommodation_type);
      }
    },
  );
}
