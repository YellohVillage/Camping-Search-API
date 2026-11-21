import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { compactCatalog } from '../format/compactCatalog.js';
import {
  accommodationTypeSchema,
  loadCatalog,
  userLanguageSchema,
  type ToolContext,
} from '../tools/context.js';

/** Ressource `yelloh://filters/{accommodation_type}/{language}` (§7.1) : même contenu que get_search_filters. */
export function registerFiltersResource(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    'search-filters',
    new ResourceTemplate('yelloh://filters/{accommodation_type}/{language}', {
      list: async () => ({
        resources: (['rental', 'slot'] as const).map((t) => ({
          uri: `yelloh://filters/${t}/fr`,
          name: `Search filters (${t}, fr)`,
          mimeType: 'application/json',
        })),
      }),
    }),
    {
      title: 'Yelloh! Village search filters',
      description:
        'Catalogue of search filter ids and labels for an accommodation type (rental or slot) and a language.',
      mimeType: 'application/json',
    },
    async (uri, vars) => {
      const type = accommodationTypeSchema.parse(String(vars.accommodation_type));
      const lang = userLanguageSchema.parse(String(vars.language));
      const compact = compactCatalog(await loadCatalog(ctx, type, lang));
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(compact) }] };
    },
  );
}
