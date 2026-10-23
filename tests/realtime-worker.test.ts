import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { issueRealtimeTicket } from '../server/realtime';

let worker: Miniflare;
const secret = 's'.repeat(48);
type Socket = NonNullable<Awaited<ReturnType<Miniflare['dispatchFetch']>>['webSocket']>;
const sockets: Socket[] = [];
beforeAll(async () => {
  const built = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'ts',
      contents: `
      import worker, { RoomHub } from './worker/index.ts';
      export { RoomHub };
      export default {
        async fetch(request, env, ctx) {
          if (new URL(request.url).pathname === '/test-notify') {
            const notice = await request.json();
            return env.ROOM_HUB.getByName(notice.roomInstanceId).fetch('https://room.internal/notify', {
              method:'POST', body:JSON.stringify(notice)
            });
          }
          return worker.fetch(request, env, ctx);
        }
      };
    `,
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    external: ['cloudflare:*', 'node:*'],
  });
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: built.outputFiles[0].text,
      compatibilityDate: '2026-10-13',
      compatibilityFlags: ['nodejs_compat'],
      durableObjects: { ROOM_HUB: { className: 'RoomHub', useSQLite: true } },
      bindings: { SESSION_SECRET: secret, ALLOWED_ORIGINS: 'https://avalon.example.test' },
    }),
  );
});
afterAll(async () => {
  sockets.forEach((s) => s.close());
  await worker?.dispose();
});
function next(socket: Socket) {
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket message timeout')), 3000);
    socket.addEventListener(
      'message',
      (event) => {
        clearTimeout(timeout);
        resolve(event.data === 'pong' ? 'pong' : JSON.parse(String(event.data)));
      },
      { once: true },
    );
  });
}
async function connect(room: string, user = 'user_a', page = 'connection_1234567890') {
  const issued = issueRealtimeTicket(
    {
      userId: user,
      sessionExpiresAt: Date.now() + 60000,
      roomInstanceId: room,
      gameId: 'game_1',
      version: 1,
      connectionId: page,
    },
    secret,
  );
  const response = await worker.dispatchFetch('https://avalon.example.test/ws', {
    headers: {
      Upgrade: 'websocket',
      Origin: 'https://avalon.example.test',
      'Sec-WebSocket-Protocol': `avalon-v1, avalon-ticket.${issued.ticket}`,
    },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  sockets.push(socket);
  const ready = next(socket);
  socket.accept();
  expect(await ready).toEqual({
    type: 'room-version',
    roomInstanceId: room,
    gameId: 'game_1',
    version: 1,
  });
  return socket;
}
it('uses hibernating heartbeat responses and broadcasts only version metadata', async () => {
  const socket = await connect('room_heartbeat');
  const pong = next(socket);
  socket.send('ping');
  expect(await pong).toBe('pong');
  const updated = next(socket);
  const notice = {
    type: 'room-version',
    roomInstanceId: 'room_heartbeat',
    gameId: 'game_1',
    version: 2,
  };
  const response = await worker.dispatchFetch('https://avalon.example.test/test-notify', {
    method: 'POST',
    body: JSON.stringify(notice),
  });
  expect(response.status).toBe(204);
  expect(await updated).toEqual(notice);
});
it('replaces a stale socket from the same page without evicting another player', async () => {
  const old = await connect('room_replace');
  const other = await connect('room_replace', 'user_b');
  const replacement = next(old);
  const fresh = await connect('room_replace');
  expect(await replacement).toEqual({ type: 'replaced' });
  const freshPong = next(fresh);
  fresh.send('ping');
  expect(await freshPong).toBe('pong');
  const otherPong = next(other);
  other.send('ping');
  expect(await otherPong).toBe('pong');
});
it('allows reconnecting after the player connection cap and retires the oldest page', async () => {
  const oldest = await connect('room_limit', 'user_a', 'connection_0000000001');
  await connect('room_limit', 'user_a', 'connection_0000000002');
  await connect('room_limit', 'user_a', 'connection_0000000003');
  const replacement = next(oldest);
  await connect('room_limit', 'user_a', 'connection_0000000004');
  expect(await replacement).toEqual({ type: 'replaced' });
});
it('rejects cross-origin and invalid-ticket connections before contacting a room', async () => {
  const response = await worker.dispatchFetch('https://avalon.example.test/ws', {
    headers: { Upgrade: 'websocket', Origin: 'https://untrusted.example.test' },
  });
  expect(response.status).toBe(403);
  const invalid = await worker.dispatchFetch('https://avalon.example.test/ws', {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'avalon-v1, avalon-ticket.invalid' },
  });
  expect(invalid.status).toBe(401);
});
