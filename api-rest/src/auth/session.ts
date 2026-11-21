import { randomUUID } from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import type { ApiClient } from '../config.js';
import { unauthorized } from '../http/errors.js';
import { isClientActive } from './apiKeys.js';

/** Token de session JWT HS256 (§4.3), sans état serveur. */

export interface SessionClaims {
  clientId: string;
  track: string;
}

export interface SessionSettings {
  /** Le premier secret signe ; tous sont acceptés en vérification (rotation). */
  secrets: Uint8Array[];
  ttlSeconds: number;
  issuer: string;
}

const CLOCK_TOLERANCE_S = 30;

export async function issueToken(
  client: ApiClient,
  s: SessionSettings,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + s.ttlSeconds;
  const token = await new SignJWT({ trk: client.track })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(s.issuer)
    .setAudience(s.issuer)
    .setSubject(client.client_id)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(exp)
    .setJti(randomUUID())
    .sign(s.secrets[0] as Uint8Array);
  return { token, expiresAt: new Date(exp * 1000) };
}

/** Vérifie l'en-tête Authorization et renvoie les informations du client, ou lève une ApiError 401. */
export async function verifyBearer(
  authorization: string | undefined,
  s: SessionSettings,
  clients: readonly ApiClient[],
  now: Date,
): Promise<SessionClaims> {
  if (!authorization) throw unauthorized('MISSING_TOKEN', 'En-tête Authorization: Bearer <token> manquant.');
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) throw unauthorized('INVALID_TOKEN', 'Token de session invalide.');
  const token = m[1] as string;

  let expired = false;
  for (const secret of s.secrets) {
    try {
      const { payload } = await jwtVerify(token, secret, {
        algorithms: ['HS256'],
        issuer: s.issuer,
        audience: s.issuer,
        clockTolerance: CLOCK_TOLERANCE_S,
        currentDate: now,
        requiredClaims: ['sub', 'exp', 'iat', 'nbf'],
      });
      const clientId = payload.sub as string;
      if (!isClientActive(clientId, clients)) {
        throw unauthorized('INVALID_TOKEN', 'Token de session invalide.');
      }
      return { clientId, track: typeof payload.trk === 'string' ? payload.trk : '' };
    } catch (err) {
      if (err instanceof joseErrors.JWTExpired) expired = true;
      else if (!(err instanceof joseErrors.JOSEError)) throw err;
    }
  }
  if (expired) throw unauthorized('TOKEN_EXPIRED', 'Le token de session a expiré.');
  throw unauthorized('INVALID_TOKEN', 'Token de session invalide.');
}
