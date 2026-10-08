import { createHash } from 'node:crypto';
import {
  PokerError,
  type ApiRequest,
  type GameConfig,
  type PokerCommand,
  type RoomState,
} from '../../shared/types.js';
import {
  advanceOnlineStreet,
  applyCommand,
  createRoom,
  joinRoom,
  projectRoom,
  settleOnlineHand,
  touchRoomActivity,
  validateConfig,
} from '../domain/engine.js';
import {
  compareScores,
  completeBoard,
  createOnlineDeal,
  dealBoardStreet,
  evaluateHoldem,
  type OnlineHandSecrets,
} from '../domain/cards.js';
import {
  ensureUser,
  guestLogin,
  renewSession,
  verifyToken,
  type AuthDeps,
  type Receipt,
  type UserRecord,
} from '../infrastructure/auth.js';
import type { Transaction } from '../infrastructure/store.js';

interface CommandReceipt {
  id: string;
  userId: string;
  digest: string;
}

interface RoomRecord {
  state: RoomState;
  receipts: CommandReceipt[];
  recentWrites?: { userId: string; at: number }[];
  onlineHand?: OnlineHandSecrets;
  onlineUndo?: Record<string, OnlineHandSecrets | null>;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const code = () => String(Math.floor(1000 + Math.random() * 9000));

function projectRecord(record: RoomRecord, userId: string) {
  const participantId = record.state.members.find(
    (item) => item.userId === userId && !item.removedAt,
  )?.participantId;
  const holeCards = participantId ? (record.onlineHand?.holeCards[participantId] ?? []) : [];
  return projectRoom(record.state, userId, holeCards);
}

function actorMemberId(record: RoomRecord, userId: string) {
  const id = record.state.members.find((item) => item.userId === userId && !item.removedAt)?.id;
  if (!id) throw new PokerError('FORBIDDEN', '你不在此房间');
  return id;
}

function advanceOnlineGame(record: RoomRecord, userId: string, now: number) {
  if (record.state.config.mode !== 'online' || !record.state.hand) return;
  const actorId = actorMemberId(record, userId);
  let guard = 0;
  while (record.state.hand && guard < 3) {
    guard += 1;
    const hand = record.state.hand;
    const secrets = record.onlineHand;
    if (!secrets || secrets.handId !== hand.id)
      throw new PokerError('INTERNAL', '线上牌局私有牌堆缺失');
    if (hand.phase === 'AWAITING_STREET_CONFIRMATION') {
      const live = hand.players.filter((item) => !item.folded);
      const ableToBet = live.filter((item) => {
        const player = record.state.participants.find(
          (candidate) => candidate.id === item.participantId,
        );
        return !item.allIn && (player?.stack ?? 0) > 0;
      }).length;
      const dealt =
        ableToBet > 1
          ? dealBoardStreet(secrets.deck, hand.street)
          : completeBoard(secrets.deck, hand.street);
      const communityCards = [...(hand.communityCards ?? []), ...dealt];
      record.state = advanceOnlineStreet(record.state, actorId, communityCards, now);
      continue;
    }
    if (hand.phase === 'SHOWDOWN') {
      const live = hand.players.filter((item) => !item.folded);
      const board = hand.communityCards ?? [];
      if (live.length > 1 && board.length !== 5)
        throw new PokerError('INTERNAL', '线上牌局公共牌不完整');
      const evaluated = new Map<string, { score: number[]; label: string; cards: string[] }>();
      if (live.length > 1) {
        for (const player of live) {
          const cards = secrets.holeCards[player.participantId];
          if (!cards || cards.length !== 2) throw new PokerError('INTERNAL', '线上牌局底牌缺失');
          const result = evaluateHoldem([...cards, ...board]);
          evaluated.set(player.participantId, { ...result, cards: [...cards] });
        }
      }
      const choices = hand.pots.map((pot) => {
        if (live.length === 1)
          return { potId: pot.id, runs: [{ winnerIds: [live[0].participantId] }] };
        const contenders = pot.eligibleIds.map((id) => ({ id, result: evaluated.get(id)! }));
        let best = contenders[0].result.score;
        for (const contender of contenders.slice(1))
          if (compareScores(contender.result.score, best) > 0) best = contender.result.score;
        return {
          potId: pot.id,
          runs: [
            {
              winnerIds: contenders
                .filter((contender) => compareScores(contender.result.score, best) === 0)
                .map((contender) => contender.id),
            },
          ],
        };
      });
      const showdownHands =
        live.length > 1
          ? live.map((player) => ({
              participantId: player.participantId,
              cards: evaluated.get(player.participantId)!.cards,
              label: evaluated.get(player.participantId)!.label,
            }))
          : [];
      record.state = settleOnlineHand(record.state, actorId, choices, showdownHands, now);
      break;
    }
    break;
  }
}

function active(record: RoomRecord | null, now: number) {
  if (!record) throw new PokerError('NOT_FOUND', '房间不存在');
  if (record.state.expiresAt <= now) throw new PokerError('NOT_FOUND', '房间已过期');
  return record;
}

function validateName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name.trim() || name.length > 128)
    throw new PokerError('INVALID', '名字须为 1–24 个字符');
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(id))
    throw new PokerError('INVALID', '请求编号无效');
}

