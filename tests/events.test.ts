import { expect, it } from 'vitest';
import { applyCommand, createRoom, joinRoom, projectRoom } from '../server/engine';
import { standardConfig } from '../shared/rules';
import { eventText, playerName } from '../src/player-names';

it('public history preserves player references through rename without exposing account IDs', () => {
  let room = createRoom('1234', { userId: 'private-host-id', name: '小王' }, standardConfig(5));
  room = joinRoom(room, { userId: 'private-guest-id', name: '小王子' });
  const guest = room.players[1];
  room = applyCommand(room, guest.userId, { type: 'rename', name: '新名字' });
  const view = projectRoom(room, 'private-host-id');
  const join = view.room.events[1];
  expect(join.parts).toEqual([{ playerId: guest.id, name: '小王子' }, ' 加入了房间']);
  expect(JSON.stringify(view)).not.toContain('private-host-id');
  expect(JSON.stringify(view)).not.toContain('private-guest-id');
  expect(
    eventText(join, view.room.players, (id, fallback) =>
      playerName(view.room.players, {}, id, fallback),
    ),
  ).toBe('新名字 加入了房间');
  room = applyCommand(room, 'private-host-id', { type: 'kick', targetId: guest.id });
  const afterKick = projectRoom(room, 'private-host-id');
  expect(
    eventText(afterKick.room.events.at(-1)!, afterKick.room.players, (id, fallback) =>
      playerName(afterKick.room.players, {}, id, fallback),
    ),
  ).toBe('新名字 已被移出大厅');
});
