import { randomUUID } from 'node:crypto';
import { clientRateLimit } from './auth/apiKeys.js';
import { RateLimiter } from './auth/rateLimit.js';
import { verifyBearer } from './auth/session.js';
import type { Config } from './config.js';
import { cryptoRng, type Rng } from './domain/rng.js';
import type {
  AppDeps,
  RequestContext,
  RouteHandler,
  SecurityMaterial,
  UpstreamCounters,
} from './http/context.js';
import { ApiError, errorBody } from './http/errors.js';
import type { HttpRequest, HttpResponse } from './http/types.js';
import { createLogger, type Logger } from './observability/logger.js';
import { authSession } from './routes/authSession.js';
import { health } from './routes/health.js';
import { openapi } from './routes/openapi.js';
import { searchCampings } from './routes/searchCampings.js';
import { searchFilters } from './routes/searchFilters.js';
import {
  createGqlClient,
  UpstreamError,
  UpstreamTimeoutError,
  type FetchFn,
  type GqlClient,
} from './upstream/gqlClient.js';

export interface App {
  handle(req: HttpRequest): Promise<HttpResponse>;
}

export interface CreateAppOptions {
  config: Config;
  gqlClient?: GqlClient;
  fetchImpl?: FetchFn;
  rng?: Rng;
  clock?: () => Date;
  logger?: Logger;
  /** Source du matériel de sécurité ; par défaut, la configuration chargée au démarrage. */
  security?: () => SecurityMaterial | Promise<SecurityMaterial>;
}

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
  protected: boolean;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Client GraphQL qui compte les appels de la requête (meta.upstream_calls, journaux). */
function countingClient(inner: GqlClient, counters: UpstreamCounters): GqlClient {
  return {
    catalog: (v, l) => {
      counters.catalog++;
      return inner.catalog(v, l);
    },
    searchCampings: (v, l) => {
      counters.search_campings++;
      return inner.searchCampings(v, l);
    },
    campingAvailability: (v, l) => {
      counters.camping_availability++;
      return inner.campingAvailability(v, l);
    },
  };
}

export function createApp(opts: CreateAppOptions): App {
  const { config } = opts;
  const deps: AppDeps = {
    config,
    gqlClient: opts.gqlClient ?? createGqlClient(config.gql, opts.fetchImpl),
    rng: opts.rng ?? cryptoRng,
    clock: opts.clock ?? (() => new Date()),
    logger: opts.logger ?? createLogger(config.logLevel),
    security: opts.security ?? (() => ({ clients: config.apiClients, secrets: config.signingSecrets })),
  };
  const sessionLimiter = new RateLimiter();
  const clientLimiter = new RateLimiter();

  const routes: Route[] = [
    { method: 'POST', path: '/v1/auth/session', handler: authSession(sessionLimiter), protected: false },
    { method: 'GET', path: '/v1/search/filters', handler: searchFilters, protected: true },
    { method: 'GET', path: '/v1/search/campings', handler: searchCampings, protected: true },
    { method: 'GET', path: '/v1/health', handler: health, protected: false },
    { method: 'GET', path: '/v1/openapi.json', handler: openapi, protected: false },
  ];

  const baseHeaders = (requestId: string): Record<string, string> => ({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Request-Id': requestId,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Strict-Transport-Security': 'max-age=31536000',
  });

  const corsHeaders = (origin: string | undefined): Record<string, string> =>
    origin && config.corsAllowedOrigins.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }
      : {};

  return {
    async handle(req: HttpRequest): Promise<HttpResponse> {
      const startedAt = Date.now();
      const incomingId = req.headers['x-request-id'];
      const requestId = incomingId && REQUEST_ID_RE.test(incomingId) ? incomingId : randomUUID();
      const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
      const method = req.method.toUpperCase();
      const upstream: UpstreamCounters = { search_campings: 0, camping_availability: 0, catalog: 0 };
      const ctx: RequestContext = {
        req: { ...req, path, method },
        requestId,
        now: deps.clock(),
        deps,
        gql: countingClient(deps.gqlClient, upstream),
        upstream,
        logFields: {},
      };
      const headers = { ...baseHeaders(requestId), ...corsHeaders(req.headers.origin) };
      let status = 500;
      let body: unknown;

      try {
        const candidates = routes.filter((r) => r.path === path);
        if (method === 'OPTIONS' && candidates.length > 0 && headers['Access-Control-Allow-Origin']) {
          status = 204;
          Object.assign(headers, {
            'Access-Control-Allow-Methods': [...new Set(candidates.map((r) => r.method)), 'OPTIONS'].join(
              ', ',
            ),
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Request-Id, Accept-Language',
            'Access-Control-Max-Age': '600',
          });
          return { statusCode: status, headers, body: '' };
        }
        if (candidates.length === 0) throw new ApiError(404, 'NOT_FOUND', `Route inconnue : ${path}`);
        const route = candidates.find((r) => r.method === method);
        if (!route) {
          throw new ApiError(
            405,
            'METHOD_NOT_ALLOWED',
            `Méthode ${method} non supportée sur ${path}.`,
            undefined,
            {
              Allow: candidates.map((r) => r.method).join(', '),
            },
          );
        }

        if (route.protected) {
          const security = await deps.security();
          ctx.client = await verifyBearer(
            req.headers.authorization,
            { secrets: security.secrets, ttlSeconds: config.sessionTtlSeconds, issuer: config.sessionIssuer },
            security.clients,
            ctx.now,
          );
          ctx.logFields.client_id = ctx.client.clientId;
          const limit = clientRateLimit(ctx.client.clientId, security.clients, config.rateLimitPerMinute);
          const rate = clientLimiter.check(`client:${ctx.client.clientId}`, limit, ctx.now.getTime());
          headers['X-RateLimit-Limit'] = String(rate.limit);
          headers['X-RateLimit-Remaining'] = String(rate.remaining);
          if (!rate.allowed) {
            throw new ApiError(
              429,
              'RATE_LIMITED',
              'Quota de requêtes dépassé, réessayez plus tard.',
              undefined,
              {
                'Retry-After': String(rate.retryAfter),
              },
            );
          }
        }

        const result = await route.handler(ctx);
        status = result.status;
        body = result.body;
        Object.assign(headers, result.headers ?? {});
      } catch (e) {
        let apiErr: ApiError;
        if (e instanceof ApiError) apiErr = e;
        else if (e instanceof UpstreamTimeoutError) {
          apiErr = new ApiError(
            504,
            'UPSTREAM_TIMEOUT',
            'Le service de disponibilités Yelloh! Village ne répond pas.',
          );
        } else if (e instanceof UpstreamError) {
          deps.logger.warn('erreur amont', { request_id: requestId, error: e.message });
          apiErr = new ApiError(
            502,
            'UPSTREAM_ERROR',
            'Le service de disponibilités Yelloh! Village est en erreur.',
          );
        } else {
          deps.logger.error('erreur interne', { request_id: requestId, error: (e as Error)?.message });
          apiErr = new ApiError(500, 'INTERNAL_ERROR', 'Erreur interne.');
        }
        status = apiErr.status;
        body = errorBody(apiErr, requestId);
        Object.assign(headers, apiErr.headers);
        ctx.logFields.error_code = apiErr.code;
      }

      deps.logger.info('request', {
        request_id: requestId,
        method,
        route: path,
        status,
        duration_ms: Date.now() - startedAt,
        upstream_calls: upstream,
        ...ctx.logFields,
      });
      return { statusCode: status, headers, body: JSON.stringify(body) };
    },
  };
}
