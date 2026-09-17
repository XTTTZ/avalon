import { randomInt, randomUUID } from 'node:crypto';
import { LANCELOT_RULES, ROLE_META, validateConfig } from '../shared/rules';
import {
  GameError,
  type Alignment,
  type GameCommand,
  type GameConfig,
  type KnownPlayer,
  type LeaderMode,
  type Phase,
  type PrivateSelf,
  type PublicEvent,
  type PublicPlayer,
  type QuestResult,
  type Role,
  type RoomView,
  type TeamVoteResult,
} from '../shared/types';

export interface ServerPlayer extends PublicPlayer {
  userId: string;
}
interface PlayerSecret {
  role: Role;
  alignment: Alignment;
  knownPlayers: KnownPlayer[];
  ladyResults: PrivateSelf['ladyResults'];
}

/** Authoritative persistence document. Never serialize this to a browser. */
export interface RoomState {
  code: string;
  version: number;
  gameId: string;
  phaseKey: string;
  phase: Phase;
  hostId: string;
  players: ServerPlayer[];
  config: GameConfig;
  leaderId: string | null;
  // Optional on disk for rooms created before host-directed leadership was added.
  leaderMode?: LeaderMode;
  nextLeaderId?: string | null;
  round: number;
  rejectionCount: number;
  proposedTeam: string[];
  readyIds: string[];
  quests: QuestResult[];
  teamVotes: TeamVoteResult[];
  ladyHolderId: string | null;
  ladyHistory: string[];
  lancelotChanges: { round: number; changed: boolean }[];
  winner: Alignment | null;
  finishReason: string | null;
  assassinationTargetId: string | null;
  events: PublicEvent[];
  createdAt: number;
  expiresAt: number;
  secrets: Record<string, PlayerSecret>;
  teamBallots: Record<string, boolean>;
  questBallots: Record<string, boolean>;
  lancelotDeck: boolean[];
}

type Actor = { userId: string; name: string };
const ROOM_LIFETIME = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 160;
function fail(code: ConstructorParameters<typeof GameError>[0], message: string): never {
  throw new GameError(code, message);
}
function ensure(
  test: unknown,
  code: ConstructorParameters<typeof GameError>[0],
  message: string,
): asserts test {
  if (!test) fail(code, message);
}
function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
function nameOf(name: unknown): string {
  ensure(typeof name === 'string', 'INVALID', '公开名字格式错误');
  const clean = name.trim();
  ensure(
    clean.length >= 1 && Array.from(clean).length <= 24 && !/[\p{Cc}\p{Cf}]/u.test(clean),
    'INVALID',
    '名字须为 1–24 个可见字符',
  );
  return clean;
}
function assertActor(actor: Actor) {
  ensure(
    actor &&
      typeof actor.userId === 'string' &&
      actor.userId.length > 0 &&
      actor.userId.length <= 256,
    'UNAUTHORIZED',
    '请重新登录',
  );
}
function event(room: RoomState, text: string, now: number) {
  room.events.push({ id: (room.events.at(-1)?.id ?? 0) + 1, text, at: now });
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
}
function transition(room: RoomState, phase: Phase) {
  room.phase = phase;
  room.phaseKey = randomUUID();
}
function requirePhase(room: RoomState, phase: Phase) {
  ensure(room.phase === phase, 'CONFLICT', '当前阶段不支持此操作，请刷新房间');
}
function member(room: RoomState, userId: string): ServerPlayer {
  const player = room.players.find((p) => p.userId === userId);
  ensure(player, 'FORBIDDEN', '你不在此房间中');
  return player;
}
function host(room: RoomState, player: ServerPlayer) {
  ensure(room.hostId === player.id, 'FORBIDDEN', '只有房主可以执行此操作');
}
function target(room: RoomState, targetId: unknown): ServerPlayer {
  ensure(typeof targetId === 'string', 'INVALID', '请选择玩家');
  const player = room.players.find((p) => p.id === targetId);
  ensure(player, 'INVALID', '玩家不存在');
  return player;
}
function clearGame(room: RoomState) {
  room.leaderId = null;
  room.nextLeaderId = null;
  room.round = 0;
  room.rejectionCount = 0;
  room.proposedTeam = [];
  room.readyIds = [];
  room.quests = [];
  room.teamVotes = [];
  room.ladyHolderId = null;
  room.ladyHistory = [];
  room.lancelotChanges = [];
  room.winner = null;
  room.finishReason = null;
  room.assassinationTargetId = null;
  room.secrets = {};
  room.teamBallots = {};
  room.questBallots = {};
  room.lancelotDeck = [];
}

