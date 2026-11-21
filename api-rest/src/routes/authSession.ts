import { findClientByApiKey, sha256Hex } from '../auth/apiKeys.js';
import type { RateLimiter } from '../auth/rateLimit.js';
import { issueToken } from '../auth/session.js';
import { ApiError, unauthorized } from '../http/errors.js';
import type { RouteHandler } from '../http/context.js';

/** POST /v1/auth/session (§5) : échange la clé d'API contre un token de session. */
export const authSession =
  (sessionLimiter: RateLimiter): RouteHandler =>
  async (ctx) => {
    const apiKey = ctx.req.headers['x-api-key'];
    if (!apiKey) throw unauthorized('MISSING_API_KEY', 'En-tête X-API-Key manquant.');

    // Au plus N demandes de token par minute pour une même clé (identifiée par son empreinte).
    const decision = ctx.deps.config.sessionRateLimitPerMinute;
    const rate = sessionLimiter.check(`session:${sha256Hex(apiKey)}`, decision, ctx.now.getTime());
    if (!rate.allowed) {
      throw new ApiError(429, 'RATE_LIMITED', 'Trop de demandes de token, réessayez plus tard.', undefined, {
        'Retry-After': String(rate.retryAfter),
      });
    }

    const security = await ctx.deps.security();
    const client = findClientByApiKey(apiKey, security.clients);
    if (!client) throw unauthorized('INVALID_API_KEY', 'Clé d’API invalide.');

    const { config } = ctx.deps;
    const { token, expiresAt } = await issueToken(
      client,
      { secrets: security.secrets, ttlSeconds: config.sessionTtlSeconds, issuer: config.sessionIssuer },
      ctx.now,
    );
    ctx.logFields.client_id = client.client_id;
    return {
      status: 201,
      body: {
        access_token: token,
        token_type: 'Bearer',
        expires_in: config.sessionTtlSeconds,
        expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        client_id: client.client_id,
      },
    };
  };
