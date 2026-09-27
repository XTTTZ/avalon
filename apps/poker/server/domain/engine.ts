import { randomUUID } from 'node:crypto';
import {
  PokerError,
  type GameConfig,
  type HandPlayer,
  type HandState,
  type LegalActions,
  type Participant,
  type PlayerAction,
  type PokerCommand,
  type PokerEvent,
  type Pot,
  type RoomState,
  type RoomView,
  type SettlementChoice,
  type Street,
  type UndoSnapshot,
} from '../../shared/types.js';

const DAY = 86_400_000;
const ROOM_TTL = 30 * DAY;
const MAX_STACK = 1_000_000_000;
const MAX_TOTAL = 1_000_000_000_000;

const copy = <T>(value: T): T => structuredClone(value);
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const normalizeName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ');

function invalid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PokerError('INVALID', message);
}

export function validateConfig(config: GameConfig): GameConfig {
  invalid(config && typeof config === 'object', '牌局设置无效');
  invalid(['standard', 'short-deck'].includes(config.variant), '请选择有效牌型');
  invalid(integer(config.chipUnit) && config.chipUnit > 0, '最小筹码单位无效');
  invalid(
    integer(config.initialStack) &&
      config.initialStack > 0 &&
      config.initialStack <= MAX_STACK &&
      config.initialStack % config.chipUnit === 0,
    '初始筹码无效',
  );
  invalid(
    Array.isArray(config.blindLevels) &&
      config.blindLevels.length > 0 &&
      config.blindLevels.length <= 50,
    '至少设置一个盲注级别',
  );
  for (const level of config.blindLevels) {
    invalid(
      integer(level.smallBlind) &&
        integer(level.bigBlind) &&
        level.smallBlind > 0 &&
        level.smallBlind <= level.bigBlind &&
        level.bigBlind <= MAX_STACK &&
        level.smallBlind % config.chipUnit === 0 &&
        level.bigBlind % config.chipUnit === 0,
      '盲注必须为有效筹码整数，且小盲不能高于大盲',
    );
  }
  invalid(['manual', 'hands'].includes(config.blindUpgrade), '盲注升级方式无效');
  invalid(integer(config.handsPerLevel) && config.handsPerLevel >= 1, '每级手数无效');
  invalid(
    integer(config.defaultRefill) &&
      config.defaultRefill > 0 &&
      config.defaultRefill <= MAX_STACK &&
      config.defaultRefill % config.chipUnit === 0,
    '默认补码无效',
  );
  return copy(config);
}

function event(
  room: RoomState,
  actorMemberId: string,
  type: PokerEvent['type'],
  detail: string,
  fields: Partial<PokerEvent> = {},
  now = Date.now(),
) {
  const entry: PokerEvent = {
    id: randomUUID(),
    seq: (room.events.at(-1)?.seq ?? 0) + 1,
    type,
    at: now,
    actorMemberId,
    detail,
    ...fields,
  };
  room.events.push(entry);
  return entry;
}

function finish(room: RoomState, now: number) {
  room.version += 1;
  room.phaseKey = randomUUID();
  room.updatedAt = now;
  room.expiresAt = now + ROOM_TTL;
  if (room.hand) room.hand.revision += 1;
  return room;
}

function participant(room: RoomState, id: string) {
  const value = room.participants.find((item) => item.id === id);
  if (!value) throw new PokerError('NOT_FOUND', '玩家不存在');
  return value;
}

function member(room: RoomState, userId: string) {
  const value = room.members.find((item) => item.userId === userId && !item.removedAt);
  if (!value) throw new PokerError('FORBIDDEN', '你不在此房间');
  return value;
}

function activeSeats(room: RoomState) {
  return room.participants
    .filter((item) => item.active && item.seat !== null)
    .sort((a, b) => a.seat! - b.seat!);
}

function activePlayerMembers(room: RoomState) {
  return room.members.filter((item) => !item.removedAt && item.participantId);
}

function handParticipant(room: RoomState, id: string) {
  const value = room.hand?.players.find((item) => item.participantId === id);
  if (!value) throw new PokerError('NOT_FOUND', '本手玩家不存在');
  return value;
}

function snapshot(room: RoomState, eventId = ''): UndoSnapshot {
  return {
    eventId,
    eventLength: room.events.length,
    members: copy(room.members),
    participants: copy(room.participants),
    hand: copy(room.hand),
    ownerMemberId: room.ownerMemberId,
    dealerMemberId: room.dealerMemberId,
    paused: room.paused,
    config: copy(room.config),
    lastButtonId: room.lastButtonId,
    completedHands: room.completedHands,
    blindLevel: room.blindLevel,
    ledgerLength: room.ledger.length,
  };
}

function keepUndo(room: RoomState, before: UndoSnapshot, eventId: string) {
  before.eventId = eventId;
  room.undo.push(before);
  if (room.undo.length > 100) room.undo.splice(0, room.undo.length - 100);
}

function ledger(
  room: RoomState,
  eventId: string,
  participantId: string,
  type: RoomState['ledger'][number]['type'],
  amount: number,
  now: number,
  handId?: string,
) {
  room.ledger.push({ id: randomUUID(), eventId, participantId, type, amount, at: now, handId });
}

function assertChipConservation(room: RoomState) {
  const issued = room.participants.reduce(
    (sum, item) =>
      sum + item.initialChips + item.refillTotal + item.rebuyTotal + item.externalAdjustment,
    0,
  );
  const held = room.participants.reduce((sum, item) => sum + item.stack, 0);
  const committed =
    room.hand && !['SETTLED', 'VOIDED'].includes(room.hand.phase)
      ? room.hand.players.reduce((sum, item) => sum + item.handCommitted, 0)
      : 0;
  invalid(
    Number.isSafeInteger(issued) &&
      Number.isSafeInteger(held) &&
      Number.isSafeInteger(committed) &&
      issued === held + committed &&
      issued <= MAX_TOTAL,
    '牌局筹码账本不守恒',
  );
}

