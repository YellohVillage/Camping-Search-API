import { createNetlifyHandler } from '../../api-rest/src/adapters/netlify.js';
import { getApp } from '../../api-rest/src/bootstrap.js';

/**
 * Fonction Netlify de l'API REST (code dans api-rest/), servie sur /v1/*.
 * Variables (scope « Functions ») : API_CLIENTS, SESSION_SIGNING_SECRET… — voir api-rest/README.md.
 * `config` doit rester déclaré ici : Netlify le lit par analyse statique de ce fichier.
 */
export default createNetlifyHandler(() => getApp());

export const config = {
  path: '/v1/*',
};
