import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { restErrorToTool } from '../errors.js';
import {
  geographyText,
  noGeographyResult,
  toMcpGeographyResult,
  type McpGeographyResult,
} from '../format/geographyResult.js';
import { normalizeKeywords } from '../rest/geographyCache.js';
import { RestApiError } from '../rest/restClient.js';
import { logToolCall, userLanguageSchema, type ToolContext } from './context.js';

export const SEARCH_GEOGRAPHY_DESCRIPTION = `Finds the Yelloh! Village campsites located in a place named by the user (country, region, department, city,
island, or a campsite name) and returns their ids (camping_ids). Call it whenever the user mentions a place,
BEFORE search_campings, then pass camping_ids unchanged in the camping_ids argument of search_campings, together
with the filters matching the other criteria of the request.
keywords: the place name only, in the user's language, without prepositions or qualifiers ("Bretagne",
"Argelès-sur-Mer", "Espagne"; not "dans le sud de la Bretagne"); at least 3 characters.
Do NOT use it for landscape types (sea, mountain, countryside, river, lake, beach access): they are filters of
get_search_filters. If the user names several places, call it once per place and merge the camping_ids.
The result gives the matched place (match.name, match.type): tell the user which area was searched if it differs
from their words. If status is "NO_RESULT", the place is unknown: you may try another obvious wording (region or
department name, official spelling); if no place is found, STILL call search_campings, without camping_ids (whole
Yelloh! Village network). There is no need to tell the user that the place was not found.
Pass user_language = the language the user is writing in: place names are searched in that language.`;

export const MIN_KEYWORDS_LENGTH = 3;

export const searchGeographyInput = z
  .object({
    keywords: z
      .string()
      .max(100)
      .refine((k) => [...normalizeKeywords(k)].length >= MIN_KEYWORDS_LENGTH, {
        message: `must contain at least ${MIN_KEYWORDS_LENGTH} characters (place name only)`,
      })
      .describe(
        'Place name only, in the user\'s language (e.g. "Bretagne", "Argelès-sur-Mer", "Spain"). At least 3 characters.',
      ),
    user_language: userLanguageSchema.describe(
      'Language the user writes in, as an ISO 639-1 / BCP 47 code (e.g. "fr", "en", "de"). Place names are searched in this language.',
    ),
  })
  .strict();

const matchSchema = z.object({ name: z.string(), type: z.string().nullable(), camping_count: z.number() });

export const searchGeographyOutput = z.object({
  status: z.enum(['OK', 'NO_RESULT']),
  keywords: z.string(),
  match: matchSchema.nullable(),
  camping_ids: z.array(z.number()),
  other_matches: z.array(matchSchema),
});

const toResult = (g: McpGeographyResult) => ({
  content: [{ type: 'text' as const, text: geographyText(g) }],
  structuredContent: g as unknown as Record<string, unknown>,
});

export function registerSearchGeography(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_geography',
    {
      title: 'Find Yelloh! Village campsites in a place',
      description: SEARCH_GEOGRAPHY_DESCRIPTION,
      inputSchema: searchGeographyInput,
      outputSchema: searchGeographyOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const started = Date.now();
      const keywords = normalizeKeywords(args.keywords);
      const log = (g: McpGeographyResult | null, extra: Record<string, unknown>) =>
        logToolCall(ctx, 'search_geography', started, {
          keywords,
          user_language: args.user_language,
          ...(g
            ? { status: g.status, match: g.match?.name ?? null, camping_count: g.camping_ids.length }
            : {}),
          ...extra,
        });

      const cached = ctx.geoCache.get(keywords, args.user_language);
      if (cached) {
        log(cached, { cache: 'hit' });
        return toResult(cached);
      }
      try {
        const g = toMcpGeographyResult(await ctx.rest.searchGeography(keywords, args.user_language));
        ctx.geoCache.set(keywords, args.user_language, g);
        log(g, { cache: 'miss' });
        return toResult(g);
      } catch (err) {
        if (err instanceof RestApiError && err.code === 'NO_RESULT') {
          // Lieu introuvable : pas une erreur (§6 bis.3), réponse stable donc mise en cache.
          const g = noGeographyResult(keywords);
          ctx.geoCache.set(keywords, args.user_language, g);
          log(g, { cache: 'miss' });
          return toResult(g);
        }
        log(null, { status: 'ERROR', error_code: (err as { code?: string }).code ?? 'UNKNOWN' });
        return restErrorToTool(err);
      }
    },
  );
}
