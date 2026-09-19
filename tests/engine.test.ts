import { describe, expect, it } from 'vitest';
import { applyCommand, createRoom, joinRoom, projectRoom, type RoomState } from '../server/engine';
import { ROLE_META, standardConfig, validateConfig } from '../shared/rules';
import { GameError, type GameCommand, type GameConfig, type Role } from '../shared/types';

const NOW = 1_900_000_000_000;
function fullRoom(config = standardConfig(5)): RoomState {
  let room = createRoom('1234', { userId: 'user-0', name: '玩家 1' }, config, NOW);
  for (let i = 1; i < config.playerCount; i++)
    room = joinRoom(room, { userId: `user-${i}`, name: `玩家 ${i + 1}` }, NOW);
  return room;
}
function command(room: RoomState, playerId: string, action: GameCommand) {
  return applyCommand(room, room.players.find((p) => p.id === playerId)!.userId, action, NOW);
}
function start(config = standardConfig(5), ready = true): RoomState {
  let room = fullRoom(config);
  room = command(room, room.hostId, { type: 'start' });
  if (ready) for (const p of room.players) room = command(room, p.id, { type: 'ready' });
  return room;
}
function byRole(room: RoomState, role: Role) {
  return room.players.find((p) => room.secrets[p.id]?.role === role)!;
}
function view(room: RoomState, id: string) {
  return projectRoom(room, room.players.find((p) => p.id === id)!.userId);
}
function teamWithEvil(room: RoomState): string[] {
  return [...room.players]
    .sort(
      (a, b) =>
        Number(room.secrets[b.id].alignment === 'evil') -
        Number(room.secrets[a.id].alignment === 'evil'),
    )
    .slice(0, room.config.quests[room.round - 1].size)
    .map((p) => p.id);
}
function approveTeam(room: RoomState, team = teamWithEvil(room)): RoomState {
  room = command(room, room.leaderId!, { type: 'propose', team });
  for (const p of room.players) room = command(room, p.id, { type: 'teamVote', approve: true });
  return room;
}
function quest(room: RoomState, failures = 0): RoomState {
  room = approveTeam(room);
  let remaining = failures;
  for (const id of room.proposedTeam) {
    const success = !(remaining > 0 && room.secrets[id].alignment === 'evil');
    if (!success) remaining--;
    room = command(room, id, { type: 'questVote', success });
  }
  expect(remaining).toBe(0);
  return room;
}
function errorCode(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('Expected error');
  } catch (error) {
    expect(error).toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe(code);
  }
}

describe('configuration', () => {
  it.each([
    [5, 2, [2, 3, 2, 3, 3]],
    [6, 2, [2, 3, 4, 3, 4]],
    [7, 3, [2, 3, 3, 4, 4]],
    [8, 3, [3, 4, 4, 5, 5]],
    [9, 3, [3, 4, 4, 5, 5]],
    [10, 4, [3, 4, 4, 5, 5]],
  ] as const)('uses the official %i-player table', (count, evil, sizes) => {
    const config = validateConfig(standardConfig(count));
    expect(config.evilCount).toBe(evil);
    expect(config.quests.map((q) => q.size)).toEqual(sizes);
    expect(config.quests.map((q) => q.failsRequired)).toEqual([1, 1, 1, count >= 7 ? 2 : 1, 1]);
    expect(config.rejectionLimit).toBe(5);
  });
  it.each([11, 12])(
    'labels %i-player defaults as extensions and supports a whole game',
    (count) => {
      expect(standardConfig(count).preset).toBe('custom');
      let room = start(standardConfig(count));
      for (let i = 0; i < 3; i++) room = quest(room);
      expect(room.phase).toBe('assassination');
    },
  );
  it('permits early custom victory but rejects unreachable thresholds and impossible failures', () => {
    const config = {
      ...standardConfig(5),
      preset: 'custom' as const,
      winsRequired: 2,
      quests: Array.from({ length: 6 }, () => ({ size: 2, failsRequired: 1 })),
    };
    expect(validateConfig(config).winsRequired).toBe(2);
    errorCode(() => validateConfig({ ...config, winsRequired: 4 }), 'INVALID');
    errorCode(
      () =>
        validateConfig({
          ...config,
          quests: [{ size: 4, failsRequired: 3 }, ...config.quests.slice(1)],
        }),
      'INVALID',
    );
    let room = start(config);
    room = quest(quest(room));
    expect(room.phase).toBe('assassination');
    expect(room.quests).toHaveLength(2);
  });
  it('checks untrusted values, duplicate special roles and paired modules', () => {
    const config = standardConfig(5);
    for (const mutation of [
      { playerCount: '5' },
      { evilCount: NaN },
      { lady: 'false' },
      { rejectionLimit: 1.5 },
      { quests: null },
      { roles: ['merlin', 'merlin', 'assassin', 'morgana', 'loyalist'] },
      { roles: ['merlin', 'percival', 'assassin', '__proto__', 'loyalist'] },
      { lancelot: 'changing' },
      { preset: 'unknown' },
      { evilCount: 3 },
    ])
      errorCode(() => validateConfig({ ...config, ...mutation } as GameConfig), 'INVALID');
    errorCode(
      () => validateConfig({ ...config, quests: config.quests.map((q) => ({ ...q, size: 1 })) }),
      'INVALID',
    );
    errorCode(
      () =>
        validateConfig({
          ...config,
          preset: 'custom',
          roles: ['loyalist', 'loyalist', 'loyalist', 'assassin', 'morgana'],
        }),
      'INVALID',
    );
  });
  it('allows a custom game without Merlin and assassin, with immediate good victory', () => {
    const config = {
      ...standardConfig(5),
      preset: 'custom' as const,
      roles: ['loyalist', 'loyalist', 'loyalist', 'minion', 'minion'] as Role[],
    };
    let room = start(config);
    for (let i = 0; i < 3; i++) room = quest(room);
    expect(room.phase).toBe('finished');
    expect(room.winner).toBe('good');
  });
});

