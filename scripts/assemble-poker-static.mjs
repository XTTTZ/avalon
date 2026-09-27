import { access, cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const rootOutput = resolve('dist');
const pokerOutput = resolve('apps/poker/dist');
const target = resolve(rootOutput, 'poker');

await Promise.all([
  access(resolve(rootOutput, 'index.html')),
  access(resolve(pokerOutput, 'index.html')),
]);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(pokerOutput, target, { recursive: true });

console.log('Combined static site ready: dist/ (Avalon) + dist/poker/ (Poker)');
