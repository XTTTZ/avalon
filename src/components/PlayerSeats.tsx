import { Check, Crown, GripVertical, Plus } from 'lucide-react';
import type { PublicPlayer, PublicRoom } from '../../shared/types';
import { ROLE_META } from '../../shared/rules';
import { movePlayer, useCardSort } from './useCardSort';

export function PlayerSeats({
  room,
  selfId,
  selection,
  onSelect,
  disabled,
  onManage,
  displayName,
  sortOrder = null,
  onOrderChange = () => {},
}: {
  displayName: (id: string) => string;
  sortOrder?: string[] | null;
  onOrderChange?: (ids: string[]) => void;
  room: PublicRoom;
  selfId: string;
  selection?: string[];
  onSelect?: (id: string) => void;
  disabled?: boolean;
  onManage?: (p: PublicPlayer) => void;
}) {
  const { dragging, begin } = useCardSort(sortOrder, Boolean(disabled), onOrderChange);
  const nextLeaderId =
    room.nextLeaderId ??
    (room.leaderMode !== 'manual' && room.leaderId
      ? room.players[
          (room.players.findIndex((p) => p.id === room.leaderId) + 1) % room.players.length
        ]?.id
      : null);
  const count =
    room.phase === 'lobby'
      ? Math.max(room.config.playerCount, room.players.length)
      : room.players.length;
  return (
    <div
      className={`players-grid ${sortOrder ? 'sorting-players' : ''}`}
      aria-label={sortOrder ? '拖动调整带队顺序' : '玩家卡带队顺序'}
    >
      {Array.from({ length: count }, (_, index) => {
        const player = room.players[index];
        if (!player)
          return (
            <div
              className="player-seat empty-seat"
              key={`empty-${index}`}
              style={sortOrder ? { order: index } : undefined}
            >
              <span className="avatar">
                <Plus size={19} strokeWidth={1.2} />
              </span>
              <span className="player-name">空位</span>
              <small>等待朋友</small>
            </div>
          );
        const position = sortOrder ? sortOrder.indexOf(player.id) : index;
        const name = displayName(player.id);
        const selected = selection?.includes(player.id) ?? room.proposedTeam.includes(player.id);
        const leader = room.leaderId === player.id;
        const revealed = room.revealedRoles.find((r) => r.playerId === player.id);
        const contents = (
          <>
            <span className="seat-number">{position + 1}</span>
            {sortOrder && <GripVertical className="sort-grip" size={16} />}
            <div className={`avatar ${selected ? 'selected-avatar' : ''}`}>
              <span>{Array.from(name)[0]}</span>
              {leader && (
                <span className="leader-marker">
                  <Crown size={11} />
                </span>
              )}
              {onSelect && selected && (
                <span className="selected-marker">
                  <Check size={10} />
                </span>
              )}
            </div>
            <span className="player-name" title={name}>
              {name}
              {selfId === player.id && <em>我</em>}
            </span>
            <small>
              {sortOrder
                ? `第 ${position + 1} 位`
                : revealed
                  ? ROLE_META[revealed.role].name
                  : room.phase === 'reveal'
                    ? room.readyIds.includes(player.id)
                      ? '已准备'
                      : '确认身份中'
                    : room.phase === 'teamVote'
                      ? room.teamVotedIds.includes(player.id)
                        ? '已投票'
                        : '等待投票'
                      : leader
                        ? '本轮队长'
                        : player.id === nextLeaderId
                          ? '下一位'
                          : room.hostId === player.id
                            ? '房主'
                            : `${player.seat + 1} 号玩家`}
            </small>
            {revealed && (
              <span className={`reveal-alignment ${revealed.alignment}`}>
                {revealed.alignment === 'good' ? '好人' : '坏人'}
              </span>
            )}
          </>
        );
        return sortOrder || onSelect || onManage ? (
          <button
            aria-label={`${position + 1}号 ${name}${sortOrder ? ' 拖动排序' : `${leader ? ' 队长' : ''}${selected ? ' 已选中' : ''}`}`}
            data-player-id={player.id}
            data-position={position + 1}
            data-leader={leader || undefined}
            style={sortOrder ? { order: position } : undefined}
            onPointerDown={(event) => begin(event, player.id)}
            onContextMenu={(event) => {
              if (sortOrder) event.preventDefault();
            }}
            onDragStart={(event) => event.preventDefault()}
            onKeyDown={(event) => {
              if (
                !sortOrder ||
                !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
              )
                return;
              event.preventDefault();
              const columns = getComputedStyle(
                event.currentTarget.parentElement!,
              ).gridTemplateColumns.split(' ').length;
              const offset =
                event.key === 'ArrowLeft'
                  ? -1
                  : event.key === 'ArrowRight'
                    ? 1
                    : event.key === 'ArrowUp'
                      ? -columns
                      : columns;
              const target = sortOrder[position + offset];
              if (target) onOrderChange(movePlayer(sortOrder, player.id, target));
            }}
            aria-pressed={onSelect ? selected : undefined}
            disabled={disabled}
            className={`player-seat ${sortOrder ? 'is-sortable' : ''} ${dragging === player.id ? 'is-dragging' : ''} ${!sortOrder && selected ? 'is-selected' : ''} ${selfId === player.id ? 'is-self' : ''}`}
            key={player.id}
            onClick={() => {
              if (!sortOrder) {
                if (onSelect) onSelect(player.id);
                else onManage?.(player);
              }
            }}
          >
            {contents}
          </button>
        ) : (
          <div
            data-player-id={player.id}
            data-position={position + 1}
            data-leader={leader || undefined}
            className={`player-seat ${sortOrder ? 'is-sortable' : ''} ${dragging === player.id ? 'is-dragging' : ''} ${!sortOrder && selected ? 'is-selected' : ''} ${selfId === player.id ? 'is-self' : ''}`}
            key={player.id}
          >
            {contents}
          </div>
        );
      })}
    </div>
  );
}