describe('seat order and leader rotation', () => {
  it('validates complete unique orders and permits only the host to change an active circle', () => {
    const source = fullRoom();
    const ids = source.players.map((p) => p.id);
    for (const playerIds of [
      null,
      ids.slice(1),
      [...ids.slice(1), ids[1]],
      ['missing', ...ids.slice(1)],
    ]) {
      errorCode(
        () => command(source, source.hostId, { type: 'reorder', playerIds } as GameCommand),
        'INVALID',
      );
    }
    for (const action of [
      { type: 'reorder', playerIds: [...ids].reverse() },
      { type: 'shuffleSeats' },
    ] as GameCommand[]) {
      errorCode(() => command(source, ids[1], action), 'FORBIDDEN');
      const active = command(source, source.hostId, { type: 'start' });
      const changed = command(active, active.hostId, action);
      expect(changed.leaderId).toBe(active.leaderId);
      expect(changed.secrets).toEqual(active.secrets);
      const finished = command(active, active.hostId, { type: 'abort' });
      errorCode(() => command(finished, finished.hostId, action), 'CONFLICT');
    }
    expect(source.players.map((p) => p.id)).toEqual(ids);
  });
  it('waits for a host-selected leader on every manual turn and initializes Lady only once', () => {
    let room = fullRoom({ ...standardConfig(5), lady: true });
    const ids = room.players.map((p) => p.id);
    room = command(room, room.hostId, { type: 'reorder', playerIds: ids, mode: 'manual' });
    room = command(room, room.hostId, { type: 'start' });
    const seats = room.players.map((player) => player.id);
    expect(room.leaderId).toBeNull();
    expect(room.ladyHolderId).toBeNull();
    for (const p of room.players) room = command(room, p.id, { type: 'ready' });
    errorCode(() => command(room, ids[0], { type: 'propose', team: ids.slice(0, 2) }), 'FORBIDDEN');
    errorCode(
      () => command(room, ids[1], { type: 'assignLeader', targetId: ids[2], timing: 'current' }),
      'FORBIDDEN',
    );
    room = command(room, room.hostId, {
      type: 'assignLeader',
      targetId: ids[2],
      timing: 'current',
    });
    const ladyId = seats[(seats.indexOf(ids[2]) + seats.length - 1) % seats.length];
    expect(room.ladyHolderId).toBe(ladyId);
    room = quest(room);
    expect(room.phase).toBe('team');
    expect(room.leaderId).toBeNull();
    const beforeSwitch = room.phaseKey;
    room = command(room, room.hostId, { type: 'reorder', playerIds: ids, mode: 'rotation' });
    expect(room.leaderId).not.toBeNull();
    expect(room.phaseKey).not.toBe(beforeSwitch);
    const current = room.leaderId;
    room = command(room, room.hostId, { type: 'reorder', playerIds: ids, mode: 'manual' });
    expect(room.leaderId).toBe(current);
    room = command(room, room.hostId, {
      type: 'assignLeader',
      targetId: ids[2],
      timing: 'current',
    });
    room = quest(room);
    expect(room.phase).toBe('lady');
    expect(room.ladyHolderId).toBe(ladyId);
    room = command(room, room.hostId, { type: 'assignLeader', targetId: ids[2], timing: 'next' });
    room = command(room, room.ladyHolderId!, {
      type: 'lady',
      targetId: room.players.find((player) => !room.ladyHistory.includes(player.id))!.id,
    });
    expect(room.leaderId).toBe(ids[2]); // Consecutive appointments are allowed.
    expect(room.nextLeaderId).toBeNull();
    room = command(room, room.hostId, { type: 'abort' });
    room = command(room, room.hostId, { type: 'rematch' });
    expect(room.leaderMode).toBe('manual');
  });
  it('keeps votes and secrets intact when order changes during voting and honors the next appointment', () => {
    let room = start();
    const leader = room.leaderId;
    const secrets = structuredClone(room.secrets);
    const ids = room.players.map((p) => p.id);
    const team = ids.slice(0, 2);
    room = command(room, leader!, { type: 'propose', team });
    room = command(room, ids[0], { type: 'teamVote', approve: true });
    const phaseKey = room.phaseKey;
    room = command(room, room.hostId, { type: 'reorder', playerIds: [...ids].reverse() });
    expect(room.leaderId).toBe(leader);
    expect(room.phaseKey).toBe(phaseKey);
    expect(room.teamBallots).toEqual({ [ids[0]]: true });
    expect(room.proposedTeam).toEqual(team);
    expect(room.secrets).toEqual(secrets);
    errorCode(
      () =>
        command(room, room.hostId, { type: 'assignLeader', targetId: ids[1], timing: 'current' }),
      'CONFLICT',
    );
    room = command(room, room.hostId, { type: 'assignLeader', targetId: leader, timing: 'next' });
    for (const id of ids.slice(1)) room = command(room, id, { type: 'teamVote', approve: false });
    expect(room.leaderId).toBe(leader);
    expect(room.nextLeaderId).toBeNull();
    expect(room.teamVotes[0].votes[ids[0]]).toBe(true);
    room = approveTeam(room, team);
    room = command(room, team[0], { type: 'questVote', success: true });
    room = command(room, room.hostId, { type: 'shuffleSeats', mode: 'manual' });
    expect(room.questBallots).toEqual({ [team[0]]: true });
    expect(room.leaderId).toBe(leader);
    const next = ids.find((id) => id !== leader)!;
    room = command(room, room.hostId, { type: 'assignLeader', targetId: next, timing: 'next' });
    room = command(room, room.hostId, { type: 'assignLeader', targetId: null, timing: 'next' });
    expect(room.nextLeaderId).toBeNull();
    room = command(room, room.hostId, { type: 'assignLeader', targetId: next, timing: 'next' });
    room = command(room, team[1], { type: 'questVote', success: true });
    expect(room.quests[0].successes).toBe(2);
    expect(room.leaderId).toBe(next);
    expect(room.nextLeaderId).toBeNull();
    expect(room.secrets).toEqual(secrets);
    room = command(room, next, { type: 'propose', team: ids.slice(0, 3) });
    for (const id of ids) room = command(room, id, { type: 'teamVote', approve: false });
    expect(room.leaderId).toBeNull();
    expect(projectRoom(room, room.players[0].userId).room.leaderMode).toBe('manual');
  });
  it('keeps a custom circle through rejections, tasks, Lady, and rematch', () => {
    const source = fullRoom({
      ...standardConfig(5),
      preset: 'custom',
      rejectionLimit: 10,
      lady: true,
    });
    let orderedIds = [2, 0, 4, 1, 3].map((index) => source.players[index].id);
    let room = command(source, source.hostId, { type: 'reorder', playerIds: orderedIds });
    expect(room.players.map((p) => p.id)).toEqual(orderedIds);
    expect(room.players.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4]);
    for (const player of source.players) {
      expect(projectRoom(room, player.userId).self.playerId).toBe(player.id);
      expect(room.players.find((p) => p.id === player.id)?.name).toBe(player.name);
    }
    room = command(room, room.hostId, { type: 'start' });
    orderedIds = room.players.map((player) => player.id);
    for (const player of room.players) room = command(room, player.id, { type: 'ready' });
    const startIndex = orderedIds.indexOf(room.leaderId!);
    const cycle = [...orderedIds.slice(startIndex), ...orderedIds.slice(0, startIndex)];
    const previous = orderedIds[(startIndex + orderedIds.length - 1) % orderedIds.length];
    expect(room.ladyHolderId).toBe(previous);
    for (let i = 0; i < cycle.length; i++) {
      expect(room.leaderId).toBe(cycle[i]);
      room = command(room, room.leaderId!, { type: 'propose', team: orderedIds.slice(0, 2) });
      for (const player of room.players)
        room = command(room, player.id, { type: 'teamVote', approve: false });
    }
    expect(room.leaderId).toBe(cycle[0]);
    room = quest(room);
    expect(room.leaderId).toBe(cycle[1]);
    room = quest(room);
    expect(room.phase).toBe('lady');
    expect(room.leaderId).toBe(cycle[1]);
    room = command(room, room.ladyHolderId!, {
      type: 'lady',
      targetId: room.players.find((p) => !room.ladyHistory.includes(p.id))!.id,
    });
    expect(room.leaderId).toBe(cycle[2]);
    room = command(room, room.hostId, { type: 'abort' });
    room = command(room, room.hostId, { type: 'rematch' });
    expect(room.players.map((p) => p.id)).toEqual(orderedIds);
  });
  it('randomizes the full circle once, and keeps IDs when people join or leave', () => {
    const source = fullRoom();
    const original = source.players.map((p) => p.id);
    let room = command(source, source.hostId, { type: 'shuffleSeats' });
    expect(room.players.map((p) => p.id).sort()).toEqual([...original].sort());
    expect(room.players.map((p) => p.seat)).toEqual([0, 1, 2, 3, 4]);
    const removed = room.players.find((p) => p.id !== room.hostId)!;
    const remaining = room.players.filter((p) => p.id !== removed.id).map((p) => p.id);
    room = command(room, room.hostId, { type: 'kick', targetId: removed.id });
    expect(room.players.map((p) => p.id)).toEqual(remaining);
    room = joinRoom(room, { userId: 'replacement', name: '新玩家' }, NOW);
    expect(room.players.slice(0, -1).map((p) => p.id)).toEqual(remaining);
    const circle = room.players.map((p) => p.id);
    room = command(room, room.hostId, { type: 'start' });
    expect(room.players.map((p) => p.id).sort()).toEqual([...circle].sort());
  });
});

