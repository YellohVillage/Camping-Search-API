import { randomUUID } from 'node:crypto';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Endpoint, McpConfig } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { CatalogCache } from '../rest/catalogCache.js';
import { RestClient, type FetchFn } from '../rest/restClient.js';
import { createMcpServer } from '../server.js';
import { contentLengthTooLarge, IpRateLimiter, originAllowed } from './guards.js';

/**
 * Point d'entrée HTTP du serveur MCP (§11.3) : Streamable HTTP en mode sans état
 * (un McpServer + un transport par requête, réponses JSON, pas de session).
 * Routes : POST /mcp/claude, /mcp/chatgpt, /mcp (si REST_API_KEY_DEFAULT) ; GET /health.
 */
export interface HandlerOptions {
  config: McpConfig;
  fetchImpl?: FetchFn;
  logger?: Logger;
  now?: () => number;
}

export type McpHttpHandler = (request: Request, info?: { ip?: string }) => Promise<Response>;

const ROUTES: Record<string, Endpoint> = {
  '/mcp/claude': 'claude',
  '/mcp/chatgpt': 'chatgpt',
  '/mcp': 'generic',
};

export function createMcpHttpHandler(opts: HandlerOptions): McpHttpHandler {
  const { config } = opts;
  const logger = opts.logger ?? createLogger(config.logLevel);
  const now = opts.now ?? (() => Date.now());
  const cache = new CatalogCache(config.catalogTtlSeconds, now);
  const limiter = new IpRateLimiter(config.rateLimitPerMinute);
  // Un client REST (donc un token) par point d'entrée, gardé en mémoire d'instance (§9.2).
  const clients = new Map<Endpoint, RestClient>();
  for (const [endpoint, apiKey] of Object.entries(config.apiKeys) as [Endpoint, string | undefined][]) {
    if (!apiKey) continue;
    clients.set(
      endpoint,
      new RestClient({
        baseUrl: config.restApiBaseUrl,
        apiKey,
        timeoutMs: config.restApiTimeoutMs,
        tokenRenewBeforeSeconds: config.tokenRenewBeforeSeconds,
        fetchImpl: opts.fetchImpl,
        userAgent: `yelloh-camping-search-mcp/${config.version}`,
      }),
    );
  }

  return async (request, info = {}) => {
    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const incomingId = request.headers.get('x-request-id');
    const requestId = incomingId && /^[A-Za-z0-9._:-]{1,128}$/.test(incomingId) ? incomingId : randomUUID();
    const origin = request.headers.get('origin');
    const headers: Record<string, string> = {
      'X-Request-Id': requestId,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000',
    };
    if (origin && config.allowedOrigins.includes(origin)) {
      Object.assign(headers, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    }
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers, ...extra },
      });
    const rpcError = (status: number, code: number, message: string, extra: Record<string, string> = {}) =>
      json(status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra);

    if (path === '/health' && request.method === 'GET') {
      return json(200, { status: 'ok', name: 'yelloh-camping-search', version: config.version });
    }
    const endpoint = ROUTES[path];
    const rest = endpoint ? clients.get(endpoint) : undefined;
    if (!endpoint || !rest) return json(404, { error: 'Not found' });

    if (!originAllowed(origin, config.allowedOrigins)) return rpcError(403, -32000, 'Forbidden origin');
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...headers,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Protocol-Version, X-Request-Id',
          'Access-Control-Max-Age': '600',
        },
      });
    }
    // Pas de flux SSE serveur → client ni de session : seul POST est accepté (§11.3).
    if (request.method !== 'POST') {
      return rpcError(405, -32000, 'Method not allowed: use POST (stateless server).', {
        Allow: 'POST, OPTIONS',
      });
    }

    const ip = info.ip ?? request.headers.get('x-nf-client-connection-ip') ?? 'unknown';
    const rate = limiter.check(ip, now());
    if (!rate.allowed) {
      return rpcError(429, -32000, `Too many requests, retry in ${rate.retryAfter} seconds.`, {
        'Retry-After': String(rate.retryAfter),
      });
    }

    if (contentLengthTooLarge(request.headers.get('content-length'), config.maxBodyBytes)) {
      return rpcError(413, -32000, 'Request body too large');
    }
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > config.maxBodyBytes)
      return rpcError(413, -32000, 'Request body too large');
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(text);
    } catch {
      return rpcError(400, -32700, 'Parse error');
    }

    const server = createMcpServer({ config, endpoint, requestId, rest, cache, logger });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(request, { parsedBody });
      const out = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) out.set(k, v);
      return new Response(res.body ? await res.text() : null, { status: res.status, headers: out });
    } catch (err) {
      logger.error('mcp: erreur interne', {
        request_id: requestId,
        endpoint,
        error: (err as Error)?.message,
      });
      return rpcError(500, -32603, 'Internal error');
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}