function validateCode(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value))
    throw new PokerError('INVALID', '请输入四位房间号');
}

function validateEntityId(value: unknown, label = '对象'): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(value))
    throw new PokerError('INVALID', `${label}编号无效`);
}

function validatePotId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{3,80}$/.test(value))
    throw new PokerError('INVALID', '底池编号无效');
}

function validateSettlement(value: unknown) {
  if (!Array.isArray(value) || value.length > 32) throw new PokerError('INVALID', '结算内容无效');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new PokerError('INVALID', '结算内容无效');
    const choice = item as Record<string, unknown>;
    validatePotId(choice.potId);
    if (choice.runs !== undefined) {
      if (
        choice.winnerIds !== undefined ||
        !Array.isArray(choice.runs) ||
        choice.runs.length < 1 ||
        choice.runs.length > 5
      )
        throw new PokerError('INVALID', '跑马结算无效');
      for (const rawRun of choice.runs) {
        if (!rawRun || typeof rawRun !== 'object' || Array.isArray(rawRun))
          throw new PokerError('INVALID', '跑马结算无效');
        const run = rawRun as Record<string, unknown>;
        if (!Array.isArray(run.winnerIds) || run.winnerIds.length < 1 || run.winnerIds.length > 10)
          throw new PokerError('INVALID', '赢家列表无效');
        for (const winner of run.winnerIds) validateEntityId(winner, '赢家');
      }
    } else {
      if (
        !Array.isArray(choice.winnerIds) ||
        choice.winnerIds.length < 1 ||
        choice.winnerIds.length > 10
      )
        throw new PokerError('INVALID', '赢家列表无效');
      for (const winner of choice.winnerIds) validateEntityId(winner, '赢家');
    }
  }
}

function validateCommand(value: unknown): asserts value is PokerCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PokerError('INVALID', '操作无效');
  const command = value as Record<string, unknown>;
  if (typeof command.type !== 'string') throw new PokerError('INVALID', '操作无效');
  switch (command.type) {
    case 'start-hand':
      if (command.buttonId !== undefined) validateEntityId(command.buttonId, 'Button');
      break;
    case 'act':
      if (!['fold', 'check', 'call', 'bet', 'raise', 'all-in'].includes(String(command.action)))
        throw new PokerError('INVALID', '玩家操作无效');
      if (command.to !== undefined && (!Number.isSafeInteger(command.to) || Number(command.to) < 0))
        throw new PokerError('INVALID', '目标金额无效');
      break;
    case 'settle':
    case 'save-settlement':
      validateSettlement(command.pots);
      break;
    case 'void-hand':
      if (typeof command.reason !== 'string') throw new PokerError('INVALID', '作废原因无效');
      break;
    case 'assign-dealer':
      if (command.memberId !== null) validateEntityId(command.memberId, '成员');
      break;
    case 'transfer-owner':
    case 'remove-member':
    case 'seat-member':
      validateEntityId(command.memberId, '成员');
      break;
    case 'reorder':
      if (!Array.isArray(command.participantIds) || command.participantIds.length > 10)
        throw new PokerError('INVALID', '座位列表无效');
      for (const id of command.participantIds) validateEntityId(id, '玩家');
      break;
    case 'set-participant-active':
      validateEntityId(command.participantId, '玩家');
      if (typeof command.active !== 'boolean') throw new PokerError('INVALID', '入座状态无效');
      break;
    case 'set-blind-level':
      if (!Number.isSafeInteger(command.level) || Number(command.level) < 0)
        throw new PokerError('INVALID', '盲注级别无效');
      break;
    case 'set-next-blinds':
      if (
        !Number.isSafeInteger(command.smallBlind) ||
        Number(command.smallBlind) <= 0 ||
        !Number.isSafeInteger(command.bigBlind) ||
        Number(command.bigBlind) <= 0
      )
        throw new PokerError('INVALID', '盲注金额无效');
      break;
    case 'refill':
      validateEntityId(command.participantId, '玩家');
      if (!Number.isSafeInteger(command.amount) || Number(command.amount) <= 0)
        throw new PokerError('INVALID', '补码金额无效');
      break;
    case 'adjust-chips':
      validateEntityId(command.participantId, '玩家');
      if (!Number.isSafeInteger(command.amount) || Number(command.amount) === 0)
        throw new PokerError('INVALID', '校正金额无效');
      if (typeof command.reason !== 'string') throw new PokerError('INVALID', '校正原因无效');
      break;
    case 'configure':
      validateConfig(command.config as GameConfig);
      break;
    case 'confirm-street':
    case 'undo':
    case 'pause':
    case 'resume':
      break;
    default:
      throw new PokerError('INVALID', '未知操作');
  }
}

