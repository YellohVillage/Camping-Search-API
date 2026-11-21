import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../src/auth/apiKeys.js';
import { loadConfig, type Config } from '../../src/config.js';
import type { ResolvedFilter } from '../../src/domain/filterResolver.js';
import type { Logger } from '../../src/observability/logger.js';
import type {
  GqlCamping,
  GqlCampingAvailability,
  GqlFilterCategory,
  GqlSearchCampings,
} from '../../src/upstream/types.js';

export const API_KEY = 'ysk_live_TestKeyChatbot0000000000000000000000';
export const API_KEY_PARTNER = 'ysk_live_TestKeyPartner0000000000000000000000';
export const SECRET_B64 = Buffer.alloc(32, 7).toString('base64');

export const clientsJson = (overrides: object[] = []) =>
  JSON.stringify([
    { client_id: 'chatbot-yv', key_sha256: sha256Hex(API_KEY), track: 'chatbot', enabled: true },
    {
      client_id: 'partner-x',
      key_sha256: sha256Hex(API_KEY_PARTNER),
      track: 'partnerx',
      enabled: true,
      rate_limit_per_minute: 2,
    },
    ...overrides,
  ]);

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ API_CLIENTS: clientsJson(), SESSION_SIGNING_SECRET: SECRET_B64, ...env }, '1.0.0-test');
}

export const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;

export const catalogRental = () => fixture<GqlFilterCategory[]>('catalog-rental.json');
export const catalogSlot = () => fixture<GqlFilterCategory[]>('catalog-slot.json');

export function camping(code: number, over: Partial<GqlCamping> = {}): GqlCamping {
  return {
    campingCode: code,
    contentId: code * 10,
    name: `Camping ${code}`,
    starCount: 4,
    city: ` Ville ${code} `,
    department: 'Dept',
    region: 'Region',
    campingUrl: `/camping/camping_${code}`,
    image: `https://img.example/${code}.jpg`,
    note: 85.25,
    isNew: false,
    availabilityStatus: 'available',
    allFilters: [],
    coordinates: { latitude: 45, longitude: 2 },
    specialOffer: null,
    filterCategories: [],
    accommodations: [
      {
        code: code * 100,
        accommodationType: 'rental',
        filters: [],
        technicalInfos: { capacity: { value: '4' } },
      },
    ],
    ...over,
  };
}

export function rf(
  id: string,
  over: Partial<ResolvedFilter> & Pick<ResolvedFilter, 'level' | 'operator'>,
): ResolvedFilter {
  const [categoryId, code, webcampId] = id.split(':');
  return { id, categoryId: categoryId!, code: code!, webcampId: webcampId ?? code!, key: code!, ...over };
}

export const availability = (
  statusCode: string | null,
  over: Partial<GqlCampingAvailability> = {},
): GqlCampingAvailability => ({
  statusCode,
  accommodationId: statusCode && ['flex', 'flexCapacity', 'available'].includes(statusCode) ? 1 : null,
  info:
    statusCode && ['flex', 'flexCapacity', 'available'].includes(statusCode)
      ? { arrivalDate: '2027-07-07T00:00:00.000Z', departureDate: '2027-07-14T00:00:00.000Z' }
      : null,
  ...over,
});

export function memoryLogger(): Logger & {
  lines: { level: string; msg: string; fields?: Record<string, unknown> }[];
} {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const mk = (level: string) => (msg: string, fields?: Record<string, unknown>) =>
    lines.push({ level, msg, fields });
  return { lines, debug: mk('debug'), info: mk('info'), warn: mk('warn'), error: mk('error') };
}

export const searchData = (
  campings: GqlCamping[],
  filterCategories = catalogRental(),
): GqlSearchCampings => ({
  campings,
  filterCategories,
});
