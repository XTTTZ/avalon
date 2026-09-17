import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { FileStore } from './store.js';
import { readAuthConfig } from './auth.js';
import { createHttpHandler, MAX_BODY_BYTES } from './http.js';

const filename = resolve(process.env.DATA_FILE || '.data/avalon.json');
const env = { ...process.env };
if (!env.SESSION_SECRET) {
  const secretFile = resolve(dirname(filename), 'session-secret');
  await mkdir(dirname(secretFile), { recursive: true, mode: 0o700 });
  try {
    env.SESSION_SECRET = await readFile(secretFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const secret = randomBytes(48).toString('base64url');
    try {
      await writeFile(secretFile, secret, { mode: 0o600, flag: 'wx' });
      env.SESSION_SECRET = secret;
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      env.SESSION_SECRET = await readFile(secretFile, 'utf8');
    }
  }
}
// This runner is explicitly development-only. The CloudBase entry never sets defaults.
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
  try {
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
  } catch {
    if (!response.headersSent) response.writeHead(400, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ ok: false, error: { code: 'INVALID', message: '请求中断，请重试' } }),
    );
  }
});
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
server.listen(Number(env.PORT || 8787), '0.0.0.0', () =>
  console.log(`Avalon local API: http://localhost:${env.PORT || 8787}`),
);
const cleanup = setInterval(() => {
  void store.cleanup(Date.now(), 1000).catch(() => console.error('Local cleanup failed'));
}, 3_600_000);
cleanup.unref();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(cleanup);
    server.close(() => process.exit(0));
  });
