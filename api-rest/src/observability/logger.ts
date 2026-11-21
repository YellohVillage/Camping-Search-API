export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Noms de champs jamais journalisés (§4.4). */
const SECRET_KEYS = /^(authorization|x-api-key|api_key|apikey|access_token|token|key|secret|password)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Logger JSON, une ligne par événement, sans secrets. */
export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (l) => process.stdout.write(l + '\n'),
): Logger {
  const log = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level: lvl,
        msg,
        ...(redact(fields ?? {}) as object),
      }),
    );
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
  };
}