export function createRoom(
  code: string,
  userId: string,
  name: string,
  config: GameConfig,
  now = Date.now(),
) {
  const cleanName = normalizeName(name);
  invalid(cleanName.length >= 1 && cleanName.length <= 24, '名字须为 1–24 个字符');
  const memberId = randomUUID();
  const participantId = randomUUID();
  const state: RoomState = {
    id: randomUUID(),
    code,
    version: 1,
    phaseKey: randomUUID(),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ROOM_TTL,
    ownerMemberId: memberId,
    dealerMemberId: null,
    paused: false,
    config: validateConfig(config),
    blindLevel: 0,
    completedHands: 0,
    lastButtonId: null,
    members: [{ id: memberId, userId, name: cleanName, joinedAt: now, participantId }],
    participants: [
      {
        id: participantId,
        memberId,
        name: cleanName,
        seat: 0,
        stack: config.initialStack,
        initialChips: config.initialStack,
        refillCount: 0,
        refillTotal: 0,
        rebuyCount: 0,
        rebuyTotal: 0,
        externalAdjustment: 0,
        handsPlayed: 0,
        potsWon: 0,
        largestPotShare: 0,
        active: true,
      },
    ],
    hand: null,
    events: [],
    ledger: [],
    undo: [],
  };
  const created = event(state, memberId, 'ROOM_CREATED', `${cleanName} 创建牌局`, {}, now);
  ledger(state, created.id, participantId, 'INITIAL', config.initialStack, now);
  assertChipConservation(state);
  return state;
}

export function joinRoom(
  source: RoomState,
  userId: string,
  name: string,
  as: 'player' | 'spectator',
  now = Date.now(),
) {
  const room = copy(source);
  const existing = room.members.find((item) => item.userId === userId);
  const cleanName = normalizeName(name);
  invalid(cleanName.length >= 1 && cleanName.length <= 24, '名字须为 1–24 个字符');
  if (existing && !existing.removedAt) return finish(room, now);
  invalid(room.members.filter((item) => !item.removedAt).length < 32, '房间人数已满');
  invalid(
    !room.members.some(
      (item) =>
        !item.removedAt && normalizeName(item.name).toLowerCase() === cleanName.toLowerCase(),
    ),
    '房间里已有同名成员',
  );
  if (existing?.removedAt) {
    existing.removedAt = undefined;
    existing.joinedAt = now;
    existing.name = cleanName;
    if (existing.participantId) {
      if (as === 'player')
        invalid(
          activePlayerMembers(room).filter((item) => item.id !== existing.id).length < 10,
          '牌桌座位已满',
        );
      const returning = participant(room, existing.participantId);
      returning.name = cleanName;
      returning.active = as === 'player' && betweenHands(room);
      if (returning.active && returning.seat === null) {
        const used = new Set(
          room.participants.map((item) => item.seat).filter((seat) => seat !== null),
        );
        let seat = 0;
        while (used.has(seat)) seat += 1;
        returning.seat = seat;
      }
      if (!returning.active) returning.seat = null;
      event(
        room,
        existing.id,
        'MEMBER_JOINED',
        returning.active ? `${cleanName} 重新入座` : `${cleanName} 重新加入旁观席`,
        { participantId: returning.id },
        now,
      );
      assertChipConservation(room);
      return finish(room, now);
    }
    if (as === 'spectator') {
      event(room, existing.id, 'MEMBER_JOINED', `${cleanName} 重新加入旁观席`, {}, now);
      assertChipConservation(room);
      return finish(room, now);
    }
  }
  const memberId = randomUUID();
  const memberRecord = existing ?? { id: memberId, userId, name: cleanName, joinedAt: now };
  if (!existing) room.members.push(memberRecord);
  if (as === 'player') {
    invalid(activePlayerMembers(room).length < 10, '牌桌座位已满');
    const participantId = randomUUID();
    const canSeat = !room.hand || ['SETTLED', 'VOIDED'].includes(room.hand.phase);
    const used = new Set(
      room.participants.map((item) => item.seat).filter((seat) => seat !== null),
    );
    let seat = 0;
    while (used.has(seat)) seat += 1;
    Object.assign(memberRecord, { participantId });
    room.participants.push({
      id: participantId,
      memberId: memberRecord.id,
      name: cleanName,
      seat: canSeat ? seat : null,
      stack: room.config.initialStack,
      initialChips: room.config.initialStack,
      refillCount: 0,
      refillTotal: 0,
      rebuyCount: 0,
      rebuyTotal: 0,
      externalAdjustment: 0,
      handsPlayed: 0,
      potsWon: 0,
      largestPotShare: 0,
      active: canSeat,
    });
    const joined = event(
      room,
      memberRecord.id,
      'MEMBER_JOINED',
      canSeat ? `${cleanName} 入座` : `${cleanName} 加入，下一手前等待入座`,
      { participantId },
      now,
    );
    ledger(room, joined.id, participantId, 'INITIAL', room.config.initialStack, now);
  } else {
    event(room, memberRecord.id, 'MEMBER_JOINED', `${cleanName} 加入旁观席`, {}, now);
  }
  assertChipConservation(room);
  return finish(room, now);
}

function rotateAfter(ids: string[], anchor: string) {
  const index = ids.indexOf(anchor);
  return ids[(index + 1 + ids.length) % ids.length];
}

function orderAfter(hand: HandState, anchor: string) {
  const ids = [...hand.players].sort((a, b) => a.seat - b.seat).map((item) => item.participantId);
  const start = ids.indexOf(anchor);
  return [...ids.slice(start + 1), ...ids.slice(0, start + 1)];
}

function nextActor(hand: HandState, after: string) {
  return (
    orderAfter(hand, after).find((id) => {
      const player = hand.players.find((item) => item.participantId === id)!;
      return hand.needsAction.includes(id) && !player.folded && !player.allIn;
    }) ?? null
  );
}

