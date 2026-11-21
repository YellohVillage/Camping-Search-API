import { randomUUID } from 'node:crypto';
import pkg from '../package.json' with { type: 'json' };
import { loadConfig } from './config.js';
import { createMcpHttpHandler, type McpHttpHandler } from './http/handler.js';

let handler: McpHttpHandler | undefined;

/** Handler unique par instance ; la configuration est validée au premier appel. */
export function getHandler(env: Record<string, string | undefined> = process.env): McpHttpHandler {
  if (!handler) handler = createMcpHttpHandler({ config: loadConfig(env, pkg.version) });
  return handler;
}

/** Pour les tests uniquement. */
export function resetHandler() {
  handler = undefined;
}

/**
 * Filet de sécurité : une configuration invalide ou une erreur imprévue donne une erreur 500 générique,
 * le détail ne part que dans les journaux (même principe que l'API REST).
 */
export async function handleSafely(
  getHandlerFn: () => McpHttpHandler,
  request: Request,
  info: { ip?: string } = {},
  log: (line: string) => void = (l) => process.stderr.write(l + '\n'),
): Promise<Response> {
  try {
    return await getHandlerFn()(request, info);
  } catch (err) {
    const requestId = randomUUID();
    const e = err as Error | undefined;
    log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        msg: 'erreur fatale : requête non traitée',
        request_id: requestId,
        route: new URL(request.url).pathname,
        error_name: e?.name ?? 'Error',
        error_message: e?.message ?? String(err),
      }),
    );
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Request-Id': requestId,
          'Cache-Control': 'no-store',
        },
      },
    );
  }
}
