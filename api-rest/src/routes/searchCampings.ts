import { allInError, classify } from '../domain/classifier.js';
import { keepCamping } from '../domain/filterEngine.js';
import { parseFilterIds, toFilterInputs, validateFilters } from '../domain/filterResolver.js';
import { resolveSiteBaseUrl } from '../domain/language.js';
import { toCampingResult } from '../domain/mappers.js';
import { cryptoRng, seededRng } from '../domain/rng.js';
import { selectCampings } from '../domain/selector.js';
import { ApiError, badRequest } from '../http/errors.js';
import type { RouteHandler } from '../http/context.js';
import { toGqlDate } from '../upstream/gqlClient.js';
import type { GqlCamping } from '../upstream/types.js';
import { parseSearchQuery } from '../validation/schemas.js';

/** GET /v1/search/campings (§7, §8). */
export const searchCampings: RouteHandler = async (ctx) => {
  const { config } = ctx.deps;
  const started = Date.now();

  // Validation des paramètres (§7.1).
  const q = parseSearchQuery(ctx.req.query, {
    maxPeople: config.maxPeople,
    maxStayNights: config.maxStayNights,
    defaultMaxResults: config.defaultMaxResults,
    maxResultsLimit: config.maxResultsLimit,
    tzBusiness: config.tzBusiness,
    now: ctx.now,
    maxCampingIds: config.maxCampingIds,
  });

  // 1. Contrôle syntaxique des ids, sans appel GraphQL (§8.2 a).
  const { parsed, invalid } = parseFilterIds(q.filters);
  if (invalid.length > 0) {
    throw badRequest(
      'INVALID_FILTER_FORMAT',
      `Identifiant(s) de filtre mal formé(s) : ${invalid.join(', ')}.`,
      {
        invalid,
      },
    );
  }

  // 2. Appel unique searchCampings, filtres présumés hébergement inclus (§8.3),
  //    restreint aux campings de campingIDs s'il y en a (§8.9).
  const gqlData = await ctx.gql.searchCampings(
    {
      accommodationType: q.accommodationType,
      peopleCount: q.peopleCount,
      campingContentIds: q.campingIds,
      startDate: toGqlDate(q.startDate),
      endDate: toGqlDate(q.endDate),
      filters: toFilterInputs(parsed),
    },
    config.gql.locale,
  );

  // 3. Validation de cohérence avec le catalogue renvoyé (§8.2 b, §8.7).
  const first = validateFilters(parsed, gqlData.filterCategories);
  const resolved = first.resolved;
  let unknown = first.unknown;
  if (unknown.length > 0 && q.campingIds.length > 0) {
    // Catalogue restreint aux campings demandés : revalidation des ids absents avec le catalogue complet (§8.9).
    const fullCatalog = await ctx.gql.catalog(
      { accommodationType: q.accommodationType, peopleCount: 1, campingContentIds: [], filters: [] },
      config.gql.locale,
    );
    const retry = validateFilters(
      parsed.filter((p) => unknown.includes(p.id)),
      fullCatalog,
    );
    resolved.push(...retry.resolved);
    unknown = retry.unknown;
  }
  if (unknown.length > 0) {
    throw badRequest(
      'UNKNOWN_FILTER',
      `Filtre(s) inconnu(s) pour accommodation_type=${q.accommodationType} : ${unknown.join(', ')}.`,
      { unknown, accommodation_type: q.accommodationType },
    );
  }
  if (allInError(gqlData.campings)) {
    throw new ApiError(502, 'UPSTREAM_ERROR', 'Le service de disponibilités Yelloh! Village est en erreur.');
  }

  // 4. Filtrage local (§8.4) ; 5. classement (§8.5).
  const campings = gqlData.campings.filter((c): c is GqlCamping => !!c);
  const kept = campings.filter((c) => keepCamping(c, resolved, q.accommodationType));
  const lists = classify(kept);

  // 6. Sélection et complétion (§8.6).
  const debugSeed = ctx.req.headers['x-debug-seed'];
  const rng = config.allowDebugSeed && debugSeed ? seededRng(debugSeed) : (ctx.deps.rng ?? cryptoRng);
  const accInputs = toFilterInputs(resolved.filter((f) => f.level === 'accommodation'));
  const selection = await selectCampings(
    lists.available,
    lists.alternative,
    (camping) =>
      ctx.gql.campingAvailability(
        {
          campingCode: camping.campingCode,
          accommodationType: q.accommodationType,
          peopleCount: q.peopleCount,
          startDate: toGqlDate(q.startDate),
          endDate: toGqlDate(q.endDate),
          filters: accInputs,
          fidelityId: null,
        },
        config.gql.locale,
      ),
    {
      maxResults: q.maxResults,
      maxAvailabilityCalls: config.maxAvailabilityCalls,
      concurrency: config.availabilityConcurrency,
      rng,
    },
  );

  // 7. Liens et réponse (§7, §10).
  const site = resolveSiteBaseUrl(
    q.userLanguage,
    ctx.req.headers['accept-language'],
    config.siteBaseUrls,
    config.siteBaseUrlDefault,
  );
  const track = ctx.client?.track || config.bookingEngineDefaultTrack;
  const results = selection.results.map((sel, i) =>
    toCampingResult(sel, i + 1, {
      startDate: q.startDate,
      endDate: q.endDate,
      peopleCount: q.peopleCount,
      accommodationType: q.accommodationType,
      track,
      siteBaseUrl: site.base,
      bookingEngineUrl: config.bookingEngineUrl,
    }),
  );

  const message =
    selection.status === 'NO_AVAILABILITY'
      ? 'aucun camping disponible'
      : selection.status === 'PARTIAL'
        ? `Seulement ${results.length} camping(s) correspondent à vos critères.`
        : null;

  Object.assign(ctx.logFields, {
    camping_ids_count: q.campingIds.length,
    business_status: selection.status,
    available: lists.available.length,
    alternative: lists.alternative.length,
    returned: results.length,
  });

  return {
    status: 200,
    body: {
      status: selection.status,
      message,
      search: {
        start_date: q.startDate,
        end_date: q.endDate,
        nights: q.nights,
        people_count: q.peopleCount,
        accommodation_type: q.accommodationType,
        filters: q.filters,
        max_results: q.maxResults,
        camping_ids: q.campingIds,
        user_language: site.lang,
        site_base_url: site.base,
      },
      summary: {
        available_count: lists.available.length,
        alternative_dates_count: lists.alternative.length,
        unavailable_count: lists.unavailable.length,
        returned_count: results.length,
      },
      results,
      meta: {
        request_id: ctx.requestId,
        generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        duration_ms: Date.now() - started,
        upstream_calls: {
          search_campings: ctx.upstream.search_campings,
          camping_availability: ctx.upstream.camping_availability,
          ...(ctx.upstream.catalog > 0 ? { catalog: ctx.upstream.catalog } : {}),
        },
      },
    },
  };
};
