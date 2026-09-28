import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, type HandState, type RoomState } from '../shared/types.js';
import {
  applyCommand,
  calculatePots,
  createRoom,
  joinRoom,
  legalActions,
  projectRoom,
} from '../server/domain/engine.js';

const config = () => structuredClone(DEFAULT_CONFIG);

function roomWithPlayers(count: number, stack = 2000) {
  let room = createRoom('1234', 'user-1', '玩家1', { ...config(), initialStack: stack }, 1000);
  for (let index = 2; index <= count; index++)
    room = joinRoom(room, `user-${index}`, `玩家${index}`, 'player', 1000 + index);
  return room;
}

function memberUser(room: RoomState, participantId: string) {
  const participant = room.participants.find((item) => item.id === participantId)!;
  return room.members.find((item) => item.id === participant.memberId)!.userId;
}

function start(room: RoomState, buttonId = room.participants[0].id) {
  return applyCommand(room, 'user-1', { type: 'start-hand', buttonId }, 2000);
}

function forceStack(room: RoomState, participantId: string, stack: number) {
  const target = room.participants.find((item) => item.id === participantId)!;
  target.externalAdjustment += stack - target.stack;
  target.stack = stack;
}

function flopState(room: RoomState): RoomState {
  const players = room.participants.map((item) => ({
    participantId: item.id,
    seat: item.seat!,
    streetCommitted: 0,
    handCommitted: 0,
    folded: false,
    allIn: false,
    hasActed: false,
    reopenAtBet: null,
  }));
  const hand: HandState = {
    id: 'hand-test',
    number: 1,
    phase: 'BETTING',
    street: 'FLOP',
    players,
    buttonId: players.at(-1)!.participantId,
    previousButtonId: null,
    smallBlindId: players[0].participantId,
    bigBlindId: players[1].participantId,
    actorId: players[0].participantId,
    needsAction: players.map((item) => item.participantId),
    currentBet: 0,
    lastFullRaiseSize: 100,
    smallBlind: 50,
    bigBlind: 100,
    pots: [],
    uncalled: null,
    settlementDraft: [],
    startedAt: 1000,
    revision: 1,
  };
  return { ...room, hand };
}

