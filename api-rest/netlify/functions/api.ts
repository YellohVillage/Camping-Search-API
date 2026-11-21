import { createNetlifyHandler } from '../../src/adapters/netlify.js';
import { getApp } from '../../src/bootstrap.js';

/**
 * Fonction Netlify unique de l'API. Netlify la regroupe (esbuild) et la sert sur /v1/*.
 * Les variables d'environnement (API_CLIENTS, SESSION_SIGNING_SECRET…) se règlent dans Netlify,
 * avec le scope « Functions ».
 */
export default createNetlifyHandler(() => getApp());

export const config = {
  path: '/v1/*',
};
