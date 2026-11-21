/** Configuration du serveur MCP (§11.2), validée au démarrage. */

export type Endpoint = 'claude' | 'chatgpt' | 'generic';

export interface McpConfig {
  version: string;
  restApiBaseUrl: string;
  /** Clé d'API REST par point d'entrée (§9.2). `generic` absent → route /mcp en 404. */
  apiKeys: Partial<Record<Endpoint, string>>;
  restApiTimeoutMs: number;
  catalogTtlSeconds: number;
  tokenRenewBeforeSeconds: number;
  maxResultsLimit: number;
  rateLimitPerMinute: number;
  allowedOrigins: string[];
  maxBodyBytes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`Configuration invalide : ${message}`);
    this.name = 'ConfigError';
  }
}

function int(env: Record<string, string | undefined>, name: string, def: number, min = 1, max = Infinity) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} doit être un entier entre ${min} et ${max}`);
  }
  return n;
}

const KEY_RE = /^ysk_live_[0-9A-Za-z]{40}$/;

function key(env: Record<string, string | undefined>, name: string, required: boolean): string | undefined {
  const v = env[name];
  if (!v) {
    if (required) throw new ConfigError(`${name} est obligatoire`);
    return undefined;
  }
  // Le message ne reprend jamais la valeur de la clé.
  if (!KEY_RE.test(v)) throw new ConfigError(`${name} n'a pas le format d'une clé d'API (ysk_live_…)`);
  return v;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  version = '0.1.0',
): McpConfig {
  const base = env.REST_API_BASE_URL;
  if (!base) throw new ConfigError('REST_API_BASE_URL est obligatoire');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError('REST_API_BASE_URL doit être une URL valide');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new ConfigError('REST_API_BASE_URL doit être en HTTPS');
  }

  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new ConfigError('LOG_LEVEL doit valoir debug, info, warn ou error');
  }

  const apiKeys: Partial<Record<Endpoint, string>> = {
    claude: key(env, 'REST_API_KEY_CLAUDE', true),
    chatgpt: key(env, 'REST_API_KEY_CHATGPT', true),
  };
  const generic = key(env, 'REST_API_KEY_DEFAULT', false);
  if (generic) apiKeys.generic = generic;

  return {
    version,
    restApiBaseUrl: base.replace(/\/+$/, ''),
    apiKeys,
    restApiTimeoutMs: int(env, 'REST_API_TIMEOUT_MS', 12000, 100),
    catalogTtlSeconds: int(env, 'CATALOG_TTL_SECONDS', 86400, 1),
    tokenRenewBeforeSeconds: int(env, 'TOKEN_RENEW_BEFORE_SECONDS', 300, 0),
    maxResultsLimit: int(env, 'MCP_MAX_RESULTS_LIMIT', 5, 1, 10),
    rateLimitPerMinute: int(env, 'MCP_RATE_LIMIT_PER_MINUTE', 30, 1),
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxBodyBytes: 64 * 1024,
    logLevel: logLevel as McpConfig['logLevel'],
  };
}
