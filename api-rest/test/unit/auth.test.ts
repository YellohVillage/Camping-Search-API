import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  clientRateLimit,
  findClientByApiKey,
  generateApiKey,
  isClientActive,
  sha256Hex,
} from '../../src/auth/apiKeys.js';
import { RateLimiter } from '../../src/auth/rateLimit.js';
import { issueToken, verifyBearer } from '../../src/auth/session.js';
import { ConfigError, parseApiClients, type ApiClient } from '../../src/config.js';
import { ApiError } from '../../src/http/errors.js';
import { API_KEY, API_KEY_PARTNER, clientsJson } from '../helpers/factories.js';

const clients = parseApiClients(clientsJson());
const secret = new Uint8Array(Buffer.alloc(32, 7));
const other = new Uint8Array(Buffer.alloc(32, 9));
const settings = { secrets: [secret], ttlSeconds: 14400, issuer: 'camping-search-api' };
const t0 = new Date('2026-11-21T12:00:00Z');

async function expectApiError(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await expect(p).rejects.toMatchObject({ code, status: 401 });
}

describe('U20 — apiKeys', () => {
  it('bonne clé acceptée, mauvaise refusée, client désactivé refusé', () => {
    expect(findClientByApiKey(API_KEY, clients)?.client_id).toBe('chatbot-yv');
    expect(findClientByApiKey(API_KEY_PARTNER, clients)?.client_id).toBe('partner-x');
    expect(findClientByApiKey('ysk_live_mauvaise', clients)).toBeUndefined();
    const disabled = clients.map((c) => ({ ...c, enabled: false }));
    expect(findClientByApiKey(API_KEY, disabled)).toBeUndefined();
  });

  it('rotation : deux entrées actives pour un même client', () => {
    const newKey = generateApiKey();
    const rotated: ApiClient[] = [
      ...clients,
      { client_id: 'chatbot-yv', key_sha256: sha256Hex(newKey), track: 'chatbot', enabled: true },
    ];
    expect(findClientByApiKey(newKey, rotated)?.client_id).toBe('chatbot-yv');
    expect(findClientByApiKey(API_KEY, rotated)?.client_id).toBe('chatbot-yv');
  });

  it('format de clé générée : ysk_live_ + 40 caractères base62', () => {
    expect(generateApiKey()).toMatch(/^ysk_live_[0-9A-Za-z]{40}$/);
    expect(generateApiKey()).not.toBe(generateApiKey());
  });

  it('isClientActive', () => {
    expect(isClientActive('chatbot-yv', clients)).toBe(true);
    expect(isClientActive('inconnu', clients)).toBe(false);
  });
});