export function createRoom(
  code: string,
  actor: Actor,
  config: GameConfig,
  now = Date.now(),
): RoomState {
  assertActor(actor);
  ensure(typeof code === 'string' && /^\d{4}$/.test(code), 'INVALID', '房间号须为四位数字');
  const player = { id: randomUUID(), userId: actor.userId, name: nameOf(actor.name), seat: 0 };
  return {
    code,
    version: 1,
    gameId: randomUUID(),
    phaseKey: randomUUID(),
    phase: 'lobby',
    hostId: player.id,
    players: [player],
    config: validateConfig(config),
    leaderId: null,
    leaderMode: 'rotation',
    nextLeaderId: null,
    round: 0,
    rejectionCount: 0,
    proposedTeam: [],
    readyIds: [],
    quests: [],
    teamVotes: [],
    ladyHolderId: null,
    ladyHistory: [],
    lancelotChanges: [],
    winner: null,
    finishReason: null,
    assassinationTargetId: null,
    events: [{ id: 1, text: `${player.name} 创建了房间`, at: now }],
    createdAt: now,
    expiresAt: now + ROOM_LIFETIME,
    secrets: {},
    teamBallots: {},
    questBallots: {},
    lancelotDeck: [],
  };
}

export function joinRoom(source: RoomState, actor: Actor, now = Date.now()): RoomState {
  assertActor(actor);
  ensure(source.expiresAt > now, 'EXPIRED', '房间已过期，请创建新房间');
  if (source.players.some((p) => p.userId === actor.userId)) return structuredClone(source);
  requirePhase(source, 'lobby');
  ensure(source.players.length < source.config.playerCount, 'CONFLICT', '房间已满');
  const room = structuredClone(source);
  const player = {
    id: randomUUID(),
    userId: actor.userId,
    name: nameOf(actor.name),
    seat: room.players.length,
  };
  room.players.push(player);
  if (room.players.length === 1) room.hostId = player.id;
  event(room, `${player.name} 加入了房间`, now);
  room.version++;
  return room;
}

function assignSecrets(room: RoomState) {
  const cards = shuffle(room.config.roles);
  room.players.forEach((p, i) => {
    room.secrets[p.id] = {
      role: cards[i],
      alignment: ROLE_META[cards[i]].alignment,
      knownPlayers: [],
      ladyResults: [],
    };
  });
  for (const player of room.players) {
    const own = room.secrets[player.id];
    for (const other of room.players) {
      if (other.id === player.id) continue;
      const theirs = room.secrets[other.id];
      if (own.role === 'merlin' && theirs.alignment === 'evil' && theirs.role !== 'mordred') {
        own.knownPlayers.push({ playerId: other.id, kind: 'evil', label: '开局邪恶' });
      } else if (
        own.role === 'percival' &&
        (theirs.role === 'merlin' || theirs.role === 'morgana')
      ) {
        own.knownPlayers.push({
          playerId: other.id,
          kind: 'merlin_candidate',
          label: '梅林／莫甘娜候选',
        });
      } else if (own.role.startsWith('lancelot_') && theirs.role.startsWith('lancelot_')) {
        own.knownPlayers.push({ playerId: other.id, kind: 'lancelot', label: '另一位兰斯洛特' });
      } else if (
        own.alignment === 'evil' &&
        own.role !== 'oberon' &&
        !own.role.startsWith('lancelot_') &&
        theirs.alignment === 'evil' &&
        theirs.role !== 'oberon' &&
        !theirs.role.startsWith('lancelot_')
      ) {
        own.knownPlayers.push({ playerId: other.id, kind: 'ally', label: '邪恶同伴' });
      }
    }
  }
}

