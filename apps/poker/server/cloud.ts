import { readAuthConfig } from './infrastructure/auth.js';
import { createHttpHandler, MAX_BODY_BYTES } from './infrastructure/http.js';
import { PostgresStore } from './infrastructure/postgres-store.js';

interface CloudEvent {
  httpMethod?: string;
  requestContext?: { sourceIp?: string; http?: { method?: string; sourceIp?: string } };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  Type?: string;
  TriggerName?: string;
}

let runtime: { store: PostgresStore; handler: ReturnType<typeof createHttpHandler> } | undefined;
const CLEANUP_BATCH_SIZE = 400;
const MAX_CLEANUP_BATCHES = 10;

function getRuntime() {
  if (runtime) return runtime;
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!allowedOrigins.length || allowedOrigins.some((origin) => new URL(origin).origin !== origin))
    throw new Error('ALLOWED_ORIGINS must contain exact HTTPS origins');
  const store = new PostgresStore(process.env.PG_REST_URL ?? '', process.env.PG_API_KEY ?? '');
  runtime = {
    store,
    handler: createHttpHandler({ store, auth: readAuthConfig(process.env) }, { allowedOrigins }),
  };
  return runtime;
}

export async function main(event: CloudEvent) {
  try {
    const { store, handler } = getRuntime();
    const method = event.httpMethod ?? event.requestContext?.http?.method;
    if (!method && event.Type === 'Timer' && event.TriggerName === 'poker-cleanup') {
      const now = Date.now();
      let deleted = 0;
      let batches = 0;
      while (batches < MAX_CLEANUP_BATCHES) {
        const batch = await store.cleanup(now, CLEANUP_BATCH_SIZE);
        deleted += batch;
        batches += 1;
        if (batch < CLEANUP_BATCH_SIZE) break;
      }
      return { deleted, batches };
    }
    if (!method) return { ok: false, error: { code: 'FORBIDDEN', message: '请使用 HTTP API' } };
    const raw = typeof event.body === 'string' ? event.body : '';
    const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      return { statusCode: 413, body: JSON.stringify({ ok: false, error: { code: 'INVALID' } }) };
    return handler({
      method,
      headers: event.headers ?? {},
      body,
      ip: event.requestContext?.sourceIp ?? event.requestContext?.http?.sourceIp,
    });
  } catch {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: '服务配置未完成' } }),
    };
  }
}
