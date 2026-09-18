import { describe, expect, it } from 'vitest';
import type { Notes, PlayerNote, PublicEvent, PublicPlayer } from '../shared/types';
import { eventText, playerName } from '../src/player-names';

const players: PublicPlayer[] = [
  { id: 'p1', name: '小明', seat: 0 },
  { id: 'p2', name: '小', seat: 1 },
  { id: 'p3', name: '阿明', seat: 2 },
];
const note = (nickname: string): PlayerNote => ({
  nickname,
  roleGuess: '',
  alignmentGuess: 'unknown',
  text: '',
});
const event = (text: string, parts?: PublicEvent['parts']): PublicEvent => ({
  id: 1,
  at: 1,
  text,
  ...(parts ? { parts } : {}),
});
const render = (entry: PublicEvent, members = players, notes: Notes = {}) =>
  eventText(entry, members, (id, fallback) => playerName(members, notes, id, fallback));

describe('private player names', () => {
  it('uses trimmed private nicknames and falls back to public or snapshot names', () => {
    expect(playerName(players, { p1: note('  好友  ') }, 'p1')).toBe('好友');
    expect(playerName(players, { p1: note('  ') }, 'p1')).toBe('小明');
    expect(playerName(players, {}, 'missing', '已离开的玩家')).toBe('已离开的玩家');
    expect(playerName(players, {}, 'missing')).toBe('玩家');
    expect(playerName([], { p1: note('老朋友') }, 'p1', '旧名字')).toBe('老朋友');
  });

  it('keeps structured events associated with player IDs across public renames and private nickname edits', () => {
    const entry = event('小明 查验了 小；湖中仙女已交接', [
      { playerId: 'p1', name: '小明' },
      ' 查验了 ',
      { playerId: 'p2', name: '小' },
      '；湖中仙女已交接',
    ]);
    const renamed = players.map((player) =>
      player.id === 'p1' ? { ...player, name: '公开新名字' } : player,
    );
    const notes: Notes = { p1: note('好友甲'), p2: note('好友乙') };
    const before = structuredClone({ entry, renamed, notes });

    expect(render(entry, renamed, notes)).toBe('好友甲 查验了 好友乙；湖中仙女已交接');
    expect(render(entry, renamed, { ...notes, p1: note('新昵称') })).toBe(
      '新昵称 查验了 好友乙；湖中仙女已交接',
    );
    expect(render(entry, renamed, { ...notes, p1: note('') })).toBe(
      '公开新名字 查验了 好友乙；湖中仙女已交接',
    );
    expect(render(entry, renamed)).toBe('公开新名字 查验了 小；湖中仙女已交接');
    expect({ entry, renamed, notes }).toEqual(before);
  });

  it('does not confuse matching public names, name substrings, or a nickname equal to another public name', () => {
    const entry = event('小明 查验了 小；湖中仙女已交接', [
      { playerId: 'p1', name: '小明' },
      ' 查验了 ',
      { playerId: 'p2', name: '小' },
      '；湖中仙女已交接',
    ]);
    const duplicateNames = players.map((player) => ({ ...player, name: '相同旧名字' }));
    expect(render(entry, players, { p1: note('小'), p2: note('好友') })).toBe(
      '小 查验了 好友；湖中仙女已交接',
    );
    expect(render(entry, duplicateNames, { p1: note('好友甲'), p2: note('好友乙') })).toBe(
      '好友甲 查验了 好友乙；湖中仙女已交接',
    );
  });

  it('uses the event snapshot for a departed player instead of another player with the same public name', () => {
    const entry = event('小明 离开了房间', [{ playerId: 'departed', name: '小明' }, ' 离开了房间']);
    expect(render(entry, players, { p1: note('另一人') })).toBe('小明 离开了房间');
    expect(render(entry, [])).toBe('小明 离开了房间');
  });
});

describe('legacy event names', () => {
  it.each([
    ['小明 创建了房间', '好友 创建了房间'],
    ['小明 加入了房间', '好友 加入了房间'],
    ['小明 提交了任务队伍，等待全员投票', '好友 提交了任务队伍，等待全员投票'],
    ['小明 已被移出大厅', '好友 已被移出大厅'],
    ['小明 离开了房间', '好友 离开了房间'],
    ['房主指定 小明 为下一任队长', '房主指定 好友 为下一任队长'],
    ['房主指定 小明 为当前队长', '房主指定 好友 为当前队长'],
    ['小明 查验了 小；湖中仙女已交接', '好友 查验了 小；湖中仙女已交接'],
  ])('renders a complete known message: %s', (source, expected) => {
    const entry = event(source);
    expect(render(entry, players, { p1: note('好友') })).toBe(expected);
    expect(entry).toEqual(event(source));
  });

  it('keeps an ambiguous old event unchanged when duplicate names prevent identifying the player', () => {
    const duplicateNames = [players[0], { ...players[1], name: '小明' }];
    expect(
      render(event('房主指定 小明 为当前队长'), duplicateNames, {
        p1: note('甲'),
        p2: note('乙'),
      }),
    ).toBe('房主指定 小明 为当前队长');
    expect(
      render(event('小明 查验了 小明；湖中仙女已交接'), duplicateNames, {
        p1: note('甲'),
        p2: note('乙'),
      }),
    ).toBe('小明 查验了 小明；湖中仙女已交接');
  });

  it('does not replace rule words or partial matches as if they were player references', () => {
    const roleNames = ['好人', '刺客', '梅林', '任务'].map((name, seat) => ({
      id: `role-${seat}`,
      name,
      seat,
    }));
    const notes = Object.fromEntries(roleNames.map((player) => [player.id, note('好友')]));
    const message = '好人达成任务条件，等待刺客选择梅林';
    expect(render(event(message), roleNames, notes)).toBe(message);
    expect(render(event('备注：小明 加入了房间'), players, { p1: note('好友') })).toBe(
      '备注：小明 加入了房间',
    );
    expect(render(event('小明 加入了房间，欢迎'), players, { p1: note('好友') })).toBe(
      '小明 加入了房间，欢迎',
    );
    expect(render(event('小明明 加入了房间'), players, { p1: note('好友') })).toBe(
      '小明明 加入了房间',
    );
  });

  it('preserves the original legacy text if the player can no longer be identified', () => {
    const entry = event('小明 创建了房间');
    expect(render(entry, [])).toBe(entry.text);
    expect(render(entry, [{ id: 'p1', name: '改名后的玩家', seat: 0 }], { p1: note('好友') })).toBe(
      entry.text,
    );
  });
});