function initializeLady(room: RoomState) {
  if (!room.config.lady || room.ladyHolderId || !room.leaderId) return;
  const index = room.players.findIndex((p) => p.id === room.leaderId);
  room.ladyHolderId = room.players[(index + room.players.length - 1) % room.players.length].id;
  room.ladyHistory = [room.ladyHolderId];
}
function rotateLeader(room: RoomState) {
  if (room.nextLeaderId) {
    room.leaderId = room.nextLeaderId;
    room.nextLeaderId = null;
    return;
  }
  if (room.leaderMode === 'manual') {
    room.leaderId = null;
    return;
  }
  const index = room.players.findIndex((p) => p.id === room.leaderId);
  room.leaderId = room.players[(index + 1) % room.players.length].id;
}
function beginRound(room: RoomState, now: number) {
  room.proposedTeam = [];
  room.teamBallots = {};
  room.questBallots = {};
  room.rejectionCount = 0;
  if (room.config.lancelot === 'changing' && room.round >= 3) {
    if (!room.lancelotDeck.length) room.lancelotDeck = shuffle([false, false, false, true, true]);
    const changed = room.lancelotDeck.pop()!;
    if (changed)
      for (const secret of Object.values(room.secrets))
        if (secret.role.startsWith('lancelot_'))
          secret.alignment = secret.alignment === 'good' ? 'evil' : 'good';
    room.lancelotChanges.push({ round: room.round, changed });
    event(room, `第 ${room.round} 轮兰斯洛特变化牌：${changed ? '交换当前阵营' : '阵营不变'}`, now);
  }
  transition(room, 'team');
}
function nextRound(room: RoomState, now: number) {
  room.round++;
  // validateConfig guarantees a victory before exhausting the configured table.
  ensure(room.round <= room.config.quests.length, 'INTERNAL', '任务轮数异常');
  rotateLeader(room);
  beginRound(room, now);
}
function finish(room: RoomState, winner: Alignment | null, reason: string, now: number) {
  room.winner = winner;
  room.finishReason = reason;
  room.questBallots = {};
  room.teamBallots = {};
  room.nextLeaderId = null;
  transition(room, 'finished');
  event(room, reason, now);
}
function resolveQuest(room: RoomState, now: number) {
  const cards = Object.values(room.questBallots);
  const fails = cards.filter((success) => !success).length;
  const passed = fails < room.config.quests[room.round - 1].failsRequired;
  room.quests.push({
    round: room.round,
    team: [...room.proposedTeam],
    fails,
    successes: cards.length - fails,
    passed,
  });
  // Discard player-to-card association immediately. It is never part of history,
  // logs, final role disclosure, or the browser projection.
  room.questBallots = {};
  event(room, `第 ${room.round} 轮任务${passed ? '成功' : '失败'}：${fails} 张失败票`, now);
  const goodWins = room.quests.filter((q) => q.passed).length;
  const evilWins = room.quests.length - goodWins;
  if (evilWins >= room.config.winsRequired)
    return finish(room, 'evil', '邪恶达成任务失败胜利条件', now);
  if (goodWins >= room.config.winsRequired) {
    if (Object.values(room.secrets).some((s) => s.role === 'assassin')) {
      transition(room, 'assassination');
      event(room, '好人达成任务条件，等待刺客选择梅林', now);
      return;
    }
    return finish(room, 'good', '好人达成任务成功胜利条件', now);
  }
  if (room.config.lady && room.round >= 2 && room.round <= 4) {
    transition(room, 'lady');
    event(room, '湖中仙女持有人正在查验阵营', now);
    return;
  }
  nextRound(room, now);
}

