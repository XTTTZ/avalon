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

  it.each(['FLOP', 'TURN', 'RIVER'] as const)(
    'offers small and overbet pot ratios when opening the %s',
    (street) => {
      const room = flopState(roomWithPlayers(3));
      room.hand!.street = street;
      room.hand!.bigBlind = 20;
      room.hand!.lastFullRaiseSize = 20;
      for (const player of room.hand!.players) player.handCommitted = 40;

      const shortcuts = legalActions(room, room.hand!.actorId!)!.shortcuts;
      expect(shortcuts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ label: '1/4 Pot', to: 30 }),
          expect.objectContaining({ label: '4/3 Pot', to: 160 }),
          expect.objectContaining({ label: '1.5 Pot', to: 180 }),
        ]),
      );
    },
  );

  it('keeps pot ratios and bet multiples when raising postflop', () => {
    const room = flopState(roomWithPlayers(3));
    const [actor, bettor, priorContributor] = room.hand!.players;
    room.hand!.bigBlind = 20;
    room.hand!.currentBet = 20;
    room.hand!.lastFullRaiseSize = 20;
    actor.streetCommitted = 0;
    actor.handCommitted = 0;
    bettor.streetCommitted = 20;
    bettor.handCommitted = 20;
    priorContributor.handCommitted = 100;

    const shortcuts = legalActions(room, actor.participantId)!.shortcuts;
    expect(shortcuts.find((item) => item.to === 40)?.label).toBe('1/3 Pot · 2×');
    expect(shortcuts.find((item) => item.to === 50)?.label).toBe('2.5×');
    expect(shortcuts.find((item) => item.to === 60)?.label).toBe('1/2 Pot · 3×');
    expect(shortcuts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '4/3 Pot', to: 160 }),
        expect.objectContaining({ label: '1.5 Pot', to: 180 }),
      ]),
    );
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

