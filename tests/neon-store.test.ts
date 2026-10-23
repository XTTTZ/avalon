import { describe, expect, it, vi } from 'vitest';
import { NeonStore, type NeonSqlClient } from '../server/neon-store.js';

const databaseUrl = 'postgresql://avalon_runtime:secret@example.neon.tech/avalon?sslmode=require';

describe('NeonStore', () => {
  it('confirms every cached room read and avoids retransferring unchanged JSON', async () => {
    let revision: string | null = '11111111-1111-4111-8111-111111111111';
    let value: unknown = { state: { version: 1, history: 'x'.repeat(600_000) } };
    const sizes: number[] = [];
    const client: NeonSqlClient = {
      query: vi.fn(async (statement, params) => {
        expect(statement).toBe('SELECT public.avalon_get_cached($1, $2, $3::uuid) AS snapshot');
        const snapshot =
          revision && params?.[2] === revision
            ? { revision, unchanged: true }
            : { revision, value };
        sizes.push(JSON.stringify(snapshot).length);
        return [{ snapshot }];
      }),
    };
    const store = new NeonStore(databaseUrl, () => client);
    const first = await store.get<{ state: { version: number } }>('rooms', '1234');
    first!.state.version = 999;
    for (let i = 0; i < 20; i++)
      expect(await store.get('rooms', '1234')).toMatchObject({ state: { version: 1 } });
    expect(client.query).toHaveBeenCalledTimes(21);
    expect(sizes[0]).toBeGreaterThan(600_000);
    expect(Math.max(...sizes.slice(1))).toBeLessThan(100);
    revision = '22222222-2222-4222-8222-222222222222';
    value = { state: { version: 2 } };
    expect(await store.get('rooms', '1234')).toEqual(value);
    revision = null;
    value = null;
    expect(await store.get('rooms', '1234')).toBeNull();
    await store.get('rooms', '1234');
    expect(vi.mocked(client.query).mock.calls.at(-1)![1]![2]).toBeNull();
    revision = '33333333-3333-4333-8333-333333333333';
    value = { state: { version: 1, instanceId: 'new-room' } };
    expect(await store.get('rooms', '1234')).toEqual(value);
  });

  it('never serves cached state after a failed or mismatched revision check', async () => {
    const client: NeonSqlClient = {
      query: vi
        .fn<NeonSqlClient['query']>()
        .mockResolvedValueOnce([{ snapshot: { revision: 'one', value: { private: true } } }])
        .mockRejectedValueOnce(new Error('database credentials must not leak'))
        .mockResolvedValueOnce([{ snapshot: { revision: 'other', unchanged: true } }]),
    };
    const store = new NeonStore(databaseUrl, () => client);
    await store.get('rooms', '1234');
    await expect(store.get('rooms', '1234')).rejects.toThrow('Database operation failed');
    await expect(store.get('rooms', '1234')).rejects.toThrow('Database operation failed');
  });

  it('uses the exact captured revision when concurrent requests replace the cached payload', async () => {
    let finish!: (rows: Record<string, unknown>[]) => void;
    const client: NeonSqlClient = {
      query: vi
        .fn<NeonSqlClient['query']>()
        .mockResolvedValueOnce([{ snapshot: { revision: 'one', value: { version: 1 } } }])
        .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
        .mockResolvedValueOnce([{ snapshot: { revision: 'two', value: { version: 2 } } }]),
    };
    const store = new NeonStore(databaseUrl, () => client);
    await store.get('rooms', '1234');
    const oldRead = store.get('rooms', '1234');
    expect(await store.get('rooms', '1234')).toEqual({ version: 2 });
    finish([{ snapshot: { revision: 'one', unchanged: true } }]);
    expect(await oldRead).toEqual({ version: 1 });
  });

  it('keeps cache keys separate by collection and owner and never caches private notes', async () => {
    const seen = new Map<string, string>();
    const client: NeonSqlClient = {
      query: vi.fn(async (statement, params) => {
        const [collection, id, revision] = params!;
        const key = `${collection}/${id}`;
        if (collection === 'notes') {
          expect(statement).toBe('SELECT public.avalon_get($1, $2) AS snapshot');
          expect(params).toHaveLength(2);
        } else {
          expect(revision).toBe(seen.get(key) ?? null);
          seen.set(key, key);
        }
        return [
          {
            snapshot:
              revision === key ? { revision, unchanged: true } : { revision: key, value: { key } },
          },
        ];
      }),
    };
    const store = new NeonStore(databaseUrl, () => client);
    for (let round = 0; round < 2; round++) {
      expect(await store.get('users', 'owner-a')).toEqual({ key: 'users/owner-a' });
      expect(await store.get('users', 'owner-b')).toEqual({ key: 'users/owner-b' });
      expect(await store.get('rooms', 'owner-a')).toEqual({ key: 'rooms/owner-a' });
      expect(await store.get('notes', '1234_owner-a')).toEqual({ key: 'notes/1234_owner-a' });
      expect(await store.get('notes', '1234_owner-b')).toEqual({ key: 'notes/1234_owner-b' });
    }
    expect(client.query).toHaveBeenCalledTimes(10);
  });

  it('bounds cached count and bytes and bypasses oversized payloads', async () => {
    const client: NeonSqlClient = {
      query: vi.fn(async (_statement, params) => [
        {
          snapshot: {
            revision: 'one',
            value: { payload: params?.[1] === 'huge' ? 'x'.repeat(2_100_000) : 'small' },
          },
        },
      ]),
    };
    const store = new NeonStore(databaseUrl, () => client);
    for (let i = 0; i < 65; i++) await store.get('rooms', String(i));
    await store.get('rooms', '0');
    expect(vi.mocked(client.query).mock.calls.at(-1)![1]![2]).toBeNull();
    await store.get('rooms', 'huge');
    await store.get('rooms', 'huge');
    expect(vi.mocked(client.query).mock.calls.at(-1)![1]![2]).toBeNull();
  });

  it('revalidates cached transactional reads on conflict and observes committed writes', async () => {
    let revision = '11111111-1111-4111-8111-111111111111';
    let value = { count: 100 };
    let commits = 0;
    const client: NeonSqlClient = {
      query: vi.fn(async (statement, params) => {
        if (statement.includes('avalon_get'))
          return [
            {
              snapshot:
                params?.[2] === revision
                  ? { revision, unchanged: true }
                  : { revision, value: structuredClone(value) },
            },
          ];
        if (++commits === 1) {
          revision = '22222222-2222-4222-8222-222222222222';
          value = { count: 80 };
          return [{ committed: false }];
        }
        expect(JSON.parse(String(params?.[0]))[0].revision).toBe(revision);
        value = JSON.parse(String(params?.[1]))[0].value;
        revision = '33333333-3333-4333-8333-333333333333';
        return [{ committed: true }];
      }),
    };
    const store = new NeonStore(databaseUrl, () => client);
    await store.get('rooms', '1234');
    await store.transaction(async (tx) => {
      const current = (await tx.get<{ count: number }>('rooms', '1234'))!;
      await tx.set('rooms', '1234', { count: current.count - 10 }, 1000);
    });
    expect(value.count).toBe(70);
    expect(await store.get('rooms', '1234')).toEqual({ count: 70 });
    expect(commits).toBe(2);
  });

  it('retries the whole optimistic transaction and commits one write set', async () => {
    let commits = 0;
    const client: NeonSqlClient = {
      query: vi.fn(async (statement, parameters) => {
        if (statement.includes('avalon_get'))
          return [
            {
              snapshot: {
                revision: commits ? '11111111-1111-1111-1111-111111111111' : null,
                value: null,
              },
            },
          ];
        if (statement.includes('avalon_commit')) {
          commits += 1;
          expect(JSON.parse(String(parameters?.[0]))).toHaveLength(1);
          expect(JSON.parse(String(parameters?.[1]))).toEqual([
            {
              collection: 'rooms',
              id: '1234',
              value: { state: 'ready' },
              expiresAt: 2_000_000,
            },
          ]);
          return [{ committed: commits > 1 }];
        }
        throw new Error('unexpected query');
      }),
    };
    const store = new NeonStore(databaseUrl, () => client);
    const result = await store.transaction(async (transaction) => {
      expect(await transaction.get('rooms', '1234')).toBeNull();
      await transaction.set('rooms', '1234', { state: 'ready' }, 2_000_000);
      return 'saved';
    });
    expect(result).toBe('saved');
    expect(commits).toBe(2);
  });

  it('validates a failed callback read set without writing', async () => {
    const client: NeonSqlClient = {
      query: vi.fn(async (statement, parameters) => {
        if (statement.includes('avalon_get'))
          return [{ snapshot: { revision: null, value: null } }];
        if (statement.includes('avalon_commit')) {
          expect(JSON.parse(String(parameters?.[1]))).toEqual([]);
          return [{ committed: true }];
        }
        throw new Error('unexpected query');
      }),
    };
    const store = new NeonStore(databaseUrl, () => client);
    await expect(
      store.transaction(async (transaction) => {
        await transaction.get('users', 'someone');
        throw new Error('domain error');
      }),
    ).rejects.toThrow('domain error');
  });

  it('rejects non-Neon and non-TLS database URLs', () => {
    expect(() => new NeonStore('postgresql://user:secret@example.com/db?sslmode=require')).toThrow(
      'Invalid Neon connection string',
    );
    expect(() => new NeonStore('postgresql://user:secret@example.neon.tech/db')).toThrow(
      'Invalid Neon connection string',
    );
  });
});