function deduct(
  room: RoomState,
  player: HandPlayer,
  amount: number,
  actorMemberId: string,
  now: number,
  label: string,
) {
  const owner = participant(room, player.participantId);
  const paid = Math.min(owner.stack, amount);
  owner.stack -= paid;
  player.streetCommitted += paid;
  player.handCommitted += paid;
  player.allIn = owner.stack === 0;
  const posted = event(
    room,
    actorMemberId,
    'BLIND_POSTED',
    `${owner.name} 自动扣${label} ${paid}`,
    { participantId: owner.id, amount: paid, street: 'PREFLOP' },
    now,
  );
  ledger(room, posted.id, owner.id, 'WAGER', -paid, now, room.hand?.id);
  return paid;
}

export function calculatePots(
  players: (Pick<HandPlayer, 'participantId' | 'handCommitted' | 'folded'> &
    Partial<Pick<HandPlayer, 'allIn'>>)[],
) {
  const levels = [
    ...new Set(players.map((item) => item.handCommitted).filter((amount) => amount > 0)),
  ].sort((a, b) => a - b);
  const pots: Pot[] = [];
  let previous = 0;
  let uncalled: { participantId: string; amount: number } | null = null;
  for (const cap of levels) {
    const contributors = players.filter((item) => item.handCommitted >= cap);
    const amount = (cap - previous) * contributors.length;
    previous = cap;
    if (contributors.length === 1) {
      uncalled = { participantId: contributors[0].participantId, amount };
      continue;
    }
    const eligibleIds = players
      .filter((item) => !item.folded && (item.handCommitted >= cap || !item.allIn))
      .map((item) => item.participantId)
      .sort();
    if (!eligibleIds.length) throw new PokerError('INTERNAL', '底池没有可争夺玩家');
    const contributorIds = contributors.map((item) => item.participantId).sort();
    const previousPot = pots.at(-1);
    if (previousPot && previousPot.eligibleIds.join('|') === eligibleIds.join('|')) {
      previousPot.amount += amount;
      previousPot.cap = cap;
      previousPot.contributorIds = [
        ...new Set([...previousPot.contributorIds, ...contributorIds]),
      ].sort();
    } else {
      pots.push({
        id: `pot-${pots.length + 1}-${cap}`,
        amount,
        contributorIds,
        eligibleIds,
        cap,
      });
    }
  }
  return { pots, uncalled };
}

function refreshPots(hand: HandState) {
  const result = calculatePots(hand.players);
  hand.pots = result.pots;
  hand.uncalled = result.uncalled;
}

function refundUncalled(room: RoomState, actorMemberId: string, now: number) {
  const hand = room.hand!;
  const ordered = [...hand.players].sort((a, b) => b.streetCommitted - a.streetCommitted);
  if (!ordered[0] || ordered[0].streetCommitted === 0) return;
  if (ordered[1] && ordered[0].streetCommitted === ordered[1].streetCommitted) return;
  const amount = ordered[0].streetCommitted - (ordered[1]?.streetCommitted ?? 0);
  const player = participant(room, ordered[0].participantId);
  ordered[0].streetCommitted -= amount;
  ordered[0].handCommitted -= amount;
  player.stack += amount;
  ordered[0].allIn = player.stack === 0;
  const returned = event(
    room,
    actorMemberId,
    'UNCALLED_RETURNED',
    `${player.name} 收回未跟注筹码 ${amount}`,
    { participantId: player.id, amount, street: hand.street },
    now,
  );
  ledger(room, returned.id, player.id, 'REFUND', amount, now, hand.id);
}

function canAct(room: RoomState, player: HandPlayer) {
  return !player.folded && !player.allIn && participant(room, player.participantId).stack > 0;
}

function closeRound(room: RoomState, actorMemberId: string, now: number) {
  const hand = room.hand!;
  refundUncalled(room, actorMemberId, now);
  refreshPots(hand);
  hand.actorId = null;
  hand.needsAction = [];
  const live = hand.players.filter((item) => !item.folded);
  if (live.length === 1) {
    hand.street = 'SHOWDOWN';
    hand.phase = 'SHOWDOWN';
    hand.settlementDraft = hand.pots.map((pot) => ({
      potId: pot.id,
      winnerIds: [live[0].participantId],
    }));
    event(room, actorMemberId, 'STREET_READY', '其他玩家均已弃牌，等待荷官确认发放', {}, now);
    return;
  }
  hand.phase = 'AWAITING_STREET_CONFIRMATION';
  const next =
    hand.street === 'PREFLOP'
      ? 'Flop'
      : hand.street === 'FLOP'
        ? 'Turn'
        : hand.street === 'TURN'
          ? 'River'
          : 'Showdown';
  event(room, actorMemberId, 'STREET_READY', `下注已齐平，请确认进入 ${next}`, {}, now);
}

function maybeCloseRound(room: RoomState, actorMemberId: string, now: number) {
  const hand = room.hand!;
  hand.needsAction = hand.needsAction.filter((id) => {
    const player = hand.players.find((item) => item.participantId === id);
    return player && canAct(room, player);
  });
  const live = hand.players.filter((item) => !item.folded);
  if (live.length <= 1) {
    closeRound(room, actorMemberId, now);
    return true;
  }
  const able = live.filter((item) => canAct(room, item));
  if (able.length <= 1) {
    const only = able[0];
    if (!only) {
      closeRound(room, actorMemberId, now);
      return true;
    }
    const actualTarget = Math.max(
      0,
      ...live
        .filter((item) => item.participantId !== only.participantId)
        .map((item) => item.streetCommitted),
    );
    if (only.streetCommitted >= actualTarget) {
      closeRound(room, actorMemberId, now);
      return true;
    }
    hand.needsAction = [only.participantId];
    hand.actorId = only.participantId;
    return false;
  }
  const complete =
    hand.needsAction.length === 0 && able.every((item) => item.streetCommitted === hand.currentBet);
  if (complete) {
    closeRound(room, actorMemberId, now);
    return true;
  }
  return false;
}