export function applyCommand(
  source: RoomState,
  userId: string,
  command: GameCommand,
  now = Date.now(),
): RoomState {
  ensure(source.expiresAt > now, 'EXPIRED', '房间已过期，请创建新房间');
  ensure(
    command &&
      typeof command === 'object' &&
      !Array.isArray(command) &&
      typeof command.type === 'string',
    'INVALID',
    '操作格式错误',
  );
  const room = structuredClone(source);
  const player = member(room, userId);
  switch (command.type) {
    case 'configure': {
      host(room, player);
      requirePhase(room, 'lobby');
      const config = validateConfig(command.config);
      ensure(config.playerCount >= room.players.length, 'INVALID', '配置人数不能少于已加入人数');
      room.config = config;
      event(room, '房主更新了游戏规则', now);
      break;
    }
    case 'rename': {
      const name = nameOf(command.name);
      if (name === player.name) return structuredClone(source);
      player.name = name;
      break;
    }
    case 'reorder':
    case 'shuffleSeats': {
      host(room, player);
      ensure(
        room.phase !== 'finished' && room.phase !== 'assassination',
        'CONFLICT',
        '本局已不再组队',
      );
      const mode = command.mode ?? room.leaderMode ?? 'rotation';
      ensure(mode === 'rotation' || mode === 'manual', 'INVALID', '带队方式无效');
      const ids =
        command.type === 'reorder' ? command.playerIds : shuffle(room.players.map((p) => p.id));
      ensure(
        Array.isArray(ids) &&
          ids.length === room.players.length &&
          new Set(ids).size === room.players.length,
        'INVALID',
        '顺序必须包含全部玩家，且不可重复',
      );
      const ordered = ids.map((id) => target(room, id));
      if (
        ordered.every((p, index) => p.id === room.players[index].id) &&
        mode === (room.leaderMode ?? 'rotation')
      )
        return structuredClone(source);
      room.leaderMode = mode;
      room.players = ordered;
      room.players.forEach((p, index) => {
        p.seat = index;
      });
      if (
        mode === 'rotation' &&
        !room.leaderId &&
        (room.phase === 'team' || room.phase === 'reveal')
      ) {
        room.leaderId = room.players[randomInt(room.players.length)].id;
        initializeLady(room);
        transition(room, room.phase);
      }
      event(
        room,
        mode === 'manual'
          ? '房主更新了座位顺序，带队由房主指定'
          : command.type === 'shuffleSeats'
            ? '房主随机排列了带队顺序'
            : '房主更新了带队顺序，按序循环',
        now,
      );
      break;
    }
    case 'assignLeader': {
      host(room, player);
      ensure(
        ['reveal', 'team', 'teamVote', 'questVote', 'lady'].includes(room.phase),
        'CONFLICT',
        '当前阶段不能指定队长',
      );
      ensure(command.timing === 'current' || command.timing === 'next', 'INVALID', '指定时机无效');
      if (command.timing === 'next') {
        const chosen = command.targetId === null ? null : target(room, command.targetId);
        room.nextLeaderId = chosen?.id ?? null;
        event(
          room,
          chosen ? `房主指定 ${chosen.name} 为下一任队长` : '房主取消了下一任队长指定',
          now,
        );
      } else {
        ensure(
          room.phase === 'reveal' || room.phase === 'team',
          'CONFLICT',
          '本轮已开始投票，请指定下一任队长',
        );
        const chosen = target(room, command.targetId);
        if (chosen.id === room.leaderId) return structuredClone(source);
        room.leaderId = chosen.id;
        room.proposedTeam = [];
        initializeLady(room);
        transition(room, room.phase);
        event(room, `房主指定 ${chosen.name} 为当前队长`, now);
      }
      break;
    }
    case 'start': {
      host(room, player);
      requirePhase(room, 'lobby');
      room.config = validateConfig(room.config);
      ensure(
        room.players.length === room.config.playerCount,
        'CONFLICT',
        '等待全部玩家加入后再开始',
      );
      clearGame(room);
      room.gameId = randomUUID();
      assignSecrets(room);
      if (room.leaderMode !== 'manual') {
        room.leaderId = room.players[randomInt(room.players.length)].id;
        initializeLady(room);
      }
      transition(room, 'reveal');
      event(room, '已随机发身份；请各自查看并确认', now);
      break;
    }
    case 'ready': {
      requirePhase(room, 'reveal');
      if (room.readyIds.includes(player.id)) return structuredClone(source);
      room.readyIds.push(player.id);
      if (room.readyIds.length === room.players.length) {
        room.round = 1;
        beginRound(room, now);
        event(room, '所有人已确认身份，开始第一轮组队', now);
      }
      break;
    }
    case 'propose': {
      requirePhase(room, 'team');
      ensure(room.leaderId === player.id, 'FORBIDDEN', '只有本轮队长可以组队');
      const team = command.team;
      ensure(
        Array.isArray(team) && team.length === room.config.quests[room.round - 1].size,
        'INVALID',
        '任务队伍人数不正确',
      );
      ensure(new Set(team).size === team.length, 'INVALID', '任务队员不可重复');
      team.forEach((id) => target(room, id));
      room.proposedTeam = room.players.filter((p) => team.includes(p.id)).map((p) => p.id);
      room.teamBallots = {};
      transition(room, 'teamVote');
      event(room, `${player.name} 提交了任务队伍，等待全员投票`, now);
      break;
    }
    case 'teamVote': {
      requirePhase(room, 'teamVote');
      ensure(typeof command.approve === 'boolean', 'INVALID', '组队票格式错误');
      ensure(!Object.hasOwn(room.teamBallots, player.id), 'CONFLICT', '已投组队票，不可更改');
      room.teamBallots[player.id] = command.approve;
      if (Object.keys(room.teamBallots).length === room.players.length) {
        const approved =
          Object.values(room.teamBallots).filter(Boolean).length > room.players.length / 2;
        room.teamVotes.push({
          round: room.round,
          attempt: room.rejectionCount + 1,
          leaderId: room.leaderId!,
          team: [...room.proposedTeam],
          votes: { ...room.teamBallots },
          approved,
        });
        room.teamBallots = {};
        if (approved) {
          room.rejectionCount = 0;
          transition(room, 'questVote');
          event(room, '组队通过，任务成员请秘密提交任务票', now);
        } else {
          room.rejectionCount++;
          if (room.rejectionCount >= room.config.rejectionLimit)
            finish(room, 'evil', `连续 ${room.config.rejectionLimit} 次组队被拒绝，邪恶获胜`, now);
          else {
            rotateLeader(room);
            room.proposedTeam = [];
            transition(room, 'team');
            event(room, `组队未通过，连续拒绝 ${room.rejectionCount} 次；队长顺延`, now);
          }
        }
      }
      break;
    }
    case 'questVote': {
      requirePhase(room, 'questVote');
      ensure(typeof command.success === 'boolean', 'INVALID', '任务票格式错误');
      ensure(room.proposedTeam.includes(player.id), 'FORBIDDEN', '只有任务队员可以提交任务票');
      ensure(!Object.hasOwn(room.questBallots, player.id), 'CONFLICT', '已提交任务票，不可更改');
      ensure(
        command.success || room.secrets[player.id].alignment === 'evil',
        'FORBIDDEN',
        '当前为正义阵营，只能提交成功票',
      );
      room.questBallots[player.id] = command.success;
      if (Object.keys(room.questBallots).length === room.proposedTeam.length)
        resolveQuest(room, now);
      break;
    }
    case 'lady': {
      requirePhase(room, 'lady');
      ensure(room.ladyHolderId === player.id, 'FORBIDDEN', '只有湖中仙女持有人可以查验');
      const chosen = target(room, command.targetId);
      ensure(!room.ladyHistory.includes(chosen.id), 'INVALID', '不能查验任何曾持有湖中仙女的玩家');
      room.secrets[player.id].ladyResults.push({
        round: room.round,
        targetId: chosen.id,
        alignment: room.secrets[chosen.id].alignment,
      });
      room.ladyHolderId = chosen.id;
      room.ladyHistory.push(chosen.id);
      event(room, `${player.name} 查验了 ${chosen.name}；湖中仙女已交接`, now);
      nextRound(room, now);
      break;
    }
    case 'assassinate': {
      requirePhase(room, 'assassination');
      ensure(room.secrets[player.id].role === 'assassin', 'FORBIDDEN', '只有刺客可以刺杀');
      const chosen = target(room, command.targetId);
      ensure(chosen.id !== player.id, 'INVALID', '不能刺杀自己');
      room.assassinationTargetId = chosen.id;
      const hit = room.secrets[chosen.id].role === 'merlin';
      finish(
        room,
        hit ? 'evil' : 'good',
        hit ? '刺客命中梅林，邪恶获胜' : '刺客未命中梅林，好人获胜',
        now,
      );
      break;
    }
    case 'transferHost': {
      host(room, player);
      requirePhase(room, 'lobby');
      room.hostId = target(room, command.targetId).id;
      event(room, '房主权限已转交', now);
      break;
    }
    case 'kick': {
      host(room, player);
      requirePhase(room, 'lobby');
      const chosen = target(room, command.targetId);
      ensure(chosen.id !== player.id, 'INVALID', '请使用离开房间');
      room.players = room.players.filter((p) => p.id !== chosen.id);
      room.players.forEach((p, i) => {
        p.seat = i;
      });
      event(room, `${chosen.name} 已被移出大厅`, now);
      break;
    }
    case 'leave': {
      requirePhase(room, 'lobby');
      room.players = room.players.filter((p) => p.id !== player.id);
      room.players.forEach((p, i) => {
        p.seat = i;
      });
      if (room.hostId === player.id) room.hostId = room.players[0]?.id ?? '';
      event(room, `${player.name} 离开了房间`, now);
      break;
    }
    case 'abort': {
      host(room, player);
      ensure(room.phase !== 'lobby' && room.phase !== 'finished', 'CONFLICT', '没有进行中的游戏');
      finish(room, null, '房主提前结束了本局；无获胜阵营', now);
      break;
    }
    case 'rematch': {
      host(room, player);
      requirePhase(room, 'finished');
      clearGame(room);
      room.gameId = randomUUID();
      room.events = [];
      room.expiresAt = now + ROOM_LIFETIME;
      transition(room, 'lobby');
      event(room, '返回大厅，准备重新发身份', now);
      break;
    }
    default:
      fail('INVALID', '未知游戏操作');
  }
  room.version++;
  return room;
}

