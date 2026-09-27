import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { readAuthConfig } from './infrastructure/auth.js';
import { createHttpHandler, MAX_BODY_BYTES } from './infrastructure/http.js';
import { FileStore } from './infrastructure/store.js';

const filename = resolve(process.env.DATA_FILE || '.data/poker.json');
const env = { ...process.env };
if (!env.POKER_SESSION_SECRET) {
  const secretFile = resolve(dirname(filename), 'poker-session-secret');
  await mkdir(dirname(secretFile), { recursive: true, mode: 0o700 });
  try {
    env.POKER_SESSION_SECRET = await readFile(secretFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const secret = randomBytes(48).toString('base64url');
    try {
      await writeFile(secretFile, secret, { mode: 0o600, flag: 'wx' });
      env.POKER_SESSION_SECRET = secret;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      env.POKER_SESSION_SECRET = await readFile(secretFile, 'utf8');
    }
  }
}
if (!env.POKER_IDENTITY_SECRET) {
  const secretFile = resolve(dirname(filename), 'poker-identity-secret');
  await mkdir(dirname(secretFile), { recursive: true, mode: 0o700 });
  try {
    env.POKER_IDENTITY_SECRET = await readFile(secretFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const secret = randomBytes(48).toString('base64url');
    try {
      await writeFile(secretFile, secret, { mode: 0o600, flag: 'wx' });
      env.POKER_IDENTITY_SECRET = secret;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      env.POKER_IDENTITY_SECRET = await readFile(secretFile, 'utf8');
    }
  }
}
env.ALLOW_GUEST ??= 'true';
const store = new FileStore(filename);
const handler = createHttpHandler(
  { store, auth: readAuthConfig(env) },
  { allowedOrigins: [], development: true },
);
const server = createServer(async (request, response) => {
  if ((request.url ?? '').split('?')[0] === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      response.writeHead(413, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ ok: false, error: { code: 'INVALID', message: '请求内容过大' } }),
      );
      return;
    }
    chunks.push(Buffer.from(chunk));
  }
  const result = await handler({
    method: request.method ?? 'GET',
    headers: Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [
        key,
        Array.isArray(value) ? value[0] : value,
      ]),
    ),
    body: Buffer.concat(chunks).toString('utf8'),
    ip: request.socket.remoteAddress,
  });
  response.writeHead(result.statusCode, result.headers);
  response.end(result.body);
});
server.listen(Number(env.PORT || 8788), '0.0.0.0', () =>
  console.log(`Poker local API: http://localhost:${env.PORT || 8788}`),
);
