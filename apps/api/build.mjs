// Compile l'entrée Node.js en un seul fichier (dépendances npm laissées externes).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/node.ts'],
  outfile: 'dist/node.js',
  bundle: true,
  packages: 'external',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  logLevel: 'info',
});
