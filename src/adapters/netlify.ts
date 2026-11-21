import type { App } from '../app.js';
import { normalizeHeaders, queryFromSearchParams, type HttpRequest } from '../http/types.js';

/**
 * Adaptateur Netlify Functions (format courant : Request Web → Response Web).
 * Le chemin est relu dans l'URL ; si la requête arrive par le préfixe interne
 * /.netlify/functions/api, il est retiré et /v1 est rétabli au besoin.
 */
export const NETLIFY_PREFIX = '/.netlify/functions/api';

export function toHttpRequest(request: Request, body: string | undefined): HttpRequest {
  const url = new URL(request.url);
  let path = url.pathname;
  if (path.startsWith(NETLIFY_PREFIX)) {
    path = path.slice(NETLIFY_PREFIX.length) || '/';
    if (!path.startsWith('/v1')) path = `/v1${path === '/' ? '' : path}`;
  }
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return {
    method: request.method,
    path,
    query: queryFromSearchParams(url.searchParams),
    headers: normalizeHeaders(headers),
    ...(body ? { body } : {}),
  };
}

export function createNetlifyHandler(getApp: () => App) {
  return async (request: Request): Promise<Response> => {
    const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text();
    const res = await getApp().handle(toHttpRequest(request, body));
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: res.headers,
    });
  };
}