describe('lobby and authoritative permissions', () => {
  it('preserves immutable state, player identity and monotonically increasing versions', () => {
    const original = createRoom(
      '1111',
      { userId: 'host', name: '  亚瑟  ' },
      standardConfig(5),
      NOW,
    );
    const joined = joinRoom(original, { userId: 'guest', name: '骑士' }, NOW);
    expect(original.players).toHaveLength(1);
    expect(joined.version).toBe(2);
    expect(original.players[0].name).toBe('亚瑟');
    const returned = joinRoom(joined, { userId: 'guest', name: '不自动改名' }, NOW);
    expect(returned.version).toBe(2);
    expect(returned.players[1].name).toBe('骑士');
    const renamed = applyCommand(joined, 'guest', { type: 'rename', name: '派克' }, NOW);
    expect(renamed.players[1].id).toBe(joined.players[1].id);
    expect(renamed.version).toBe(3);
    expect(joined.players[1].name).toBe('骑士');
  });
  it('only lets host configure/start/kick, transfers host on leave and reseats players', () => {
    let room = fullRoom();
    const originalHost = room.hostId;
    const guest = room.players[1];
    errorCode(() => command(room, guest.id, { type: 'start' }), 'FORBIDDEN');
    errorCode(() => command(room, guest.id, { type: 'kick', targetId: originalHost }), 'FORBIDDEN');
    room = command(room, originalHost, { type: 'transferHost', targetId: guest.id });
    expect(room.hostId).toBe(guest.id);
    room = command(room, guest.id, { type: 'kick', targetId: originalHost });
    expect(room.players.map((p) => p.seat)).toEqual([0, 1, 2, 3]);
    room = command(room, guest.id, { type: 'leave' });
    expect(room.hostId).toBe(room.players[0].id);
    errorCode(
      () => applyCommand(room, guest.userId, { type: 'rename', name: '入侵' }, NOW),
      'FORBIDDEN',
    );
  });
  it('refuses nonmembers, expired rooms, malformed inputs and underfilled games', () => {
    const room = createRoom('1234', { userId: 'host', name: '房主' }, standardConfig(5), NOW);
    errorCode(() => applyCommand(room, 'host', { type: 'start' }, NOW), 'CONFLICT');
    errorCode(() => projectRoom(room, 'stranger'), 'FORBIDDEN');
    errorCode(() => applyCommand(room, 'host', { type: 'rename', name: '\n' }, NOW), 'INVALID');
    errorCode(
      () => applyCommand(room, 'host', { type: 'unknown' } as unknown as GameCommand, NOW),
      'INVALID',
    );
    errorCode(() => joinRoom(room, { userId: 'late', name: '骑士' }, room.expiresAt), 'EXPIRED');
  });
  it('forbids replacing active players and rejoining preserves active identity', () => {
    const room = start();
    const p = room.players[0];
    const other = room.players.find((player) => player.id !== room.hostId)!;
    for (const type of ['leave', 'kick', 'transferHost', 'configure'] as const) {
      const action =
        type === 'configure' ? { type, config: room.config } : { type, targetId: other.id };
      errorCode(() => command(room, room.hostId, action as GameCommand), 'CONFLICT');
    }
    errorCode(() => joinRoom(room, { userId: 'new', name: '替补' }, NOW), 'CONFLICT');
    expect(joinRoom(room, { userId: p.userId, name: '重连' }, NOW).players[0].id).toBe(p.id);
  });
  it('requires all identity confirmations and rotates phaseKey only on stage transitions', () => {
    let room = start(standardConfig(5), false);
    const key = room.phaseKey;
    room = command(room, room.players[0].id, { type: 'ready' });
    expect(room.phase).toBe('reveal');
    expect(room.phaseKey).toBe(key);
    expect(command(room, room.players[0].id, { type: 'ready' }).version).toBe(room.version);
    for (const p of room.players.slice(1)) room = command(room, p.id, { type: 'ready' });
    expect(room.phase).toBe('team');
    expect(room.round).toBe(1);
    expect(room.phaseKey).not.toBe(key);
  });
});