function validateRequest(input: unknown): asserts input is ApiRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new PokerError('INVALID', '请求格式无效');
  const value = input as Record<string, unknown>;
  if (typeof value.action !== 'string') throw new PokerError('INVALID', '未知操作');
  if (['create', 'join', 'command'].includes(value.action)) validateId(value.requestId);
  if (['join', 'get', 'heartbeat', 'command'].includes(value.action)) validateCode(value.code);
  if (value.action === 'create') {
    validateName(value.name);
    validateConfig(value.config as GameConfig);
  }
  if (value.action === 'join') {
    validateName(value.name);
    if (!['player', 'spectator'].includes(String(value.as)))
      throw new PokerError('INVALID', '加入方式无效');
  }
  if (
    ['get', 'heartbeat'].includes(value.action) &&
    value.version !== undefined &&
    !Number.isSafeInteger(value.version)
  )
    throw new PokerError('INVALID', '版本无效');
  if (value.action === 'command') {
    if (!Number.isSafeInteger(value.expectedVersion) || typeof value.phaseKey !== 'string')
      throw new PokerError('INVALID', '牌局版本无效');
    validateCommand(value.command);
  }
  if (
    !['auth.guest', 'session', 'create', 'join', 'get', 'heartbeat', 'command'].includes(
      value.action,
    )
  )
    throw new PokerError('INVALID', '未知操作');
}

function remember(user: UserRecord, receipt: Receipt) {
  user.receipts = [...user.receipts, receipt].slice(-128);
}

function userRate(user: UserRecord, action: string, now: number) {
  const recent = (user.recentActions ?? []).filter((item) => item.at > now - 3_600_000);
  if (
    recent.filter((item) => item.at > now - 60_000).length >= 20 ||
    (action === 'create' && recent.filter((item) => item.action === 'create').length >= 5)
  )
    throw new PokerError('RATE_LIMIT', '操作太频繁，请稍后再试');
  recent.push({ at: now, action });
  user.recentActions = recent.slice(-1200);
}

function roomRate(record: RoomRecord, userId: string, now: number) {
  const recent = (record.recentWrites ?? []).filter((item) => item.at > now - 60_000);
  if (recent.filter((item) => item.userId === userId).length >= 60)
    throw new PokerError('RATE_LIMIT', '操作太频繁，请稍后再试');
  recent.push({ userId, at: now });
  record.recentWrites = recent;
}

async function saveRoom(transaction: Transaction, record: RoomRecord) {
  await transaction.set('rooms', record.state.code, record, record.state.expiresAt);
}

