import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('cloudfunctions/avalon', { recursive: true });
await mkdir('cloudfunctions/avalon/vendor', { recursive: true });
await copyFile(
  'vendor/avalon-safe-lodash-set-1.0.0.tgz',
  'cloudfunctions/avalon/vendor/avalon-safe-lodash-set-1.0.0.tgz',
);
await build({
  entryPoints: ['server/cloud.ts'],
  outfile: 'cloudfunctions/avalon/index.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['@cloudbase/node-sdk'],
  sourcemap: false,
  minify: false,
});
console.log('Cloud function ready: cloudfunctions/avalon/index.js (handler: index.main)');
