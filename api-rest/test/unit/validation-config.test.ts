import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseApiClients } from '../../src/config.js';
import { ApiError } from '../../src/http/errors.js';
import { parseFiltersQuery, parseIsoDate, parseSearchQuery, todayIn } from '../../src/validation/schemas.js';
import { clientsJson, SECRET_B64 } from '../helpers/factories.js';

const limits = {
  maxPeople: 10,
  maxStayNights: 90,
  defaultMaxResults: 3,
  maxResultsLimit: 10,
  tzBusiness: 'Europe/Paris',
  now: new Date('2026-11-21T12:00:00Z'),
};
const base = { startDate: '2027-07-10', endDate: '2027-07-17', peopleCount: '4' };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return `${e.status} ${e.code}`;
    throw e;
  }
  return 'OK';
}

describe('U21 — erreurs 400 de /v1/search/campings', () => {
  it('cas nominal et valeurs par défaut', () => {
    expect(parseSearchQuery(base, limits)).toEqual({
      startDate: '2027-07-10',
      endDate: '2027-07-17',
      nights: 7,
      peopleCount: 4,
      accommodationType: 'rental',
      filters: [],
      maxResults: 3,
    });
  });
  it('alias snake_case, filtres répétés et dédoublonnés', () => {
    const q = parseSearchQuery(
      {
        start_date: '2027-07-10',
        end_date: '2027-07-12',
        people_count: '2',
        accommodation_type: 'slot',
        max_results: '4',
        filters: ['a:b, c:d', 'a:b'],
        user_language: 'de',
      },
      limits,
    );
    expect(q).toMatchObject({
      accommodationType: 'slot',
      maxResults: 4,
      filters: ['a:b', 'c:d'],
      userLanguage: 'de',
      nights: 2,
    });
  });
  it('MISSING_PARAMETER avec la liste des paramètres manquants', () => {
    try {
      parseSearchQuery({ startDate: '2027-07-10' }, limits);
    } catch (e) {
      expect(e).toMatchObject({
        code: 'MISSING_PARAMETER',
        details: { missing: ['endDate', 'peopleCount'] },
      });
    }
  });
  it('INVALID_DATES', () => {
    expect(code(() => parseSearchQuery({ ...base, startDate: '10/07/2027' }, limits))).toBe(
      '400 INVALID_DATES',
    );
    expect(code(() => parseSearchQuery({ ...base, startDate: '2027-02-30' }, limits))).toBe(
      '400 INVALID_DATES',
    );
    expect(
      code(() => parseSearchQuery({ ...base, startDate: '2026-11-20', endDate: '2026-11-25' }, limits)),
    ).toBe('400 INVALID_DATES');
    expect(code(() => parseSearchQuery({ ...base, endDate: '2027-07-10' }, limits))).toBe(
      '400 INVALID_DATES',
    );
    expect(code(() => parseSearchQuery({ ...base, endDate: '2027-10-09' }, limits))).toBe(
      '400 INVALID_DATES',
    );
    expect(code(() => parseSearchQuery({ ...base, endDate: '2027-10-08' }, limits))).toBe('OK');
    expect(
      code(() => parseSearchQuery({ ...base, startDate: '2026-11-21', endDate: '2026-11-22' }, limits)),
    ).toBe('OK');
  });
  it('INVALID_PEOPLE_COUNT', () => {
    for (const p of ['0', '11', '2.5', 'abc', '-1']) {
      expect(code(() => parseSearchQuery({ ...base, peopleCount: p }, limits))).toBe(
        '400 INVALID_PEOPLE_COUNT',
      );
    }
    expect(code(() => parseSearchQuery({ ...base, peopleCount: '10' }, limits))).toBe('OK');
  });
  it('INVALID_ACCOMMODATION_TYPE, INVALID_MAX_RESULTS, TOO_MANY_FILTERS', () => {
    expect(code(() => parseSearchQuery({ ...base, accommodationType: 'tente' }, limits))).toBe(
      '400 INVALID_ACCOMMODATION_TYPE',
    );
    expect(code(() => parseSearchQuery({ ...base, maxResults: '0' }, limits))).toBe(
      '400 INVALID_MAX_RESULTS',
    );
    expect(code(() => parseSearchQuery({ ...base, maxResults: '11' }, limits))).toBe(
      '400 INVALID_MAX_RESULTS',
    );
    const many = Array.from({ length: 31 }, (_, i) => `swimming:X${i}`).join(',');
    expect(code(() => parseSearchQuery({ ...base, filters: many }, limits))).toBe('400 TOO_MANY_FILTERS');
  });
  it('« aujourd’hui » calculé dans le fuseau métier', () => {
    expect(todayIn('Europe/Paris', new Date('2026-11-21T23:30:00Z'))).toBe('2026-11-22');
    expect(parseIsoDate('2027-13-01')).toBeNull();
  });
});