function currentTarget(room: RoomState, player: HandPlayer) {
  const hand = room.hand!;
  const able = hand.players.filter((item) => !item.folded && canAct(room, item));
  if (able.length === 1 && able[0].participantId === player.participantId) {
    return Math.max(
      0,
      ...hand.players
        .filter((item) => !item.folded && item.participantId !== player.participantId)
        .map((item) => item.streetCommitted),
    );
  }
  return hand.currentBet;
}

function ceilRatio(value: number, numerator: number, denominator: number, unit: number) {
  return Math.ceil(Math.ceil((value * numerator) / denominator) / unit) * unit;
}

export function legalActions(room: RoomState, participantId: string): LegalActions | null {
  const hand = room.hand;
  if (!hand || hand.phase !== 'BETTING' || hand.actorId !== participantId || room.paused)
    return null;
  const player = handParticipant(room, participantId);
  const owner = participant(room, participantId);
  const target = currentTarget(room, player);
  const callNeeded = Math.max(0, target - player.streetCommitted);
  const maxTo = player.streetCommitted + owner.stack;
  const hasOpponent = hand.players.some(
    (item) =>
      item.participantId !== participantId &&
      !item.folded &&
      participant(room, item.participantId).stack > 0,
  );
  const reopened = player.reopenAtBet === null || hand.currentBet >= player.reopenAtBet;
  const actions: PlayerAction[] = ['fold'];
  if (callNeeded === 0) actions.push('check');
  else actions.push('call');
  const minBetTo = hand.currentBet === 0 ? hand.bigBlind : null;
  const minRaiseTo = hand.currentBet > 0 ? hand.currentBet + hand.lastFullRaiseSize : null;
  const canBet = hand.currentBet === 0 && hasOpponent && maxTo > 0;
  const canRaise = hand.currentBet > 0 && hasOpponent && reopened && maxTo > hand.currentBet;
  if (canBet) actions.push('bet');
  if (canRaise) actions.push('raise');
  if (owner.stack > 0 && (maxTo <= target || canBet || canRaise)) actions.push('all-in');
  const potTotal = hand.players.reduce((sum, item) => sum + item.handCommitted, 0);
  const shortcuts: LegalActions['shortcuts'] = [];
  const candidates: { label: string; num: number; den: number }[] = [
    { label: '1/3 Pot', num: 1, den: 3 },
    { label: '1/2 Pot', num: 1, den: 2 },
    { label: '2/3 Pot', num: 2, den: 3 },
    { label: '3/4 Pot', num: 3, den: 4 },
    { label: '1 Pot', num: 1, den: 1 },
  ];
  for (const candidate of candidates) {
    const raw =
      hand.currentBet === 0
        ? ceilRatio(potTotal, candidate.num, candidate.den, room.config.chipUnit)
        : player.streetCommitted +
          callNeeded +
          ceilRatio(potTotal + callNeeded, candidate.num, candidate.den, room.config.chipUnit);
    const minimum =
      hand.currentBet === 0 ? hand.bigBlind : hand.currentBet + hand.lastFullRaiseSize;
    const to = Math.min(maxTo, Math.max(minimum, raw));
    if (to <= player.streetCommitted) continue;
    const action = hand.currentBet === 0 ? 'bet' : 'raise';
    if ((action === 'bet' && !canBet) || (action === 'raise' && !canRaise)) continue;
    if (!shortcuts.some((item) => item.to === to)) {
      shortcuts.push({
        label:
          to === minimum && raw < minimum
            ? '最低'
            : to === maxTo && raw > maxTo
              ? 'All-in'
              : candidate.label,
        action: to === maxTo ? 'all-in' : action,
        to,
      });
    }
  }
  return {
    participantId,
    actions,
    callNeeded,
    callPayable: Math.min(callNeeded, owner.stack),
    minBetTo,
    minRaiseTo,
    maxTo,
    shortcuts,
  };
}

function startHand(
  room: RoomState,
  actorMemberId: string,
  buttonId: string | undefined,
  now: number,
) {
  invalid(!room.paused, '牌局暂停中');
  invalid(!room.hand || ['SETTLED', 'VOIDED'].includes(room.hand.phase), '上一手尚未结束');
  const seats = activeSeats(room).filter((item) => item.stack > 0);
  invalid(seats.length >= 2, '至少需要两位有筹码的玩家');
  invalid(seats.length <= 10, '最多 10 位玩家');
  if (room.config.blindUpgrade === 'hands') {
    room.blindLevel = Math.min(
      room.config.blindLevels.length - 1,
      Math.floor(room.completedHands / room.config.handsPerLevel),
    );
  }
  const level = room.config.blindLevels[room.blindLevel];
  const ids = seats.map((item) => item.id);
  let button = buttonId;
  if (!room.lastButtonId) {
    invalid(button && ids.includes(button), '请选择首手 Button');
  } else {
    button = rotateAfter(ids, room.lastButtonId);
  }
  const smallBlindId = ids.length === 2 ? button! : rotateAfter(ids, button!);
  const bigBlindId = rotateAfter(ids, smallBlindId);
  const hand: HandState = {
    id: randomUUID(),
    number: room.completedHands + 1,
    phase: 'BETTING',
    street: 'PREFLOP',
    players: seats.map((item) => ({
      participantId: item.id,
      seat: item.seat!,
      streetCommitted: 0,
      handCommitted: 0,
      folded: false,
      allIn: false,
      hasActed: false,
      reopenAtBet: null,
    })),
    buttonId: button!,
    previousButtonId: room.lastButtonId,
    smallBlindId,
    bigBlindId,
    actorId: null,
    needsAction: [],
    currentBet: level.bigBlind,
    lastFullRaiseSize: level.bigBlind,
    smallBlind: level.smallBlind,
    bigBlind: level.bigBlind,
    pots: [],
    uncalled: null,
    settlementDraft: [],
    startedAt: now,
    revision: 0,
  };
  room.hand = hand;
  room.lastButtonId = button!;
  deduct(room, handParticipant(room, smallBlindId), level.smallBlind, actorMemberId, now, '小盲');
  deduct(room, handParticipant(room, bigBlindId), level.bigBlind, actorMemberId, now, '大盲');
  hand.needsAction = hand.players
    .filter((item) => canAct(room, item))
    .map((item) => item.participantId);
  hand.actorId = nextActor(hand, bigBlindId);
  refreshPots(hand);
  const started = event(
    room,
    actorMemberId,
    'HAND_STARTED',
    `第 ${hand.number} 手开始，盲注 ${level.smallBlind}/${level.bigBlind}`,
    { street: 'PREFLOP' },
    now,
  );
  maybeCloseRound(room, actorMemberId, now);
  return started;
}

