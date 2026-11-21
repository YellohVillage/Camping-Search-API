import { buildCatalog } from '../domain/filterCatalog.js';
import { lookupLanguage, resolveUserLanguage } from '../domain/language.js';
import type { RouteHandler } from '../http/context.js';
import { parseFiltersQuery } from '../validation/schemas.js';

/** GET /v1/search/filters (§6) : catalogue des filtres, libellés dans la langue de l'utilisateur. */
export const searchFilters: RouteHandler = async (ctx) => {
  const { config } = ctx.deps;
  const q = parseFiltersQuery(ctx.req.query);
  const lang = resolveUserLanguage(q.userLanguage, ctx.req.headers['accept-language']);
  const gqlLocale = lookupLanguage(lang, config.gql.locales, config.gql.localeDefault);

  const categories = await ctx.gql.catalog(
    { accommodationType: q.accommodationType, peopleCount: 1, campingContentIds: [], filters: [] },
    gqlLocale,
  );
  const generatedAt = ctx.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const catalog = buildCatalog(categories, q.accommodationType, gqlLocale, generatedAt, ctx.deps.logger);
  return {
    status: 200,
    body: catalog,
    headers: { 'Cache-Control': 'private, max-age=86400', Vary: 'Accept-Language' },
  };
};
