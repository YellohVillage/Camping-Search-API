import { z } from 'zod';

/** Entrée de la variable API_CLIENTS (§4.2). */
export interface ApiClient {
  client_id: string;
  key_sha256: string;
  track: string;
  enabled: boolean;
  rate_limit_per_minute?: number;
}

export interface GqlConfig {
  endpoint: string;
  origin: string;
  marketSite: string;
  /** gql-locale des appels de recherche (§10.3). */
  locale: string;
  /** Table langue → gql-locale des appels de catalogue (§10.3). */
  locales: Record<string, string>;
  localeDefault: string;
  bypassCache: boolean;
  timeoutMs: number;
  userAgent: string;
}

export interface Config {
  version: string;
  apiClients: ApiClient[];
  /** Secrets de signature : le premier sert à signer, tous servent à vérifier. */
  signingSecrets: Uint8Array[];
  sessionTtlSeconds: number;
  sessionIssuer: string;
  gql: GqlConfig;
  siteBaseUrls: Record<string, string>;
  siteBaseUrlDefault: string;
  bookingEngineUrl: string;
  bookingEngineDefaultTrack: string;
  defaultMaxResults: number;
  maxResultsLimit: number;
  maxAvailabilityCalls: number;
  availabilityConcurrency: number;
  maxPeople: number;
  maxStayNights: number;
  rateLimitPerMinute: number;
  sessionRateLimitPerMinute: number;
  corsAllowedOrigins: string[];
  allowDebugSeed: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  tzBusiness: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuration invalide : ${message}`);
    this.name = 'ConfigError';
  }
}

const DEFAULT_SITE_BASE_URLS: Record<string, string> = {
  fr: 'https://www.yellohvillage.fr',
  en: 'https://www.yellohvillage.co.uk',
  de: 'https://www.yellohvillage.de',
  es: 'https://www.yellohvillage.es',
  ca: 'https://www.yellohvillage.es',
  nl: 'https://www.yellohvillage.nl',
  it: 'https://www.yellohvillage.it',
};

const DEFAULT_GQL_LOCALES: Record<string, string> = {
  fr: 'fr',
  en: 'en',
  de: 'de',
  es: 'es',
  ca: 'es',
  nl: 'nl',
  it: 'it',
};

export const apiClientSchema = z.object({
  client_id: z.string().regex(/^[a-z0-9-]{3,40}$/, 'client_id doit respecter [a-z0-9-]{3,40}'),
  key_sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'key_sha256 doit être une empreinte SHA-256 hexadécimale (64 caractères)')
    .transform((v) => v.toLowerCase()),
  track: z.string().min(1, 'track est obligatoire'),
  enabled: z.boolean(),
  rate_limit_per_minute: z.number().int('rate_limit_per_minute doit être un entier').min(1).optional(),
});

/** Valide le contenu JSON de API_CLIENTS. Lève ConfigError avec un message explicite. */
export function parseApiClients(raw: string | undefined): ApiClient[] {
  if (!raw || raw.trim() === '') throw new ConfigError('API_CLIENTS est obligatoire');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError('API_CLIENTS doit être un tableau JSON valide');
  }
  const parsed = z
    .array(apiClientSchema)
    .min(1, 'API_CLIENTS doit contenir au moins un client')
    .safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`API_CLIENTS : ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim());
  }
  return parsed.data;
}

/** Décode un secret base64 et vérifie qu'il fait au moins 32 octets. */
export function parseSigningSecret(name: string, raw: string): Uint8Array {
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 32) throw new ConfigError(`${name} doit faire au moins 32 octets (encodés en base64)`);
  return new Uint8Array(buf);
}