describe('Online bot membership', () => {
  function onlineRoom(count = 1) {
    const room = roomWithPlayers(count);
    room.config.mode = 'online';
    return room;
  }

  it('adds bots with unique names, private identities, initial chips and reversible membership', () => {
    let room = onlineRoom();
    room = joinRoom(room, 'named-human', '机器人 1', 'spectator', 1100);
    const originalMembers = structuredClone(room.members);
    const originalParticipants = structuredClone(room.participants);
    const originalLedger = structuredClone(room.ledger);
    room = applyCommand(room, 'user-1', { type: 'add-bot' }, 1200);
    const bot = room.participants.at(-1)!;
    const botMember = room.members.find((item) => item.id === bot.memberId)!;
    expect(bot).toMatchObject({
      name: '机器人 2',
      isBot: true,
      active: true,
      seat: 1,
      stack: 2000,
    });
    expect(botMember).toMatchObject({ isBot: true, participantId: bot.id });
    expect(botMember.userId).toMatch(/^bot:/);
    expect(room.ledger.at(-1)).toMatchObject({
      participantId: bot.id,
      type: 'INITIAL',
      amount: 2000,
    });
    const publicMember = projectRoom(room, 'user-1').members.find((item) => item.isBot)!;
    expect(publicMember).toMatchObject({ id: bot.memberId, isBot: true });
    expect(publicMember).not.toHaveProperty('userId');
    room = applyCommand(room, 'user-1', { type: 'undo' }, 1300);
    expect(room.members.map(({ lastActiveAt: _lastActiveAt, ...item }) => item)).toEqual(
      originalMembers.map(({ lastActiveAt: _lastActiveAt, ...item }) => item),
    );
    expect(room.participants).toEqual(originalParticipants);
    expect(room.ledger).toEqual(originalLedger);
    expect(room.events.find((item) => item.participantId === bot.id)?.revertedBy).toBeDefined();
  });

  it('retains removed bot balances and audit records and can undo removal', () => {
    let room = applyCommand(onlineRoom(), 'user-1', { type: 'add-bot' }, 1100);
    const botId = room.participants.at(-1)!.id;
    room = applyCommand(
      room,
      'user-1',
      { type: 'refill', participantId: botId, amount: 500 },
      1200,
    );
    const botBefore = structuredClone(room.participants.find((item) => item.id === botId)!);
    const ledgerBefore = structuredClone(room.ledger);
    room = applyCommand(room, 'user-1', { type: 'remove-bot', participantId: botId }, 1300);
    expect(room.participants.find((item) => item.id === botId)).toMatchObject({
      active: false,
      seat: null,
      stack: 2500,
      initialChips: 2000,
      refillTotal: 500,
    });
    expect(room.ledger).toEqual(ledgerBefore);
    expect(room.members.find((item) => item.id === botBefore.memberId)?.removedAt).toBe(1300);
    expect(projectRoom(room, 'user-1').members.some((item) => item.id === botBefore.memberId)).toBe(
      false,
    );
    room = applyCommand(room, 'user-1', { type: 'undo' }, 1400);
    expect(room.participants.find((item) => item.id === botId)).toEqual(botBefore);
    expect(room.members.find((item) => item.id === botBefore.memberId)?.removedAt).toBeUndefined();
    room = applyCommand(room, 'user-1', { type: 'remove-bot', participantId: botId }, 1500);
    room = applyCommand(room, 'user-1', { type: 'add-bot' }, 1600);
    expect(room.participants.at(-1)?.name).toBe('机器人 2');
    expect(room.participants.reduce((sum, item) => sum + item.stack, 0)).toBe(6500);
  });

  it('allows spectator dealers to manage bots and rejects ordinary players or human targets', () => {
    let room = onlineRoom(2);
    room = joinRoom(room, 'dealer', '荷官', 'spectator', 1100);
    const dealer = room.members.find((item) => item.userId === 'dealer')!;
    room = applyCommand(room, 'user-1', { type: 'assign-dealer', memberId: dealer.id }, 1200);
    room = applyCommand(room, 'dealer', { type: 'add-bot' }, 1300);
    const botId = room.participants.at(-1)!.id;
    expect(() => applyCommand(room, 'user-2', { type: 'add-bot' })).toThrow('需要房主或荷官权限');
    expect(() =>
      applyCommand(room, 'user-2', { type: 'remove-bot', participantId: botId }),
    ).toThrow('需要房主或荷官权限');
    expect(() =>
      applyCommand(room, 'dealer', { type: 'remove-bot', participantId: room.participants[0].id }),
    ).toThrow('机器人不存在');
    room = applyCommand(room, 'dealer', { type: 'remove-bot', participantId: botId }, 1400);
    expect(room.participants.find((item) => item.id === botId)?.active).toBe(false);
  });

  it('restricts bots to online rooms between hands and never grants them room control', () => {
    const chipsRoom = roomWithPlayers(1);
    expect(() => applyCommand(chipsRoom, 'user-1', { type: 'add-bot' })).toThrow('仅线上模式');
    expect(() =>
      applyCommand(chipsRoom, 'user-1', {
        type: 'remove-bot',
        participantId: chipsRoom.participants[0].id,
      }),
    ).toThrow('仅线上模式');
    let room = applyCommand(onlineRoom(), 'user-1', { type: 'add-bot' }, 1100);
    const bot = room.participants.at(-1)!;
    expect(() =>
      applyCommand(room, 'user-1', { type: 'assign-dealer', memberId: bot.memberId }),
    ).toThrow('机器人不能担任荷官');
    expect(() =>
      applyCommand(room, 'user-1', { type: 'transfer-owner', memberId: bot.memberId }),
    ).toThrow('机器人不能担任房主');
    expect(() =>
      applyCommand(room, 'user-1', {
        type: 'configure',
        config: { ...room.config, mode: 'chips' },
      }),
    ).toThrow('房间创建后不能切换牌局模式');
    room = start(room);
    expect(() => applyCommand(room, 'user-1', { type: 'add-bot' })).toThrow(
      '请在两手之间添加机器人',
    );
    expect(() =>
      applyCommand(room, 'user-1', { type: 'remove-bot', participantId: bot.id }),
    ).toThrow('请在两手之间移除机器人');
  });

  it('enforces ten seated players and thirty-two current members, releasing capacity on removal', () => {
    let room = onlineRoom();
    for (let i = 0; i < 9; i++) room = applyCommand(room, 'user-1', { type: 'add-bot' }, 1100 + i);
    expect(() => applyCommand(room, 'user-1', { type: 'add-bot' })).toThrow('牌桌座位已满');
    room = applyCommand(
      room,
      'user-1',
      { type: 'remove-bot', participantId: room.participants[4].id },
      1200,
    );
    room = applyCommand(room, 'user-1', { type: 'add-bot' }, 1300);
    expect(room.participants.at(-1)?.seat).toBe(4);
    let crowded = onlineRoom();
    for (let i = 0; i < 30; i++)
      crowded = joinRoom(crowded, `spectator-${i}`, `旁观${i}`, 'spectator', 1100 + i);
    crowded = applyCommand(crowded, 'user-1', { type: 'add-bot' }, 1200);
    expect(() => applyCommand(crowded, 'user-1', { type: 'add-bot' })).toThrow('房间人数已满');
    crowded = applyCommand(
      crowded,
      'user-1',
      { type: 'remove-bot', participantId: crowded.participants.at(-1)!.id },
      1300,
    );
    expect(() => applyCommand(crowded, 'user-1', { type: 'add-bot' }, 1400)).not.toThrow();
  });

  it('counts seated players rather than spectator accounts when humans join or return', () => {
    let room = onlineRoom(10);
    const departing = room.participants[1];
    room = applyCommand(
      room,
      'user-1',
      { type: 'remove-member', memberId: departing.memberId },
      1100,
    );
    for (const player of room.participants.slice(2))
      room = applyCommand(
        room,
        'user-1',
        { type: 'set-participant-active', participantId: player.id, active: false },
        1200,
      );
    room = applyCommand(room, 'user-1', { type: 'add-bot' }, 1300);
    room = joinRoom(room, 'user-2', '玩家2', 'player', 1400);
    room = joinRoom(room, 'new-human', '新玩家', 'player', 1500);
    expect(room.participants.filter((item) => item.active && item.seat !== null)).toHaveLength(4);
    room = applyCommand(
      room,
      'user-1',
      { type: 'remove-member', memberId: departing.memberId },
      1600,
    );
    forceStack(room, departing.id, 0);
    room = joinRoom(room, 'user-2', '玩家2', 'player', 1700);
    expect(room.participants.find((item) => item.id === departing.id)).toMatchObject({
      active: false,
      seat: null,
    });
  });

  it('pauses an undo that restores a bot turn so the bot cannot immediately replay it', () => {
    let room = applyCommand(onlineRoom(), 'user-1', { type: 'add-bot' }, 1100);
    const bot = room.participants.at(-1)!;
    const botUser = memberUser(room, bot.id);
    room = start(room, bot.id);
    expect(room.hand!.actorId).toBe(bot.id);
    const before = structuredClone(room.hand);
    room = applyCommand(room, botUser, { type: 'act', action: 'call' }, 2100);
    room = applyCommand(room, 'user-1', { type: 'undo' }, 2200);
    expect(room.hand).toMatchObject({ actorId: bot.id, currentBet: before!.currentBet });
    expect(room.hand!.players).toEqual(before!.players);
    expect(room.paused).toBe(true);
    expect(room.events.slice(-2).map((item) => item.type)).toEqual([
      'ACTION_UNDONE',
      'SESSION_PAUSED',
    ]);
    expect(legalActions(room, bot.id)).toBeNull();
    room = applyCommand(room, 'user-1', { type: 'resume' }, 2300);
    expect(legalActions(room, bot.id)?.actions).toContain('call');
  });
});

