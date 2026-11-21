import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restErrorToTool } from '../errors.js';
import { catalogText, compactCatalog } from '../format/compactCatalog.js';
import {
  accommodationTypeSchema,
  loadCatalog,
  logToolCall,
  userLanguageSchema,
  type ToolContext,
} from './context.js';

export const GET_SEARCH_FILTERS_DESCRIPTION = `Returns the list of search criteria (filters) available for Yelloh! Village campsites, for one accommodation
type. Call it BEFORE search_campings whenever the user mentions any criterion (comfort level, pool, slide,
sea, mountain, pets, accessibility, kids club, activities, services, accommodation type…), then pass the
matching filter "id" values to search_campings. Use only ids returned by this tool, never invent or modify
them. accommodation_type must be the same as the one used in search_campings ("rental" = mobile home,
chalet, tent…; "slot" = pitch for the customer's own tent, caravan or camper van).
Filters with operator "OR" in the same category are alternatives (e.g. 4 flowers OR Premium); all other
selected filters must all be satisfied. Pass user_language = the language the user is writing in: labels are
returned in that language (ids are the same in every language).`;

export const getSearchFiltersInput = z
  .object({
    accommodation_type: accommodationTypeSchema
      .default('rental')
      .describe(
        "rental = rented accommodation (mobile home, chalet, lodge tent…); slot = pitch for the customer's own tent, caravan or camper van.",
      ),
    user_language: userLanguageSchema.describe(
      'Language the user is writing in, as an ISO 639-1 / BCP 47 code (e.g. "fr", "en", "de"). Labels are returned in this language.',
    ),
  })
  .strict();

const filterSchema = z.object({ id: z.string(), label: z.string(), label_en: z.string().nullable() });

export const getSearchFiltersOutput = z.object({
  accommodation_type: accommodationTypeSchema,
  sections: z.array(
    z.object({
      section: z.string(),
      label: z.string(),
      label_en: z.string().nullable(),
      categories: z.array(
        z.object({
          category_id: z.string(),
          operator: z.enum(['AND', 'OR']),
          filters: z.array(filterSchema),
        }),
      ),
    }),
  ),
});

export function registerGetSearchFilters(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_search_filters',
    {
      title: 'Yelloh! Village search criteria',
      description: GET_SEARCH_FILTERS_DESCRIPTION,
      inputSchema: getSearchFiltersInput,
      outputSchema: getSearchFiltersOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const started = Date.now();
      try {
        const compact = compactCatalog(await loadCatalog(ctx, args.accommodation_type, args.user_language));
        logToolCall(ctx, 'get_search_filters', started, {
          accommodation_type: args.accommodation_type,
          user_language: args.user_language,
          status: 'OK',
        });
        return {
          content: [{ type: 'text', text: catalogText(compact) }],
          structuredContent: compact as unknown as Record<string, unknown>,
        };
      } catch (err) {
        logToolCall(ctx, 'get_search_filters', started, {
          accommodation_type: args.accommodation_type,
          status: 'ERROR',
          error_code: (err as { code?: string }).code ?? 'UNKNOWN',
        });
        return restErrorToTool(err, args.accommodation_type);
      }
    },
  );
}