function act(
  room: RoomState,
  actorMemberId: string,
  participantId: string,
  action: PlayerAction,
  to: number | undefined,
  now: number,
) {
  const hand = room.hand;
  invalid(hand?.phase === 'BETTING' && !room.paused, '当前不能下注');
  invalid(hand.actorId === participantId, '还没轮到你行动');
  const legal = legalActions(room, participantId);
  if (!legal || !legal.actions.includes(action))
    throw new PokerError('INVALID', '该操作当前不合法');
  const player = handParticipant(room, participantId);
  const owner = participant(room, participantId);
  const oldBet = hand.currentBet;
  let target = player.streetCommitted;
  if (action === 'call') target += legal.callPayable;
  if (action === 'all-in') target = legal.maxTo;
  if (action === 'bet' || action === 'raise') {
    invalid(integer(to ?? -1), '请输入有效目标金额');
    target = to!;
    invalid(target <= legal.maxTo && target > player.streetCommitted, '下注金额超出可用筹码');
    if (action === 'bet') {
      invalid(hand.currentBet === 0, '当前应使用加注');
      invalid(target >= hand.bigBlind || target === legal.maxTo, `最低下注到 ${hand.bigBlind}`);
    } else {
      invalid(hand.currentBet > 0, '当前应使用下注');
      invalid(
        target >= hand.currentBet + hand.lastFullRaiseSize || target === legal.maxTo,
        `最低加到 ${hand.currentBet + hand.lastFullRaiseSize}`,
      );
      invalid(target > hand.currentBet, '加注必须高于当前下注');
    }
  }
  if (action === 'check') invalid(legal.callNeeded === 0, '当前不能过牌');
  const before = player.streetCommitted;
  const paid = target - before;
  if (action === 'fold') player.folded = true;
  if (paid > 0) {
    invalid(paid <= owner.stack, '筹码不足');
    owner.stack -= paid;
    player.streetCommitted += paid;
    player.handCommitted += paid;
    player.allIn = owner.stack === 0;
  }
  const increased = player.streetCommitted > oldBet;
  const increment = increased ? player.streetCommitted - oldBet : 0;
  const fullRaise = increased && increment >= hand.lastFullRaiseSize;
  if (increased) hand.currentBet = player.streetCommitted;
  if (fullRaise) hand.lastFullRaiseSize = increment;
  player.hasActed = true;
  player.reopenAtBet = hand.currentBet + hand.lastFullRaiseSize;
  hand.needsAction = hand.needsAction.filter((id) => id !== participantId);
  if (fullRaise || (oldBet === 0 && increased && player.streetCommitted >= hand.bigBlind)) {
    hand.needsAction = hand.players
      .filter((item) => item.participantId !== participantId && canAct(room, item))
      .map((item) => item.participantId);
  } else if (increased) {
    for (const candidate of hand.players) {
      if (
        candidate.participantId !== participantId &&
        canAct(room, candidate) &&
        candidate.streetCommitted < hand.currentBet &&
        !hand.needsAction.includes(candidate.participantId)
      ) {
        hand.needsAction.push(candidate.participantId);
      }
    }
  }
  const label =
    action === 'fold'
      ? '弃牌'
      : action === 'check'
        ? '过牌'
        : action === 'call'
          ? `跟注 ${paid}`
          : action === 'all-in'
            ? `All-in 到 ${player.streetCommitted}`
            : `${action === 'bet' ? '下注' : '加注'}到 ${player.streetCommitted}`;
  const acted = event(
    room,
    actorMemberId,
    'PLAYER_ACTED',
    `${owner.name} ${label}`,
    { participantId, amount: paid, action, street: hand.street },
    now,
  );
  if (paid > 0) ledger(room, acted.id, participantId, 'WAGER', -paid, now, hand.id);
  refreshPots(hand);
  if (!maybeCloseRound(room, actorMemberId, now)) hand.actorId = nextActor(hand, participantId);
  return acted;
}

function confirmStreet(room: RoomState, actorMemberId: string, now: number) {
  const hand = room.hand;
  invalid(hand?.phase === 'AWAITING_STREET_CONFIRMATION' && !room.paused, '当前无需确认下一阶段');
  const before = hand.street;
  const next: Record<Exclude<Street, 'SHOWDOWN'>, Street> = {
    PREFLOP: 'FLOP',
    FLOP: 'TURN',
    TURN: 'RIVER',
    RIVER: 'SHOWDOWN',
  };
  hand.street = next[before as Exclude<Street, 'SHOWDOWN'>];
  const confirmed = event(
    room,
    actorMemberId,
    'STREET_CONFIRMED',
    hand.street === 'SHOWDOWN' ? '荷官确认进入 Showdown' : `荷官确认进入 ${hand.street}`,
    { street: hand.street },
    now,
  );
  if (hand.street === 'SHOWDOWN') {
    hand.phase = 'SHOWDOWN';
    hand.settlementDraft = hand.pots
      .filter((pot) => pot.eligibleIds.length === 1)
      .map((pot) => ({ potId: pot.id, winnerIds: [...pot.eligibleIds] }));
    return confirmed;
  }
  hand.phase = 'BETTING';
  hand.currentBet = 0;
  hand.lastFullRaiseSize = hand.bigBlind;
  for (const player of hand.players) {
    player.streetCommitted = 0;
    player.hasActed = false;
    player.reopenAtBet = null;
  }
  hand.needsAction = hand.players
    .filter((item) => canAct(room, item))
    .map((item) => item.participantId);
  hand.actorId = nextActor(hand, hand.buttonId);
  refreshPots(hand);
  maybeCloseRound(room, actorMemberId, now);
  return confirmed;
}

