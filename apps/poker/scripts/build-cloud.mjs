import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('cloudfunctions/poker', { recursive: true });
await build({
  entryPoints: ['server/cloud.ts'],
  outfile: 'cloudfunctions/poker/index.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: false,
  minify: false,
});
console.log('Poker CloudBase function ready: cloudfunctions/poker/index.js');