describe('Permissions and correction', () => {
  it('moves left and right past the neighboring player, preserving gaps and other seats', () => {
    let room = roomWithPlayers(4);
    room.participants.forEach((item, index) => (item.seat = [0, 2, 5, 8][index]));
    const targetId = room.participants[1].id;
    room = applyCommand(
      room,
      'user-2',
      { type: 'move-seat', participantId: targetId, direction: 'left' },
      1300,
    );
    expect(room.participants.map((item) => item.seat)).toEqual([0, 5, 2, 8]);
    expect(room.events.at(-1)).toMatchObject({
      type: 'SEATS_CHANGED',
      participantId: targetId,
      detail: '玩家2 向左换到 玩家3 的另一侧',
    });
    room = applyCommand(
      room,
      'user-2',
      { type: 'move-seat', participantId: targetId, direction: 'right' },
      1400,
    );
    expect(room.participants.map((item) => item.seat)).toEqual([0, 2, 5, 8]);
  });

  it('wraps around the table, ignores spectators, and restores both seats on undo', () => {
    let room = roomWithPlayers(4);
    const targetId = room.participants[0].id;
    room = applyCommand(
      room,
      'user-1',
      { type: 'set-participant-active', participantId: room.participants[3].id, active: false },
      1200,
    );
    room = joinRoom(room, 'spectator', '旁观', 'spectator', 1250);
    const originalSeats = room.participants.map((item) => item.seat);
    room = applyCommand(
      room,
      'user-1',
      { type: 'move-seat', participantId: targetId, direction: 'right' },
      1300,
    );
    expect(room.participants.map((item) => item.seat)).toEqual([2, 1, 0, null]);
    const moveEventId = room.events.at(-1)!.id;
    room = applyCommand(room, 'user-1', { type: 'undo' }, 1400);
    expect(room.participants.map((item) => item.seat)).toEqual(originalSeats);
    expect(room.events.find((item) => item.id === moveEventId)?.revertedBy).toBe(
      room.events.at(-1)!.id,
    );
  });

  it('supports either direction heads-up and rejects a table with only one seated player', () => {
    let room = roomWithPlayers(2);
    const targetId = room.participants[1].id;
    room = applyCommand(
      room,
      'user-2',
      { type: 'move-seat', participantId: targetId, direction: 'left' },
      1300,
    );
    expect(room.participants.map((item) => item.seat)).toEqual([1, 0]);
    room = applyCommand(
      room,
      'user-2',
      { type: 'move-seat', participantId: targetId, direction: 'right' },
      1400,
    );
    expect(room.participants.map((item) => item.seat)).toEqual([0, 1]);
    room = applyCommand(
      room,
      'user-2',
      { type: 'set-participant-active', participantId: targetId, active: false },
      1500,
    );
    expect(() =>
      applyCommand(room, 'user-1', {
        type: 'move-seat',
        participantId: room.participants[0].id,
        direction: 'left',
      }),
    ).toThrow('需要至少两位入座玩家');
    expect(() =>
      applyCommand(room, 'user-2', {
        type: 'move-seat',
        participantId: targetId,
        direction: 'left',
      }),
    ).toThrow('请先加入牌桌再换座');
  });

  it('allows owner and spectator dealer to move players and send them to spectators', () => {
    let room = roomWithPlayers(3);
    room = joinRoom(room, 'spectator', '荷官', 'spectator', 1200);
    const spectator = room.members.find((item) => item.userId === 'spectator')!;
    room = applyCommand(room, 'user-1', { type: 'assign-dealer', memberId: spectator.id }, 1300);
    const targetId = room.participants[1].id;
    room = applyCommand(
      room,
      'user-1',
      { type: 'move-seat', participantId: targetId, direction: 'left' },
      1400,
    );
    expect(room.participants.map((item) => item.seat)).toEqual([0, 2, 1]);
    room = applyCommand(
      room,
      'spectator',
      { type: 'move-seat', participantId: targetId, direction: 'right' },
      1500,
    );
    expect(room.participants.map((item) => item.seat)).toEqual([0, 1, 2]);
    for (const userId of ['user-1', 'spectator']) {
      room = applyCommand(
        room,
        userId,
        { type: 'set-participant-active', participantId: targetId, active: false },
        1600,
      );
      expect(room.participants[1]).toMatchObject({ active: false, seat: null });
      room = applyCommand(
        room,
        userId,
        { type: 'set-participant-active', participantId: targetId, active: true },
        1700,
      );
    }
    room = applyCommand(room, 'user-1', { type: 'assign-dealer', memberId: null }, 1800);
    expect(() =>
      applyCommand(room, 'spectator', {
        type: 'move-seat',
        participantId: targetId,
        direction: 'left',
      }),
    ).toThrow('需要房主或荷官权限');
  });

  it('rejects moving another player without permission and any seat changes during a hand', () => {
    let room = roomWithPlayers(3);
    const targetId = room.participants[1].id;
    expect(() =>
      applyCommand(room, 'user-3', {
        type: 'move-seat',
        participantId: targetId,
        direction: 'left',
      }),
    ).toThrow('需要房主或荷官权限');
    expect(() =>
      applyCommand(room, 'user-3', {
        type: 'set-participant-active',
        participantId: targetId,
        active: false,
      }),
    ).toThrow('需要房主或荷官权限');
    room = start(room);
    for (const userId of ['user-1', 'user-2']) {
      expect(() =>
        applyCommand(room, userId, {
          type: 'move-seat',
          participantId: targetId,
          direction: 'left',
        }),
      ).toThrow('请在两手之间更换座位');
      expect(() =>
        applyCommand(room, userId, {
          type: 'set-participant-active',
          participantId: targetId,
          active: false,
        }),
      ).toThrow('请在两手之间调整入座状态');
    }
  });

  it('rejects moving a participant whose member has left the room', () => {
    const room = roomWithPlayers(3);
    const target = room.participants[1];
    room.members.find((item) => item.id === target.memberId)!.removedAt = 1200;
    expect(() =>
      applyCommand(room, 'user-1', {
        type: 'move-seat',
        participantId: target.id,
        direction: 'left',
      }),
    ).toThrow('该玩家已离开房间');
  });

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