function normalizedChoices(hand: HandState, choices: SettlementChoice[]) {
  invalid(choices.length === hand.pots.length, '请为每个底池指定赢家');
  return hand.pots.map((pot) => {
    const choice = choices.find((item) => item.potId === pot.id);
    invalid(choice && choice.winnerIds.length > 0, '每个底池至少选择一位赢家');
    const unique = [...new Set(choice.winnerIds)];
    invalid(unique.length === choice.winnerIds.length, '赢家不能重复');
    invalid(
      unique.every((id) => pot.eligibleIds.includes(id)),
      '赢家没有资格争夺该底池',
    );
    return { potId: pot.id, winnerIds: unique };
  });
}

function settle(room: RoomState, actorMemberId: string, choices: SettlementChoice[], now: number) {
  const hand = room.hand;
  invalid(hand?.phase === 'SHOWDOWN' && !room.paused, '当前不能结算');
  const normalized = normalizedChoices(hand, choices);
  const seatOrder = [...hand.players]
    .sort((a, b) => a.seat - b.seat)
    .map((item) => item.participantId);
  const oddOrder = [
    ...seatOrder.slice(seatOrder.indexOf(hand.buttonId) + 1),
    ...seatOrder.slice(0, seatOrder.indexOf(hand.buttonId) + 1),
  ];
  const payouts = new Map<string, number>();
  const shares = new Map<string, number>();
  for (const pot of hand.pots) {
    const winners = normalized.find((item) => item.potId === pot.id)!.winnerIds;
    const each = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount % winners.length;
    for (const id of winners) {
      payouts.set(id, (payouts.get(id) ?? 0) + each);
      shares.set(id, Math.max(shares.get(id) ?? 0, each));
    }
    for (const id of oddOrder) {
      if (remainder === 0) break;
      if (winners.includes(id)) {
        payouts.set(id, (payouts.get(id) ?? 0) + 1);
        shares.set(id, Math.max(shares.get(id) ?? 0, each + 1));
        remainder -= 1;
      }
    }
  }
  const totalPots = hand.pots.reduce((sum, pot) => sum + pot.amount, 0);
  invalid(
    [...payouts.values()].reduce((sum, amount) => sum + amount, 0) === totalPots,
    '结算金额不守恒',
  );
  const settled = event(
    room,
    actorMemberId,
    'HAND_SETTLED',
    `第 ${hand.number} 手结算 ${totalPots}`,
    {},
    now,
  );
  for (const [id, amount] of payouts) {
    const owner = participant(room, id);
    owner.stack += amount;
    owner.potsWon += 1;
    owner.largestPotShare = Math.max(owner.largestPotShare, shares.get(id) ?? 0);
    ledger(room, settled.id, id, 'PAYOUT', amount, now, hand.id);
  }
  for (const player of hand.players) participant(room, player.participantId).handsPlayed += 1;
  hand.settlementDraft = normalized;
  hand.phase = 'SETTLED';
  hand.settledAt = now;
  room.completedHands += 1;
  return settled;
}

function voidHand(room: RoomState, actorMemberId: string, reason: string, now: number) {
  const hand = room.hand;
  invalid(hand && !['SETTLED', 'VOIDED'].includes(hand.phase), '当前没有可作废的牌局');
  invalid(reason.trim().length >= 2 && reason.trim().length <= 120, '请填写简短原因');
  const voided = event(room, actorMemberId, 'HAND_VOIDED', `本手作废：${reason.trim()}`, {}, now);
  for (const player of hand.players) {
    if (player.handCommitted > 0) {
      participant(room, player.participantId).stack += player.handCommitted;
      ledger(room, voided.id, player.participantId, 'REFUND', player.handCommitted, now, hand.id);
      player.handCommitted = 0;
      player.streetCommitted = 0;
    }
  }
  room.lastButtonId = hand.previousButtonId;
  hand.pots = [];
  hand.uncalled = null;
  hand.actorId = null;
  hand.needsAction = [];
  hand.phase = 'VOIDED';
  return voided;
}

function assertAdmin(room: RoomState, memberId: string) {
  if (room.ownerMemberId !== memberId && room.dealerMemberId !== memberId)
    throw new PokerError('FORBIDDEN', '需要房主或荷官权限');
}

function assertOwner(room: RoomState, memberId: string) {
  if (room.ownerMemberId !== memberId) throw new PokerError('FORBIDDEN', '需要房主权限');
}

function betweenHands(room: RoomState) {
  return !room.hand || ['SETTLED', 'VOIDED'].includes(room.hand.phase);
}

