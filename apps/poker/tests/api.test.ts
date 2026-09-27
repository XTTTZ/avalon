import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type RoomView } from '../shared/types.js';
import { handleApi } from '../server/application/api.js';
import { FileStore } from '../server/infrastructure/store.js';

const deps = () => ({
  store: new FileStore(null),
  auth: { sessionSecret: 's'.repeat(48), identitySecret: 'i'.repeat(48), allowGuest: true },
  now: () => 1_000_000,
});

describe('Poker API', () => {
  it('creates, joins and restores a room with isolated guest identities', async () => {
    const runtime = deps();
    const owner = await handleApi(
      { action: 'auth.guest', deviceSecret: 'a'.repeat(64) },
      undefined,
      runtime,
    );
    const guest = await handleApi(
      { action: 'auth.guest', deviceSecret: 'b'.repeat(64) },
      undefined,
      runtime,
    );
    const created = (await handleApi(
      { action: 'create', name: '甲', config: DEFAULT_CONFIG, requestId: 'create_request_0001' },
      (owner as { token: string }).token,
      runtime,
    )) as RoomView;
    const joined = (await handleApi(
      {
        action: 'join',
        code: created.code,
        name: '乙',
        as: 'player',
        requestId: 'join_request_000001',
      },
      (guest as { token: string }).token,
      runtime,
    )) as RoomView;
    expect(joined.participants).toHaveLength(2);
    const restored = (await handleApi(
      { action: 'get', code: created.code },
      (owner as { token: string }).token,
      runtime,
    )) as RoomView;
    expect(restored.me.isOwner).toBe(true);
    expect(restored.participants.map((item) => item.name)).toEqual(['甲', '乙']);
  });

  it('replays an identical command once and rejects a changed payload with the same id', async () => {
    const runtime = deps();
    const session = (await handleApi(
      { action: 'auth.guest', deviceSecret: 'c'.repeat(64) },
      undefined,
      runtime,
    )) as { token: string };
    const created = (await handleApi(
      { action: 'create', name: '房主', config: DEFAULT_CONFIG, requestId: 'create_request_0002' },
      session.token,
      runtime,
    )) as RoomView;
    const request = {
      action: 'command' as const,
      code: created.code,
      command: { type: 'pause' as const },
      expectedVersion: created.version,
      phaseKey: created.phaseKey,
      requestId: 'command_request_001',
    };
    const first = (await handleApi(request, session.token, runtime)) as RoomView;
    const replay = (await handleApi(request, session.token, runtime)) as RoomView;
    expect(first.version).toBe(replay.version);
    await expect(
      handleApi({ ...request, command: { type: 'resume' } }, session.token, runtime),
    ).rejects.toThrow('请求编号已用于其他操作');
  });

  it('rejects stale non-replayed commands', async () => {
    const runtime = deps();
    const session = (await handleApi(
      { action: 'auth.guest', deviceSecret: 'd'.repeat(64) },
      undefined,
      runtime,
    )) as { token: string };
    const room = (await handleApi(
      { action: 'create', name: '房主', config: DEFAULT_CONFIG, requestId: 'create_request_0003' },
      session.token,
      runtime,
    )) as RoomView;
    await handleApi(
      {
        action: 'command',
        code: room.code,
        command: { type: 'pause' },
        expectedVersion: room.version,
        phaseKey: room.phaseKey,
        requestId: 'command_request_002',
      },
      session.token,
      runtime,
    );
    await expect(
      handleApi(
        {
          action: 'command',
          code: room.code,
          command: { type: 'configure', config: DEFAULT_CONFIG },
          expectedVersion: room.version,
          phaseKey: room.phaseKey,
          requestId: 'command_request_003',
        },
        session.token,
        runtime,
      ),
    ).rejects.toThrow('牌局已更新');
  });
});
