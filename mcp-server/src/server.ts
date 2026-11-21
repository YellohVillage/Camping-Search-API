import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerFindACamping } from './prompts/findACamping.js';
import { registerFiltersResource } from './resources/filtersResource.js';
import type { ToolContext } from './tools/context.js';
import { registerGetSearchFilters } from './tools/getSearchFilters.js';
import { registerSearchCampings } from './tools/searchCampings.js';

/** Instructions injectées dans le contexte du modèle par les clients qui les gèrent (§4, ≤ 1 500 caractères). */
export const SERVER_INSTRUCTIONS = `Yelloh! Village campsite search. Workflow: (1) make sure you know the stay dates (YYYY-MM-DD) and the number of people — ask the user if missing, never guess; (2) if the user mentions criteria, call get_search_filters with the same accommodation_type and user_language, and map the criteria to the returned ids only; (3) call search_campings. accommodation_type is "rental" unless the user mentions a tent, caravan, camper van or pitch ("slot"). Always pass user_language = the language the user writes in. Present each proposal with BOTH links exactly as returned: campsite page (camping_page) and booking (booking_link). For "alternative_dates" results, say clearly they are not available on the requested dates and give the proposed dates; for "alternative_capacity", give the capacity. Never state or estimate prices. If status is NO_AVAILABILITY, say no campsite is available and suggest relaxing dates or filters. If a criterion has no matching filter, tell the user instead of ignoring it.`;

/** Un McpServer par requête HTTP (mode sans état, §11.3). */
export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    {
      name: 'yelloh-camping-search',
      title: 'Yelloh! Village – Recherche de camping',
      version: ctx.config.version,
    },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false },
        prompts: { listChanged: false },
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  registerGetSearchFilters(server, ctx);
  registerSearchCampings(server, ctx);
  registerFiltersResource(server, ctx);
  registerFindACamping(server);
  return server;
}