export async function handleApi(input: unknown, token: string | undefined, deps: AuthDeps) {
  validateRequest(input);
  const now = (deps.now ?? Date.now)();
  if (input.action === 'auth.guest') return guestLogin(input.deviceSecret, deps);
  if (input.action === 'session') return renewSession(token, deps);
  const claims = verifyToken(token, deps.auth, now);
  if (input.action === 'create') {
    const hash = digest(input);
    for (let attempt = 0; attempt < 30; attempt++) {
      const roomCode = code();
      const result = await deps.store.transaction(async (transaction) => {
        const user = await ensureUser(transaction, claims.userId, now);
        const replay = user.receipts.find((item) => item.id === input.requestId);
        if (replay) {
          if (replay.digest !== hash) throw new PokerError('CONFLICT', '请求编号已用于其他操作');
          const previous = active(await transaction.get<RoomRecord>('rooms', replay.code), now);
          return projectRecord(previous, claims.userId);
        }
        if (await transaction.get<RoomRecord>('rooms', roomCode)) return null;
        userRate(user, 'create', now);
        const state = createRoom(roomCode, claims.userId, input.name, input.config, now);
        const record: RoomRecord = { state, receipts: [], recentWrites: [] };
        await saveRoom(transaction, record);
        user.lastRoom = roomCode;
        remember(user, { id: input.requestId, digest: hash, code: roomCode });
        await transaction.set('users', user.userId, user, user.expiresAt);
        return projectRecord(record, claims.userId);
      });
      if (result) return result;
    }
    throw new PokerError('CONFLICT', '暂时无法分配房间号，请重试');
  }
  if (input.action === 'join') {
    const hash = digest(input);
    return deps.store.transaction(async (transaction) => {
      const user = await ensureUser(transaction, claims.userId, now);
      const replay = user.receipts.find((item) => item.id === input.requestId);
      if (replay) {
        if (replay.digest !== hash) throw new PokerError('CONFLICT', '请求编号已用于其他操作');
        const previous = active(await transaction.get<RoomRecord>('rooms', replay.code), now);
        return projectRecord(previous, claims.userId);
      }
      userRate(user, 'join', now);
      const record = active(await transaction.get<RoomRecord>('rooms', input.code), now);
      record.state = joinRoom(record.state, claims.userId, input.name, input.as, now);
      await saveRoom(transaction, record);
      user.lastRoom = input.code;
      remember(user, { id: input.requestId, digest: hash, code: input.code });
      await transaction.set('users', user.userId, user, user.expiresAt);
      return projectRecord(record, claims.userId);
    });
  }
  if (input.action === 'get') {
    const record = active(await deps.store.get<RoomRecord>('rooms', input.code), now);
    const view = projectRecord(record, claims.userId);
    if (input.version === view.version) return { unchanged: true, version: view.version };
    return view;
  }
  if (input.action === 'heartbeat') {
    return deps.store.transaction(async (transaction) => {
      await ensureUser(transaction, claims.userId, now);
      const record = active(await transaction.get<RoomRecord>('rooms', input.code), now);
      roomRate(record, claims.userId, now);
      record.state = touchRoomActivity(record.state, claims.userId, now);
      await saveRoom(transaction, record);
      const view = projectRecord(record, claims.userId);
      if (input.version === view.version) return { unchanged: true, version: view.version };
      return view;
    });
  }
  if (input.action === 'command') {
    const hash = digest(input.command);
    return deps.store.transaction(async (transaction) => {
      const record = active(await transaction.get<RoomRecord>('rooms', input.code), now);
      const replay = record.receipts.find(
        (item) => item.id === input.requestId && item.userId === claims.userId,
      );
      if (replay) {
        if (replay.digest !== hash) throw new PokerError('CONFLICT', '请求编号已用于其他操作');
        return projectRecord(record, claims.userId);
      }
      roomRate(record, claims.userId, now);
      if (
        record.state.version !== input.expectedVersion ||
        record.state.phaseKey !== input.phaseKey
      )
        throw new PokerError('CONFLICT', '牌局已更新，请同步后重试');
      const command = input.command as PokerCommand;
      const priorSecret = record.onlineHand ? structuredClone(record.onlineHand) : null;
      const undoTarget = command.type === 'undo' ? record.state.undo.at(-1)?.eventId : undefined;
      const undoLength = record.state.undo.length;
      record.state = applyCommand(record.state, claims.userId, command, now);
      if (undoTarget && record.onlineUndo && undoTarget in record.onlineUndo) {
        record.onlineHand = record.onlineUndo[undoTarget]
          ? structuredClone(record.onlineUndo[undoTarget]!)
          : undefined;
        delete record.onlineUndo[undoTarget];
      } else if (record.state.config.mode === 'online' && record.state.undo.length > undoLength) {
        const eventId = record.state.undo.at(-1)!.eventId;
        record.onlineUndo ??= {};
        record.onlineUndo[eventId] = priorSecret;
      }
      if (
        record.state.config.mode === 'online' &&
        command.type === 'start-hand' &&
        record.state.hand
      ) {
        record.onlineHand = createOnlineDeal(record.state.hand);
        record.state.hand.communityCards = [];
        record.state.hand.showdownHands = [];
      }
      advanceOnlineGame(record, claims.userId, now);
      if (record.onlineUndo) {
        const retained = new Set(record.state.undo.map((item) => item.eventId));
        for (const eventId of Object.keys(record.onlineUndo))
          if (!retained.has(eventId)) delete record.onlineUndo[eventId];
      }
      record.receipts.push({ id: input.requestId, userId: claims.userId, digest: hash });
      record.receipts = record.receipts.slice(-512);
      await saveRoom(transaction, record);
      return projectRecord(record, claims.userId);
    });
  }
  throw new PokerError('INVALID', '未知操作');
}
