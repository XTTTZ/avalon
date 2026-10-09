import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type PokerCommand, type RoomView } from '../shared/types.js';
import { handleApi } from '../server/application/api.js';
import { FileStore } from '../server/infrastructure/store.js';

const deps = () => ({
  store: new FileStore(null),
  auth: { sessionSecret: 's'.repeat(48), identitySecret: 'i'.repeat(48), allowGuest: true },
  now: () => 1_000_000,
});

describe('Poker API', () => {
  it('validates relative seat movement and applies each request only once', async () => {
    const runtime = deps();
    const owner = (await handleApi(
      { action: 'auth.guest', deviceSecret: 'e'.repeat(64) },
      undefined,
      runtime,
    )) as { token: string };
    const guest = (await handleApi(
      { action: 'auth.guest', deviceSecret: 'f'.repeat(64) },
      undefined,
      runtime,
    )) as { token: string };
    let room = (await handleApi(
      { action: 'create', name: '房主', config: DEFAULT_CONFIG, requestId: 'seat_create_request' },
      owner.token,
      runtime,
    )) as RoomView;
    room = (await handleApi(
      {
        action: 'join',
        code: room.code,
        name: '玩家',
        as: 'player',
        requestId: 'seat_join_request',
      },
      guest.token,
      runtime,
    )) as RoomView;
    const participantId = room.me.participantId!;
    const request = {
      action: 'command' as const,
      code: room.code,
      expectedVersion: room.version,
      phaseKey: room.phaseKey,
      requestId: 'seat_move_request',
      command: { type: 'move-seat', participantId, direction: 'left' } as PokerCommand,
    };
    for (const direction of ['up', '', null, 1]) {
      await expect(
        handleApi(
          { ...request, command: { type: 'move-seat', participantId, direction } },
          guest.token,
          runtime,
        ),
      ).rejects.toThrow('换座方向无效');
    }
    await expect(
      handleApi(
        { ...request, command: { type: 'move-seat', direction: 'left' } },
        guest.token,
        runtime,
      ),
    ).rejects.toThrow('玩家编号无效');
    const moved = (await handleApi(request, guest.token, runtime)) as RoomView;
    expect(moved.participants.map((item) => item.seat)).toEqual([1, 0]);
    const replay = (await handleApi(request, guest.token, runtime)) as RoomView;
    expect(replay.version).toBe(moved.version);
    expect(replay.participants.map((item) => item.seat)).toEqual([1, 0]);
    await expect(
      handleApi(
        {
          ...request,
          command: {
            type: 'move-seat',
            participantId: room.participants[0].id,
            direction: 'right',
          },
          expectedVersion: moved.version,
          phaseKey: moved.phaseKey,
          requestId: 'seat_forbidden_request',
        },
        guest.token,
        runtime,
      ),
    ).rejects.toThrow('需要房主或荷官权限');
  });

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
