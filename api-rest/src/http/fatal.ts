import { randomUUID } from 'node:crypto';
import type { App } from '../app.js';
import type { HttpRequest, HttpResponse } from './types.js';

/**
 * Filet de sécurité des adaptateurs : si l'application ne peut pas être créée (configuration absente ou
 * invalide) ou si une erreur échappe à son propre traitement, on renvoie une erreur 500 générique.
 * Le détail (type et message) part uniquement dans les journaux de la plateforme, jamais dans la réponse :
 * sinon Netlify renverrait au client le message et la pile d'appels de l'exception.
 */
export async function handleSafely(
  getApp: () => App,
  req: HttpRequest,
  log: (line: string) => void = (l) => process.stderr.write(l + '\n'),
): Promise<HttpResponse> {
  try {
    return await getApp().handle(req);
  } catch (err) {
    const incoming = req.headers['x-request-id'];
    const requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    const e = err as Error | undefined;
    log(
      JSON.stringify({
        time: new Date().toISOString(),
        level: 'error',
        msg: 'erreur fatale : requête non traitée',
        request_id: requestId,
        route: req.path,
        error_name: e?.name ?? 'Error',
        error_message: e?.message ?? String(err),
      }),
    );
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-Id': requestId,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Strict-Transport-Security': 'max-age=31536000',
      },
      body: JSON.stringify({
        error: { code: 'INTERNAL_ERROR', message: 'Erreur interne.', request_id: requestId },
      }),
    };
  }
}