describe('U19, U26 — session (JWT)', () => {
  it('U19 : token valide accepté, claims et durée', async () => {
    const { token, expiresAt } = await issueToken(clients[0]!, settings, t0);
    expect(expiresAt.getTime() - t0.getTime()).toBe(14400 * 1000);
    const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
    expect(payload).toMatchObject({
      sub: 'chatbot-yv',
      trk: 'chatbot',
      iss: 'camping-search-api',
      aud: 'camping-search-api',
    });
    expect(payload.exp - payload.iat).toBe(14400);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    await expect(verifyBearer(`Bearer ${token}`, settings, clients, t0)).resolves.toEqual({
      clientId: 'chatbot-yv',
      track: 'chatbot',
    });
  });

  it('U19 : expiré → TOKEN_EXPIRED (4 h + 1 s, au-delà de la tolérance de 30 s)', async () => {
    const { token } = await issueToken(clients[0]!, settings, t0);
    const okLate = new Date(t0.getTime() + (14400 + 20) * 1000);
    await expect(verifyBearer(`Bearer ${token}`, settings, clients, okLate)).resolves.toBeTruthy();
    const late = new Date(t0.getTime() + (14400 + 31) * 1000);
    await expectApiError(verifyBearer(`Bearer ${token}`, settings, clients, late), 'TOKEN_EXPIRED');
  });

  it('U19 : mauvaise signature, en-tête mal formé, absent', async () => {
    const { token } = await issueToken(clients[0]!, { ...settings, secrets: [other] }, t0);
    await expectApiError(verifyBearer(`Bearer ${token}`, settings, clients, t0), 'INVALID_TOKEN');
    await expectApiError(verifyBearer('Basic abc', settings, clients, t0), 'INVALID_TOKEN');
    await expectApiError(verifyBearer('Bearer pas.un.jwt', settings, clients, t0), 'INVALID_TOKEN');
    await expectApiError(verifyBearer(undefined, settings, clients, t0), 'MISSING_TOKEN');
  });

  it('rotation du secret : un token signé avec l’ancien secret reste valide', async () => {
    const { token } = await issueToken(clients[0]!, { ...settings, secrets: [other] }, t0);
    await expect(
      verifyBearer(`Bearer ${token}`, { ...settings, secrets: [secret, other] }, clients, t0),
    ).resolves.toBeTruthy();
  });

  it('mauvais émetteur ou algorithme refusé', async () => {
    const forged = await new SignJWT({ trk: 'x' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('autre')
      .setAudience('camping-search-api')
      .setSubject('chatbot-yv')
      .setIssuedAt(Math.floor(t0.getTime() / 1000))
      .setNotBefore(Math.floor(t0.getTime() / 1000))
      .setExpirationTime(Math.floor(t0.getTime() / 1000) + 60)
      .sign(secret);
    await expectApiError(verifyBearer(`Bearer ${forged}`, settings, clients, t0), 'INVALID_TOKEN');
  });

  it('U26 : client désactivé ou retiré → le même token est refusé', async () => {
    const { token } = await issueToken(clients[0]!, settings, t0);
    const disabled = clients.map((c) => (c.client_id === 'chatbot-yv' ? { ...c, enabled: false } : c));
    await expectApiError(verifyBearer(`Bearer ${token}`, settings, disabled, t0), 'INVALID_TOKEN');
    const removed = clients.filter((c) => c.client_id !== 'chatbot-yv');
    await expectApiError(verifyBearer(`Bearer ${token}`, settings, removed, t0), 'INVALID_TOKEN');
  });
});

describe('U29 — rateLimit', () => {
  it('client à 2/min : 3e requête refusée avec Retry-After ; compteurs indépendants', () => {
    const rl = new RateLimiter();
    const now = 1_000_000;
    const limit = clientRateLimit('partner-x', clients, 60);
    expect(limit).toBe(2);
    expect(rl.check('partner-x', limit, now)).toMatchObject({ allowed: true, remaining: 1 });
    expect(rl.check('partner-x', limit, now + 1)).toMatchObject({ allowed: true, remaining: 0 });
    const refused = rl.check('partner-x', limit, now + 2);
    expect(refused).toMatchObject({ allowed: false, remaining: 0 });
    expect(refused.retryAfter).toBeGreaterThanOrEqual(1);
    expect(rl.check('chatbot-yv', 60, now + 3).allowed).toBe(true);
    expect(rl.check('partner-x', limit, now + 60_001).allowed).toBe(true);
  });

  it('client sans champ : limite globale 60 → 61e refusée', () => {
    const rl = new RateLimiter();
    const limit = clientRateLimit('chatbot-yv', clients, 60);
    expect(limit).toBe(60);
    for (let i = 0; i < 60; i++) expect(rl.check('c', limit, 5000 + i).allowed).toBe(true);
    expect(rl.check('c', limit, 5100).allowed).toBe(false);
  });

  it('plusieurs entrées d’un même client : la limite la plus élevée s’applique', () => {
    const list: ApiClient[] = [
      { client_id: 'a-b', key_sha256: 'a'.repeat(64), track: 't', enabled: true, rate_limit_per_minute: 5 },
      { client_id: 'a-b', key_sha256: 'b'.repeat(64), track: 't', enabled: true, rate_limit_per_minute: 9 },
    ];
    expect(clientRateLimit('a-b', list, 60)).toBe(9);
  });

  it('rate_limit_per_minute: 0 → erreur de configuration', () => {
    const bad = JSON.stringify([
      { client_id: 'abc', key_sha256: 'a'.repeat(64), track: 't', enabled: true, rate_limit_per_minute: 0 },
    ]);
    expect(() => parseApiClients(bad)).toThrow(ConfigError);
  });

  it('nettoyage des clés inactives au-delà de 10 000 entrées', () => {
    const rl = new RateLimiter();
    for (let i = 0; i < 10_001; i++) rl.check(`k${i}`, 5, 0);
    expect(rl.check('nouvelle', 5, 120_000).allowed).toBe(true);
  });
});