/** Explicit whitelist is the security boundary; no spread of authoritative state. */
export function projectRoom(source: RoomState, userId: string): RoomView {
  const player = member(source, userId);
  const secret = source.secrets[player.id];
  const view: RoomView = {
    room: {
      code: source.code,
      version: source.version,
      gameId: source.gameId,
      phaseKey: source.phaseKey,
      phase: source.phase,
      hostId: source.hostId,
      players: source.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })),
      config: source.config,
      leaderId: source.leaderId,
      leaderMode: source.leaderMode ?? 'rotation',
      nextLeaderId: source.nextLeaderId ?? null,
      round: source.round,
      rejectionCount: source.rejectionCount,
      proposedTeam: source.proposedTeam,
      readyIds: source.readyIds,
      teamVotedIds: Object.keys(source.teamBallots),
      questSubmittedCount: Object.keys(source.questBallots).length,
      quests: source.quests,
      teamVotes: source.teamVotes,
      ladyHolderId: source.ladyHolderId,
      ladyHistory: source.ladyHistory,
      lancelotChanges: source.lancelotChanges,
      winner: source.winner,
      finishReason: source.finishReason,
      assassinationTargetId: source.assassinationTargetId,
      revealedRoles:
        source.phase === 'finished'
          ? source.players.map((p) => ({
              playerId: p.id,
              role: source.secrets[p.id].role,
              alignment: source.secrets[p.id].alignment,
            }))
          : [],
      events: source.events,
      createdAt: source.createdAt,
      expiresAt: source.expiresAt,
    },
    self: {
      playerId: player.id,
      role: secret?.role ?? null,
      alignment: secret?.alignment ?? null,
      knownPlayers: secret?.knownPlayers ?? [],
      roleText: secret
        ? ROLE_META[secret.role].description +
          (source.config.lancelot !== 'off' ? ` ${LANCELOT_RULES}` : '')
        : '身份将在房主开始游戏后随机发放。',
      teamVote: Object.hasOwn(source.teamBallots, player.id) ? source.teamBallots[player.id] : null,
      questSubmitted: Object.hasOwn(source.questBallots, player.id),
      ladyResults: secret?.ladyResults ?? [],
      canAssassinate: source.phase === 'assassination' && secret?.role === 'assassin',
    },
  };
  return structuredClone(view);
}
