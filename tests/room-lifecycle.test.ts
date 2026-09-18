import { describe, expect, it } from 'vitest';
import { applyCommand, createRoom, joinRoom, projectRoom } from '../server/engine';
import { noteMatchesRoom, retainedNoteExpiry } from '../server/room-lifecycle';
import { standardConfig } from '../shared/rules';

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('public player names', () => {
  it('reserves normalized names on join and rename, but permits the same player to reconnect', () => {
    let room = createRoom('1234', { userId: 'host', name: ' Ａlice ' }, standardConfig(5), NOW);
    expect(room.players[0].name).toBe('Alice');
    for (const name of ['Alice', ' alice ', 'ＡＬＩＣＥ'])
      expect(() => joinRoom(room, { userId: 'guest', name }, NOW)).toThrow('这个名字已被使用');
    room = joinRoom(room, { userId: 'guest', name: 'Bob   Smith' }, NOW);
    expect(room.players[1].name).toBe('Bob Smith');
    expect(() => joinRoom(room, { userId: 'other', name: 'ＢＯＢ　ＳＭＩＴＨ' }, NOW)).toThrow(
      '这个名字已被使用',
    );
    expect(() => applyCommand(room, 'guest', { type: 'rename', name: 'ALICE' }, NOW)).toThrow(
      '这个名字已被使用',
    );
    expect(joinRoom(room, { userId: 'guest', name: 'Alice' }, NOW)).toEqual(room);
    const renamed = applyCommand(
      room,
      'guest',
      { type: 'rename', name: 'ＢＯＢ　ＳＭＩＴＨ' },
      NOW,
    );
    expect(renamed.players[1].name).toBe('BOB SMITH');
    expect(renamed.players[1].id).toBe(room.players[1].id);
  });

  it('checks legacy public names using the same normalization', () => {
    const room = createRoom('1234', { userId: 'host', name: 'Alice' }, standardConfig(5), NOW);
    room.players[0].name = ' ＡＬＩＣＥ ';
    expect(() => joinRoom(room, { userId: 'guest', name: 'alice' }, NOW)).toThrow(
      '这个名字已被使用',
    );
  });
});

describe('room idle deadlines', () => {
  it('uses 24-hour lobbies, 48-hour active games and fixed 24-hour results', () => {
    let room = createRoom('1234', { userId: 'host', name: '房主' }, standardConfig(5), NOW);
    expect(room.expiresAt).toBe(NOW + DAY);
    for (let i = 1; i < 5; i++)
      room = joinRoom(room, { userId: `guest${i}`, name: `玩家${i}` }, NOW + HOUR);
    expect(room.expiresAt).toBe(NOW + HOUR + DAY);
    room = applyCommand(room, 'host', { type: 'start' }, NOW + 2 * HOUR);
    expect(room.expiresAt).toBe(NOW + 2 * HOUR + 2 * DAY);
    room = applyCommand(room, 'host', { type: 'ready' }, NOW + 3 * HOUR);
    expect(room.expiresAt).toBe(NOW + 3 * HOUR + 2 * DAY);
    expect(applyCommand(room, 'host', { type: 'ready' }, NOW + 4 * HOUR)).toEqual(room);
    const snapshot = structuredClone(room);
    projectRoom(room, 'host');
    expect(room).toEqual(snapshot);
    room = applyCommand(room, 'host', { type: 'abort' }, NOW + 4 * HOUR);
    expect(room.expiresAt).toBe(NOW + 4 * HOUR + DAY);
    room = applyCommand(room, 'host', { type: 'rename', name: '改名' }, NOW + 5 * HOUR);
    expect(room.expiresAt).toBe(NOW + 4 * HOUR + DAY);
    const instance = room.instanceId;
    const oldGame = room.gameId;
    room = applyCommand(room, 'host', { type: 'rematch' }, NOW + 6 * HOUR);
    expect(room.expiresAt).toBe(NOW + 6 * HOUR + DAY);
    expect(room.instanceId).toBe(instance);
    expect(room.gameId).not.toBe(oldGame);
  });

  it('expires an empty room immediately and does not rewrite legacy deadlines on read', () => {
    const room = createRoom('1234', { userId: 'host', name: '房主' }, standardConfig(5), NOW);
    const empty = applyCommand(room, 'host', { type: 'leave' }, NOW + HOUR);
    expect(empty.expiresAt).toBe(NOW + HOUR);
    expect(() => joinRoom(empty, { userId: 'guest', name: '玩家' }, NOW + HOUR)).toThrow();
    delete room.instanceId;
    delete room.lastActiveAt;
    room.expiresAt = NOW + 7 * DAY;
    expect(projectRoom(room, 'host').room.expiresAt).toBe(NOW + 7 * DAY);
    expect(joinRoom(room, { userId: 'guest', name: '玩家' }, NOW + 6 * DAY).expiresAt).toBe(
      NOW + 7 * DAY,
    );
  });
});

describe('private note room binding', () => {
  const room = {
    instanceId: 'room-a',
    createdAt: NOW,
    expiresAt: NOW + 2 * DAY,
    players: [{ userId: 'u_1' }],
  };
  const note = { roomInstanceId: 'room-a', roomCreatedAt: NOW, expiresAt: NOW + DAY };

  it('retains old notes while their same room is active, but never across a reused room code', () => {
    expect(retainedNoteExpiry(note, room, 'u_1', NOW + DAY)).toBe(room.expiresAt);
    expect(retainedNoteExpiry(note, room, 'other', NOW + DAY)).toBeNull();
    expect(retainedNoteExpiry(note, room, 'u_1', room.expiresAt)).toBeNull();
    expect(retainedNoteExpiry(note, undefined, 'u_1', NOW)).toBeNull();
    expect(noteMatchesRoom(note, { ...room, instanceId: 'room-b' })).toBe(false);
    expect(noteMatchesRoom({ expiresAt: NOW + DAY }, room)).toBe(false);
    expect(noteMatchesRoom({ expiresAt: NOW + DAY, roomCreatedAt: NOW }, room)).toBe(false);
  });

  it('keeps existing legacy room notes readable without allowing new notes into legacy rooms', () => {
    const legacyRoom = { ...room, instanceId: undefined };
    expect(noteMatchesRoom({ expiresAt: NOW + DAY }, legacyRoom)).toBe(true);
    expect(noteMatchesRoom({ expiresAt: NOW - 1 }, legacyRoom)).toBe(false);
    expect(noteMatchesRoom({ expiresAt: NOW + DAY, roomCreatedAt: NOW }, legacyRoom)).toBe(true);
    expect(noteMatchesRoom(note, legacyRoom)).toBe(false);
  });
});
