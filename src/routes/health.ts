import type { RouteHandler } from '../http/context.js';

/** GET /v1/health (§15) ; `?deep=true` vérifie le GraphQL amont. */
export const health: RouteHandler = async (ctx) => {
  const { config } = ctx.deps;
  const deep = ctx.req.query.deep === 'true';
  if (!deep) return { status: 200, body: { status: 'ok', version: config.version, upstream: 'not_checked' } };
  try {
    await ctx.gql.catalog(
      { accommodationType: 'rental', peopleCount: 1, campingContentIds: [], filters: [] },
      config.gql.locale,
    );
    return { status: 200, body: { status: 'ok', version: config.version, upstream: 'ok' } };
  } catch (err) {
    ctx.deps.logger.warn('health: GraphQL en erreur', { error: (err as Error).message });
    return { status: 503, body: { status: 'degraded', version: config.version, upstream: 'error' } };
  }
};
