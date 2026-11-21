import { getHandler, handleSafely } from '../../src/bootstrap.js';

/**
 * Fonction Netlify du serveur MCP. Variables d'environnement (scope « Functions ») :
 * REST_API_BASE_URL, REST_API_KEY_CLAUDE, REST_API_KEY_CHATGPT (secrets), voir README.
 */
export default (request: Request, context?: { ip?: string }) =>
  handleSafely(() => getHandler(), request, { ip: context?.ip });

export const config = {
  path: ['/mcp', '/mcp/*', '/health'],
};
