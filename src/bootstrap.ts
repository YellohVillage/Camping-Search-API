import pkg from '../package.json' with { type: 'json' };
import { createApp, type App } from './app.js';
import { loadConfig } from './config.js';

let app: App | undefined;

/**
 * Application unique par instance (démarrage à froid). La configuration est validée ici :
 * une configuration invalide lève une ConfigError explicite et l'instance refuse de démarrer.
 */
export function getApp(env: Record<string, string | undefined> = process.env): App {
  if (!app) app = createApp({ config: loadConfig(env, pkg.version) });
  return app;
}

/** Pour les tests uniquement. */
export function resetApp() {
  app = undefined;
}
