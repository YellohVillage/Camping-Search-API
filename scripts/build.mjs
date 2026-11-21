import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Bundle AWS Lambda (cible secondaire) : dist/lambda.js, handler `lambda.handler`.
 * Sur Netlify (cible principale), la fonction netlify/functions/api.ts est regroupée par Netlify lui-même.
 */
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/lambda.ts'],
  outfile: 'dist/lambda.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  minify: true,
  sourcemap: true,
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
writeFileSync('dist/package.json', JSON.stringify({ type: 'module' }) + '\n');
process.stdout.write('dist/lambda.js écrit.\n');
