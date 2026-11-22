import { selectGeography } from '../domain/geography.js';
import { lookupLanguage, resolveUserLanguage } from '../domain/language.js';
import { ApiError } from '../http/errors.js';
import type { RouteHandler } from '../http/context.js';
import { parseGeographyQuery } from '../validation/schemas.js';

/** GET /v1/search/geography (§7 bis) : mots clés d'un lieu → identifiants des campings de la zone. */
export const searchGeography: RouteHandler = async (ctx) => {
  const { config } = ctx.deps;
  const started = Date.now();
  const q = parseGeographyQuery(ctx.req.query, config.geoMinKeywordsLength);
  const lang = resolveUserLanguage(q.userLanguage, ctx.req.headers['accept-language']);
  const locale = lookupLanguage(lang, config.gql.locales, config.gql.localeDefault);

  const results = await ctx.gql.autocomplete(q.keywords, locale);
  const selected = selectGeography(results);
  Object.assign(ctx.logFields, { keywords: q.keywords, locale });
  if (!selected) {
    throw new ApiError(404, 'NO_RESULT', 'no result', { keywords: q.keywords, locale });
  }
  const { match, others } = selected;
  Object.assign(ctx.logFields, { match: match.name, camping_count: match.ids.length });

  return {
    status: 200,
    headers: { 'Cache-Control': 'private, max-age=86400', Vary: 'Accept-Language' },
    body: {
      status: 'OK',
      keywords: q.keywords,
      user_language: lang,
      locale,
      match: {
        name: match.name,
        type: match.type,
        content_id: match.contentId,
        camping_count: match.ids.length,
      },
      camping_ids: match.ids,
      other_matches: others.map((o) => ({
        name: o.name,
        type: o.type,
        content_id: o.contentId,
        camping_count: o.ids.length,
      })),
      meta: {
        request_id: ctx.requestId,
        generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        duration_ms: Date.now() - started,
        upstream_calls: { search_autocomplete: ctx.upstream.search_autocomplete },
      },
    },
  };
};
