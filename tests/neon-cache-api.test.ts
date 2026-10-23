import { describe, expect, it, vi } from 'vitest';
import { handleApi, authorizeRealtime, type RoomRecord } from '../server/api';
import { issueToken, readAuthConfig, type AuthDeps } from '../server/auth';
import { createRoom, joinRoom } from '../server/engine';
import { NeonStore, type NeonSqlClient } from '../server/neon-store';
import { standardConfig } from '../shared/rules';
import type { RoomView } from '../shared/types';

const databaseUrl = 'postgresql://avalon_runtime:secret@example.neon.tech/avalon?sslmode=require';
const start = 1_800_000_000_000;
const userA = 'a'.repeat(43);
const userB = 'b'.repeat(43);

function fixture() {
  let now = start;
  let room = createRoom('1234', { userId: userA, name: '甲' }, standardConfig(5), now);
  room = joinRoom(room, { userId: userB, name: '乙' }, now);
  const [a, b] = room.players;
  room.phase = 'team';
  room.secrets[a.id] = { role: 'merlin', alignment: 'good', knownPlayers: [], ladyResults: [] };
  room.secrets[b.id] = { role: 'assassin', alignment: 'evil', knownPlayers: [], ladyResults: [] };
  let revision: string | null = '11111111-1111-4111-8111-111111111111';
  let value: RoomRecord | null = { state: room, receipts: [], recentWrites: [] };
  const query = vi.fn<NeonSqlClient['query']>(async (statement, params) => {
    if (params?.[0] === 'notes') {
      expect(statement).toBe('SELECT public.avalon_get($1, $2) AS snapshot');
      return [
        {
          snapshot: {
            revision: 'note',
            value: {
              revision: 1,
              roomInstanceId: room.instanceId,
              expiresAt: room.expiresAt,
              notes: {
                [a.id]: { nickname: params[1] === `1234_${userA}` ? '仅甲知道' : '仅乙知道' },
              },
            },
          },
        },
      ];
    }
    return [
      {
        snapshot:
          revision && params?.[2] === revision
            ? { revision, unchanged: true }
            : { revision, value: structuredClone(value) },
      },
    ];
  });
  const deps: AuthDeps = {
    store: new NeonStore(databaseUrl, () => ({ query })),
    now: () => now,
    auth: readAuthConfig({ SESSION_SECRET: 's'.repeat(48) }),
  };
  const token = (userId: string) =>
    issueToken({ userId, provider: 'guest', expiresAt: start + 86_400_000 }, deps.auth);
  return {
    deps,
    room,
    query,
    token,
    advance: (time: number) => {
      now = time;
    },
    change: (next: RoomRecord | null, nextRevision: string | null) => {
      value = next;
      revision = nextRevision;
    },
  };
}

describe('revision-validated snapshot authorization', () => {
  it('projects each player secret and private notes separately from the same cached room', async () => {
    const { deps, room, token, query } = fixture();
    const a = (await handleApi({ action: 'get', code: room.code }, token(userA), deps)) as RoomView;
    const b = (await handleApi({ action: 'get', code: room.code }, token(userB), deps)) as RoomView;
    expect(a.self.role).toBe('merlin');
    expect(b.self.role).toBe('assassin');
    expect(a.room.revealedRoles).toEqual([]);
    expect(b.room.revealedRoles).toEqual([]);
    const aNotes = await handleApi({ action: 'notes.get', code: room.code }, token(userA), deps);
    const bNotes = await handleApi({ action: 'notes.get', code: room.code }, token(userB), deps);
    expect(JSON.stringify(aNotes)).toContain('仅甲知道');
    expect(JSON.stringify(aNotes)).not.toContain('仅乙知道');
    expect(JSON.stringify(bNotes)).toContain('仅乙知道');
    expect(JSON.stringify(bNotes)).not.toContain('仅甲知道');
    expect(query.mock.calls[1][1]![2]).not.toBeNull();
  });

  it('checks current expiry even when Neon confirms the cached room unchanged', async () => {
    const context = fixture();
    await handleApi({ action: 'get', code: '1234' }, context.token(userA), context.deps);
    // Session remains valid while a room expires earlier than its token.
    context.advance(start + 60_000);
    context.room.expiresAt = start + 50_000;
    context.change({ state: context.room, receipts: [], recentWrites: [] }, 'new-revision');
    // Warm the updated snapshot while it is still valid.
    context.advance(start + 40_000);
    await handleApi({ action: 'get', code: '1234' }, context.token(userA), context.deps);
    context.advance(start + 60_000);
    await expect(
      handleApi({ action: 'get', code: '1234' }, context.token(userA), context.deps),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
    await expect(
      authorizeRealtime('1234', context.room.gameId, context.token(userA), context.deps),
    ).rejects.toMatchObject({ code: 'EXPIRED' });
  });

  it('rejects a removed player and a stale room identity after deletion and code reuse', async () => {
    const context = fixture();
    await handleApi({ action: 'get', code: '1234' }, context.token(userA), context.deps);
    context.room.players = context.room.players.filter((player) => player.userId !== userA);
    context.change({ state: context.room, receipts: [], recentWrites: [] }, 'removed');
    await expect(
      handleApi({ action: 'get', code: '1234' }, context.token(userA), context.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      authorizeRealtime('1234', context.room.gameId, context.token(userA), context.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    context.change(null, null);
    await expect(
      handleApi({ action: 'get', code: '1234' }, context.token(userA), context.deps),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const nextRoom = createRoom(
      '1234',
      { userId: userB, name: '乙' },
      standardConfig(5),
      start + 100,
    );
    context.change({ state: nextRoom, receipts: [], recentWrites: [] }, 'recreated');
    await expect(
      handleApi({ action: 'get', code: '1234' }, context.token(userA), context.deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      authorizeRealtime('1234', context.room.gameId, context.token(userB), context.deps),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const nextView = (await handleApi(
      { action: 'get', code: '1234', version: 1, gameId: context.room.gameId },
      context.token(userB),
      context.deps,
    )) as RoomView;
    expect(nextView.room.gameId).toBe(nextRoom.gameId);
  });
});