describe('team votes and quests', () => {
  it('validates captain, unique team and exact mission size', () => {
    const room = start();
    const other = room.players.find((p) => p.id !== room.leaderId)!;
    errorCode(
      () => command(room, other.id, { type: 'propose', team: teamWithEvil(room) }),
      'FORBIDDEN',
    );
    errorCode(
      () => command(room, room.leaderId!, { type: 'propose', team: [other.id, other.id] }),
      'INVALID',
    );
    errorCode(
      () => command(room, room.leaderId!, { type: 'propose', team: [other.id] }),
      'INVALID',
    );
    errorCode(
      () => command(room, room.leaderId!, { type: 'propose', team: [other.id, 'fake-id'] }),
      'INVALID',
    );
  });
  it('does not publish any vote choice until everyone has voted; a tie rejects', () => {
    let room = start(standardConfig(6));
    const previousLeader = room.leaderId;
    room = command(room, room.leaderId!, { type: 'propose', team: teamWithEvil(room) });
    const voter = room.players[0];
    room = command(room, voter.id, { type: 'teamVote', approve: false });
    expect(view(room, room.players[1].id).room.teamVotes).toEqual([]);
    expect(view(room, room.players[1].id).self.teamVote).toBeNull();
    expect(view(room, voter.id).self.teamVote).toBe(false);
    errorCode(() => command(room, voter.id, { type: 'teamVote', approve: true }), 'CONFLICT');
    for (let i = 1; i < room.players.length; i++)
      room = command(room, room.players[i].id, { type: 'teamVote', approve: i <= 3 });
    expect(room.phase).toBe('team');
    expect(room.rejectionCount).toBe(1);
    expect(room.leaderId).not.toBe(previousLeader);
    expect(room.teamVotes[0].approved).toBe(false);
    expect(Object.keys(room.teamVotes[0].votes)).toHaveLength(6);
  });
  it('ends in evil victory after exactly five consecutive rejected teams', () => {
    let room = start();
    const leaders: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      leaders.push(room.leaderId!);
      room = command(room, room.leaderId!, { type: 'propose', team: teamWithEvil(room) });
      for (const p of room.players)
        room = command(room, p.id, { type: 'teamVote', approve: false });
      expect(room.phase).toBe(attempt < 5 ? 'team' : 'finished');
    }
    expect(new Set(leaders).size).toBe(5);
    expect(room.winner).toBe('evil');
    expect(room.quests).toEqual([]);
  });
  it('allows only team members to submit and good players may never submit failure', () => {
    let room = start();
    const good = room.players.filter((p) => room.secrets[p.id].alignment === 'good');
    room = approveTeam(
      room,
      good.slice(0, 2).map((p) => p.id),
    );
    errorCode(() => command(room, good[0].id, { type: 'questVote', success: false }), 'FORBIDDEN');
    errorCode(() => command(room, good[2].id, { type: 'questVote', success: true }), 'FORBIDDEN');
    room = command(room, good[0].id, { type: 'questVote', success: true });
    errorCode(() => command(room, good[0].id, { type: 'questVote', success: true }), 'CONFLICT');
    expect(view(room, good[2].id).room.questSubmittedCount).toBe(1);
    expect(view(room, good[0].id).self.questSubmitted).toBe(true);
    expect(view(room, good[2].id).self.questSubmitted).toBe(false);
  });
  it('resets rejection count after approval and uses two failures for the fourth 7-player quest', () => {
    let room = start(standardConfig(7));
    room = quest(room, 1);
    room = quest(room, 0);
    room = quest(room, 1);
    expect(room.round).toBe(4);
    room = quest(room, 1);
    expect(room.quests[3].passed).toBe(true);
    expect(room.phase).toBe('team');
    expect(room.round).toBe(5);
    room = quest(room, 1);
    expect(room.winner).toBe('evil');
  });
  it('permanently drops individual task ballots, including after game end', () => {
    let room = start();
    room = quest(room, 1);
    expect(room.questBallots).toEqual({});
    expect(room.quests[0].fails).toBe(1);
    room = command(room, room.hostId, { type: 'abort' });
    for (const player of room.players) {
      const payload = view(room, player.id);
      expect(Object.keys(payload.room.quests[0]).sort()).toEqual([
        'fails',
        'passed',
        'round',
        'successes',
        'team',
      ]);
      expect(JSON.stringify(payload)).not.toContain('questBallots');
    }
  });
  it.each([true, false])('resolves assassination correctly when hit=%s', (hit) => {
    let room = start();
    for (let i = 0; i < 3; i++) room = quest(room);
    expect(room.phase).toBe('assassination');
    expect(room.winner).toBeNull();
    const assassin = byRole(room, 'assassin');
    const merlin = byRole(room, 'merlin');
    expect(view(room, assassin.id).self.canAssassinate).toBe(true);
    errorCode(
      () => command(room, merlin.id, { type: 'assassinate', targetId: assassin.id }),
      'FORBIDDEN',
    );
    const chosen = hit ? merlin : byRole(room, 'loyalist');
    room = command(room, assassin.id, { type: 'assassinate', targetId: chosen.id });
    expect(room.phase).toBe('finished');
    expect(room.winner).toBe(hit ? 'evil' : 'good');
    expect(view(room, merlin.id).room.revealedRoles).toHaveLength(5);
  });
});

