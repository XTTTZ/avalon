import { describe, expect, it } from 'vitest';
import { chooseBotAction } from '../server/domain/bots.js';
import { applyCommand, createRoom, joinRoom, legalActions } from '../server/domain/engine.js';
import { DEFAULT_CONFIG, type RoomState } from '../shared/types.js';

function seeded(seed = 42) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function table(count = 3, stack = 2000, unit = 1) {
  let room = createRoom('8080', 'user-0', 'Player 0', {
    ...structuredClone(DEFAULT_CONFIG),
    initialStack: stack,
    chipUnit: unit,
  });
  for (let index = 1; index < count; index += 1) {
    room = joinRoom(room, `user-${index}`, `Player ${index}`, 'player');
  }
  return applyCommand(room, 'user-0', { type: 'start-hand', buttonId: room.participants[0].id });
}

function act(room: RoomState, command: ReturnType<typeof chooseBotAction>) {
  const participant = room.participants.find((item) => item.id === room.hand!.actorId)!;
  const user = room.members.find((item) => item.id === participant.memberId)!.userId;
  return applyCommand(room, user, command);
}

function river() {
  const room = table(2);
  const hand = room.hand!;
  hand.street = 'RIVER';
  hand.communityCards = ['As', 'Ks', 'Qs', '2d', '3c'];
  hand.currentBet = 0;
  hand.lastFullRaiseSize = hand.bigBlind;
  hand.players.forEach((player) => {
    room.participants.find((item) => item.id === player.participantId)!.stack -=
      100 - player.handCommitted;
    player.streetCommitted = 0;
    player.handCommitted = 100;
    player.hasActed = false;
    player.reopenAtBet = null;
  });
  return room;
}

describe('casual poker bot', () => {
  it('uses only its own cards and public state, with reproducible seeded decisions', () => {
    const room = river();
    const expected = chooseBotAction(room, room.hand!.actorId!, ['Js', 'Ts'], seeded());
    const forbid = () => {
      throw new Error('Private information was accessed');
    };
    Object.defineProperties(room, {
      undo: { get: forbid },
      ledger: { get: forbid },
      deck: { get: forbid },
      holeCards: { get: forbid },
      secrets: { get: forbid },
    });
    Object.defineProperty(room.hand!, 'showdownHands', { get: forbid });
    expect(chooseBotAction(room, room.hand!.actorId!, ['Js', 'Ts'], seeded())).toEqual(expected);
  });

  it('value bets the nuts without shoving a deep stack', () => {
    const room = river();
    const command = chooseBotAction(room, room.hand!.actorId!, ['Js', 'Ts'], seeded());
    expect(command.action).toBe('bet');
    expect(command.to).toBeGreaterThanOrEqual(100);
    expect(command.to).toBeLessThan(200);
    expect(() => act(room, command)).not.toThrow();
  });

  it('folds a weak river hand to an expensive bet', () => {
    let room = river();
    room = act(room, { type: 'act', action: 'bet', to: 1000 });
    const command = chooseBotAction(room, room.hand!.actorId!, ['7h', '8d'], seeded());
    expect(command).toEqual({ type: 'act', action: 'fold' });
    expect(() => act(room, command)).not.toThrow();
  });

  it('can make a short all-in with the nuts and checks when raising cannot reopen', () => {
    const short = river();
    const actor = short.participants.find((item) => item.id === short.hand!.actorId)!;
    actor.externalAdjustment += 10 - actor.stack;
    actor.stack = 10;
    const shove = chooseBotAction(short, actor.id, ['Js', 'Ts'], seeded());
    expect(shove.action).toBe('all-in');
    expect(() => act(short, shove)).not.toThrow();

    const closed = river();
    const player = closed.hand!.players.find(
      (item) => item.participantId === closed.hand!.actorId,
    )!;
    closed.hand!.currentBet = 50;
    player.streetCommitted = 50;
    player.reopenAtBet = 100;
    expect(legalActions(closed, player.participantId)!.actions).not.toContain('raise');
    expect(chooseBotAction(closed, player.participantId, ['Js', 'Ts'], seeded()).action).toBe(
      'check',
    );
  });

  it('calls rather than illegally reraising after a short all-in', () => {
    let room = table(3, 500);
    const hand = room.hand!;
    hand.street = 'FLOP';
    hand.communityCards = ['As', 'Ks', 'Qs'];
    hand.currentBet = 0;
    hand.lastFullRaiseSize = 100;
    hand.bigBlind = 100;
    hand.players.forEach((player) => {
      player.streetCommitted = 0;
      player.hasActed = false;
      player.reopenAtBet = null;
    });
    room = act(room, { type: 'act', action: 'bet', to: 100 });
    const shortStack = room.participants.find((item) => item.id === room.hand!.actorId)!;
    shortStack.externalAdjustment += 150 - shortStack.stack;
    shortStack.stack = 150;
    room = act(room, { type: 'act', action: 'all-in' });
    room = act(room, { type: 'act', action: 'call' });
    expect(legalActions(room, room.hand!.actorId!)!.actions).not.toContain('raise');
    const command = chooseBotAction(room, room.hand!.actorId!, ['Js', 'Ts'], seeded());
    expect(command.action).toBe('call');
    expect(() => act(room, command)).not.toThrow();
  });

  it('stops a raise war after two aggressive public actions', () => {
    let room = river();
    room = act(room, { type: 'act', action: 'bet', to: 100 });
    room = act(room, { type: 'act', action: 'raise', to: 300 });
    expect(chooseBotAction(room, room.hand!.actorId!, ['Js', 'Ts'], seeded()).action).toBe('call');
  });

  it('produces legal, unit-aligned choices across player counts, streets and stack sizes', () => {
    for (const count of [2, 6, 10]) {
      for (const stack of [30, 500, 2000]) {
        let room = table(count, stack, 5);
        let steps = 0;
        while (room.hand!.phase === 'BETTING' && steps < 30) {
          const id = room.hand!.actorId!;
          const command = chooseBotAction(
            room,
            id,
            steps % 2 ? ['7h', '2d'] : ['Ah', 'Ad'],
            seeded(steps + count),
          );
          expect(legalActions(room, id)!.actions).toContain(command.action);
          if (command.to !== undefined) expect(command.to % 5).toBe(0);
          room = act(room, command);
          steps += 1;
        }
        expect(steps).toBeLessThan(30);
      }
    }
    for (const street of ['FLOP', 'TURN', 'RIVER'] as const) {
      const room = river();
      room.hand!.street = street;
      room.hand!.communityCards = room.hand!.communityCards!.slice(
        0,
        street === 'FLOP' ? 3 : street === 'TURN' ? 4 : 5,
      );
      const command = chooseBotAction(room, room.hand!.actorId!, ['Jh', 'Th'], seeded());
      expect(() => act(room, command)).not.toThrow();
    }
  });

  it('rejects a wrong turn or unavailable/duplicate private cards', () => {
    const room = river();
    expect(() => chooseBotAction(room, 'missing', ['Js', 'Ts'])).toThrow('当前无法行动');
    expect(() => chooseBotAction(room, room.hand!.actorId!, [])).toThrow('手牌或公共牌无效');
    expect(() => chooseBotAction(room, room.hand!.actorId!, ['As', 'As'])).toThrow(
      '手牌或公共牌无效',
    );
  });
});
