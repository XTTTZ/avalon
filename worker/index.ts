import { DurableObject } from 'cloudflare:workers';
import { createHttpHandler, MAX_BODY_BYTES } from '../server/http.js';
import { readAuthConfig, type AuthDeps } from '../server/auth.js';
import { NeonStore } from '../server/neon-store.js';
import { verifyRealtimeTicket, type VerifiedRealtimeTicket } from '../server/realtime.js';
import { GameError, type RealtimeNotice } from '../shared/types.js';

interface WorkerEnv extends Env {
  DATABASE_URL: string;
  SESSION_SECRET: string;
  IDENTITY_SECRET: string;
  APP_VERSION?: string;
}

interface SocketAttachment {
  userId: string;
  roomInstanceId: string;
  gameId: string;
  sessionExpiresAt: number;
}

const CLEANUP_BATCH_SIZE = 400;
const MAX_CLEANUP_BATCHES = 10;
const MAX_ROOM_SOCKETS = 64;
const MAX_USER_SOCKETS = 3;

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(value: unknown, status = 200, extra: HeadersInit = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_HEADERS, ...Object.fromEntries(new Headers(extra)) },
  });
}

function validNotice(value: unknown): value is RealtimeNotice {
  if (!value || typeof value !== 'object') return false;
  const notice = value as Partial<RealtimeNotice>;
  return (
    notice.type === 'room-version' &&
    typeof notice.roomInstanceId === 'string' &&
    /^[A-Za-z0-9:_-]{1,160}$/.test(notice.roomInstanceId) &&
    typeof notice.gameId === 'string' &&
    /^[A-Za-z0-9:_-]{1,100}$/.test(notice.gameId) &&
    Number.isSafeInteger(notice.version) &&
    Number(notice.version) >= 1 &&
    (notice.closed === undefined || typeof notice.closed === 'boolean')
  );
}

function isNewer(current: RealtimeNotice | undefined, next: RealtimeNotice) {
  if (!current) return true;
  return (
    next.version > current.version ||
    (next.version === current.version && next.closed === true && current.closed !== true)
  );
}

function encodeInternalClaims(claims: VerifiedRealtimeTicket) {
  return Buffer.from(JSON.stringify(claims)).toString('base64url');
}

function decodeInternalClaims(value: string | null): VerifiedRealtimeTicket | null {
  if (!value || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const claims = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof claims.userId !== 'string' ||
      typeof claims.roomInstanceId !== 'string' ||
      typeof claims.gameId !== 'string' ||
      !Number.isSafeInteger(claims.version) ||
      !Number.isSafeInteger(claims.expiresAt) ||
      !Number.isSafeInteger(claims.sessionExpiresAt)
    )
      return null;
    return claims as unknown as VerifiedRealtimeTicket;
  } catch {
    return null;
  }
}

export class RoomHub extends DurableObject<WorkerEnv> {
  private current?: RealtimeNotice;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<RealtimeNotice>('notice');
      if (validNotice(stored)) this.current = stored;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') return this.acceptSocket(request);
    if (url.pathname === '/notify' && request.method === 'POST') return this.notify(request);
    return new Response('Not found', { status: 404 });
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return new Response('Expected WebSocket', { status: 426 });
    const claims = decodeInternalClaims(request.headers.get('X-Avalon-Realtime'));
    if (!claims || claims.expiresAt <= Date.now())
      return new Response('Unauthorized', { status: 401 });
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_ROOM_SOCKETS)
      return new Response('Room connection limit', { status: 429 });
    const userSockets = sockets.filter(
      (socket) =>
        (socket.deserializeAttachment() as SocketAttachment | null)?.userId === claims.userId,
    );
    if (userSockets.length >= MAX_USER_SOCKETS)
      return new Response('Player connection limit', { status: 429 });

    const ticketNotice: RealtimeNotice = {
      type: 'room-version',
      roomInstanceId: claims.roomInstanceId,
      gameId: claims.gameId,
      version: claims.version,
    };
    if (this.current && this.current.roomInstanceId !== ticketNotice.roomInstanceId)
      return new Response('Conflict', { status: 409 });
    if (isNewer(this.current, ticketNotice)) {
      this.current = ticketNotice;
      await this.ctx.storage.put('notice', ticketNotice);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      userId: claims.userId,
      roomInstanceId: claims.roomInstanceId,
      gameId: claims.gameId,
      sessionExpiresAt: claims.sessionExpiresAt,
    } satisfies SocketAttachment);
    server.send(JSON.stringify(this.current ?? ticketNotice));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'avalon-v1' },
    });
  }

  private async notify(request: Request): Promise<Response> {
    let notice: unknown;
    try {
      notice = await request.json();
    } catch {
      return new Response('Invalid notice', { status: 400 });
    }
    if (!validNotice(notice)) return new Response('Invalid notice', { status: 400 });
    if (this.current && this.current.roomInstanceId !== notice.roomInstanceId)
      return new Response('Conflict', { status: 409 });
    if (!isNewer(this.current, notice)) return new Response(null, { status: 204 });

    this.current = notice;
    await this.ctx.storage.put('notice', notice);
    const payload = JSON.stringify(notice);
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (
        !attachment ||
        attachment.roomInstanceId !== notice.roomInstanceId ||
        attachment.sessionExpiresAt <= now
      ) {
        socket.close(1008, 'Session expired');
        continue;
      }
      try {
        socket.send(payload);
      } catch {
        socket.close(1011, 'Delivery failed');
      }
    }
    return new Response(null, { status: 204 });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (message === 'ping') socket.send('pong');
    else socket.close(1008, 'Unsupported message');
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    socket.close(code, reason);
  }

  webSocketError(socket: WebSocket) {
    socket.close(1011, 'WebSocket error');
  }
}

