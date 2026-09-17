import { useCallback, useEffect, useRef, useState } from 'react';
import { Eye, Fingerprint, LockKeyhole, ShieldCheck } from 'lucide-react';
import type { GameCommand, RoomView } from '../../shared/types';
import { ROLE_META } from '../../shared/rules';

export function SecretPanel({
  view,
  busy,
  command,
  confirm,
}: {
  view: RoomView;
  busy: boolean;
  command: (command: GameCommand) => Promise<void>;
  confirm: (title: string, message: string, action: () => Promise<void>) => void;
}) {
  const { room, self } = view;
  const [revealed, setRevealed] = useState(false);
  const [hasViewed, setHasViewed] = useState(false);
  const [target, setTarget] = useState('');
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const hide = useCallback(() => {
    setRevealed(false);
    holding.current = false;
    if (timeout.current) clearTimeout(timeout.current);
  }, []);
  const show = (timed: boolean) => {
    hide();
    setRevealed(true);
    setHasViewed(true);
    holding.current = !timed;
    timeout.current = setTimeout(hide, timed ? 5000 : 15000);
  };
  useEffect(() => {
    hide();
    setTarget('');
  }, [room.phaseKey, hide]);
  useEffect(() => {
    const visibility = () => {
      if (document.visibilityState !== 'visible') hide();
    };
    const release = () => {
      if (holding.current) hide();
    };
    window.addEventListener('blur', hide);
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      if (timeout.current) clearTimeout(timeout.current);
      window.removeEventListener('blur', hide);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [hide]);
  const playerName = (id: string) => room.players.find((p) => p.id === id)?.name ?? '玩家';
  if (room.phase === 'lobby')
    return (
      <div className="empty-state card">
        <LockKeyhole size={36} />
        <h2>尚未发身份</h2>
        <p>等待房主开始游戏</p>
      </div>
    );
  return (
    <div className="identity-page">
      <div className="section-heading">
        <div>
          <h2>我的身份</h2>
        </div>
        <span className="pill">
          <LockKeyhole size={12} />
          仅你可见
        </span>
      </div>
      <div className={`secret-card ${revealed ? 'is-revealed' : ''}`}>
        {!revealed ? (
          <div className="secret-cover">
            <div className="secret-emblem">
              <ShieldCheck size={44} strokeWidth={1} />
            </div>
            <h2>身份已隐藏</h2>
          </div>
        ) : (
          <div className="secret-content" aria-live="polite">
            <h2>{self.role ? ROLE_META[self.role].name : '等待发牌'}</h2>
            <span className={`alignment-label ${self.alignment}`}>
              {self.alignment === 'good' ? '当前阵营 · 好人' : '当前阵营 · 坏人'}
            </span>
            <p className="role-description">{self.roleText}</p>
            {self.knownPlayers.length > 0 && (
              <div className="known-players">
                <h3>你知道的信息</h3>
                {self.knownPlayers.map((p) => (
                  <div key={`${p.playerId}-${p.kind}`}>
                    <span>{playerName(p.playerId)}</span>
                    <small>{p.label}</small>
                  </div>
                ))}
              </div>
            )}
            {self.ladyResults.length > 0 && (
              <div className="known-players">
                <h3>湖中仙女查验</h3>
                {self.ladyResults.map((result) => (
                  <div key={`${result.round}-${result.targetId}`}>
                    <span>{playerName(result.targetId)}</span>
                    <small>
                      第 {result.round} 轮 · {result.alignment === 'good' ? '好人' : '坏人'}
                    </small>
                  </div>
                ))}
                <p className="small">查验时的阵营；兰斯洛特之后可能变化。</p>
              </div>
            )}
          </div>
        )}
        <button
          className="hold-button"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            show(false);
          }}
          onPointerUp={hide}
          onPointerCancel={hide}
          onLostPointerCapture={() => {
            if (holding.current) hide();
          }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
              event.preventDefault();
              show(false);
            }
          }}
          onKeyUp={(event) => {
            if (event.key === ' ' || event.key === 'Enter') hide();
          }}
          onBlur={() => {
            if (holding.current) hide();
          }}
          aria-label="按住显示身份，松开隐藏"
        >
          <Fingerprint size={22} />
          {revealed ? '松开隐藏身份' : '长按查看身份'}
        </button>
      </div>
      <button className="text-button reveal-timed" onClick={() => (revealed ? hide() : show(true))}>
        <Eye size={16} />
        {revealed ? '立即隐藏' : '临时显示 5 秒'}
      </button>
      <p className="privacy-caption">
        <LockKeyhole size={13} />
        松开或切后台自动隐藏
      </p>
      {room.phase === 'reveal' && (
        <div className="card action-card">
          <button
            className="button primary full"
            disabled={busy || !hasViewed || room.readyIds.includes(self.playerId)}
            onClick={() => {
              hide();
              void command({ type: 'ready' });
            }}
          >
            {room.readyIds.includes(self.playerId) ? '已确认，等待其他玩家' : '确认身份'}
          </button>
        </div>
      )}
      {room.phase === 'assassination' && (
        <div className="card action-card">
          <h3>刺杀梅林</h3>
          {!revealed ? (
            <p>显示身份后查看行动</p>
          ) : self.canAssassinate ? (
            <>
              <p>选择梅林，命中则坏人获胜。</p>
              <div className="target-grid">
                {room.players
                  .filter((p) => p.id !== self.playerId)
                  .map((player) => (
                    <button
                      className={`target-chip ${target === player.id ? 'selected' : ''}`}
                      key={player.id}
                      onClick={() => setTarget(player.id)}
                    >
                      {player.seat + 1}. {player.name}
                    </button>
                  ))}
              </div>
              <button
                className="button danger full"
                disabled={busy || !target}
                onClick={() => {
                  hide();
                  confirm(
                    '确认刺杀目标？',
                    `刺杀「${playerName(target)}」后本局结束，无法撤回。`,
                    () => command({ type: 'assassinate', targetId: target }),
                  );
                }}
              >
                确认刺杀{target ? ` · ${playerName(target)}` : ''}
              </button>
            </>
          ) : (
            <p>等待刺客选择目标</p>
          )}
        </div>
      )}
    </div>
  );
}
