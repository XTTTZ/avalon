import type { Notes, PublicEvent, PublicPlayer } from '../shared/types';

export function playerName(
  players: PublicPlayer[],
  notes: Notes,
  id: string,
  fallback = '玩家',
): string {
  return notes[id]?.nickname.trim() || players.find((player) => player.id === id)?.name || fallback;
}

/** Legacy rooms have plain text events. Match complete known messages, never arbitrary substrings. */
function legacyParts(text: string, players: PublicPlayer[]): PublicEvent['parts'] {
  const matches: NonNullable<PublicEvent['parts']>[] = [];
  const patterns = [
    ['', ' 创建了房间'],
    ['', ' 加入了房间'],
    ['', ' 提交了任务队伍，等待全员投票'],
    ['', ' 已被移出大厅'],
    ['', ' 离开了房间'],
    ['房主指定 ', ' 为下一任队长'],
    ['房主指定 ', ' 为当前队长'],
  ];
  for (const player of players) {
    const reference = { playerId: player.id, name: player.name };
    for (const [prefix, suffix] of patterns) {
      if (text === `${prefix}${player.name}${suffix}`) matches.push([prefix, reference, suffix]);
    }
    for (const target of players) {
      if (text === `${player.name} 查验了 ${target.name}；湖中仙女已交接`)
        matches.push([
          reference,
          ' 查验了 ',
          { playerId: target.id, name: target.name },
          '；湖中仙女已交接',
        ]);
    }
  }
  // Old rooms could contain duplicate names. Do not guess the wrong player's identity.
  return matches.length === 1 ? matches[0] : undefined;
}

export function eventText(
  event: PublicEvent,
  players: PublicPlayer[],
  displayName: (id: string, fallback?: string) => string,
): string {
  const parts = event.parts ?? legacyParts(event.text, players);
  return (
    parts
      ?.map((part) => (typeof part === 'string' ? part : displayName(part.playerId, part.name)))
      .join('') ?? event.text
  );
}