describe('Poker betting engine', () => {
  it('posts blinds and starts preflop left of the big blind', () => {
    const room = start(roomWithPlayers(4));
    const hand = room.hand!;
    const ordered = room.participants.sort((a, b) => a.seat! - b.seat!);
    expect(hand.buttonId).toBe(ordered[0].id);
    expect(hand.smallBlindId).toBe(ordered[1].id);
    expect(hand.bigBlindId).toBe(ordered[2].id);
    expect(hand.actorId).toBe(ordered[3].id);
    expect(ordered[1].stack).toBe(1990);
    expect(ordered[2].stack).toBe(1980);
  });

  it('keeps the big blind action after every other player calls', () => {
    let room = start(roomWithPlayers(3));
    const hand = room.hand!;
    const first = hand.actorId!;
    room = applyCommand(room, memberUser(room, first), { type: 'act', action: 'call' }, 2100);
    const second = room.hand!.actorId!;
    room = applyCommand(room, memberUser(room, second), { type: 'act', action: 'call' }, 2200);
    expect(room.hand!.actorId).toBe(hand.bigBlindId);
    expect(legalActions(room, hand.bigBlindId)?.actions).toContain('check');
    room = applyCommand(
      room,
      memberUser(room, hand.bigBlindId),
      { type: 'act', action: 'check' },
      2300,
    );
    expect(room.hand!.phase).toBe('AWAITING_STREET_CONFIRMATION');
  });

  it('does not reopen a bet after one short all-in', () => {
    let room = flopState(roomWithPlayers(3, 500));
    const [a, b, c] = room.participants;
    forceStack(room, b.id, 150);
    room = applyCommand(
      room,
      memberUser(room, a.id),
      { type: 'act', action: 'bet', to: 100 },
      2000,
    );
    room = applyCommand(room, memberUser(room, b.id), { type: 'act', action: 'all-in' }, 2100);
    room = applyCommand(room, memberUser(room, c.id), { type: 'act', action: 'call' }, 2200);
    const actions = legalActions(room, a.id)?.actions ?? [];
    expect(room.hand!.actorId).toBe(a.id);
    expect(actions).toContain('call');
    expect(actions).not.toContain('raise');
  });

  it('reopens a bet after cumulative short all-ins reach a full raise', () => {
    let room = flopState(roomWithPlayers(4, 500));
    const [a, b, c, d] = room.participants;
    forceStack(room, b.id, 150);
    forceStack(room, c.id, 200);
    room = applyCommand(
      room,
      memberUser(room, a.id),
      { type: 'act', action: 'bet', to: 100 },
      2000,
    );
    room = applyCommand(room, memberUser(room, b.id), { type: 'act', action: 'all-in' }, 2100);
    room = applyCommand(room, memberUser(room, c.id), { type: 'act', action: 'all-in' }, 2200);
    room = applyCommand(room, memberUser(room, d.id), { type: 'act', action: 'call' }, 2300);
    expect(room.hand!.actorId).toBe(a.id);
    expect(legalActions(room, a.id)?.actions).toContain('raise');
    expect(legalActions(room, a.id)?.minRaiseTo).toBe(300);
  });

  it('does not allow a player to bet into an empty side pot', () => {
    let room = flopState(roomWithPlayers(2, 100));
    const [a, b] = room.participants;
    forceStack(room, b.id, 0);
    const bHand = room.hand!.players.find((item) => item.participantId === b.id)!;
    bHand.allIn = true;
    room.hand!.needsAction = [a.id];
    expect(legalActions(room, a.id)?.actions).not.toContain('bet');
    room = applyCommand(room, memberUser(room, a.id), { type: 'act', action: 'check' }, 2000);
    expect(room.hand!.phase).toBe('AWAITING_STREET_CONFIRMATION');
  });

  it('advances an all-in runout with one dealer confirmation', () => {
    let room = flopState(roomWithPlayers(2, 100));
    for (const participant of room.participants) forceStack(room, participant.id, 0);
    for (const player of room.hand!.players) player.allIn = true;
    room.hand!.phase = 'AWAITING_STREET_CONFIRMATION';
    room.hand!.actorId = null;
    room.hand!.needsAction = [];
    room = applyCommand(room, 'user-1', { type: 'confirm-street' }, 2000);
    expect(room.hand!.street).toBe('SHOWDOWN');
    expect(room.hand!.phase).toBe('SHOWDOWN');
  });
});

