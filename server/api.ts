import { createHash } from 'node:crypto';
import {
  GameError,
  type ApiRequest,
  type GameCommand,
  type GameConfig,
  type Notes,
  type NotesResult,
  type RoomView,
} from '../shared/types.js';
import { ROLE_META, validateConfig } from '../shared/rules.js';
import { applyCommand, createRoom, joinRoom, projectRoom, type RoomState } from './engine.js';
import {
  ensureUser,
  finishWechat,
  guestLogin,
  sessionFor,
  startWechat,
  verifyToken,
  type AuthDeps,
  type Receipt,
  type UserRecord,
} from './auth.js';
import type { Transaction } from './store.js';
import { randomRoomCode } from './room-code.js';
import { noteMatchesRoom } from './room-lifecycle.js';

interface CommandReceipt {
  id: string;
  userId: string;
  digest: string;
  left: boolean;
}
export interface RoomRecord {
  state: RoomState;
  receipts: CommandReceipt[];
  recentWrites: { userId: string; at: number }[];
}
interface NoteRecord extends NotesResult {
  expiresAt: number;
  roomInstanceId?: string;
  roomCreatedAt?: number;
}
function invalid(message = '请求参数无效'): never {
  throw new GameError('INVALID', message);
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).some((key) => !fields.includes(key))) invalid('请求包含未知字段');
}
function safeTree(value: unknown, depth = 0) {
  if (depth > 12) invalid();
  if (value && typeof value === 'object') {
    if (Object.keys(value).length > 100) invalid();
    for (const [key, nested] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid();
      safeTree(nested, depth + 1);
    }
  }
}
function requestId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(id)) invalid('请求编号无效');
}
function roomCode(code: unknown): asserts code is string {
  // Keep existing six-digit rooms and saved invitations usable after the upgrade.
  if (typeof code !== 'string' || !/^(?:\d{4}|\d{6})$/.test(code)) invalid('请输入有效房间号');
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateRequest(request: unknown): asserts request is ApiRequest {
  object(request);
  safeTree(request);
  const fields: Record<string, string[]> = {
    'auth.guest': ['deviceSecret'],
    'auth.wechat.start': ['redirectUri', 'verifier'],
    'auth.wechat.finish': ['code', 'state', 'verifier'],
    session: [],
    create: ['name', 'config', 'requestId'],
    join: ['code', 'name', 'requestId'],
    get: ['code', 'version', 'gameId'],
    command: ['code', 'command', 'expectedVersion', 'phaseKey', 'requestId'],
    'notes.get': ['code'],
    'notes.save': ['code', 'notes', 'expectedRevision'],
  };
  if (typeof request.action !== 'string' || !Object.hasOwn(fields, request.action))
    invalid('未知操作');
  exact(request, ['action', ...fields[request.action]]);
  if (['join', 'get', 'command', 'notes.get', 'notes.save'].includes(request.action))
    roomCode(request.code);
  if (['create', 'join', 'command'].includes(request.action)) requestId(request.requestId);
  if (request.action === 'create' || request.action === 'join') {
    if (typeof request.name !== 'string' || !request.name.trim() || request.name.length > 256)
      invalid('名字须为 1–24 个字符');
  }
  if (request.action === 'create') validateConfig(request.config as GameConfig);
  if (
    request.action === 'get' &&
    request.version !== undefined &&
    (!Number.isSafeInteger(request.version) || Number(request.version) < 0)
  )
    invalid();
  if (
    request.action === 'get' &&
    request.gameId !== undefined &&
    (typeof request.gameId !== 'string' || request.gameId.length > 100)
  )
    invalid();
  if (request.action === 'command') {
    if (
      !Number.isSafeInteger(request.expectedVersion) ||
      Number(request.expectedVersion) < 1 ||
      typeof request.phaseKey !== 'string' ||
      request.phaseKey.length > 100
    )
      invalid();
    object(request.command);
    const commandFields: Record<string, string[]> = {
      configure: ['config'],
      reorder: ['playerIds', 'mode'],
      shuffleSeats: ['mode'],
      assignLeader: ['targetId', 'timing'],
      rename: ['name'],
      start: [],
      ready: [],
      propose: ['team'],
      teamVote: ['approve'],
      questVote: ['success'],
      lady: ['targetId'],
      assassinate: ['targetId'],
      transferHost: ['targetId'],
      kick: ['targetId', 'endGame'],
      leave: [],
      dissolve: [],
      abort: [],
      rematch: [],
    };
    if (
      typeof request.command.type !== 'string' ||
      !Object.hasOwn(commandFields, request.command.type)
    )
      invalid('未知游戏操作');
    exact(request.command, ['type', ...commandFields[request.command.type]]);
  }
}
function active(record: RoomRecord | null, now: number): RoomRecord {
  if (!record) throw new GameError('NOT_FOUND', '房间不存在或已清理');
  if (record.state.dissolvedAt !== undefined) throw new GameError('EXPIRED', '房间已被房主解散');
  if (record.state.expiresAt <= now) throw new GameError('EXPIRED', '房间已过期，请创建新房间');
  return record;
}
function member(room: RoomState, userId: string) {
  const player = room.players.find((player) => player.userId === userId);
  if (!player) throw new GameError('FORBIDDEN', '你不在此房间中');
  return player;
}
function userRate(user: UserRecord, action: string, now: number) {
  user.recentActions = user.recentActions.filter((entry) => entry.at > now - 3_600_000);
  if (
    user.recentActions.filter((entry) => entry.at > now - 60_000).length >= 20 ||
    (action === 'create' &&
      user.recentActions.filter((entry) => entry.action === 'create').length >= 5)
  ) {
    throw new GameError('RATE_LIMIT', '操作太频繁，请稍后再试');
  }
  user.recentActions.push({ at: now, action });
  // The minute cap permits at most 1,200 events/hour. Retain the entire hour
  // so repeated joins cannot evict create events and bypass the hourly cap.
  user.recentActions = user.recentActions.slice(-1200);
}
function roomRate(record: RoomRecord, userId: string, now: number) {
  record.recentWrites = record.recentWrites.filter((entry) => entry.at > now - 60_000);
  if (record.recentWrites.filter((entry) => entry.userId === userId).length >= 60)
    throw new GameError('RATE_LIMIT', '操作太频繁，请稍后再试');
  record.recentWrites.push({ userId, at: now });
}
function addReceipt(user: UserRecord, receipt: Receipt) {
  user.receipts = [...user.receipts, receipt].slice(-32);
}
async function replayJoin(
  transaction: Transaction,
  receipt: Receipt,
  hash: string,
  userId: string,
  now: number,
) {
  if (receipt.digest !== hash) throw new GameError('CONFLICT', '同一请求编号不能用于不同操作');
  const record = active(await transaction.get<RoomRecord>('rooms', receipt.code), now);
  member(record.state, userId);
  return projectRoom(record.state, userId);
}
async function notesRoom(
  transaction: Pick<Transaction, 'get'>,
  code: string,
  userId: string,
  now: number,
) {
  const record = active(await transaction.get<RoomRecord>('rooms', code), now);
  member(record.state, userId);
  return record;
}
function isNoteTarget(room: RoomState, id: string): boolean {
  return (
    room.players.some((player) => player.id === id) ||
    (room.phase === 'finished' && (room.departedPlayers ?? []).some((player) => player.id === id))
  );
}
function validateNotes(notes: unknown, room: RoomState, previous: Notes = {}): Notes {
  object(notes);
  if (Object.keys(notes).length > 12) invalid('笔记数量超出限制');
  const output: Notes = {};
  for (const [targetId, value] of Object.entries(notes)) {
    if (!isNoteTarget(room, targetId)) {
      // A lobby kick may race the owner's editor. Prune their previously saved
      // target without making all other notes impossible to save.
      if (Object.hasOwn(previous, targetId)) continue;
      invalid('笔记玩家不在房间');
    }
    object(value);
    exact(value, ['nickname', 'roleGuess', 'alignmentGuess', 'text']);
    if (
      typeof value.nickname !== 'string' ||
      value.nickname.length > 24 ||
      typeof value.text !== 'string' ||
      value.text.length > 1000 ||
      typeof value.roleGuess !== 'string' ||
      (value.roleGuess !== '' && !Object.hasOwn(ROLE_META, value.roleGuess)) ||
      !['good', 'evil', 'unknown'].includes(String(value.alignmentGuess))
    )
      invalid('笔记格式或长度无效');
    output[targetId] = {
      nickname: value.nickname,
      text: value.text,
      roleGuess: value.roleGuess,
      alignmentGuess: value.alignmentGuess,
    } as Notes[string];
  }
  return output;
}

export type ApiResult =
  | RoomView
  | { unchanged: true; version: number }
  | { left: true }
  | NotesResult
  | Awaited<ReturnType<typeof guestLogin>>
  | Awaited<ReturnType<typeof startWechat>>;
export async function handleApi(
  input: unknown,
  token: string | undefined,
  deps: AuthDeps,
): Promise<ApiResult> {
  validateRequest(input);
  const request = input;
  const now = (deps.now ?? Date.now)();
  if (request.action === 'auth.guest') return guestLogin(request.deviceSecret, deps);
  if (request.action === 'auth.wechat.start')
    return startWechat(request.redirectUri, request.verifier, deps);
  if (request.action === 'auth.wechat.finish')
    return finishWechat(request.code, request.state, request.verifier, deps);
  const claims = verifyToken(token, deps.auth, now);
  const userId = claims.userId;

  if (request.action === 'get') {
    // Normal polling costs exactly one database document read and no writes.
    const record = active(await deps.store.get<RoomRecord>('rooms', request.code), now);
    member(record.state, userId);
    // A recycled four-digit code can have the same version in a different game.
    // Legacy clients without a game ID receive the full authorized view.
    if (request.version === record.state.version && request.gameId === record.state.gameId)
      return { unchanged: true, version: record.state.version };
    return projectRoom(record.state, userId);
  }
  if (request.action === 'session') {
    return deps.store.transaction(async (transaction) => {
      const user = await ensureUser(transaction, userId, claims.provider, now);
      if (user.lastRoom) {
        const record = await transaction.get<RoomRecord>('rooms', user.lastRoom);
        if (
          !record ||
          record.state.expiresAt <= now ||
          !record.state.players.some((player) => player.userId === userId)
        )
          user.lastRoom = null;
      }
      await transaction.set('users', userId, user, user.expiresAt);
      return sessionFor(user, deps.auth, now);
    });
  }
  if (request.action === 'create') {
    const hash = digest(request);
    for (let attempt = 0; attempt < 32; attempt++) {
      const code = randomRoomCode();
      const result = await deps.store.transaction(async (transaction) => {
        const user = await ensureUser(transaction, userId, claims.provider, now);
        const receipt = user.receipts.find((receipt) => receipt.id === request.requestId);
        if (receipt) return replayJoin(transaction, receipt, hash, userId, now);
        // The read and write share a transaction, including concurrent creates.
        // Expired documents also reserve their code until cleanup removes them.
        if (await transaction.get('rooms', code)) return null;
        userRate(user, 'create', now);
        const state = createRoom(code, { userId, name: request.name }, request.config, now);
        user.lastRoom = code;
        addReceipt(user, { id: request.requestId, digest: hash, code, at: now });
        await transaction.set(
          'rooms',
          code,
          { state, receipts: [], recentWrites: [] } satisfies RoomRecord,
          state.expiresAt,
        );
        await transaction.set('users', userId, user, user.expiresAt);
        return projectRoom(state, userId);
      });
      if (result) return result;
    }
    throw new GameError('CONFLICT', '暂时无法创建房间，请重试');
  }
  if (request.action === 'join') {
    return deps.store.transaction(async (transaction) => {
      const user = await ensureUser(transaction, userId, claims.provider, now);
      const hash = digest(request);
      const receipt = user.receipts.find((receipt) => receipt.id === request.requestId);
      if (receipt) return replayJoin(transaction, receipt, hash, userId, now);
      userRate(user, 'join', now);
      const record = active(await transaction.get<RoomRecord>('rooms', request.code), now);
      record.state = joinRoom(record.state, { userId, name: request.name }, now);
      user.lastRoom = request.code;
      addReceipt(user, { id: request.requestId, digest: hash, code: request.code, at: now });
      await transaction.set('rooms', request.code, record, record.state.expiresAt);
      await transaction.set('users', userId, user, user.expiresAt);
      return projectRoom(record.state, userId);
    });
  }
  if (request.action === 'command') {
    return deps.store.transaction(async (transaction) => {
      const stored = await transaction.get<RoomRecord>('rooms', request.code);
      const hash = digest(request);
      const receipt = stored?.receipts.find(
        (receipt) => receipt.id === request.requestId && receipt.userId === userId,
      );
      if (receipt) {
        if (receipt.digest !== hash)
          throw new GameError('CONFLICT', '同一请求编号不能用于不同操作');
        if (receipt.left) return { left: true } as const;
      }
      const record = active(stored, now);
      if (receipt) {
        member(record.state, userId);
        return projectRoom(record.state, userId);
      }
      member(record.state, userId);
      const concurrent = ['ready', 'teamVote', 'questVote'].includes(request.command.type);
      if (
        request.phaseKey !== record.state.phaseKey ||
        request.expectedVersion > record.state.version ||
        (request.expectedVersion !== record.state.version && !concurrent)
      )
        throw new GameError('CONFLICT', '房间状态已更新，请刷新后重试');
      roomRate(record, userId, now);
      const dissolvedUserIds =
        request.command.type === 'dissolve'
          ? record.state.players.map((player) => player.userId)
          : [];
      record.state = applyCommand(record.state, userId, request.command as GameCommand, now);
      const left = request.command.type === 'leave' || request.command.type === 'dissolve';
      record.receipts = [
        ...record.receipts,
        { id: request.requestId, userId, digest: hash, left },
      ].slice(-512);
      await transaction.set('rooms', request.code, record, record.state.expiresAt);
      if (left) {
        const user = await ensureUser(transaction, userId, claims.provider, now);
        if (user.lastRoom === request.code) user.lastRoom = null;
        await transaction.set('users', userId, user, user.expiresAt);
        for (const leavingUserId of dissolvedUserIds.length ? dissolvedUserIds : [userId])
          await transaction.delete('notes', `${request.code}_${leavingUserId}`);
        return { left: true } as const;
      }
      return projectRoom(record.state, userId);
    });
  }
  if (request.action === 'notes.get') {
    const room = await notesRoom(deps.store, request.code, userId, now);
    const record = await deps.store.get<NoteRecord>('notes', `${request.code}_${userId}`);
    return record && noteMatchesRoom(record, room.state)
      ? {
          notes: Object.fromEntries(
            Object.entries(record.notes).filter(([id]) => isNoteTarget(room.state, id)),
          ),
          revision: record.revision,
        }
      : { notes: {}, revision: 0 };
  }
  if (request.action === 'notes.save') {
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) invalid();
    return deps.store.transaction(async (transaction) => {
      const room = await notesRoom(transaction, request.code, userId, now);
      const id = `${request.code}_${userId}`;
      const stored = await transaction.get<NoteRecord>('notes', id);
      const existing = stored && noteMatchesRoom(stored, room.state) ? stored : null;
      if ((existing?.revision ?? 0) !== request.expectedRevision)
        throw new GameError('CONFLICT', '笔记已在其他页面更新，请重新载入');
      // Notes share the room's persistent write limiter without changing its game version.
      roomRate(room, userId, now);
      const result: NoteRecord = {
        notes: validateNotes(request.notes, room.state, existing?.notes),
        revision: (existing?.revision ?? 0) + 1,
        expiresAt: room.state.expiresAt,
        ...(room.state.instanceId ? { roomInstanceId: room.state.instanceId } : {}),
        roomCreatedAt: room.state.createdAt,
      };
      await transaction.set('rooms', request.code, room, room.state.expiresAt);
      await transaction.set('notes', id, result, result.expiresAt);
      return { notes: result.notes, revision: result.revision };
    });
  }
  return invalid('未知操作');
}