describe('secrets, optional modules and rematch', () => {
  it('projects only authorized knowledge, respecting Mordred, Oberon and Percival ambiguity', () => {
    const config = standardConfig(10);
    config.roles = [
      'merlin',
      'percival',
      'loyalist',
      'loyalist',
      'loyalist',
      'loyalist',
      'assassin',
      'morgana',
      'mordred',
      'oberon',
    ];
    const room = start(config);
    const ids = (role: Role) =>
      view(room, byRole(room, role).id)
        .self.knownPlayers.map((p) => p.playerId)
        .sort();
    expect(ids('merlin')).toEqual(
      ['assassin', 'morgana', 'oberon'].map((role) => byRole(room, role as Role).id).sort(),
    );
    expect(ids('percival')).toEqual(
      ['merlin', 'morgana'].map((role) => byRole(room, role as Role).id).sort(),
    );
    expect(ids('oberon')).toEqual([]);
    expect(ids('loyalist')).toEqual([]);
    expect(ids('assassin')).toEqual(
      ['mordred', 'morgana'].map((role) => byRole(room, role as Role).id).sort(),
    );
    for (const p of room.players) {
      const payload = view(room, p.id);
      expect(payload.room.revealedRoles).toEqual([]);
      expect(payload.room.players.every((player) => !('userId' in player))).toBe(true);
      for (const hidden of ['secrets', 'teamBallots', 'questBallots', 'lancelotDeck'])
        expect(payload.room).not.toHaveProperty(hidden);
      expect(payload.self.role).toBe(room.secrets[p.id].role);
    }
    const payload = view(room, room.hostId);
    payload.room.config.roles.length = 0;
    expect(room.config.roles).toHaveLength(10);
  });
  it('keeps lady results private, passes the token, and disallows any former holder', () => {
    let room = start({ ...standardConfig(7), lady: true });
    room = quest(room, 0);
    room = quest(room, 1);
    expect(room.phase).toBe('lady');
    const holder = room.ladyHolderId!;
    errorCode(() => command(room, holder, { type: 'lady', targetId: holder }), 'INVALID');
    const target = room.players.find((p) => p.id !== holder)!;
    const alignment = room.secrets[target.id].alignment;
    room = command(room, holder, { type: 'lady', targetId: target.id });
    expect(view(room, holder).self.ladyResults).toEqual([
      { round: 2, targetId: target.id, alignment },
    ]);
    expect(view(room, target.id).self.ladyResults).toEqual([]);
    expect(room.ladyHolderId).toBe(target.id);
    expect(room.phase).toBe('team');
    expect(room.round).toBe(3);
    room = quest(room, 0);
    expect(room.phase).toBe('lady');
    errorCode(() => command(room, target.id, { type: 'lady', targetId: holder }), 'INVALID');
    const next = room.players.find((p) => !room.ladyHistory.includes(p.id))!;
    room = command(room, target.id, { type: 'lady', targetId: next.id });
    expect(room.ladyHistory).toEqual([holder, target.id, next.id]);
    expect(
      view(room, room.players.find((player) => player.id !== target.id)!.id).room.ladyHistory,
    ).toEqual([holder, target.id, next.id]);
  });
  it('skips lady actions once a winning threshold is reached', () => {
    let room = start({ ...standardConfig(5), lady: true });
    room = quest(quest(room));
    const holder = room.ladyHolderId!;
    room = command(room, holder, {
      type: 'lady',
      targetId: room.players.find((p) => p.id !== holder)!.id,
    });
    room = quest(room);
    expect(room.phase).toBe('assassination');
  });
  it('uses initial knowledge but current alignment after a Lancelot swap', () => {
    const config = standardConfig(9);
    config.lancelot = 'changing';
    config.roles = [
      'merlin',
      'percival',
      'loyalist',
      'loyalist',
      'loyalist',
      'lancelot_good',
      'assassin',
      'morgana',
      'lancelot_evil',
    ];
    let room = start(config);
    const good = byRole(room, 'lancelot_good');
    const evil = byRole(room, 'lancelot_evil');
    const assassin = byRole(room, 'assassin');
    const merlin = byRole(room, 'merlin');
    const knowledge = view(room, merlin.id).self.knownPlayers;
    expect(view(room, good.id).self.knownPlayers.map((k) => k.playerId)).toEqual([evil.id]);
    expect(view(room, evil.id).self.knownPlayers.map((k) => k.playerId)).toEqual([good.id]);
    expect(view(room, assassin.id).self.knownPlayers.some((k) => k.playerId === evil.id)).toBe(
      false,
    );
    room.lancelotDeck = [true];
    room = quest(quest(room));
    expect(room.round).toBe(3);
    expect(room.lancelotChanges).toEqual([{ round: 3, changed: true }]);
    expect(room.secrets[good.id].alignment).toBe('evil');
    expect(room.secrets[evil.id].alignment).toBe('good');
    expect(view(room, merlin.id).self.knownPlayers).toEqual(knowledge);
    expect(Object.values(room.secrets).filter((s) => s.alignment === 'evil')).toHaveLength(
      config.evilCount,
    );
    const team = [
      good.id,
      evil.id,
      ...room.players
        .filter((p) => p.id !== good.id && p.id !== evil.id)
        .slice(0, 2)
        .map((p) => p.id),
    ];
    room = approveTeam(room, team);
    errorCode(() => command(room, evil.id, { type: 'questVote', success: false }), 'FORBIDDEN');
    room = command(room, good.id, { type: 'questVote', success: false });
    expect(view(room, good.id).self.questSubmitted).toBe(true);
  });
  it('draws from a five-card deck, reshuffles for extended games, and preserves fixed mode', () => {
    const config = standardConfig(9);
    config.preset = 'custom';
    config.lancelot = 'changing';
    config.winsRequired = 5;
    config.quests = Array.from({ length: 9 }, () => ({ size: 4, failsRequired: 1 }));
    config.roles = [
      'merlin',
      'percival',
      'loyalist',
      'loyalist',
      'loyalist',
      'lancelot_good',
      'assassin',
      'morgana',
      'lancelot_evil',
    ];
    let room = start(config);
    for (let i = 0; i < 8; i++) room = quest(room, i % 2);
    expect(room.round).toBe(9);
    expect(room.lancelotChanges).toHaveLength(7);
    expect(room.lancelotChanges.slice(0, 5).filter((draw) => draw.changed)).toHaveLength(2);
    expect(room.lancelotDeck).toHaveLength(3);
    const fixed = { ...config, lancelot: 'fixed' as const };
    let fixedRoom = start(fixed);
    fixedRoom = quest(quest(fixedRoom));
    expect(fixedRoom.lancelotChanges).toEqual([]);
    for (const secret of Object.values(fixedRoom.secrets))
      expect(secret.alignment).toBe(ROLE_META[secret.role].alignment);
  });
  it('supports host abort and cleans all previous secret state before a rematch', () => {
    let room = start();
    const gameId = room.gameId;
    const ids = room.players.map((p) => p.id);
    room = quest(room, 1);
    room = command(room, room.hostId, { type: 'abort' });
    expect(room.phase).toBe('finished');
    expect(room.winner).toBeNull();
    room = command(room, room.hostId, { type: 'rematch' });
    expect(room.gameId).not.toBe(gameId);
    expect(room.phase).toBe('lobby');
    expect(room.secrets).toEqual({});
    expect(room.players.map((p) => p.id)).toEqual(ids);
    expect(room.quests).toEqual([]);
    expect(view(room, room.hostId).self.role).toBeNull();
    expect(view(room, room.hostId).room.revealedRoles).toEqual([]);
    room = command(room, room.hostId, { type: 'start' });
    expect(room.phase).toBe('reveal');
  });
});

