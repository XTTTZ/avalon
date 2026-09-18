import { useState } from 'react';
import { Swords } from 'lucide-react';
import type { GameCommand, RoomView } from '../../shared/types';

export function AssassinationPanel({
  view,
  busy,
  command,
  confirm,
  displayName,
}: {
  view: RoomView;
  busy: boolean;
  command: (command: GameCommand) => Promise<void>;
  confirm: (title: string, message: string, action: () => Promise<void>) => void;
  displayName?: (id: string) => string;
}) {
  const { room, self } = view;
  const [selection, setSelection] = useState({ phaseKey: room.phaseKey, targetId: '' });
  const target = selection.phaseKey === room.phaseKey ? selection.targetId : '';
  const playerName = (id: string) =>
    displayName?.(id) ?? room.players.find((player) => player.id === id)?.name ?? '玩家';

  if (room.phase !== 'assassination') return null;
  return (
    <div className="action-panel assassination-action">
      <div className="action-icon">
        <Swords size={24} />
      </div>
      <div className="action-copy">
        <h3>{self.canAssassinate ? '刺杀梅林' : '等待刺客行动'}</h3>
        {self.canAssassinate && (
          <>
            <p>选择刺杀目标。</p>
            <div className="target-grid">
              {room.players
                .filter((player) => player.id !== self.playerId)
                .map((player) => (
                  <button
                    className={`target-chip ${target === player.id ? 'selected' : ''}`}
                    key={player.id}
                    disabled={busy}
                    aria-pressed={target === player.id}
                    onClick={() => setSelection({ phaseKey: room.phaseKey, targetId: player.id })}
                  >
                    {player.seat + 1}. {playerName(player.id)}
                  </button>
                ))}
            </div>
            <button
              className="button danger full"
              disabled={busy || !target}
              onClick={() =>
                confirm(
                  '确认刺杀目标？',
                  `刺杀「${playerName(target)}」后本局结束，无法撤回。`,
                  () => command({ type: 'assassinate', targetId: target }),
                )
              }
            >
              确认刺杀{target ? ` · ${playerName(target)}` : ''}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
