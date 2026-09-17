import { GameError, type ApiErrorCode } from '../shared/types.js';
import { handleApi } from './api.js';
import type { AuthDeps } from './auth.js';

export const MAX_BODY_BYTES = 64 * 1024;
export interface HttpRequest {
  method: string;
  headers: Record<string, string | undefined>;
  body: string;
  ip?: string;
}
export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: false;
}
export interface HttpOptions {
  allowedOrigins: string[];
  development?: boolean;
}
const statuses: Record<ApiErrorCode, number> = {
  INVALID: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMIT: 429,
  EXPIRED: 410,
  INTERNAL: 500,
};

/** A best-effort warm-instance edge limiter; mutations also have transactional limits. */
export class RequestLimiter {
  private entries = new Map<string, { count: number; resetAt: number }>();
  check(key: string, limit: number, now: number) {
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + 60_000 };
      this.entries.set(key, entry);
    }
    if (entry.count++ >= limit) throw new GameError('RATE_LIMIT', '请求太频繁，请稍后再试');
    if (this.entries.size > 10_000) {
      for (const [id, value] of this.entries) if (value.resetAt <= now) this.entries.delete(id);
      while (this.entries.size > 10_000) this.entries.delete(this.entries.keys().next().value!);
    }
  }
}
export function createHttpHandler(deps: AuthDeps, options: HttpOptions) {
  const limiter = new RequestLimiter();
  return async (request: HttpRequest): Promise<HttpResponse> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Origin',
    };
    const normalized = Object.fromEntries(
      Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]),
    );
    try {
      const origin = normalized.origin;
      if (origin && !options.development && !options.allowedOrigins.includes(origin))
        throw new GameError('FORBIDDEN', '此来源未获授权');
      if (origin) headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Max-Age'] = '600';
      if (request.method === 'OPTIONS') return { statusCode: 204, headers, body: '' };
      if (request.method !== 'POST')
        return {
          statusCode: 405,
          headers: { ...headers, Allow: 'POST, OPTIONS' },
          body: JSON.stringify({
            ok: false,
            error: { code: 'INVALID', message: '仅支持 POST 请求' },
          }),
        };
      const now = (deps.now ?? Date.now)();
      const ip = request.ip ?? 'unknown';
      limiter.check(`requests:${ip}`, 900, now);
      if (!/^application\/json(?:\s*;|$)/i.test(normalized['content-type'] ?? ''))
        throw new GameError('INVALID', '请求须使用 application/json');
      if (Buffer.byteLength(request.body) > MAX_BODY_BYTES)
        throw new GameError('INVALID', '请求内容过大');
      let input: unknown;
      try {
        input = JSON.parse(request.body);
      } catch {
        throw new GameError('INVALID', 'JSON 格式错误');
      }
      if (
        input &&
        typeof input === 'object' &&
        String((input as { action?: string }).action).startsWith('auth.')
      )
        limiter.check(`auth:${ip}`, 60, now);
      const authorization = normalized.authorization;
      const token = authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
      const data = await handleApi(input, token, deps);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data }) };
    } catch (error) {
      const safe =
        error instanceof GameError
          ? error
          : new GameError('INTERNAL', '服务暂时不可用，请稍后重试');
      // Never log payloads, tokens, ballots, OAuth URLs, or database state.
      if (!(error instanceof GameError))
        console.error('Avalon request failed', error instanceof Error ? error.name : 'unknown');
      if (safe.code === 'RATE_LIMIT') headers['Retry-After'] = '60';
      return {
        statusCode: statuses[safe.code],
        headers,
        body: JSON.stringify({ ok: false, error: { code: safe.code, message: safe.message } }),
      };
    }
  };
}
