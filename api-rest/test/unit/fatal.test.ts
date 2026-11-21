import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLambdaHandler } from '../../src/adapters/lambda.js';
import { createNetlifyHandler } from '../../src/adapters/netlify.js';
import type { App } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createApp } from '../../src/app.js';
import { handleSafely } from '../../src/http/fatal.js';

/** Application dont la création échoue comme en production sans variables d'environnement. */
const failingGetApp = (): App => createApp({ config: loadConfig({}) });

const SENSITIVE = ['ConfigError', 'SESSION_SIGNING_SECRET', 'trace', 'stack', 'Configuration invalide'];

afterEach(() => vi.restoreAllMocks());

describe('erreur fatale : aucune fuite de détail vers le client', () => {
  it('handleSafely : 500 générique, détail uniquement dans les journaux', async () => {
    const lines: string[] = [];
    const res = await handleSafely(
      failingGetApp,
      { method: 'GET', path: '/v1/health', query: {}, headers: { 'x-request-id': 'req-42' } },
      (l) => lines.push(l),
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Erreur interne.', request_id: 'req-42' },
    });
    for (const word of SENSITIVE) expect(res.body).not.toContain(word);
    expect(res.headers).toMatchObject({
      'X-Request-Id': 'req-42',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    expect(lines).toHaveLength(1);
    const log = JSON.parse(lines[0]!);
    expect(log).toMatchObject({
      level: 'error',
      request_id: 'req-42',
      route: '/v1/health',
      error_name: 'ConfigError',
    });
    expect(log.error_message).toContain('SESSION_SIGNING_SECRET est obligatoire');
  });

  it('identifiant de requête invalide remplacé ; erreur non Error gérée', async () => {
    const lines: string[] = [];
    const res = await handleSafely(
      () => {
        throw 'boom';
      },
      { method: 'GET', path: '/v1/x', query: {}, headers: { 'x-request-id': 'mauvais id !' } },
      (l) => lines.push(l),
    );
    expect(res.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(lines[0]!).error_message).toBe('boom');
  });

  it('erreur levée pendant le traitement (hors création) : même protection', async () => {
    const app: App = { handle: () => Promise.reject(new Error('détail interne')) };
    const res = await handleSafely(
      () => app,
      { method: 'GET', path: '/v1/x', query: {}, headers: {} },
      () => undefined,
    );
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('détail interne');
  });

  it('Netlify sans configuration : 500 générique au lieu du message et de la pile', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const res = await createNetlifyHandler(failingGetApp)(new Request('https://h.example/v1/health'));
    expect(res.status).toBe(500);
    const body = await res.text();
    for (const word of SENSITIVE) expect(body).not.toContain(word);
    expect(JSON.parse(body).error.code).toBe('INTERNAL_ERROR');
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(String(stderr.mock.calls[0]?.[0])).toContain('ConfigError');
  });

  it('Lambda sans configuration : même comportement', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = await createLambdaHandler(failingGetApp)({
      httpMethod: 'GET',
      path: '/v1/health',
      headers: {},
      body: null,
    } as never);
    expect(out.statusCode).toBe(500);
    for (const word of SENSITIVE) expect(out.body).not.toContain(word);
  });
});