describe('card order and host removals', () => {
  it('starts a random full circle at its first card and rotates without reshuffling', () => {
    const lobby = fullRoom();
    let room = command(lobby, lobby.hostId, { type: 'start' });
    const order = room.players.map((player) => player.id);
    expect([...order].sort()).toEqual(lobby.players.map((player) => player.id).sort());
    expect(room.players.map((player) => player.seat)).toEqual([0, 1, 2, 3, 4]);
    expect(room.leaderId).toBe(order[0]);
    for (const player of room.players) room = command(room, player.id, { type: 'ready' });
    room = approveTeam(room);
    for (const id of room.proposedTeam)
      room = command(room, id, { type: 'questVote', success: true });
    expect(room.leaderId).toBe(order[1]);
    expect(room.players.map((player) => player.id)).toEqual(order);
    expect(room.orderCustomized).not.toBe(true);
  });

  it('requires host confirmation to end a live game and preserves the removed identity only in the result', () => {
    let room = start();
    const removed = room.players.find((player) => player.id !== room.hostId)!;
    const role = room.secrets[removed.id].role;
    errorCode(
      () => command(room, removed.id, { type: 'kick', targetId: room.hostId, endGame: true }),
      'FORBIDDEN',
    );
    errorCode(
      () => command(room, room.hostId, { type: 'kick', targetId: room.hostId, endGame: true }),
      'INVALID',
    );
    errorCode(() => command(room, room.hostId, { type: 'kick', targetId: removed.id }), 'CONFLICT');
    expect(view(room, room.hostId).room.departedPlayers).toEqual([]);
    room = command(room, room.hostId, { type: 'kick', targetId: removed.id, endGame: true });
    expect(room.phase).toBe('finished');
    expect(room.winner).toBeNull();
    expect(room.players).toHaveLength(4);
    errorCode(() => projectRoom(room, removed.userId), 'FORBIDDEN');
    const visible = view(room, room.hostId).room;
    expect(visible.revealedRoles).toHaveLength(5);
    expect(visible.revealedRoles.find((entry) => entry.playerId === removed.id)?.role).toBe(role);
    expect(JSON.stringify(visible)).not.toContain(removed.userId);
    room = command(room, room.hostId, { type: 'rematch' });
    expect(room.departedPlayers).toEqual([]);
    expect(room.players).toHaveLength(4);
    expect(view(room, room.hostId).room.revealedRoles).toEqual([]);
    errorCode(() => command(room, room.hostId, { type: 'start' }), 'CONFLICT');
  });

  it('lets players leave a finished game and lets only the host dissolve the room', () => {
    let room = start();
    room = command(room, room.hostId, { type: 'abort' });
    const leaving = room.players.find((player) => player.id !== room.hostId)!;
    const role = room.secrets[leaving.id].role;
    room = command(room, leaving.id, { type: 'leave' });
    expect(room.players.some((player) => player.id === leaving.id)).toBe(false);
    expect(room.departedPlayers).toContainEqual({
      id: leaving.id,
      name: leaving.name,
      seat: leaving.seat,
      departure: 'left',
    });
    expect(view(room, room.hostId).room.revealedRoles).toContainEqual({
      playerId: leaving.id,
      role,
      alignment: room.secrets[leaving.id].alignment,
    });
    errorCode(() => command(room, room.players[1].id, { type: 'dissolve' }), 'FORBIDDEN');
    room = command(room, room.hostId, { type: 'dissolve' });
    expect(room.players).toEqual([]);
    expect(room.dissolvedAt).toBe(NOW);
    expect(room.expiresAt).toBe(NOW);
  });
});
