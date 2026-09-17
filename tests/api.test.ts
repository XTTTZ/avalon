import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { standardConfig } from '../shared/rules';
import type { ApiRequest, GameCommand, RoomView, Session, NotesResult } from '../shared/types';
import { handleApi, type RoomRecord } from '../server/api';
import { readAuthConfig, type AuthDeps } from '../server/auth';
import { CloudBaseStore, FileStore, type DatabaseLike } from '../server/store';
import { createHttpHandler } from '../server/http';
import * as roomCodes from '../server/room-code';

const now = 1_800_000_000_000;
const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function deps(store = new FileStore(null)): AuthDeps {
  return {
    store,
    now: () => now,
    auth: readAuthConfig({ SESSION_SECRET: 'a'.repeat(48), ALLOW_GUEST: 'true' }),
  };
}
async function guest(dependencies: AuthDeps, id: number): Promise<Session> {
  return (await handleApi(
    { action: 'auth.guest', deviceSecret: String(id).padStart(48, 'a') },
    undefined,
    dependencies,
  )) as Session;
}
async function setup(dependencies = deps(), count = 5) {
  const sessions = await Promise.all(
    Array.from({ length: count }, (_, index) => guest(dependencies, index)),
  );
  let view = (await handleApi(
    { action: 'create', name: '玩家0', config: standardConfig(count), requestId: randomUUID() },
    sessions[0].token,
    dependencies,
  )) as RoomView;
  for (let i = 1; i < count; i++)
    view = (await handleApi(
      { action: 'join', code: view.room.code, name: `玩家${i}`, requestId: randomUUID() },
      sessions[i].token,
      dependencies,
    )) as RoomView;
  return { deps: dependencies, sessions, view };
}
function command(view: RoomView, value: GameCommand, id = randomUUID()): ApiRequest {
  return {
    action: 'command',
    code: view.room.code,
    command: value,
    expectedVersion: view.room.version,
    phaseKey: view.room.phaseKey,
    requestId: id,
  };
}
async function advanceToTeam(context: Awaited<ReturnType<typeof setup>>) {
  let view = (await handleApi(
    command(context.view, { type: 'start' }),
    context.sessions[0].token,
    context.deps,
  )) as RoomView;
  const requests = context.sessions.map((session) =>
    handleApi(command(view, { type: 'ready' }), session.token, context.deps),
  );
  const result = await Promise.all(requests);
  view = result.at(-1) as RoomView;
  expect(view.room.phase).toBe('team');
  return view;
}
describe('authoritative API, retries and persistence', () => {
  it('invalidates former leader requests and persists pending appointments with retry protection', async () => {
    const context = await setup();
    const before = await advanceToTeam(context);
    const oldLeader = before.room.players.findIndex((p) => p.id === before.room.leaderId);
    const next = before.room.players.find((p) => p.id !== before.room.leaderId)!;
    const replaced = (await handleApi(
      command(before, { type: 'assignLeader', targetId: next.id, timing: 'current' }),
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    expect(replaced.room.phaseKey).not.toBe(before.room.phaseKey);
    await expect(
      handleApi(
        command(before, {
          type: 'propose',
          team: before.room.players.slice(0, 2).map((p) => p.id),
        }),
        context.sessions[oldLeader].token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const pending = command(replaced, { type: 'assignLeader', targetId: next.id, timing: 'next' });
    const assigned = (await handleApi(
      pending,
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    const retry = (await handleApi(pending, context.sessions[0].token, context.deps)) as RoomView;
    expect(retry.room.version).toBe(assigned.room.version);
    const restored = (await handleApi(
      { action: 'get', code: before.room.code },
      context.sessions[1].token,
      context.deps,
    )) as RoomView;
    expect(restored.room.nextLeaderId).toBe(next.id);
    expect(restored.room.leaderId).toBe(next.id);
  });
  it('allocates four-digit rooms atomically when concurrent creates collide', async () => {
    const dependencies = deps();
    const [first, second] = await Promise.all([guest(dependencies, 0), guest(dependencies, 1)]);
    const random = vi
      .spyOn(roomCodes, 'randomRoomCode')
      .mockReturnValueOnce('1234')
      .mockReturnValueOnce('1234')
      .mockReturnValueOnce('5678');
    const [a, b] = (await Promise.all(
      [first, second].map((session, index) =>
        handleApi(
          {
            action: 'create',
            name: `房主${index}`,
            config: standardConfig(5),
            requestId: randomUUID(),
          },
          session.token,
          dependencies,
        ),
      ),
    )) as RoomView[];
    expect(new Set([a.room.code, b.room.code])).toEqual(new Set(['1234', '5678']));
    expect(random).toHaveBeenCalledTimes(3);
    for (const [index, view] of [a, b].entries()) {
      expect(view.room.code).toMatch(/^[1-9]\d{3}$/);
      const record = await dependencies.store.get<RoomRecord>('rooms', view.room.code);
      expect(record?.state.hostId).toBe(view.self.playerId);
      expect(record?.state.players[0].userId).toBe([first, second][index].userId);
    }
  });
  it('never overwrites an occupied code, including expired rooms awaiting cleanup', async () => {
    const context = await setup();
    const before = await context.deps.store.get<RoomRecord>('rooms', context.view.room.code);
    const other = await guest(context.deps, 100);
    const random = vi.spyOn(roomCodes, 'randomRoomCode').mockReturnValue(context.view.room.code);
    const later = { ...context.deps, now: () => now + 8 * 86_400_000 };
    await expect(
      handleApi(
        { action: 'create', name: '新房主', config: standardConfig(5), requestId: randomUUID() },
        other.token,
        later,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(random).toHaveBeenCalledTimes(32);
    expect(await context.deps.store.get('rooms', context.view.room.code)).toEqual(before);
    await context.deps.store.cleanup(now + 8 * 86_400_000);
    const after = (await handleApi(
      { action: 'create', name: '新房主', config: standardConfig(5), requestId: randomUUID() },
      other.token,
      later,
    )) as RoomView;
    expect(after.room.code).toBe(context.view.room.code);
    expect(after.room.gameId).not.toBe(context.view.room.gameId);
  });
  it('keeps legacy six-digit rooms accessible without creating new six-digit rooms', async () => {
    const context = await setup();
    const record = (await context.deps.store.get<RoomRecord>('rooms', context.view.room.code))!;
    record.state.code = '990080';
    await context.deps.store.transaction((transaction) =>
      transaction.set('rooms', '990080', record, record.state.expiresAt),
    );
    const restored = (await handleApi(
      { action: 'get', code: '990080' },
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    expect(restored.self.playerId).toBe(context.view.room.players[0].id);
    expect(restored.room.code).toBe('990080');
  });
  it('persists seating with private notes and rejects stale or unauthorized orders', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avalon-seat-order-'));
    temporary.push(directory);
    const filename = join(directory, 'rooms.json');
    const context = await setup(deps(new FileStore(filename)));
    const code = context.view.room.code;
    const ids = context.view.room.players.map((p) => p.id);
    const notes = {
      [ids[1]]: {
        nickname: '私人昵称',
        roleGuess: '',
        alignmentGuess: 'unknown',
        text: '只绑定玩家，不绑定座位',
      },
    };
    await handleApi(
      { action: 'notes.save', code, notes, expectedRevision: 0 },
      context.sessions[0].token,
      context.deps,
    );
    const reorder = command(context.view, { type: 'reorder', playerIds: [...ids].reverse() });
    await expect(handleApi(reorder, context.sessions[1].token, context.deps)).rejects.toMatchObject(
      { code: 'FORBIDDEN' },
    );
    const view = (await handleApi(reorder, context.sessions[0].token, context.deps)) as RoomView;
    expect(view.self.playerId).toBe(ids[0]);
    expect(view.room.players.map((p) => p.id)).toEqual([...ids].reverse());
    await expect(
      handleApi(
        command(context.view, { type: 'shuffleSeats' }),
        context.sessions[0].token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const shuffle = command(view, { type: 'shuffleSeats' });
    const shuffled = (await handleApi(
      shuffle,
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    const replay = (await handleApi(shuffle, context.sessions[0].token, context.deps)) as RoomView;
    expect(replay.room.players).toEqual(shuffled.room.players);
    expect(replay.room.version).toBe(shuffled.room.version);
    const reopened = deps(new FileStore(filename));
    const restored = (await handleApi(
      { action: 'get', code },
      context.sessions[0].token,
      reopened,
    )) as RoomView;
    expect(restored.room.players).toEqual(shuffled.room.players);
    expect(
      await handleApi({ action: 'notes.get', code }, context.sessions[0].token, reopened),
    ).toMatchObject({ notes });
  });
  it('serializes joins, preserves stable membership and deduplicates create/join response loss', async () => {
    const dependencies = deps();
    const sessions = await Promise.all(Array.from({ length: 5 }, (_, i) => guest(dependencies, i)));
    const create: ApiRequest = {
      action: 'create',
      name: '房主',
      config: standardConfig(5),
      requestId: randomUUID(),
    };
    const copies = (await Promise.all([
      handleApi(create, sessions[0].token, dependencies),
      handleApi(create, sessions[0].token, dependencies),
    ])) as RoomView[];
    expect(copies[0].room.code).toBe(copies[1].room.code);
    const requests = sessions.slice(1).map((_, i): ApiRequest => ({
      action: 'join',
      code: copies[0].room.code,
      name: `玩家${i}`,
      requestId: randomUUID(),
    }));
    await Promise.all(
      requests.map((request, i) => handleApi(request, sessions[i + 1].token, dependencies)),
    );
    const replay = (await handleApi(requests[0], sessions[1].token, dependencies)) as RoomView;
    expect(replay.room.players).toHaveLength(5);
    expect(replay.room.version).toBe(5);
    await expect(
      handleApi({ ...create, name: '别名' }, sessions[0].token, dependencies),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
  it('permits same-phase concurrent votes, exactly once, and rejects old phase ballots', async () => {
    const context = await setup();
    const team = await advanceToTeam(context);
    const leaderIndex = team.room.players.findIndex((player) => player.id === team.room.leaderId);
    const voting = (await handleApi(
      command(team, {
        type: 'propose',
        team: team.room.players.slice(0, 2).map((player) => player.id),
      }),
      context.sessions[leaderIndex].token,
      context.deps,
    )) as RoomView;
    const requests = context.sessions.map(() =>
      command(voting, { type: 'teamVote', approve: true }),
    );
    const results = (await Promise.all(
      context.sessions.map((session, i) => handleApi(requests[i], session.token, context.deps)),
    )) as RoomView[];
    expect(results.at(-1)!.room.phase).toBe('questVote');
    expect(results.at(-1)!.room.teamVotes).toHaveLength(1);
    const retry = (await handleApi(
      requests[0],
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    expect(retry.room.version).toBe(results.at(-1)!.room.version);
    await expect(
      handleApi(
        command(voting, { type: 'teamVote', approve: false }),
        context.sessions[0].token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(JSON.stringify(retry)).not.toContain('questBallots');
  });
  it('blocks unauthenticated/nonmember reads and stale or impersonated actions', async () => {
    const context = await setup();
    const stranger = await guest(context.deps, 9);
    await expect(
      handleApi({ action: 'get', code: context.view.room.code }, undefined, context.deps),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      handleApi(
        { action: 'get', code: context.view.room.code, version: context.view.room.version },
        stranger.token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      handleApi(
        { action: 'get', code: context.view.room.code, userId: context.sessions[0].userId },
        stranger.token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID' });
    await expect(
      handleApi(command(context.view, { type: 'start' }), context.sessions[1].token, context.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const renamed = (await handleApi(
      command(context.view, { type: 'rename', name: '新名字' }),
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    await expect(
      handleApi(command(context.view, { type: 'start' }), context.sessions[0].token, context.deps),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await handleApi(
        { action: 'get', code: renamed.room.code, version: renamed.room.version },
        context.sessions[0].token,
        context.deps,
      ),
    ).toEqual({ unchanged: true, version: renamed.room.version });
  });
  it('isolates private notes, checks target/revision and rejects prototype keys', async () => {
    const context = await setup();
    const code = context.view.room.code;
    const target = context.view.room.players[0].id;
    const notes = {
      [target]: {
        nickname: '我的昵称',
        roleGuess: 'merlin',
        alignmentGuess: 'good',
        text: '仅自己可见秘密',
      },
    };
    const saved = (await handleApi(
      { action: 'notes.save', code, notes, expectedRevision: 0 },
      context.sessions[1].token,
      context.deps,
    )) as NotesResult;
    expect(saved.revision).toBe(1);
    expect(
      await handleApi({ action: 'notes.get', code }, context.sessions[0].token, context.deps),
    ).toEqual({ notes: {}, revision: 0 });
    expect(
      await handleApi({ action: 'notes.get', code }, context.sessions[1].token, context.deps),
    ).toEqual(saved);
    await expect(
      handleApi(
        { action: 'notes.get', code, userId: context.sessions[1].userId },
        context.sessions[0].token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID' });
    await expect(
      handleApi(
        { action: 'notes.save', code, notes, expectedRevision: 0 },
        context.sessions[1].token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      handleApi(
        { action: 'notes.save', code, notes: { outsider: notes[target] }, expectedRevision: 1 },
        context.sessions[1].token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID' });
    await expect(
      handleApi(
        JSON.parse(
          `{"action":"notes.save","code":"${code}","notes":{"__proto__":{}},"expectedRevision":1}`,
        ),
        context.sessions[1].token,
        context.deps,
      ),
    ).rejects.toMatchObject({ code: 'INVALID' });
    expect(
      JSON.stringify(
        await handleApi({ action: 'get', code }, context.sessions[0].token, context.deps),
      ),
    ).not.toContain('仅自己可见秘密');
  });
  it('persists identity, notes, game phase and command receipts across a server restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'avalon-test-'));
    temporary.push(directory);
    const filename = join(directory, 'state.json');
    const context = await setup(deps(new FileStore(filename)));
    const request = command(context.view, { type: 'start' });
    const first = (await handleApi(request, context.sessions[0].token, context.deps)) as RoomView;
    const restarted = deps(new FileStore(filename));
    const recovered = (await handleApi(
      { action: 'session' },
      context.sessions[0].token,
      restarted,
    )) as Session;
    expect(recovered.lastRoom).toBe(first.room.code);
    const view = await handleApi(
      { action: 'get', code: first.room.code },
      recovered.token,
      restarted,
    );
    expect(view).toEqual(first);
    expect(await handleApi(request, recovered.token, restarted)).toEqual(first);
    const relogged = await guest(restarted, 0);
    expect(relogged.userId).toBe(recovered.userId);
    expect(relogged.lastRoom).toBe(first.room.code);
  });
  it('prunes a kicked target without trapping the remaining private notes in a save conflict', async () => {
    const context = await setup();
    const code = context.view.room.code;
    const target = context.view.room.players[4].id;
    const host = context.view.room.players[0].id;
    const note = { nickname: '', roleGuess: '', alignmentGuess: 'unknown', text: 'private' };
    const notes = { [target]: note, [host]: note };
    await handleApi(
      { action: 'notes.save', code, notes, expectedRevision: 0 },
      context.sessions[1].token,
      context.deps,
    );
    await handleApi(
      command(context.view, { type: 'kick', targetId: target }),
      context.sessions[0].token,
      context.deps,
    );
    const loaded = (await handleApi(
      { action: 'notes.get', code },
      context.sessions[1].token,
      context.deps,
    )) as NotesResult;
    expect(loaded).toEqual({ notes: { [host]: note }, revision: 1 });
    const saved = (await handleApi(
      { action: 'notes.save', code, notes, expectedRevision: 1 },
      context.sessions[1].token,
      context.deps,
    )) as NotesResult;
    expect(saved).toEqual({ notes: { [host]: note }, revision: 2 });
  });
  it('allows saving after old notes expire while a rematch keeps the room alive', async () => {
    const context = await setup();
    const code = context.view.room.code;
    const target = context.view.room.players[0].id;
    const notes = {
      [target]: { nickname: '', roleGuess: '', alignmentGuess: 'unknown', text: 'new game' },
    };
    await handleApi(
      { action: 'notes.save', code, notes, expectedRevision: 0 },
      context.sessions[0].token,
      context.deps,
    );
    let view = (await handleApi(
      command(context.view, { type: 'start' }),
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    const later = { ...context.deps, now: () => now + 6 * 86_400_000 };
    view = (await handleApi(
      command(view, { type: 'abort' }),
      context.sessions[0].token,
      later,
    )) as RoomView;
    await handleApi(command(view, { type: 'rematch' }), context.sessions[0].token, later);
    const afterNotesExpiry = { ...context.deps, now: () => now + 8 * 86_400_000 };
    expect(
      await handleApi({ action: 'notes.get', code }, context.sessions[0].token, afterNotesExpiry),
    ).toEqual({ notes: {}, revision: 0 });
    expect(
      await handleApi(
        { action: 'notes.save', code, notes, expectedRevision: 0 },
        context.sessions[0].token,
        afterNotesExpiry,
      ),
    ).toEqual({ notes, revision: 1 });
  });
  it('rolls back failed transactions, recovers leave receipts, and clears removed/expired rooms', async () => {
    const context = await setup();
    const code = context.view.room.code;
    const leaving = command(context.view, { type: 'leave' });
    expect(await handleApi(leaving, context.sessions[4].token, context.deps)).toEqual({
      left: true,
    });
    expect(await handleApi(leaving, context.sessions[4].token, context.deps)).toEqual({
      left: true,
    });
    const fresh = (await handleApi(
      { action: 'get', code },
      context.sessions[0].token,
      context.deps,
    )) as RoomView;
    await handleApi(
      command(fresh, { type: 'kick', targetId: fresh.room.players[3].id }),
      context.sessions[0].token,
      context.deps,
    );
    expect(
      ((await handleApi({ action: 'session' }, context.sessions[3].token, context.deps)) as Session)
        .lastRoom,
    ).toBeNull();
    const expired = { ...context.deps, now: () => now + 8 * 86_400_000 };
    await expect(
      handleApi({ action: 'get', code }, context.sessions[0].token, expired),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(
      ((await handleApi({ action: 'session' }, context.sessions[0].token, expired)) as Session)
        .lastRoom,
    ).toBeNull();
    const before = await context.deps.store.get<RoomRecord>('rooms', code);
    await expect(
      context.deps.store.transaction(async (transaction) => {
        await transaction.delete('rooms', code);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await context.deps.store.get('rooms', code)).toEqual(before);
    await context.deps.store.cleanup(now + 8 * 86_400_000);
    expect(await context.deps.store.get('rooms', code)).toBeNull();
  });
  it('returns no old secret projection when a create response is retried after rematch', async () => {
    const dependencies = deps();
    const host = await guest(dependencies, 0);
    const create: ApiRequest = {
      action: 'create',
      name: 'host',
      config: standardConfig(5),
      requestId: randomUUID(),
    };
    let view = (await handleApi(create, host.token, dependencies)) as RoomView;
    for (let index = 1; index < 5; index++) {
      const player = await guest(dependencies, index);
      view = (await handleApi(
        { action: 'join', code: view.room.code, name: `p${index}`, requestId: randomUUID() },
        player.token,
        dependencies,
      )) as RoomView;
    }
    view = (await handleApi(
      command(view, { type: 'start' }),
      host.token,
      dependencies,
    )) as RoomView;
    view = (await handleApi(
      command(view, { type: 'abort' }),
      host.token,
      dependencies,
    )) as RoomView;
    view = (await handleApi(
      command(view, { type: 'rematch' }),
      host.token,
      dependencies,
    )) as RoomView;
    const replay = (await handleApi(create, host.token, dependencies)) as RoomView;
    expect(replay.room.gameId).toBe(view.room.gameId);
    expect(replay.self.role).toBeNull();
    expect(replay.room.revealedRoles).toEqual([]);
  });
  it('does not let join traffic evict the hourly room creation limit', async () => {
    let clock = now;
    const dependencies = { ...deps(), now: () => clock };
    const host = await guest(dependencies, 0);
    let code = '';
    for (let i = 0; i < 5; i++) {
      const view = (await handleApi(
        { action: 'create', name: 'host', config: standardConfig(5), requestId: randomUUID() },
        host.token,
        dependencies,
      )) as RoomView;
      code = view.room.code;
    }
    for (let minute = 0; minute < 6; minute++) {
      clock += 61_000;
      for (let i = 0; i < 19; i++)
        await handleApi(
          { action: 'join', code, name: 'host', requestId: randomUUID() },
          host.token,
          dependencies,
        );
    }
    await expect(
      handleApi(
        { action: 'create', name: 'host', config: standardConfig(5), requestId: randomUUID() },
        host.token,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });
});
describe('HTTP boundaries', () => {
  it('enforces origin, JSON/body limits, method and error envelopes without internal details', async () => {
    const handler = createHttpHandler(deps(), { allowedOrigins: ['https://avalon.example.com'] });
    const request = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://avalon.example.com' },
      body: JSON.stringify({ action: 'auth.guest', deviceSecret: 'a'.repeat(48) }),
      ip: '1.2.3.4',
    };
    const success = await handler(request);
    expect(success.statusCode).toBe(200);
    expect(JSON.parse(success.body).ok).toBe(true);
    expect(success.headers['Cache-Control']).toBe('no-store, private');
    expect(
      (
        await handler({
          ...request,
          headers: { ...request.headers, Origin: 'https://evil.example/' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await handler({ ...request, body: '[' })).statusCode).toBe(400);
    expect((await handler({ ...request, body: 'a'.repeat(70_000) })).statusCode).toBe(400);
    expect((await handler({ ...request, method: 'GET' })).statusCode).toBe(405);
    expect((await handler({ ...request, method: 'OPTIONS' })).statusCode).toBe(204);
    const bad = await handler({
      ...request,
      body: JSON.stringify({ action: 'get', code: '123456' }),
    });
    expect(bad.statusCode).toBe(401);
    expect(JSON.parse(bad.body)).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } });
  });
});

describe('CloudBase adapter contracts', () => {
  function fakeDatabase(readResult: unknown, writeResult: unknown = {}) {
    const db = {
      collection: () => ({
        doc: () => ({
          get: async () => readResult,
          set: async () => writeResult,
          delete: async () => writeResult,
        }),
      }),
      runTransaction: async <T>(work: (transaction: DatabaseLike) => Promise<T>) =>
        work(db as unknown as DatabaseLike),
    };
    return new CloudBaseStore(db as unknown as DatabaseLike);
  }
  it('accepts SDK array reads outside transactions and object/null reads inside', async () => {
    for (const data of [[{ value: { version: 7 } }], { value: { version: 7 } }]) {
      const store = fakeDatabase({ data });
      expect(await store.get('rooms', '123456')).toEqual({ version: 7 });
      expect(await store.transaction((transaction) => transaction.get('rooms', '123456'))).toEqual({
        version: 7,
      });
    }
    for (const data of [[], null])
      expect(await fakeDatabase({ data }).get('rooms', '123456')).toBeNull();
  });
  it('treats SDK returned error codes as failures and preserves retryable conflict codes', async () => {
    const error = { code: 'DATABASE_TRANSACTION_CONFLICT', message: 'private database diagnostic' };
    await expect(fakeDatabase(error).get('rooms', '123456')).rejects.toMatchObject({
      code: error.code,
      message: 'Database operation failed',
    });
    const store = fakeDatabase({ data: [] }, error);
    await expect(
      store.transaction((transaction) =>
        transaction.set('rooms', '123456', { value: 'secret' }, now),
      ),
    ).rejects.toMatchObject({ code: error.code });
    await expect(
      store.transaction((transaction) => transaction.delete('rooms', '123456')),
    ).rejects.toMatchObject({ code: error.code });
  });
});