describe('Pots and settlement', () => {
  it('builds main and side pots for several all-in caps', () => {
    const result = calculatePots([
      { participantId: 'a', handCommitted: 100, folded: false, allIn: true },
      { participantId: 'b', handCommitted: 300, folded: false, allIn: true },
      { participantId: 'c', handCommitted: 500, folded: false, allIn: false },
      { participantId: 'd', handCommitted: 500, folded: false, allIn: false },
    ]);
    expect(result.uncalled).toBeNull();
    expect(result.pots.map((pot) => pot.amount)).toEqual([400, 600, 400]);
    expect(result.pots.map((pot) => pot.eligibleIds.length)).toEqual([4, 3, 2]);
  });

  it('keeps folded dead money but removes the player from eligibility', () => {
    const result = calculatePots([
      { participantId: 'a', handCommitted: 100, folded: false, allIn: true },
      { participantId: 'b', handCommitted: 300, folded: true, allIn: true },
      { participantId: 'c', handCommitted: 500, folded: false, allIn: false },
      { participantId: 'd', handCommitted: 500, folded: false, allIn: false },
    ]);
    expect(result.pots.map((pot) => pot.amount)).toEqual([400, 1000]);
    expect(result.pots[0].eligibleIds).toEqual(['a', 'c', 'd']);
    expect(result.pots[1].eligibleIds).toEqual(['c', 'd']);
  });

  it('separates a unique unmatched top contribution', () => {
    const result = calculatePots([
      { participantId: 'a', handCommitted: 100, folded: false, allIn: true },
      { participantId: 'b', handCommitted: 300, folded: false, allIn: true },
      { participantId: 'c', handCommitted: 500, folded: false, allIn: false },
    ]);
    expect(result.pots.map((pot) => pot.amount)).toEqual([300, 400]);
    expect(result.uncalled).toEqual({ participantId: 'c', amount: 200 });
  });

  it('awards an odd chip to the first winner left of the button', () => {
    let room = roomWithPlayers(3, 100);
    const [button, left, other] = room.participants;
    room = flopState(room);
    for (const player of room.hand!.players) {
      player.handCommitted = 101 / 3;
    }
    room.hand!.players[0].handCommitted = 33;
    room.hand!.players[1].handCommitted = 34;
    room.hand!.players[2].handCommitted = 34;
    room.hand!.buttonId = button.id;
    room.hand!.pots = [
      {
        id: 'pot-1',
        amount: 101,
        contributorIds: [button.id, left.id, other.id],
        eligibleIds: [left.id, other.id],
        cap: 34,
      },
    ];
    room.hand!.phase = 'SHOWDOWN';
    room.participants.forEach((participant) => {
      participant.stack = 0;
      participant.externalAdjustment =
        room.hand!.players.find((player) => player.participantId === participant.id)!
          .handCommitted - participant.initialChips;
    });
    room = applyCommand(
      room,
      'user-1',
      { type: 'settle', pots: [{ potId: 'pot-1', winnerIds: [left.id, other.id] }] },
      3000,
    );
    expect(room.participants.find((item) => item.id === left.id)!.stack).toBe(51);
    expect(room.participants.find((item) => item.id === other.id)!.stack).toBe(50);
  });
});

describe('Permissions and correction', () => {
  it('lets a spectator dealer advance streets but never act for a player', () => {
    let room = roomWithPlayers(2);
    room = joinRoom(room, 'spectator', '荷官', 'spectator', 1200);
    const spectator = room.members.find((item) => item.userId === 'spectator')!;
    room = applyCommand(room, 'user-1', { type: 'assign-dealer', memberId: spectator.id }, 1300);
    room = applyCommand(
      room,
      'spectator',
      { type: 'start-hand', buttonId: room.participants[0].id },
      1400,
    );
    expect(() => applyCommand(room, 'spectator', { type: 'act', action: 'fold' }, 1500)).toThrow(
      '旁观者不能下注',
    );
  });

  it('revokes dealer permission immediately', () => {
    let room = roomWithPlayers(2);
    room = joinRoom(room, 'spectator', '荷官', 'spectator', 1200);
    const spectator = room.members.find((item) => item.userId === 'spectator')!;
    room = applyCommand(room, 'user-1', { type: 'assign-dealer', memberId: spectator.id }, 1300);
    room = applyCommand(room, 'user-1', { type: 'assign-dealer', memberId: null }, 1400);
    expect(() =>
      applyCommand(
        room,
        'spectator',
        { type: 'start-hand', buttonId: room.participants[0].id },
        1500,
      ),
    ).toThrow('需要房主或荷官权限');
  });

  it('undoes a wager without rolling back room permission or version', () => {
    let room = start(roomWithPlayers(3));
    const actorId = room.hand!.actorId!;
    const userId = memberUser(room, actorId);
    const stackBefore = room.participants.find((item) => item.id === actorId)!.stack;
    room = applyCommand(room, userId, { type: 'act', action: 'call' }, 2100);
    const version = room.version;
    room = applyCommand(room, 'user-1', { type: 'undo' }, 2200);
    expect(room.version).toBeGreaterThan(version);
    expect(room.participants.find((item) => item.id === actorId)!.stack).toBe(stackBefore);
    expect(room.hand!.actorId).toBe(actorId);
    expect(projectRoom(room, userId).legalActions).not.toBeNull();
  });
});