async function readBody(request: Request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    throw new GameError('INVALID', '请求内容过大');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new GameError('INVALID', '请求内容过大');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseAllowedOrigins(env: WorkerEnv) {
  const values = env.ALLOWED_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length) throw new Error('ALLOWED_ORIGINS is required');
  for (const value of values) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== value)
      throw new Error('ALLOWED_ORIGINS must contain exact HTTPS origins');
  }
  return values;
}

function websocketProtocols(request: Request) {
  return (request.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function createDeps(env: WorkerEnv, context: ExecutionContext): AuthDeps {
  return {
    store: new NeonStore(env.DATABASE_URL),
    auth: readAuthConfig({
      SESSION_SECRET: env.SESSION_SECRET,
      IDENTITY_SECRET: env.IDENTITY_SECRET,
    }),
    onRoomChange: (notice) => {
      const stub = env.ROOM_HUB.getByName(notice.roomInstanceId, { locationHint: 'apac-se' });
      context.waitUntil(
        stub
          .fetch('https://room.internal/notify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(notice),
          })
          .then((response) => {
            if (!response.ok) throw new Error(`Room notification failed (${response.status})`);
          })
          .catch((error) => {
            console.error(
              JSON.stringify({
                level: 'error',
                message: 'Avalon realtime notification failed',
                error: error instanceof Error ? error.name : 'unknown',
              }),
            );
          }),
      );
    },
  };
}

async function handleApiRequest(request: Request, env: WorkerEnv, context: ExecutionContext) {
  const handler = createHttpHandler(createDeps(env, context), {
    allowedOrigins: parseAllowedOrigins(env),
  });
  let body = '';
  try {
    if (request.method !== 'OPTIONS') body = await readBody(request);
  } catch (error) {
    const message = error instanceof GameError ? error.message : '请求内容无效';
    return json({ ok: false, error: { code: 'INVALID', message } }, 400);
  }
  const result = await handler({
    method: request.method,
    headers: Object.fromEntries(request.headers),
    body,
    ip: request.headers.get('CF-Connecting-IP') ?? undefined,
  });
  return new Response(result.statusCode === 204 ? null : result.body, {
    status: result.statusCode,
    headers: result.headers,
  });
}

async function handleWebSocket(request: Request, env: WorkerEnv) {
  if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
    return json({ ok: false, error: { code: 'INVALID', message: '需要 WebSocket 连接' } }, 426);
  const origin = request.headers.get('Origin');
  if (origin && !parseAllowedOrigins(env).includes(origin))
    return json({ ok: false, error: { code: 'FORBIDDEN', message: '此来源未获授权' } }, 403);
  const protocols = websocketProtocols(request);
  const ticket = protocols
    .find((value) => value.startsWith('avalon-ticket.'))
    ?.slice('avalon-ticket.'.length);
  if (!protocols.includes('avalon-v1') || !ticket)
    return json({ ok: false, error: { code: 'UNAUTHORIZED', message: '实时连接凭证缺失' } }, 401);
  let claims: VerifiedRealtimeTicket;
  try {
    claims = verifyRealtimeTicket(ticket, env.SESSION_SECRET);
  } catch (error) {
    const status = error instanceof GameError ? 401 : 500;
    return json(
      {
        ok: false,
        error: {
          code: status === 401 ? 'UNAUTHORIZED' : 'INTERNAL',
          message: status === 401 ? '实时连接已失效，请重新连接' : '服务暂时不可用',
        },
      },
      status,
    );
  }
  const stub = env.ROOM_HUB.getByName(claims.roomInstanceId, { locationHint: 'apac-se' });
  const headers = new Headers(request.headers);
  headers.set('X-Avalon-Realtime', encodeInternalClaims(claims));
  return stub.fetch('https://room.internal/connect', { method: 'GET', headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv, context: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/poker') {
      url.pathname = '/poker/';
      return Response.redirect(url.toString(), 302);
    }
    if (url.pathname === '/api/health') {
      if (request.method !== 'GET')
        return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      return json({ ok: true, service: 'avalon', version: env.APP_VERSION ?? 'development' });
    }
    if (url.pathname === '/api') return handleApiRequest(request, env, context);
    if (url.pathname === '/ws') return handleWebSocket(request, env);
    if (url.pathname.startsWith('/api/'))
      return json({ ok: false, error: { code: 'NOT_FOUND', message: '接口不存在' } }, 404);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv) {
    const store = new NeonStore(env.DATABASE_URL);
    const now = Date.now();
    for (let batches = 0; batches < MAX_CLEANUP_BATCHES; batches++) {
      const deleted = await store.cleanup(now, CLEANUP_BATCH_SIZE);
      if (deleted < CLEANUP_BATCH_SIZE) break;
    }
  },
} satisfies ExportedHandler<WorkerEnv>;