describe('U25 — /v1/search/filters', () => {
  it('accommodation_type obligatoire, alias accepté', () => {
    expect(code(() => parseFiltersQuery({}))).toBe('400 MISSING_PARAMETER');
    expect(code(() => parseFiltersQuery({ accommodation_type: 'x' }))).toBe('400 INVALID_ACCOMMODATION_TYPE');
    expect(parseFiltersQuery({ accommodationType: 'slot' })).toEqual({ accommodationType: 'slot' });
    expect(parseFiltersQuery({ accommodation_type: 'rental', user_language: 'de' })).toEqual({
      accommodationType: 'rental',
      userLanguage: 'de',
    });
  });
});

describe('configuration (§13)', () => {
  const env = { API_CLIENTS: clientsJson(), SESSION_SIGNING_SECRET: SECRET_B64 };
  it('valeurs par défaut', () => {
    const c = loadConfig(env, '9.9.9');
    expect(c).toMatchObject({
      version: '9.9.9',
      sessionTtlSeconds: 14400,
      maxPeople: 10,
      maxStayNights: 90,
      defaultMaxResults: 3,
      maxResultsLimit: 10,
      maxAvailabilityCalls: 8,
      availabilityConcurrency: 4,
      rateLimitPerMinute: 60,
      siteBaseUrlDefault: 'https://www.yellohvillage.co.uk',
      bookingEngineDefaultTrack: 'chatbot',
    });
    expect(c.gql).toMatchObject({
      locale: 'fr',
      localeDefault: 'en',
      marketSite: '1',
      bypassCache: false,
      timeoutMs: 8000,
    });
    expect(c.gql.locales.ca).toBe('es');
    expect(c.siteBaseUrls.ca).toBe('https://www.yellohvillage.es');
  });
  it('surcharges', () => {
    const c = loadConfig({
      ...env,
      SESSION_SIGNING_SECRET_PREVIOUS: Buffer.alloc(40, 2).toString('base64'),
      CORS_ALLOWED_ORIGINS: 'https://a.example, https://b.example',
      GQL_BYPASS_CACHE: 'true',
      SITE_BASE_URLS: '{"fr":"https://x.example/"}',
      MAX_PEOPLE: '12',
    });
    expect(c.signingSecrets).toHaveLength(2);
    expect(c.corsAllowedOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(c.gql.bypassCache).toBe(true);
    expect(c.siteBaseUrls).toEqual({ fr: 'https://x.example' });
    expect(c.maxPeople).toBe(12);
  });
  it('erreurs explicites', () => {
    expect(() => loadConfig({ API_CLIENTS: clientsJson() })).toThrow(/SESSION_SIGNING_SECRET/);
    expect(() => loadConfig({ ...env, SESSION_SIGNING_SECRET: 'Y291cnQ=' })).toThrow(/32 octets/);
    expect(() => loadConfig({ ...env, API_CLIENTS: '' })).toThrow(/API_CLIENTS est obligatoire/);
    expect(() => loadConfig({ ...env, API_CLIENTS: '{' })).toThrow(/tableau JSON/);
    expect(() => loadConfig({ ...env, API_CLIENTS: '[]' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, MAX_PEOPLE: 'dix' })).toThrow(/MAX_PEOPLE/);
    expect(() => loadConfig({ ...env, GQL_BYPASS_CACHE: 'oui' })).toThrow(/GQL_BYPASS_CACHE/);
    expect(() => loadConfig({ ...env, GQL_ENDPOINT: 'pas une url' })).toThrow(/GQL_ENDPOINT/);
    expect(() => loadConfig({ ...env, LOG_LEVEL: 'trace' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ ...env, TZ_BUSINESS: 'Mars/Olympus' })).toThrow(/TZ_BUSINESS/);
    expect(() => loadConfig({ ...env, SITE_BASE_URLS: '[1]' })).toThrow(/SITE_BASE_URLS/);
    expect(() => loadConfig({ ...env, GQL_LOCALES: 'x' })).toThrow(/GQL_LOCALES/);
    expect(() => loadConfig({ ...env, DEFAULT_MAX_RESULTS: '5', MAX_RESULTS_LIMIT: '4' })).toThrow(
      /DEFAULT_MAX_RESULTS/,
    );
    expect(() =>
      parseApiClients(
        JSON.stringify([{ client_id: 'A!', key_sha256: 'a'.repeat(64), track: 't', enabled: true }]),
      ),
    ).toThrow(/client_id/);
  });
});