export function applyCommand(
  source: RoomState,
  userId: string,
  command: PokerCommand,
  now = Date.now(),
) {
  const room = copy(source);
  const actor = member(room, userId);
  let before: UndoSnapshot | null = null;
  let primary: PokerEvent | null = null;
  switch (command.type) {
    case 'start-hand':
      assertAdmin(room, actor.id);
      before = snapshot(room);
      primary = startHand(room, actor.id, command.buttonId, now);
      break;
    case 'act': {
      invalid(actor.participantId, '旁观者不能下注');
      before = snapshot(room);
      primary = act(room, actor.id, actor.participantId, command.action, command.to, now);
      break;
    }
    case 'confirm-street':
      assertAdmin(room, actor.id);
      before = snapshot(room);
      primary = confirmStreet(room, actor.id, now);
      break;
    case 'save-settlement':
      assertAdmin(room, actor.id);
      invalid(room.hand?.phase === 'SHOWDOWN', '当前不能编辑结算');
      room.hand.settlementDraft = normalizedChoices(room.hand, command.pots);
      break;
    case 'settle':
      assertAdmin(room, actor.id);
      before = snapshot(room);
      primary = settle(room, actor.id, command.pots, now);
      break;
    case 'undo': {
      assertAdmin(room, actor.id);
      const frame = room.undo.pop();
      invalid(frame, '没有可以撤销的操作');
      const currentEvents = room.events;
      const targetIndex = currentEvents.findIndex((item) => item.id === frame.eventId);
      const revertedEvents = currentEvents.slice(
        frame.eventLength ?? (targetIndex >= 0 ? targetIndex : currentEvents.length),
      );
      const target = revertedEvents.find((item) => item.id === frame.eventId);
      room.participants = copy(frame.participants);
      room.hand = copy(frame.hand);
      room.members = copy(frame.members ?? room.members);
      room.ownerMemberId = frame.ownerMemberId ?? room.ownerMemberId;
      room.dealerMemberId =
        'dealerMemberId' in frame ? (frame.dealerMemberId ?? null) : room.dealerMemberId;
      room.paused = frame.paused ?? room.paused;
      room.config = copy(frame.config ?? room.config);
      room.lastButtonId = frame.lastButtonId;
      room.completedHands = frame.completedHands;
      room.blindLevel = frame.blindLevel;
      room.ledger = room.ledger.slice(0, frame.ledgerLength);
      const undone = event(
        room,
        actor.id,
        'ACTION_UNDONE',
        `撤销：${target?.detail ?? '最近操作'}`,
        {},
        now,
      );
      for (const reverted of revertedEvents) reverted.revertedBy = undone.id;
      room.events = currentEvents;
      break;
    }
    case 'void-hand':
      assertAdmin(room, actor.id);
      before = snapshot(room);
      primary = voidHand(room, actor.id, command.reason, now);
      break;
    case 'pause':
      assertAdmin(room, actor.id);
      invalid(!room.paused, '牌局已经暂停');
      before = snapshot(room);
      room.paused = true;
      primary = event(room, actor.id, 'SESSION_PAUSED', '荷官暂停牌局', {}, now);
      break;
    case 'resume':
      assertAdmin(room, actor.id);
      invalid(room.paused, '牌局没有暂停');
      before = snapshot(room);
      room.paused = false;
      primary = event(room, actor.id, 'SESSION_RESUMED', '荷官继续牌局', {}, now);
      break;
    case 'assign-dealer':
      assertOwner(room, actor.id);
      if (command.memberId !== null)
        invalid(
          room.members.some((item) => item.id === command.memberId && !item.removedAt),
          '成员不存在',
        );
      before = snapshot(room);
      room.dealerMemberId = command.memberId;
      primary = event(
        room,
        actor.id,
        'DEALER_CHANGED',
        command.memberId
          ? `荷官权限交给 ${room.members.find((item) => item.id === command.memberId)!.name}`
          : '已收回额外荷官权限',
        {},
        now,
      );
      break;
    case 'transfer-owner': {
      assertOwner(room, actor.id);
      invalid(command.memberId !== actor.id, '你已经是房主');
      const target = room.members.find((item) => item.id === command.memberId && !item.removedAt);
      invalid(target, '成员不存在');
      before = snapshot(room);
      room.ownerMemberId = target.id;
      if (room.dealerMemberId === target.id) room.dealerMemberId = null;
      primary = event(room, actor.id, 'OWNER_CHANGED', `房主转移给 ${target.name}`, {}, now);
      break;
    }
    case 'remove-member': {
      assertOwner(room, actor.id);
      invalid(command.memberId !== actor.id, '请先转移房主再离开');
      const target = room.members.find((item) => item.id === command.memberId && !item.removedAt);
      invalid(target, '成员不存在');
      if (target.participantId) {
        invalid(betweenHands(room), '请在两手之间移除玩家');
      }
      before = snapshot(room);
      if (target.participantId) {
        const targetPlayer = participant(room, target.participantId);
        targetPlayer.active = false;
        targetPlayer.seat = null;
      }
      if (room.dealerMemberId === target.id) room.dealerMemberId = null;
      target.removedAt = now;
      primary = event(
        room,
        actor.id,
        'MEMBER_REMOVED',
        `${target.name} 离开房间${target.participantId ? '，账务记录已保留' : ''}`,
        { participantId: target.participantId },
        now,
      );
      break;
    }
    case 'seat-member': {
      assertOwner(room, actor.id);
      invalid(betweenHands(room), '请在两手之间安排入座');
      const target = room.members.find((item) => item.id === command.memberId && !item.removedAt);
      invalid(target, '成员不存在');
      invalid(!target.participantId, '该成员已有玩家账务');
      invalid(activePlayerMembers(room).length < 10, '牌桌座位已满');
      before = snapshot(room);
      const participantId = randomUUID();
      const used = new Set(
        room.participants.map((item) => item.seat).filter((seat) => seat !== null),
      );
      let seat = 0;
      while (used.has(seat)) seat += 1;
      target.participantId = participantId;
      room.participants.push({
        id: participantId,
        memberId: target.id,
        name: target.name,
        seat,
        stack: room.config.initialStack,
        initialChips: room.config.initialStack,
        refillCount: 0,
        refillTotal: 0,
        rebuyCount: 0,
        rebuyTotal: 0,
        externalAdjustment: 0,
        handsPlayed: 0,
        potsWon: 0,
        largestPotShare: 0,
        active: true,
      });
      primary = event(
        room,
        actor.id,
        'SEATS_CHANGED',
        `${target.name} 从旁观席入座`,
        { participantId },
        now,
      );
      ledger(room, primary.id, participantId, 'INITIAL', room.config.initialStack, now);
      break;
    }
    case 'reorder': {
      assertOwner(room, actor.id);
      invalid(betweenHands(room), '请在两手之间调整座位');
      const seated = room.participants.filter((item) => item.seat !== null);
      invalid(
        command.participantIds.length === seated.length &&
          new Set(command.participantIds).size === seated.length &&
          command.participantIds.every((id) => seated.some((item) => item.id === id)),
        '座位列表不完整',
      );
      before = snapshot(room);
      command.participantIds.forEach((id, seat) => (participant(room, id).seat = seat));
      primary = event(room, actor.id, 'SEATS_CHANGED', '房主调整了座位顺序', {}, now);
      break;
    }
    case 'set-participant-active': {
      assertOwner(room, actor.id);
      invalid(betweenHands(room), '请在两手之间调整入座状态');
      const target = participant(room, command.participantId);
      invalid(
        room.members.some((item) => item.id === target.memberId && !item.removedAt),
        '该玩家已离开房间',
      );
      if (command.active && !target.active) invalid(activeSeats(room).length < 10, '牌桌座位已满');
      before = snapshot(room);
      target.active = command.active;
      if (command.active && target.seat === null) {
        const seats = new Set(
          room.participants.map((item) => item.seat).filter((seat) => seat !== null),
        );
        let seat = 0;
        while (seats.has(seat)) seat += 1;
        target.seat = seat;
      }
      primary = event(
        room,
        actor.id,
        'SEATS_CHANGED',
        `${target.name}${command.active ? ' 入座' : ' 暂停参与'}`,
        {},
        now,
      );
      break;
    }
    case 'set-blind-level':
      assertOwner(room, actor.id);
      invalid(betweenHands(room), '请在两手之间修改盲注级别');
      invalid(
        Number.isSafeInteger(command.level) &&
          command.level >= 0 &&
          command.level < room.config.blindLevels.length,
        '盲注级别无效',
      );
      before = snapshot(room);
      room.blindLevel = command.level;
      primary = event(
        room,
        actor.id,
        'BLIND_LEVEL_CHANGED',
        `下一手盲注设为 ${room.config.blindLevels[command.level].smallBlind}/${room.config.blindLevels[command.level].bigBlind}`,
        {},
        now,
      );
      break;
    case 'refill': {
      assertAdmin(room, actor.id);
      invalid(betweenHands(room), '补码将在本手结束后处理');
      invalid(
        integer(command.amount) &&
          command.amount > 0 &&
          command.amount <= MAX_STACK &&
          command.amount % room.config.chipUnit === 0,
        '补码金额无效',
      );
      const target = participant(room, command.participantId);
      before = snapshot(room);
      const rebuy = target.stack === 0;
      target.stack += command.amount;
      invalid(target.stack <= MAX_TOTAL, '筹码总量超出限制');
      if (rebuy) {
        target.rebuyCount += 1;
        target.rebuyTotal += command.amount;
      } else {
        target.refillCount += 1;
        target.refillTotal += command.amount;
      }
      const added = event(
        room,
        actor.id,
        'CHIPS_ADDED',
        `${target.name} ${rebuy ? 'Rebuy' : 'Refill'} ${command.amount}`,
        { participantId: target.id, amount: command.amount },
        now,
      );
      ledger(room, added.id, target.id, rebuy ? 'REBUY' : 'REFILL', command.amount, now);
      primary = added;
      break;
    }
    case 'adjust-chips': {
      assertAdmin(room, actor.id);
      invalid(betweenHands(room) || room.paused, '请先暂停牌局再校正筹码');
      invalid(
        Number.isSafeInteger(command.amount) &&
          command.amount !== 0 &&
          Math.abs(command.amount) <= MAX_STACK &&
          command.amount % room.config.chipUnit === 0,
        '校正金额无效',
      );
      invalid(
        command.reason.trim().length >= 2 && command.reason.trim().length <= 120,
        '请填写校正原因',
      );
      const target = participant(room, command.participantId);
      invalid(
        target.stack + command.amount >= 0 && target.stack + command.amount <= MAX_TOTAL,
        '校正后筹码超出范围',
      );
      before = snapshot(room);
      target.stack += command.amount;
      target.externalAdjustment += command.amount;
      const adjusted = event(
        room,
        actor.id,
        'CHIPS_ADJUSTED',
        `${target.name} 校正 ${command.amount > 0 ? '+' : ''}${command.amount}：${command.reason.trim()}`,
        { participantId: target.id, amount: command.amount },
        now,
      );
      ledger(room, adjusted.id, target.id, 'ADJUSTMENT', command.amount, now, room.hand?.id);
      primary = adjusted;
      break;
    }
    case 'configure':
      assertOwner(room, actor.id);
      invalid(betweenHands(room), '请在两手之间修改规则');
      before = snapshot(room);
      room.config = validateConfig(command.config);
      room.blindLevel = Math.min(room.blindLevel, room.config.blindLevels.length - 1);
      primary = event(room, actor.id, 'RULES_CHANGED', '房主更新了牌局规则', {}, now);
      break;
  }
  if (before && primary) keepUndo(room, before, primary.id);
  assertChipConservation(room);
  return finish(room, now);
}

export function projectRoom(room: RoomState, userId: string): RoomView {
  const self = member(room, userId);
  const { undo: _undo, ledger: _ledger, ...publicRoom } = copy(room);
  return {
    ...publicRoom,
    members: publicRoom.members
      .filter((item) => !item.removedAt)
      .map(({ userId: _userId, removedAt: _removedAt, ...item }) => item),
    me: {
      memberId: self.id,
      participantId: self.participantId ?? null,
      isOwner: room.ownerMemberId === self.id,
      isDealer: room.ownerMemberId === self.id || room.dealerMemberId === self.id,
    },
    legalActions: self.participantId ? legalActions(room, self.participantId) : null,
  };
}
