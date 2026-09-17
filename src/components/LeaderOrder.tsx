import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Crown, Repeat2, Shuffle } from 'lucide-react';
import type { GameCommand, LeaderMode, PublicPlayer, PublicRoom } from '../../shared/types';

export function LeaderOrder({ room }: { room: PublicRoom }) {
  const active = room.phase !== 'lobby' && room.phase !== 'finished';
  if (room.leaderMode === 'manual')
    return (
      <div className="leader-order manual-leaders">
        <div className="leader-order-heading">
          <h3>房主指定带队</h3>
        </div>
        <p>当前：{room.players.find((p) => p.id === room.leaderId)?.name ?? '等待指定'}</p>
        <p>下一任：{room.players.find((p) => p.id === room.nextLeaderId)?.name ?? '等待指定'}</p>
      </div>
    );
  const start = Math.max(
    0,
    room.players.findIndex((player) => player.id === (room.nextLeaderId ?? room.leaderId)),
  );
  const players = [...room.players.slice(start), ...room.players.slice(0, start)];
  const current = room.players.find((p) => p.id === room.leaderId);
  if (room.nextLeaderId && current) players.unshift(current);
  return (
    <div className="leader-order">
      <div className="leader-order-heading">
        <h3>带队顺序</h3>
        <span>
          {room.phase === 'lobby'
            ? '首位随机 · 循环'
            : room.nextLeaderId
              ? '指定后按序循环'
              : '按序循环'}
        </span>
      </div>
      <ol className="leader-queue" aria-label="带队顺序">
        {players.map((player, index) => (
          <li
            key={`${player.id}-${index}`}
            className={active && current && index === 0 ? 'current-leader' : ''}
            aria-current={active && current && index === 0 ? 'step' : undefined}
            data-player-id={player.id}
          >
            <span className="queue-position">{index + 1}</span>
            <span className="queue-name">{player.name}</span>
            {active && current && index === 0 && (
              <span className="queue-status">
                <Crown size={13} />
                当前
              </span>
            )}
            {active && index === 1 && <span className="queue-status">下一位</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function SeatOrderEditor({
  players,
  busy,
  onSave,
  onShuffle,
  onCancel,
  mode: initialMode,
  inGame,
}: {
  players: PublicPlayer[];
  busy: boolean;
  onSave: (playerIds: string[], mode: LeaderMode) => Promise<boolean>;
  onShuffle: (mode: LeaderMode) => Promise<boolean>;
  onCancel: () => void;
  mode: LeaderMode;
  inGame: boolean;
}) {
  const [order, setOrder] = useState(() => players.map((player) => player.id));
  const [error, setError] = useState('');
  const [mode, setMode] = useState(initialMode);
  const membersKey = players
    .map((player) => player.id)
    .sort()
    .join(',');
  useEffect(() => {
    setOrder(players.map((player) => player.id));
    setError('');
  }, [membersKey]);
  const move = (index: number, offset: number) => {
    setOrder((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
    setError('');
  };
  const submit = async (random = false) => {
    setError('');
    try {
      const saved = random ? await onShuffle(mode) : await onSave(order, mode);
      if (!saved) setError('未保存，请刷新房间后重试。');
    } catch {
      setError('未保存，请重试。');
    }
  };
  return (
    <div className="seat-order-editor">
      <label className="field">
        带队方式
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as LeaderMode)}
          disabled={busy}
        >
          <option value="rotation">按序循环</option>
          <option value="manual">房主指定</option>
        </select>
      </label>
      <p className="small muted">按现实座位排列，反向可切换顺／逆时针。</p>
      {inGame && <p className="small muted">改序保留当前队长；指定队长可另行操作。</p>}
      <div className="order-tools">
        <button
          className="text-button"
          disabled={busy || order.length < 2}
          onClick={() => setOrder(([first, ...rest]) => [first, ...rest.reverse()])}
        >
          <Repeat2 size={16} />
          反向
        </button>
        <button
          className="text-button"
          disabled={busy || order.length < 2}
          onClick={() => void submit(true)}
        >
          <Shuffle size={16} />
          随机排序并保存
        </button>
      </div>
      <ol className="seat-order-list" aria-label="座位顺序">
        {order.map((id, index) => {
          const player = players.find((p) => p.id === id);
          if (!player) return null;
          return (
            <li key={id} data-player-id={id}>
              <span className="seat-order-number">{index + 1}</span>
              <span className="seat-order-name">{player.name}</span>
              <button
                className="icon-button"
                disabled={busy || index === 0}
                onClick={() => move(index, -1)}
                aria-label={`上移 ${player.name}`}
              >
                <ArrowUp size={19} />
              </button>
              <button
                className="icon-button"
                disabled={busy || index === order.length - 1}
                onClick={() => move(index, 1)}
                aria-label={`下移 ${player.name}`}
              >
                <ArrowDown size={19} />
              </button>
            </li>
          );
        })}
      </ol>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <div className="sticky-modal-actions">
        <button className="button secondary" onClick={onCancel}>
          取消
        </button>
        <button className="button primary" disabled={busy} onClick={() => void submit()}>
          保存顺序
        </button>
      </div>
    </div>
  );
}

export function AssignLeader({
  room,
  busy,
  command,
}: {
  room: PublicRoom;
  busy: boolean;
  command: (command: GameCommand) => Promise<boolean>;
}) {
  const canReplace = room.phase === 'team' || room.phase === 'reveal';
  const [timing, setTiming] = useState<'current' | 'next'>(canReplace ? 'current' : 'next');
  const [target, setTarget] = useState('');
  const [error, setError] = useState('');
  const selectedTiming = canReplace ? timing : 'next';
  const submit = async (clear = false) => {
    setError('');
    try {
      if (
        !(await command({
          type: 'assignLeader',
          targetId: clear ? null : target,
          timing: clear ? 'next' : selectedTiming,
        }))
      )
        setError('未保存，请重试。');
    } catch {
      setError('未保存，请重试。');
    }
  };
  return (
    <div className="assign-leader">
      <label className="field">
        生效时间
        <select
          value={selectedTiming}
          disabled={busy}
          onChange={(e) => setTiming(e.target.value as 'current' | 'next')}
        >
          {canReplace && <option value="current">立即更换当前队长</option>}
          <option value="next">下一次轮换时上任</option>
        </select>
      </label>
      {!canReplace && <p className="small muted">本轮投票保留，下一次轮换时生效。</p>}
      <div className="target-grid" aria-label="选择队长">
        {room.players.map((player) => (
          <button
            key={player.id}
            className={`target-chip ${target === player.id ? 'selected' : ''}`}
            aria-pressed={target === player.id}
            disabled={busy}
            onClick={() => setTarget(player.id)}
          >
            {player.name}
          </button>
        ))}
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <button
        className="button primary full"
        disabled={busy || !target}
        onClick={() => void submit()}
      >
        确认指定
      </button>
      {room.nextLeaderId && (
        <button className="text-button full" disabled={busy} onClick={() => void submit(true)}>
          取消下一任指定
        </button>
      )}
    </div>
  );
}
