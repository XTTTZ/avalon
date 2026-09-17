import cloudbase from '@cloudbase/node-sdk';
import { CloudBaseStore, type DatabaseLike, type Store } from './store.js';
import { PostgresStore } from './postgres-store.js';
import { readAuthConfig } from './auth.js';
import { createHttpHandler, MAX_BODY_BYTES } from './http.js';

interface CloudEvent {
  httpMethod?: string;
  requestContext?: {
    sourceIp?: string;
    identity?: { sourceIp?: string };
    http?: { method?: string; sourceIp?: string };
  };
  headers?: Record<string, string>;
  body?: string;
  isBase64Encoded?: boolean;
  Type?: string;
  TriggerName?: string;
}
let runtime: { store: Store; handler: ReturnType<typeof createHttpHandler> } | undefined;
function getRuntime() {
  if (runtime) return runtime;
  const auth = readAuthConfig(process.env);
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    !allowedOrigins.length ||
    allowedOrigins.some((origin) => {
      const url = new URL(origin);
      return url.origin !== origin || url.protocol !== 'https:';
    })
  ) {
    throw new Error('ALLOWED_ORIGINS must contain exact HTTPS origins');
  }
  if (process.env.STORE_BACKEND && !['document', 'postgres'].includes(process.env.STORE_BACKEND))
    throw new Error('Invalid store backend');
  const store =
    process.env.STORE_BACKEND === 'postgres'
      ? new PostgresStore(process.env.PG_REST_URL ?? '', process.env.PG_API_KEY ?? '')
      : new CloudBaseStore(
          cloudbase
            .init({
              env: process.env.CLOUDBASE_ENV_ID || cloudbase.SYMBOL_CURRENT_ENV,
            })
            .database() as unknown as DatabaseLike,
        );
  runtime = { store, handler: createHttpHandler({ store, auth }, { allowedOrigins }) };
  return runtime;
}
export async function main(event: CloudEvent) {
  try {
    const { store, handler } = getRuntime();
    const method = event.httpMethod ?? event.requestContext?.http?.method;
    // CloudBase timer triggers are platform events, never interpreted from HTTP JSON.
    if (!method && event.Type === 'Timer' && event.TriggerName === 'avalon-cleanup') {
      return { deleted: await store.cleanup(Date.now(), 400) };
    }
    if (!method)
      return { ok: false, error: { code: 'FORBIDDEN', message: '请使用配置的 HTTP API' } };
    const raw = typeof event.body === 'string' ? event.body : '';
    const body = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES)
      return {
        statusCode: 413,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ ok: false, error: { code: 'INVALID', message: '请求内容过大' } }),
      };
    return handler({
      method,
      headers: event.headers ?? {},
      body,
      ip:
        event.requestContext?.sourceIp ??
        event.requestContext?.identity?.sourceIp ??
        event.requestContext?.http?.sourceIp,
    });
  } catch {
    // A deployment mistake must never fall back to unverified identities or memory state.
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: false,
        error: { code: 'INTERNAL', message: '服务配置未完成，请联系房主' },
      }),
    };
  }
}
