import type { Endpoint, McpConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { CatalogCache } from '../rest/catalogCache.js';
import type { RestClient } from '../rest/restClient.js';
import type { AccommodationType, RestCatalog } from '../rest/types.js';
import { z } from 'zod';

/** Dépendances partagées par les outils, la ressource et le prompt d'une requête MCP. */
export interface ToolContext {
  config: McpConfig;
  endpoint: Endpoint;
  requestId: string;
  rest: RestClient;
  cache: CatalogCache;
  logger: Logger;
}

/** Code de langue BCP 47 simplifié (§5.2, §6.2). */
export const userLanguageSchema = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/, 'must be a language code such as "fr", "en" or "de-AT"');

export const accommodationTypeSchema = z.enum(['rental', 'slot']);

/** Catalogue depuis le cache d'instance (24 h), sinon depuis l'API REST (§5.3). */
export async function loadCatalog(
  ctx: ToolContext,
  type: AccommodationType,
  userLanguage: string,
): Promise<RestCatalog> {
  const cached = ctx.cache.get(type, userLanguage);
  if (cached) return cached;
  const catalog = await ctx.rest.getFilters(type, userLanguage);
  ctx.cache.set(type, userLanguage, catalog);
  return catalog;
}

/** Ligne de journal d'un appel d'outil (§9.3) : critères de séjour uniquement. */
export function logToolCall(
  ctx: ToolContext,
  tool: string,
  started: number,
  fields: Record<string, unknown>,
): void {
  ctx.logger.info('tool_call', {
    request_id: ctx.requestId,
    endpoint: ctx.endpoint,
    tool,
    duration_ms: Date.now() - started,
    ...fields,
  });
}
