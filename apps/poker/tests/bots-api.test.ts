import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type PokerCommand, type RoomView } from '../shared/types.js';
import { handleApi } from '../server/application/api.js';
import { FileStore } from '../server/infrastructure/store.js';

async function fixture() {
  let now = 1_000_000;
  const runtime = {
    store: new FileStore(null),
    auth: { sessionSecret: 's'.repeat(48), identitySecret: 'i'.repeat(48), allowGuest: true },
    now: () => now,
  };
  const login = async (letter: string) =>
    (await handleApi(
      { action: 'auth.guest', deviceSecret: letter.repeat(64) },
      undefined,
      runtime,
    )) as { token: string };
  const owner = await login('a');
  const visitor = await login('b');
  const outsider = await login('c');
  let room = (await handleApi(
    {
      action: 'create',
      name: '房主',
      config: { ...DEFAULT_CONFIG, mode: 'online' },
      requestId: 'create_bot_room_request',
    },
    owner.token,
    runtime,
  )) as RoomView;
  room = (await handleApi(
    {
      action: 'join',
      code: room.code,
      name: '旁观者',
      as: 'spectator',
      requestId: 'join_bot_room_request',
    },
    visitor.token,
    runtime,
  )) as RoomView;
  let requests = 0;
  const command = (view: RoomView, value: PokerCommand, token = owner.token) =>
    handleApi(
      {
        action: 'command',
        code: view.code,
        expectedVersion: view.version,
        phaseKey: view.phaseKey,
        command: value,
        requestId: `bot_command_request_${++requests}`,
      },
      token,
      runtime,
    ) as Promise<RoomView>;
  const get = (token = owner.token) =>
    handleApi({ action: 'get', code: room.code }, token, runtime) as Promise<RoomView>;
  const step = (ms = 2000) => {
    now += ms;
  };
  return { runtime, owner, visitor, outsider, room, command, get, step };
}

describe('Server bot turns', () => {
  it('allows the owner/dealer to manage bots but rejects spectators and malformed targets', async () => {
    const f = await fixture();
    await expect(f.command(f.room, { type: 'add-bot' }, f.visitor.token)).rejects.toThrow('权限');
    let room = await f.command(f.room, { type: 'assign-dealer', memberId: f.room.me.memberId });
    room = await f.command(room, { type: 'add-bot' }, f.visitor.token);
    const bot = room.participants.find((item) => item.isBot)!;
    expect(bot.stack).toBe(DEFAULT_CONFIG.initialStack);
    expect(room.members.find((item) => item.isBot)).not.toHaveProperty('userId');
    await expect(f.command(room, { type: 'remove-bot', participantId: '' })).rejects.toThrow(
      '编号无效',
    );
    room = await f.command(room, { type: 'remove-bot', participantId: bot.id }, f.visitor.token);
    expect(room.members.some((item) => item.id === bot.memberId)).toBe(false);
    expect(room.participants.find((item) => item.id === bot.id)?.stack).toBe(bot.stack);
  });

  it('paces each bot action, serializes concurrent viewers, and pauses after undo', async () => {
    const f = await fixture();
    let room = await f.command(f.room, { type: 'add-bot' });
    const bot = room.participants.find((item) => item.isBot)!;
    room = await f.command(room, { type: 'start-hand', buttonId: bot.id });
    expect(room.hand?.actorId).toBe(bot.id);
    const ownCards = room.online!.holeCards;
    const startVersion = room.version;
    expect((await f.get()).version).toBe(startVersion);
    f.step();
    await expect(f.get(f.outsider.token)).rejects.toThrow('不在此房间');
    const views = await Promise.all([f.get(), f.get(f.visitor.token), f.get()]);
    expect(new Set(views.map((view) => view.version)).size).toBe(1);
    room = views[0];
    const botActions = room.events.filter(
      (item) => item.type === 'PLAYER_ACTED' && item.participantId === bot.id,
    );
    expect(botActions).toHaveLength(1);
    expect(room.online!.holeCards).toEqual(ownCards);
    expect(views[1].online!.holeCards).toEqual([]);
    expect(JSON.stringify(room)).not.toContain('onlineHand');
    room = await f.command(room, { type: 'undo' });
    expect(room.paused).toBe(true);
    expect(room.hand?.actorId).toBe(bot.id);
    const pausedVersion = room.version;
    f.step();
    expect((await f.get()).version).toBe(pausedVersion);
    room = await f.command(room, { type: 'resume' });
    expect(room.paused).toBe(false);
    f.step();
    room = await f.get();
    expect(
      room.events.filter(
        (item) => item.type === 'PLAYER_ACTED' && item.participantId === bot.id && !item.revertedBy,
      ),
    ).toHaveLength(1);
    expect(room.online!.holeCards).toEqual(ownCards);
  });

  it('finishes a full bot table through polling, without a client controlling their actions', async () => {
    const f = await fixture();
    let room = await f.get();
    room = await f.command(room, {
      type: 'set-participant-active',
      participantId: room.me.participantId!,
      active: false,
    });
    for (let index = 0; index < 3; index++) room = await f.command(room, { type: 'add-bot' });
    room = await f.command(room, {
      type: 'start-hand',
      buttonId: room.participants.find((item) => item.isBot)!.id,
    });
    for (let count = 0; count < 100 && room.hand?.phase !== 'SETTLED'; count++) {
      f.step();
      room = await f.get();
    }
    expect(room.hand?.phase).toBe('SETTLED');
    expect(room.completedHands).toBe(1);
    expect(room.participants.reduce((sum, item) => sum + item.stack, 0)).toBe(
      DEFAULT_CONFIG.initialStack * 4,
    );
    expect(
      room.events
        .filter((item) => item.type === 'PLAYER_ACTED')
        .every(
          (item) => room.participants.find((player) => player.id === item.participantId)?.isBot,
        ),
    ).toBe(true);
  });
});
