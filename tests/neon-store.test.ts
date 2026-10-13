import { describe, expect, it, vi } from 'vitest';
import { NeonStore, type NeonSqlClient } from '../server/neon-store.js';

const databaseUrl = 'postgresql://avalon_runtime:secret@example.neon.tech/avalon?sslmode=require';

describe('NeonStore', () => {
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
