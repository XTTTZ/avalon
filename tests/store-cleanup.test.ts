import { describe, expect, it } from 'vitest';
import { FileStore } from '../server/store';

describe('local file room cleanup', () => {
  it('renews expired notes only for members of the same active room instance', async () => {
    const store = new FileStore(null);
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
    const store = new FileStore(null);
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
