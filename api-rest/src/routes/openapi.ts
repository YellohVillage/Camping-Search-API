import { z } from 'zod';
import type { RouteHandler } from '../http/context.js';

/** Schémas des réponses (§5, §6, §7, §7 bis, §11), source du contrat OpenAPI 3.1 et des assertions de test. */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const errorSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
      request_id: z.string(),
    }),
  })
  .meta({ id: 'Error' });

export const sessionSchema = z
  .object({
    access_token: z.string(),
    token_type: z.literal('Bearer'),
    expires_in: z.number().int(),
    expires_at: z.string(),
    client_id: z.string(),
  })
  .meta({ id: 'Session' });

export const catalogSchema = z
  .object({
    accommodation_type: z.enum(['rental', 'slot']),
    locale: z.string(),
    generated_at: z.string(),
    sections: z.array(
      z.object({
        section: z.string(),
        label: z.string(),
        categories: z.array(
          z.object({
            category_id: z.string(),
            level: z.enum(['camping', 'accommodation']),
            operator: z.enum(['AND', 'OR']),
            filters: z.array(
              z.object({ id: z.string(), label: z.string(), label_en: z.string().nullable() }),
            ),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'FilterCatalog' });

export const campingResultSchema = z
  .object({
    rank: z.number().int(),
    availability_type: z.enum(['available', 'alternative_dates', 'alternative_capacity']),
    camping_code: z.number().int(),
    name: z.string(),
    stars: z.number().int().nullable(),
    rating: z.number().nullable(),
    city: z.string(),
    department: z.string().nullable(),
    region: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    image_url: z.string().nullable(),
    camping_url: z.string(),
    is_new: z.boolean(),
    special_offer: z.string().nullable(),
    alternative_begin_date_availability: dateStr.nullable(),
    alternative_end_date_availability: dateStr.nullable(),
    alternative_capacity: z.number().int().nullable(),
    bookingengine_link: z.string(),
  })
  .meta({ id: 'CampingResult' });

export const searchResponseSchema = z
  .object({
    status: z.enum(['OK', 'PARTIAL', 'NO_AVAILABILITY']),
    message: z.string().nullable(),
    search: z.object({
      start_date: dateStr,
      end_date: dateStr,
      nights: z.number().int(),
      people_count: z.number().int(),
      accommodation_type: z.enum(['rental', 'slot']),
      filters: z.array(z.string()),
      max_results: z.number().int(),
      camping_ids: z.array(z.number().int()),
      user_language: z.string().nullable(),
      site_base_url: z.string(),
    }),
    summary: z.object({
      available_count: z.number().int(),
      alternative_dates_count: z.number().int(),
      unavailable_count: z.number().int(),
      returned_count: z.number().int(),
    }),
    results: z.array(campingResultSchema),
    meta: z.object({
      request_id: z.string(),
      generated_at: z.string(),
      duration_ms: z.number(),
      upstream_calls: z.object({
        search_campings: z.number().int(),
        camping_availability: z.number().int(),
        catalog: z.number().int().optional(),
      }),
    }),
  })
  .meta({ id: 'SearchResponse' });

const geographyMatchSchema = z.object({
  name: z.string(),
  type: z.string().nullable(),
  content_id: z.number().int().nullable(),
  camping_count: z.number().int(),
});

export const geographyResponseSchema = z
  .object({
    status: z.literal('OK'),
    keywords: z.string(),
    user_language: z.string().nullable(),
    locale: z.string(),
    match: geographyMatchSchema,
    camping_ids: z.array(z.number().int()),
    other_matches: z.array(geographyMatchSchema),
    meta: z.object({
      request_id: z.string(),
      generated_at: z.string(),
      duration_ms: z.number(),
      upstream_calls: z.object({ search_autocomplete: z.number().int() }),
    }),
  })
  .meta({ id: 'GeographyResponse' });

export const healthSchema = z
  .object({ status: z.string(), version: z.string(), upstream: z.enum(['not_checked', 'ok', 'error']) })
  .meta({ id: 'Health' });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema: z.toJSONSchema(schema, { target: 'draft-2020-12' }) } },
});
const err = (description: string) => json(errorSchema, description);

const q = (name: string, required: boolean, description: string, schema: object = { type: 'string' }) => ({
  name,
  in: 'query',
  required,
  description,
  schema,
});

export function buildOpenApiDocument(version: string) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Camping Search API — Yelloh! Village',
      version,
      description:
        'Recherche de campings Yelloh! Village disponibles pour applications tierces. Spécification : specs/specifications.md.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
    paths: {
      '/v1/auth/session': {
        post: {
          summary: "Échange la clé d'API contre un token de session (4 h)",
          security: [{ apiKey: [] }],
          responses: {
            '201': json(sessionSchema, 'Token de session'),
            '401': err('MISSING_API_KEY, INVALID_API_KEY'),
            '429': err('RATE_LIMITED'),
          },
        },
      },
      '/v1/search/filters': {
        get: {
          summary: 'Catalogue des filtres de recherche',
          security: [{ bearer: [] }],
          parameters: [
            q('accommodation_type', true, 'rental ou slot (alias accommodationType)', {
              enum: ['rental', 'slot'],
            }),
            q(
              'user_language',
              false,
              'Langue de l’utilisateur (BCP 47), à défaut Accept-Language, puis anglais',
            ),
          ],
          responses: {
            '200': json(catalogSchema, 'Catalogue'),
            '400': err('MISSING_PARAMETER, INVALID_ACCOMMODATION_TYPE'),
            '401': err('MISSING_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED'),
            '429': err('RATE_LIMITED'),
            '502': err('UPSTREAM_ERROR'),
            '504': err('UPSTREAM_TIMEOUT'),
          },
        },
      },
      '/v1/search/campings': {
        get: {
          summary: 'Recherche : au plus N propositions de campings avec lien YellohResa',
          security: [{ bearer: [] }],
          parameters: [
            q('startDate', true, 'Date d’arrivée YYYY-MM-DD (alias start_date)', {
              type: 'string',
              format: 'date',
            }),
            q('endDate', true, 'Date de départ YYYY-MM-DD (alias end_date)', {
              type: 'string',
              format: 'date',
            }),
            q('peopleCount', true, 'Nombre de personnes (alias people_count)', {
              type: 'integer',
              minimum: 1,
            }),
            q('accommodationType', false, 'rental (défaut) ou slot (alias accommodation_type)', {
              enum: ['rental', 'slot'],
            }),
            q(
              'filters',
              false,
              'Ids du catalogue séparés par des virgules (ex. confort_type:F4:4,swimming:SR7)',
            ),
            q('maxResults', false, 'Nombre maximum de propositions (alias max_results)', {
              type: 'integer',
              minimum: 1,
            }),
            q('user_language', false, 'Langue de l’utilisateur (site de camping_url)'),
            q(
              'campingIDs',
              false,
              'Identifiants de contenu des campings (camping_ids de /v1/search/geography), séparés par des virgules (alias campingIds, camping_ids)',
            ),
          ],
          responses: {
            '200': json(searchResponseSchema, 'Propositions (status OK, PARTIAL ou NO_AVAILABILITY)'),
            '400': err(
              'MISSING_PARAMETER, INVALID_DATES, INVALID_PEOPLE_COUNT, INVALID_ACCOMMODATION_TYPE, INVALID_MAX_RESULTS, INVALID_FILTER_FORMAT, UNKNOWN_FILTER, TOO_MANY_FILTERS, INVALID_CAMPING_IDS',
            ),
            '401': err('MISSING_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED'),
            '429': err('RATE_LIMITED'),
            '502': err('UPSTREAM_ERROR'),
            '504': err('UPSTREAM_TIMEOUT'),
          },
        },
      },
      '/v1/search/geography': {
        get: {
          summary: 'Recherche géographique : mots clés d’un lieu → identifiants des campings de la zone',
          security: [{ bearer: [] }],
          parameters: [
            q('keywords', true, 'Nom du lieu, au moins 3 caractères (alias q)', {
              type: 'string',
              minLength: 3,
              maxLength: 100,
            }),
            q(
              'user_language',
              false,
              'Langue des mots clés (BCP 47), à défaut Accept-Language, puis anglais',
            ),
          ],
          responses: {
            '200': json(geographyResponseSchema, 'Lieu trouvé'),
            '400': err('MISSING_PARAMETER, INVALID_KEYWORDS'),
            '401': err('MISSING_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED'),
            '404': err('NO_RESULT (message « no result »)'),
            '429': err('RATE_LIMITED'),
            '502': err('UPSTREAM_ERROR'),
            '504': err('UPSTREAM_TIMEOUT'),
          },
        },
      },
      '/v1/health': {
        get: {
          summary: 'Supervision (?deep=true vérifie le GraphQL amont)',
          responses: { '200': json(healthSchema, 'OK'), '503': json(healthSchema, 'Amont en erreur') },
        },
      },
      '/v1/openapi.json': {
        get: { summary: 'Ce document', responses: { '200': { description: 'OpenAPI 3.1' } } },
      },
    },
  };
}

export const openapi: RouteHandler = async (ctx) => ({
  status: 200,
  body: buildOpenApiDocument(ctx.deps.config.version),
});