function int(env: Record<string, string | undefined>, name: string, def: number, min = 1): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${name} doit être un entier ≥ ${min}`);
  return n;
}

function bool(env: Record<string, string | undefined>, name: string, def: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new ConfigError(`${name} doit valoir true ou false`);
}

function url(env: Record<string, string | undefined>, name: string, def: string): string {
  const raw = env[name] ?? def;
  try {
    new URL(raw);
  } catch {
    throw new ConfigError(`${name} doit être une URL valide`);
  }
  return raw.replace(/\/$/, '');
}

function stringMap(env: Record<string, string | undefined>, name: string, def: Record<string, string>) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ConfigError(`${name} doit être un objet JSON`);
  }
  const parsed = z.record(z.string().regex(/^[a-z]{2,3}$/), z.string().min(1)).safeParse(json);
  if (!parsed.success) throw new ConfigError(`${name} doit être un objet JSON { "code langue": "valeur" }`);
  return parsed.data;
}

export function loadConfig(env: Record<string, string | undefined> = process.env, version = '1.0.0'): Config {
  const secret = env.SESSION_SIGNING_SECRET;
  if (!secret) throw new ConfigError('SESSION_SIGNING_SECRET est obligatoire');
  const signingSecrets = [parseSigningSecret('SESSION_SIGNING_SECRET', secret)];
  if (env.SESSION_SIGNING_SECRET_PREVIOUS) {
    signingSecrets.push(
      parseSigningSecret('SESSION_SIGNING_SECRET_PREVIOUS', env.SESSION_SIGNING_SECRET_PREVIOUS),
    );
  }

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError('LOG_LEVEL doit valoir debug, info, warn ou error');
  }
  const tzBusiness = env.TZ_BUSINESS ?? 'Europe/Paris';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tzBusiness });
  } catch {
    throw new ConfigError('TZ_BUSINESS doit être un fuseau IANA valide');
  }

  const siteBaseUrls = stringMap(env, 'SITE_BASE_URLS', DEFAULT_SITE_BASE_URLS);
  for (const [k, v] of Object.entries(siteBaseUrls)) siteBaseUrls[k] = v.replace(/\/$/, '');

  const defaultMaxResults = int(env, 'DEFAULT_MAX_RESULTS', 3);
  const maxResultsLimit = int(env, 'MAX_RESULTS_LIMIT', 10);
  if (defaultMaxResults > maxResultsLimit) {
    throw new ConfigError('DEFAULT_MAX_RESULTS doit être ≤ MAX_RESULTS_LIMIT');
  }

  return {
    version,
    apiClients: parseApiClients(env.API_CLIENTS),
    signingSecrets,
    sessionTtlSeconds: int(env, 'SESSION_TTL_SECONDS', 14400, 60),
    sessionIssuer: env.SESSION_ISSUER ?? 'camping-search-api',
    gql: {
      endpoint: url(env, 'GQL_ENDPOINT', 'https://api.sitemarket.prod.yellohvillage.fr/graphql'),
      origin: url(env, 'GQL_ORIGIN', 'https://www.yellohvillage.fr'),
      marketSite: env.GQL_MARKET_SITE ?? '1',
      locale: env.GQL_LOCALE ?? 'fr',
      locales: stringMap(env, 'GQL_LOCALES', DEFAULT_GQL_LOCALES),
      localeDefault: env.GQL_LOCALE_DEFAULT ?? 'en',
      bypassCache: bool(env, 'GQL_BYPASS_CACHE', false),
      timeoutMs: int(env, 'GQL_TIMEOUT_MS', 8000, 100),
      userAgent: `camping-search-api/${version}`,
    },
    siteBaseUrls,
    siteBaseUrlDefault: url(env, 'SITE_BASE_URL_DEFAULT', 'https://www.yellohvillage.co.uk'),
    bookingEngineUrl: url(env, 'BOOKING_ENGINE_URL', 'https://booking.yellohvillage.com/multi-list.php'),
    bookingEngineDefaultTrack: env.BOOKING_ENGINE_DEFAULT_TRACK ?? 'chatbot',
    defaultMaxResults,
    maxResultsLimit,
    maxAvailabilityCalls: int(env, 'MAX_AVAILABILITY_CALLS', 8),
    availabilityConcurrency: int(env, 'AVAILABILITY_CONCURRENCY', 4),
    maxPeople: int(env, 'MAX_PEOPLE', 10),
    maxStayNights: int(env, 'MAX_STAY_NIGHTS', 90),
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', 60),
    sessionRateLimitPerMinute: 10,
    corsAllowedOrigins: (env.CORS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    allowDebugSeed: bool(env, 'ALLOW_DEBUG_SEED', false),
    logLevel: logLevel as Config['logLevel'],
    tzBusiness,
  };
}
