import { describe, expect, it, vi } from 'vitest';
import { PostgresStore } from '../server/postgres-store.js';

const endpoint = 'https://example.com/v1/rdb/rest';
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('PostgresStore', () => {
  it('bounds conflict retries and returns a retryable game error', async () => {
    const jitter = vi.spyOn(Math, 'random').mockReturnValue(0);
    const request = vi.fn(async () => reply(false)) as unknown as typeof fetch;
    try {
      await expect(
        new PostgresStore(endpoint, 'server-key', request).transaction(async () => 1),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(request).toHaveBeenCalledTimes(8);
    } finally {
      jitter.mockRestore();
    }
  });
  it('retries stale revisions and commits a fresh read with all writes', async () => {
    const bodies: Record<string, unknown>[] = [];
    let reads = 0;
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/avalon_get'))
        return reply({ revision: `r${++reads}`, value: { count: reads } });
      bodies.push(JSON.parse(String(init?.body)));
      return reply(bodies.length > 1);
    }) as unknown as typeof fetch;
    const store = new PostgresStore(endpoint, 'server-key', request);
    const result = await store.transaction(async (tx) => {
      const value = (await tx.get<{ count: number }>('rooms', '1234'))!;
      value.count++;
      await tx.set('rooms', '1234', value, 1000);
      return value.count;
    });
    expect(result).toBe(3);
    expect(bodies[0].p_reads).toEqual([{ collection: 'rooms', id: '1234', revision: 'r1' }]);
    expect(bodies[1].p_writes).toEqual([
      { collection: 'rooms', id: '1234', value: { count: 3 }, expiresAt: 1000 },
    ]);
  });

  it('reserves missing keys, reads its writes, and discards failed callback writes', async () => {
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/avalon_get')) return reply({ revision: null, value: null });
      const body = JSON.parse(String(init?.body));
      expect(body.p_reads).toEqual([{ collection: 'notes', id: 'private', revision: null }]);
      expect(body.p_writes).toEqual([]);
      return reply(true);
    }) as unknown as typeof fetch;
    const store = new PostgresStore(endpoint, 'server-key', request);
    await expect(
      store.transaction(async (tx) => {
        await tx.set('notes', 'private', { text: 'secret' }, 1000);
        const note = await tx.get<{ text: string }>('notes', 'private');
        expect(note?.text).toBe('secret');
        await tx.delete('notes', 'private');
        expect(await tx.get('notes', 'private')).toBeNull();
        throw new Error('Rejected');
      }),
    ).rejects.toThrow('Rejected');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('validates rejected operations before deciding whether to retry', async () => {
    let commits = 0;
    const request = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith('/avalon_get')
        ? reply({ revision: 'r', value: { ready: commits > 0 } })
        : reply(++commits > 1),
    ) as unknown as typeof fetch;
    const store = new PostgresStore(endpoint, 'server-key', request);
    expect(
      await store.transaction(async (tx) => {
        const value = await tx.get<{ ready: boolean }>('rooms', '1234');
        if (!value?.ready) throw new Error('Not ready');
        return 'done';
      }),
    ).toBe('done');
  });

  it('keeps provider errors private and limits cleanup', async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (JSON.parse(String(init?.body)).p_limit === 400) return reply(2);
      return reply({ secret: 'identity', key: 'server-key' }, 403);
    }) as unknown as typeof fetch;
    const store = new PostgresStore(endpoint, 'server-key', request);
    await expect(store.get('rooms', '1234')).rejects.toThrow('PostgreSQL operation failed');
    expect(await store.cleanup(1000, 999)).toBe(2);
    expect(() => new PostgresStore('http://example.com', 'key')).toThrow();
    expect(() => new PostgresStore(endpoint, '')).toThrow();
  });
});
