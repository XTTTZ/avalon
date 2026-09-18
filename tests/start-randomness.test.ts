import { randomInt } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyCommand, createRoom, joinRoom, type RoomState } from '../server/engine';
import { standardConfig } from '../shared/rules';
import type { GameCommand } from '../shared/types';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomInt: vi.fn(actual.randomInt) };
});
afterEach(() => vi.mocked(randomInt).mockReset());

function lobby(count = 5) {
  let room = createRoom('1234', { userId: 'host', name: '房主' }, standardConfig(count));
  for (let index = 1; index < count; index++)
    room = joinRoom(room, { userId: `guest-${index}`, name: `玩家${index}` });
  return room;
}
function hostCommand(room: RoomState, command: GameCommand) {
  return applyCommand(room, 'host', command);
}

// Use controlled entropy instead of flaky assertions that random results must
// differ. Identity permutations and receiving the same role again are valid.
function draws(seats: number[], roles: number[]) {
  const remaining = [...seats, ...roles];
  vi.mocked(randomInt)
    .mockReset()
    .mockImplementation((max: number) => {
      const next = remaining.shift();
      if (next === undefined || next < 0 || next >= max) throw new Error('Unexpected random draw');
      return next;
    });
}

describe('independent server-side start randomization', () => {
  it.each([5, 6, 7, 8, 9, 10, 11, 12])(
    'reshuffles all %i players and deals roles again after custom seating and rematch',
    (count) => {
      let room = lobby(count);
      const bounds = Array.from({ length: count - 1 }, (_, index) => count - index);
      const zeroDraws = bounds.map(() => 0);
      const keepDraws = bounds.map((max) => max - 1);
      for (let game = 0; game < 2; game++) {
        const before = room.players.map((player) => player.id);
        room = hostCommand(room, { type: 'reorder', playerIds: before, mode: 'rotation' });
        expect(room.orderCustomized).toBe(true);
        draws(zeroDraws, keepDraws);
        room = hostCommand(room, { type: 'start' });
        expect(room.players.map((player) => player.id)).toEqual([...before.slice(1), before[0]]);
        expect(room.players.map((player) => player.seat)).toEqual(
          Array.from({ length: count }, (_, index) => index),
        );
        expect(room.players.map((player) => room.secrets[player.id].role)).toEqual(
          room.config.roles,
        );
        expect(room.leaderId).toBe(before[1]);
        expect(room.orderCustomized).toBe(false);
        expect(vi.mocked(randomInt).mock.calls).toEqual([...bounds, ...bounds].map((max) => [max]));
        room = hostCommand(room, { type: 'abort' });
        room = hostCommand(room, { type: 'rematch' });
      }
    },
  );

  it('uses fresh role draws even when the resulting player order is identical', () => {
    const source = lobby();
    const keep = [4, 3, 2, 1];
    draws(keep, keep);
    const first = hostCommand(source, { type: 'start' });
    draws(keep, [0, 0, 0, 0]);
    const second = hostCommand(source, { type: 'start' });
    expect(first.players).toEqual(source.players);
    expect(second.players).toEqual(first.players);
    expect(first.players.map((player) => first.secrets[player.id].role)).toEqual(
      source.config.roles,
    );
    expect(second.players.map((player) => second.secrets[player.id].role)).toEqual([
      ...source.config.roles.slice(1),
      source.config.roles[0],
    ]);
  });

  it('does not reuse the seat permutation for the role deck or change identities on a later reorder', () => {
    const source = lobby();
    draws([0, 0, 0, 0], [4, 3, 2, 1]);
    const started = hostCommand(source, { type: 'start' });
    expect(started.players.map((player) => player.id)).not.toEqual(
      source.players.map((player) => player.id),
    );
    expect(started.players.map((player) => started.secrets[player.id].role)).toEqual(
      source.config.roles,
    );
    const changed = hostCommand(started, {
      type: 'reorder',
      playerIds: [...started.players].reverse().map((player) => player.id),
    });
    expect(changed.secrets).toEqual(started.secrets);
    expect(randomInt).toHaveBeenCalledTimes(8);
  });
});
