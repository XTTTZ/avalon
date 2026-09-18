import { describe, expect, it } from 'vitest';
import { CloudBaseStore, FileStore, type DatabaseLike, type Store } from '../server/store';

/** SDK-shaped adapter double. Business cleanup also runs against real SQL in CI. */
function documentStore(): Store {
  const records = new Map<string, { value: unknown; expiresAt: number }>();
  const db = {
    command: { lte: (n: number) => n },
    collection: (collection: string) => ({
      doc: (id: string) => ({
        get: async () => ({ data: records.get(`${collection}/${id}`) ?? null }),
        set: async (value: { value: unknown; expiresAt: number }) => {
          records.set(`${collection}/${id}`, structuredClone(value));
          return {};
        },
        delete: async () => {
          records.delete(`${collection}/${id}`);
          return {};
        },
      }),
      where: ({ expiresAt }: { expiresAt: number }) => ({
        limit: (limit: number) => ({
          get: async () => ({
            data: [...records.entries()]
              .filter(
                ([key, value]) => key.startsWith(`${collection}/`) && value.expiresAt <= expiresAt,
              )
              .slice(0, limit)
              .map(([key, value]) => ({ _id: key.slice(collection.length + 1), ...value })),
          }),
        }),
      }),
    }),
    runTransaction: async <T>(work: (transaction: DatabaseLike) => Promise<T>) =>
      work(db as unknown as DatabaseLike),
  };
  return new CloudBaseStore(db as unknown as DatabaseLike);
}

describe.each([
  ['local file', () => new FileStore(null)],
  ['CloudBase document', documentStore],
] as const)('%s room cleanup', (_name, makeStore) => {
  it('renews expired notes only for members of the same active room instance', async () => {
    const store = makeStore();
    const state = {
      instanceId: 'new-room',
      createdAt: 10,
      expiresAt: 500,
      players: [{ userId: 'u_1' }, { userId: 'u_2' }],
    };
    const note = {
      roomInstanceId: 'new-room',
      expiresAt: 100,
      revision: 4,
      notes: { p: { text: 'private' } },
    };
    await store.transaction(async (tx) => {
      await tx.set('rooms', '1234', { state }, 500);
      await tx.set('notes', '1234_u_1', note, 100);
      await tx.set('notes', '1234_u_2', { ...note, roomInstanceId: 'old-room' }, 100);
      await tx.set('notes', '1234_outsider', note, 100);
      await tx.set('notes', '5678_u_1', note, 100);
    });
    expect(await store.cleanup(200)).toBe(3);
    expect(await store.get('notes', '1234_u_1')).toEqual({
      ...note,
      expiresAt: 500,
      roomCreatedAt: 10,
    });
    for (const id of ['1234_u_2', '1234_outsider', '5678_u_1'])
      expect(await store.get('notes', id)).toBeNull();
    expect(await store.cleanup(500)).toBe(2);
    expect(await store.get('notes', '1234_u_1')).toBeNull();
    expect(await store.get('rooms', '1234')).toBeNull();
  });

  it('preserves legacy notes while never reviving them inside a new-format room', async () => {
    const store = makeStore();
    const state = { createdAt: 10, expiresAt: 500, players: [{ userId: 'u' }] };
    const note = { expiresAt: 100, revision: 2, notes: {} };
    await store.transaction(async (tx) => {
      await tx.set('rooms', '1234', { state }, 500);
      await tx.set('notes', '1234_u', note, 100);
      await tx.set('rooms', '5678', { state: { ...state, instanceId: 'new-room' } }, 500);
      await tx.set('notes', '5678_u', note, 100);
    });
    expect(await store.cleanup(200)).toBe(1);
    expect(await store.get('notes', '1234_u')).toEqual({
      ...note,
      expiresAt: 500,
      roomCreatedAt: 10,
    });
    expect(await store.get('notes', '5678_u')).toBeNull();
    expect(await store.cleanup(200)).toBe(0);
  });
});
