import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowLeftRight,
  Check,
  CirclePause,
  CirclePlay,
  Coins,
  Copy,
  Crown,
  Eye,
  History,
  LogOut,
  RefreshCw,
  RotateCcw,
  Settings,
  Spade,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import {
  DEFAULT_CONFIG,
  type GameConfig,
  type Participant,
  type PlayerAction,
  type RoomView,
  type SettlementChoice,
} from '../shared/types';
import { usePoker } from './api/client';

const amount = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const streetName = {
  PREFLOP: 'Preflop',
  FLOP: 'Flop',
  TURN: 'Turn',
  RIVER: 'River',
  SHOWDOWN: 'Showdown',
};

type TableEdge = 'top' | 'bottom' | 'left' | 'right';
type TableSeatSlot = { edge: TableEdge; along: number };

function tableSeatSlots(count: number, rowsOnly: boolean): TableSeatSlot[] {
  const slot = (edge: TableEdge, along = 0): TableSeatSlot => ({ edge, along });
  if (rowsOnly) {
    const fractions = (n: number) =>
      n === 1
        ? [0]
        : Array.from({ length: n }, (_, i) => ((i / (n - 1)) * 2 - 1) * (n === 4 ? 0.67 : 0.6));
    const bottom = fractions(Math.max(1, Math.floor(count / 2)))
      .reverse()
      .map((x) => slot('bottom', x));
    const top = fractions(Math.ceil(count / 2)).map((x) => slot('top', x));
    const around = [...bottom, ...top];
    const start = bottom.reduce(
      (best, item, i) => (Math.abs(item.along) < Math.abs(bottom[best].along) ? i : best),
      0,
    );
    return [...around.slice(start), ...around.slice(0, start)].slice(0, count);
  }
  const b = (x = 0) => slot('bottom', x);
  const t = (x = 0) => slot('top', x);
  const l = (y = 0) => slot('left', y);
  const r = (y = 0) => slot('right', y);
  switch (count) {
    case 1:
      return [b()];
    case 2:
      return [b(), t()];
    case 3:
      return [b(), t(-0.45), t(0.45)];
    case 4:
      return [b(), l(), t(), r()];
    case 5:
      return [b(), l(), t(-0.45), t(0.45), r()];
    case 6:
      return [b(0.45), b(-0.45), l(), t(-0.45), t(0.45), r()];
    case 7:
      return [b(), b(-0.63), l(), t(-0.45), t(0.45), r(), b(0.63)];
    case 8:
      return [b(), b(-0.63), l(), t(-0.63), t(), t(0.63), r(), b(0.63)];
    case 9:
      return [b(0.45), b(-0.45), l(0.3), l(-0.3), t(-0.63), t(), t(0.63), r(-0.3), r(0.3)];
    default:
      return [b(), b(-0.63), l(0.3), l(-0.3), t(-0.63), t(), t(0.63), r(-0.3), r(0.3), b(0.63)];
  }
}

const suitInfo: Record<string, { symbol: string; name: string }> = {
  s: { symbol: '♠', name: '黑桃' },
  h: { symbol: '♥', name: '红桃' },
  d: { symbol: '♦', name: '方片' },
  c: { symbol: '♣', name: '梅花' },
};

function PlayingCard({
  code,
  compact = false,
  hidden = false,
}: {
  code?: string;
  compact?: boolean;
  hidden?: boolean;
}) {
  if (hidden)
    return (
      <span
        className={`playing-card card-back ${compact ? 'compact' : ''}`}
        aria-label="未公开底牌"
      />
    );
  if (!code) return <span className={`playing-card placeholder ${compact ? 'compact' : ''}`} />;
  const rank = code[0] === 'T' ? '10' : code[0];
  const suit = suitInfo[code[1]];
  const red = code[1] === 'h' || code[1] === 'd';
  return (
    <span
      className={`playing-card ${red ? 'red' : ''} ${compact ? 'compact' : ''}`}
      aria-label={`${suit?.name ?? ''}${rank}`}
    >
      <b>{rank}</b>
      <i>{suit?.symbol}</i>
    </span>
  );
}

function CommunityCards({ room }: { room: RoomView }) {
  if ((room.config.mode ?? 'chips') !== 'online' || !room.hand) return null;
  const cards = room.online?.communityCards ?? room.hand.communityCards ?? [];
  return (
    <div className="community-cards" aria-label="公共牌">
      {Array.from({ length: 5 }, (_, index) => (
        <PlayingCard code={cards[index]} compact key={`board-${index}`} />
      ))}
    </div>
  );
}

function Home({
  busy,
  create,
  join,
}: {
  busy: boolean;
  create: (name: string, config: GameConfig) => Promise<boolean>;
  join: (code: string, name: string, as: 'player' | 'spectator') => Promise<boolean>;
}) {
  const [name, setName] = useState(() => localStorage.getItem('poker.publicName') ?? '');
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('room') ?? '');
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [joinAs, setJoinAs] = useState<'player' | 'spectator'>('player');
  const [config, setConfig] = useState<GameConfig>(DEFAULT_CONFIG);
  const [blindText, setBlindText] = useState(
    DEFAULT_CONFIG.blindLevels.map((level) => `${level.smallBlind}/${level.bigBlind}`).join(', '),
  );
  const blindPlanValid = (() => {
    const parts = blindText
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    return (
      parts.length > 0 &&
      parts.length <= 50 &&
      parts.every((item) => {
        const match = /^(\d+)\s*\/\s*(\d+)$/.exec(item);
        return Boolean(match && Number(match[1]) > 0 && Number(match[1]) <= Number(match[2]));
      })
    );
  })();
  const remember = () => localStorage.setItem('poker.publicName', name.trim());
  return (
    <main className="shell home-shell">
      <section className="hero">
        <div className="brand-mark">
          <Spade size={30} />
        </div>
        <h1>Poker 德州扑克</h1>
      </section>
      <section className="card form-card">
        <div className="segmented">
          <button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>
            创建牌局
          </button>
          <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>
            加入牌局
          </button>
        </div>
        <label>
          你的名字
          <input
            value={name}
            maxLength={24}
            onChange={(event) => setName(event.target.value)}
            placeholder="桌上显示的名字"
          />
        </label>
        {mode === 'create' ? (
          <>
            <div className="game-mode-picker">
              <span>牌局模式</span>
              <div className="segmented compact">
                <button
                  className={(config.mode ?? 'chips') === 'chips' ? 'active' : ''}
                  onClick={() => setConfig({ ...config, mode: 'chips' })}
                >
                  电子筹码
                </button>
                <button
                  className={config.mode === 'online' ? 'active' : ''}
                  onClick={() => setConfig({ ...config, mode: 'online', variant: 'standard' })}
                >
                  线上发牌
                </button>
              </div>
              <small>
                {config.mode === 'online'
                  ? '系统发牌、亮公共牌并按牌型自动结算'
                  : '配合实体扑克牌，只记录筹码和下注'}
              </small>
            </div>
            <label>
              初始筹码
              <input
                type="number"
                inputMode="numeric"
                value={config.initialStack}
                onChange={(event) =>
                  setConfig({ ...config, initialStack: Number(event.target.value) })
                }
              />
            </label>
            <div className="field-row">
              <label>
                盲注升级
                <select
                  value={config.blindUpgrade}
                  onChange={(event) =>
                    setConfig({
                      ...config,
                      blindUpgrade: event.target.value as GameConfig['blindUpgrade'],
                    })
                  }
                >
                  <option value="manual">手动选择</option>
                  <option value="hands">按手数自动</option>
                </select>
              </label>
              {config.blindUpgrade === 'hands' ? (
                <label>
                  每级手数
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    value={config.handsPerLevel}
                    onChange={(event) =>
                      setConfig({ ...config, handsPerLevel: Number(event.target.value) })
                    }
                  />
                </label>
              ) : (
                <label>
                  默认补码
                  <input
                    type="number"
                    inputMode="numeric"
                    value={config.defaultRefill}
                    onChange={(event) =>
                      setConfig({ ...config, defaultRefill: Number(event.target.value) })
                    }
                  />
                </label>
              )}
            </div>
            <label>
              盲注级别（逗号分隔）
              <input
                value={blindText}
                placeholder="10/20, 20/40, 30/60"
                onChange={(event) => {
                  const value = event.target.value;
                  setBlindText(value);
                  const levels = value
                    .split(/[,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .map((item) => {
                      const match = /^(\d+)\s*\/\s*(\d+)$/.exec(item);
                      return match
                        ? { smallBlind: Number(match[1]), bigBlind: Number(match[2]) }
                        : null;
                    });
                  if (levels.length && levels.every(Boolean))
                    setConfig({ ...config, blindLevels: levels as GameConfig['blindLevels'] });
                }}
              />
            </label>
            <button
              className="primary wide"
              disabled={busy || !name.trim() || !blindPlanValid}
              onClick={() => {
                remember();
                void create(name, config);
              }}
            >
              创建并入座
            </button>
          </>
        ) : (
          <>
            <label>
              四位房间号
              <input
                value={code}
                inputMode="numeric"
                maxLength={4}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="0000"
              />
            </label>
            <div className="segmented compact">
              <button
                className={joinAs === 'player' ? 'active' : ''}
                onClick={() => setJoinAs('player')}
              >
                <Users size={17} /> 入座
              </button>
              <button
                className={joinAs === 'spectator' ? 'active' : ''}
                onClick={() => setJoinAs('spectator')}
              >
                <Eye size={17} /> 旁观
              </button>
            </div>
            <button
              className="primary wide"
              disabled={busy || !name.trim() || code.length !== 4}
              onClick={() => {
                remember();
                void join(code, name, joinAs);
              }}
            >
              进入房间
            </button>
          </>
        )}
      </section>
      <p className="footnote">下注与筹码公开 · 玩家只操作自己的行动</p>
    </main>
  );
}

function PositionBadges({ room, id }: { room: RoomView; id: string }) {
  const hand = room.hand;
  if (!hand) return null;
  return (
    <span className="position-badges">
      {hand.buttonId === id && <b>BTN</b>}
      {hand.smallBlindId === id && <b>SB</b>}
      {hand.bigBlindId === id && <b>BB</b>}
    </span>
  );
}

function PlayerCard({
  room,
  player,
  onSelect,
}: {
  room: RoomView;
  player: Participant;
  onSelect: () => void;
}) {
  const state = room.hand?.players.find((item) => item.participantId === player.id);
  const acting = room.hand?.actorId === player.id;
  const self = room.me.participantId === player.id;
  const status = state?.folded
    ? 'FOLD'
    : state?.allIn
      ? 'ALL-IN'
      : acting
        ? '行动中'
        : !player.active
          ? '暂停'
          : '';
  return (
    <button
      type="button"
      className={`player-card table-seat ${acting ? 'acting' : ''} ${state?.folded ? 'folded' : ''} ${self ? 'self' : ''}`}
      aria-label={`${(player.seat ?? 0) + 1}号位 ${player.name}，本街下注 ${amount(state?.streetCommitted ?? 0)}`}
      aria-haspopup="dialog"
      onClick={onSelect}
    >
      <div className="player-title">
        <strong title={player.name}>{player.name}</strong>
        <PositionBadges room={room} id={player.id} />
      </div>
      <div className="player-card-meta">
        <div className="player-stack" aria-label={`剩余筹码 ${amount(player.stack)}`}>
          <strong>{amount(player.stack)}</strong>
        </div>
      </div>
      <div className="player-state-slot">
        {status && (
          <span
            className={`status ${acting && !state?.folded && !state?.allIn ? 'turn' : ''} ${state?.folded ? 'fold' : ''} ${state?.allIn ? 'allin' : ''}`}
          >
            {status}
          </span>
        )}
      </div>
    </button>
  );
}

function SeatCards({ room, player }: { room: RoomView; player: Participant }) {
  const hand = room.hand;
  const state = hand?.players.find((item) => item.participantId === player.id);
  if ((room.config.mode ?? 'chips') !== 'online' || !hand || !state) return null;
  const showdown = hand.showdownHands?.find((item) => item.participantId === player.id);
  const ownCards = room.me.participantId === player.id ? (room.online?.holeCards ?? []) : [];
  const visibleCards = showdown?.cards ?? ownCards;
  const hidden = visibleCards.length !== 2;
  return (
    <div
      className={`seat-hole-cards ${state.folded ? 'folded' : ''}`}
      key={`${hand.id}-${player.id}`}
      aria-label={hidden ? `${player.name} 的底牌` : `${player.name} 的底牌已显示`}
    >
      {[0, 1].map((index) => (
        <PlayingCard
          code={visibleCards[index]}
          compact
          hidden={hidden}
          key={`${player.id}-card-${index}`}
        />
      ))}
    </div>
  );
}

function SeatBet({ room, player }: { room: RoomView; player: Participant }) {
  const hand = room.hand;
  const committed = hand?.players.find((item) => item.participantId === player.id)?.streetCommitted;
  if (!hand || !committed) return null;
  return (
    <div
      className="seat-bet"
      key={`${hand.id}-${hand.street}-${player.id}-${committed}`}
      aria-label={`${player.name} 本街下注 ${amount(committed)}`}
    >
      <strong>{amount(committed)}</strong>
    </div>
  );
}

function PlayerDetailPopover({
  room,
  player,
  onClose,
}: {
  room: RoomView;
  player: Participant;
  onClose: () => void;
}) {
  const state = room.hand?.players.find((item) => item.participantId === player.id);
  const acting = room.hand?.actorId === player.id;
  const statuses = [
    acting ? '行动中' : '',
    state?.folded ? 'Fold' : '',
    state?.allIn ? 'All-in' : '',
    !player.active ? '暂停参与' : '',
  ].filter(Boolean);
  return (
    <>
      <button className="player-popover-backdrop" aria-label="关闭玩家详情" onClick={onClose} />
      <section
        className="player-popover"
        role="dialog"
        aria-modal="true"
        aria-label={`${player.name} 的筹码详情`}
      >
        <header>
          <div>
            <span className="seat-number">{(player.seat ?? 0) + 1}</span>
            <strong>{player.name}</strong>
            <PositionBadges room={room} id={player.id} />
          </div>
          <button aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>
        <dl>
          <div>
            <dt>本街下注</dt>
            <dd>{amount(state?.streetCommitted ?? 0)}</dd>
          </div>
          <div>
            <dt>本手投入</dt>
            <dd>{amount(state?.handCommitted ?? 0)}</dd>
          </div>
          <div>
            <dt>剩余筹码</dt>
            <dd>{amount(player.stack)}</dd>
          </div>
        </dl>
        {statuses.length > 0 && <p>{statuses.join(' · ')}</p>}
      </section>
    </>
  );
}

function ActionBar({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const legal = room.legalActions;
  const [amountTo, setAmountTo] = useState('');
  if (!legal) {
    const actor = room.participants.find((item) => item.id === room.hand?.actorId);
    return (
      <div className="action-bar waiting">
        <span>
          {room.paused ? '牌局已暂停' : actor ? `等待 ${actor.name} 行动` : '等待荷官操作'}
        </span>
      </div>
    );
  }
  const send = (action: PlayerAction, to?: number) =>
    void command({ type: 'act', action, ...(to !== undefined ? { to } : {}) });
  const confirmAllIn = () => {
    if (window.confirm(`确认 All-in 到 ${amount(legal.maxTo)}？此操作会投入全部剩余筹码。`))
      send('all-in');
  };
  return (
    <div className="action-bar your-turn">
      <div className="action-summary">
        <strong>轮到你</strong>
        <span>需跟 {amount(legal.callNeeded)}</span>
        {legal.minRaiseTo && <span>最低加到 {amount(legal.minRaiseTo)}</span>}
      </div>
      <div className="quick-row">
        {legal.shortcuts.map((shortcut) => (
          <button
            key={`${shortcut.label}-${shortcut.to}`}
            disabled={busy}
            onClick={() =>
              shortcut.action === 'all-in' ? confirmAllIn() : send(shortcut.action, shortcut.to)
            }
          >
            {shortcut.label}
            <b>{amount(shortcut.to)}</b>
          </button>
        ))}
      </div>
      {(legal.actions.includes('bet') || legal.actions.includes('raise')) && (
        <div className="amount-row">
          <input
            aria-label="加到本轮总额"
            type="number"
            inputMode="numeric"
            value={amountTo}
            onChange={(event) => setAmountTo(event.target.value)}
            placeholder={`加到 ${legal.minRaiseTo ?? legal.minBetTo}`}
          />
          <button
            className="secondary"
            disabled={busy || !amountTo}
            onClick={() =>
              send(legal.actions.includes('raise') ? 'raise' : 'bet', Number(amountTo))
            }
          >
            确认
          </button>
        </div>
      )}
      <div className="main-actions">
        <button
          className="danger"
          disabled={busy || !legal.actions.includes('fold')}
          onClick={() => send('fold')}
        >
          Fold
        </button>
        {legal.actions.includes('check') ? (
          <button className="primary" disabled={busy} onClick={() => send('check')}>
            Check
          </button>
        ) : (
          <button
            className="primary"
            disabled={busy || !legal.actions.includes('call')}
            onClick={() => send('call')}
          >
            Call {amount(legal.callPayable)}
          </button>
        )}
        <button
          className="allin-button"
          disabled={busy || !legal.actions.includes('all-in')}
          onClick={confirmAllIn}
        >
          All-in
        </button>
      </div>
    </div>
  );
}

function DealerPrompt({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const hand = room.hand;
  if (!hand || hand.phase !== 'AWAITING_STREET_CONFIRMATION') return null;
  const next =
    hand.street === 'PREFLOP'
      ? 'Flop'
      : hand.street === 'FLOP'
        ? 'Turn'
        : hand.street === 'TURN'
          ? 'River'
          : 'Showdown';
  const live = hand.players.filter((item) => !item.folded).length;
  const ableToBet = hand.players.filter((item) => {
    const player = room.participants.find((candidate) => candidate.id === item.participantId);
    return !item.folded && !item.allIn && (player?.stack ?? 0) > 0;
  }).length;
  const runout = hand.street !== 'RIVER' && ableToBet <= 1;
  return (
    <section className="dealer-prompt">
      <p className="eyebrow">荷官提示</p>
      <h2>{runout ? '所有下注已完成' : '下注已齐平'}</h2>
      <p>{runout ? '请发完剩余公共牌' : `请在线下发 ${next}`}</p>
      <div className="prompt-stats">
        <span>
          当前总额 <b>{amount(hand.players.reduce((sum, item) => sum + item.handCommitted, 0))}</b>
        </span>
        <span>
          剩余玩家 <b>{live}</b>
        </span>
      </div>
      {room.me.isDealer ? (
        <button
          className="dealer-button"
          disabled={busy}
          onClick={() => void command({ type: 'confirm-street' })}
        >
          <Check size={19} /> {runout ? '已发完 · 进入 Showdown' : `确认已发 ${next}`}
        </button>
      ) : (
        <p className="muted">等待荷官确认</p>
      )}
    </section>
  );
}

function Showdown({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const hand = room.hand;
  const makeChoices = (currentHand: NonNullable<RoomView['hand']>) =>
    currentHand.pots.map((pot) => {
      const existing = currentHand.settlementDraft.find((item) => item.potId === pot.id);
      const runs = existing?.runs?.length
        ? existing.runs.map((run) => ({ winnerIds: [...run.winnerIds] }))
        : existing?.winnerIds?.length
          ? [{ winnerIds: [...existing.winnerIds] }]
          : [
              {
                winnerIds: pot.eligibleIds.length === 1 ? [...pot.eligibleIds] : [],
              },
            ];
      return { potId: pot.id, runs };
    });
  const [choices, setChoices] = useState<SettlementChoice[]>(() => (hand ? makeChoices(hand) : []));
  useEffect(() => {
    if (hand?.phase === 'SHOWDOWN') setChoices(makeChoices(hand));
  }, [hand?.id, hand?.phase, hand?.settlementDraft]);
  if (!hand || hand.phase !== 'SHOWDOWN') return null;
  const toggle = (potId: string, runIndex: number, participantId: string) => {
    setChoices((current) =>
      current.map((choice) => {
        if (choice.potId !== potId || !choice.runs) return choice;
        const runs = choice.runs.map((run, index) => {
          if (index !== runIndex) return run;
          return {
            winnerIds: run.winnerIds.includes(participantId)
              ? run.winnerIds.filter((id) => id !== participantId)
              : [...run.winnerIds, participantId],
          };
        });
        return { potId, runs };
      }),
    );
  };
  const setRunCount = (potId: string, count: number, eligibleIds: string[]) => {
    setChoices((current) =>
      current.map((choice) => {
        if (choice.potId !== potId) return choice;
        const existing = choice.runs ?? [];
        const defaultWinners = eligibleIds.length === 1 ? [...eligibleIds] : [];
        const runs = Array.from({ length: count }, (_, index) =>
          existing[index] ? existing[index] : { winnerIds: defaultWinners },
        );
        return { potId, runs };
      }),
    );
  };
  const complete = hand.pots.every((pot) => {
    const runs = choices.find((item) => item.potId === pot.id)?.runs;
    return Boolean(runs?.length && runs.every((run) => run.winnerIds.length > 0));
  });
  return (
    <section className="card showdown">
      <p className="eyebrow">Showdown</p>
      <h2>指定每个底池赢家</h2>
      <p className="muted">
        可为每个底池选择跑一次或多次；每次多人勾选即平分，余数按 Button 左侧顺时针分配。
      </p>
      {hand.pots.map((pot, index) => {
        const runs = choices.find((item) => item.potId === pot.id)?.runs ?? [{ winnerIds: [] }];
        const baseRunAmount = Math.floor(pot.amount / runs.length);
        const extraRuns = pot.amount % runs.length;
        return (
          <div className="pot-choice" key={pot.id}>
            <div className="pot-choice-header">
              <strong>
                {index === 0 ? '主池' : `边池 ${index}`} · {amount(pot.amount)}
              </strong>
              <div className="run-count" aria-label="跑马次数">
                <button
                  aria-label="减少跑马次数"
                  disabled={!room.me.isDealer || busy || runs.length <= 1}
                  onClick={() => setRunCount(pot.id, runs.length - 1, pot.eligibleIds)}
                >
                  −
                </button>
                <span>跑 {runs.length} 次</span>
                <button
                  aria-label="增加跑马次数"
                  disabled={!room.me.isDealer || busy || runs.length >= Math.min(5, pot.amount)}
                  onClick={() => setRunCount(pot.id, runs.length + 1, pot.eligibleIds)}
                >
                  +
                </button>
              </div>
            </div>
            {runs.map((run, runIndex) => (
              <div className="run-choice" key={`${pot.id}-run-${runIndex}`}>
                {runs.length > 1 && (
                  <strong className="run-label">
                    第 {runIndex + 1} 次 · {amount(baseRunAmount + (runIndex < extraRuns ? 1 : 0))}
                  </strong>
                )}
                <div className="winner-grid">
                  {pot.eligibleIds.map((id) => {
                    const player = room.participants.find((item) => item.id === id)!;
                    const selected = run.winnerIds.includes(id);
                    return (
                      <button
                        className={selected ? 'selected' : ''}
                        disabled={!room.me.isDealer || busy}
                        key={id}
                        onClick={() => toggle(pot.id, runIndex, id)}
                      >
                        <span className="avatar small">{player.name.slice(0, 1)}</span>
                        {player.name}
                        {selected && <Check size={16} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        );
      })}
      {room.me.isDealer ? (
        <button
          className="primary wide"
          disabled={busy || !complete}
          onClick={() => void command({ type: 'settle', pots: choices })}
        >
          确认并发放全部底池
        </button>
      ) : (
        <p className="muted">等待荷官结算</p>
      )}
    </section>
  );
}

function OnlineHoleCards({ room }: { room: RoomView }) {
  if ((room.config.mode ?? 'chips') !== 'online' || !room.hand) return null;
  if (['SETTLED', 'VOIDED'].includes(room.hand.phase)) return null;
  const cards = room.online?.holeCards ?? [];
  if (cards.length !== 2) return null;
  const result = room.hand.showdownHands?.find(
    (item) => item.participantId === room.me.participantId,
  );
  return (
    <section className="hole-card-bar" aria-label="你的底牌">
      <span>
        <small>你的手牌</small>
        {result && <b>{result.label}</b>}
      </span>
      <div>
        {cards.map((card) => (
          <PlayingCard code={card} key={card} />
        ))}
      </div>
    </section>
  );
}

function OnlineShowdown({ room }: { room: RoomView }) {
  const hands = room.hand?.showdownHands ?? [];
  if ((room.config.mode ?? 'chips') !== 'online' || hands.length === 0) return null;
  const winners = new Set(
    room.hand!.settlementDraft.flatMap((choice) =>
      (choice.runs?.length ? choice.runs : [{ winnerIds: choice.winnerIds ?? [] }]).flatMap(
        (run) => run.winnerIds,
      ),
    ),
  );
  return (
    <section className="card online-showdown">
      <div>
        <p className="eyebrow">Showdown</p>
        <h2>系统已自动结算</h2>
      </div>
      <div className="revealed-hands">
        {hands.map((hand) => {
          const player = room.participants.find((item) => item.id === hand.participantId);
          return (
            <article
              className={winners.has(hand.participantId) ? 'winner' : ''}
              key={hand.participantId}
            >
              <span>
                <strong>{player?.name ?? '玩家'}</strong>
                <small>{hand.label}</small>
              </span>
              <div>
                {hand.cards.map((card) => (
                  <PlayingCard code={card} compact key={card} />
                ))}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PotSummary({ room, onShowPots }: { room: RoomView; onShowPots?: () => void }) {
  const hand = room.hand;
  const hasSidePots = (hand?.pots.length ?? 0) > 1;
  const total = hand?.players.reduce((sum, item) => sum + item.handCommitted, 0) ?? 0;
  const actorState = hand?.players.find((item) => item.participantId === hand.actorId);
  const callAmount = hand ? Math.max(0, hand.currentBet - (actorState?.streetCommitted ?? 0)) : 0;
  const minimum = hand
    ? hand.currentBet > 0
      ? hand.currentBet + hand.lastFullRaiseSize
      : hand.bigBlind
    : 0;
  return (
    <>
      <p className="table-phase">
        {hand ? `#${hand.number} · ${streetName[hand.street]}` : '牌桌准备 · 等待开局'}
      </p>
      {hasSidePots && onShowPots ? (
        <button
          className="center-pot pot-details-trigger"
          onClick={onShowPots}
          aria-label={`查看 ${hand!.pots.length} 个底池的金额与争夺资格`}
        >
          <span>底池</span>
          <strong>{amount(total)}</strong>
          <span aria-hidden="true">⌄</span>
        </button>
      ) : (
        <div className="center-pot">
          <span>底池</span>
          <strong>{amount(total)}</strong>
        </div>
      )}
      <CommunityCards room={room} />
      {hand && (
        <>
          <div className="center-meta">
            <span>
              盲 {hand.smallBlind}/{hand.bigBlind}
            </span>
            {hand.phase === 'BETTING' ? (
              <>
                <span>跟 {amount(callAmount)}</span>
                <span>
                  {hand.currentBet > 0 ? '加至' : '下注'} {amount(minimum)}
                </span>
              </>
            ) : (
              <span>
                {hand.phase === 'SETTLED'
                  ? '已结算'
                  : (room.config.mode ?? 'chips') === 'online'
                    ? '系统处理中'
                    : '等待荷官'}
              </span>
            )}
          </div>
          {hasSidePots && !onShowPots && (
            <div className="center-pots">
              {hasSidePots &&
                hand.pots.map((pot, index) => (
                  <div className="center-pot-line" key={pot.id}>
                    <span>{index === 0 ? '主池' : `边池 ${index}`}</span>
                    <b>{amount(pot.amount)}</b>
                    <small>
                      {pot.eligibleIds
                        .map((id) => room.participants.find((item) => item.id === id)?.name)
                        .join(' / ')}
                    </small>
                  </div>
                ))}
              {hand.uncalled && (
                <div className="center-pot-line pending">
                  <span>待跟</span>
                  <b>{amount(hand.uncalled.amount)}</b>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}

function PlayerListRow({
  room,
  player,
  onSelect,
}: {
  room: RoomView;
  player: Participant;
  onSelect: () => void;
}) {
  const state = room.hand?.players.find((item) => item.participantId === player.id);
  const acting = room.hand?.actorId === player.id;
  const folded = Boolean(state?.folded);
  const self = room.me.participantId === player.id;
  return (
    <button
      type="button"
      className={`list-player-row ${acting ? 'acting' : ''} ${folded ? 'folded' : ''} ${self ? 'self' : ''}`}
      aria-label={`${(player.seat ?? 0) + 1}号位 ${player.name}${folded ? '，已 Fold' : ''}`}
      aria-haspopup="dialog"
      onClick={onSelect}
    >
      <div className="list-player-identity">
        <span className="seat-number">{(player.seat ?? 0) + 1}</span>
        <strong title={player.name}>{player.name}</strong>
        <PositionBadges room={room} id={player.id} />
      </div>
      {folded ? (
        <span className="list-fold">FOLD</span>
      ) : (
        <>
          <span className="list-player-state">
            {state?.allIn ? 'ALL-IN' : acting ? '行动中' : ''}
          </span>
          <span className="list-amount">
            <small>本街</small>
            <b>{amount(state?.streetCommitted ?? 0)}</b>
          </span>
          <span className="list-amount">
            <small>本手</small>
            <b>{amount(state?.handCommitted ?? 0)}</b>
          </span>
          <span className="list-amount secondary-value">
            <small>筹码</small>
            <b>{amount(player.stack)}</b>
          </span>
        </>
      )}
    </button>
  );
}

function TableView({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [showPots, setShowPots] = useState(false);
  const tableRef = useRef<HTMLElement>(null);
  const [tableWidth, setTableWidth] = useState(370);
  const [layout, setLayout] = useState<'table' | 'list'>(() =>
    localStorage.getItem('poker.tableLayout') === 'list' ? 'list' : 'table',
  );
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const observer = new ResizeObserver(([entry]) => setTableWidth(entry.contentRect.width));
    observer.observe(table);
    return () => observer.disconnect();
  }, [layout]);
  const seated = [...room.participants]
    .filter((item) => item.active && item.seat !== null)
    .sort((a, b) => a.seat! - b.seat!);
  const selfIndex = seated.findIndex((item) => item.id === room.me.participantId);
  const arranged =
    selfIndex > 0 ? [...seated.slice(selfIndex), ...seated.slice(0, selfIndex)] : seated;
  const hand = room.hand;
  const betweenHands = !hand || ['SETTLED', 'VOIDED'].includes(hand.phase);
  const online = (room.config.mode ?? 'chips') === 'online';
  const compactTable = Boolean(room.legalActions);
  const selectedPlayer = room.participants.find((item) => item.id === selectedPlayerId);
  const dense = arranged.length >= 7;
  const narrowRows = tableWidth <= 335 && arranged.length <= 8;
  const feltWidth = narrowRows ? tableWidth - 12 : tableWidth * 0.71;
  const feltHeight = arranged.length > 8 ? Math.max(feltWidth, 350) : feltWidth;
  const tableHeight = feltHeight + 98;
  const seatWidth = tableWidth <= 335 ? 60 : Math.min(70, Math.max(64, tableWidth * 0.185));
  const sideWidth = Math.min(seatWidth, (tableWidth - feltWidth - 6) / 2);
  const slots = tableSeatSlots(Math.max(arranged.length, 1), narrowRows);

  const changeLayout = (next: 'table' | 'list') => {
    setLayout(next);
    localStorage.setItem('poker.tableLayout', next);
  };
  return (
    <>
      <div className="table-toolbar" aria-label="牌桌显示方式">
        <button
          className={layout === 'table' ? 'active' : ''}
          onClick={() => changeLayout('table')}
        >
          牌桌
        </button>
        <button className={layout === 'list' ? 'active' : ''} onClick={() => changeLayout('list')}>
          列表
        </button>
      </div>
      {layout === 'table' ? (
        <section
          className={`poker-table ${online ? 'online-mode' : ''} ${arranged.length >= 5 ? 'crowded' : ''} ${arranged.length >= 7 ? 'dense' : ''} ${arranged.length > 8 ? 'many' : ''} ${compactTable ? 'action-compact' : ''}`}
          aria-label="牌桌与玩家座位"
          ref={tableRef}
          style={
            {
              height: tableHeight,
              '--felt-width': `${feltWidth}px`,
              '--felt-height': `${feltHeight}px`,
            } as CSSProperties
          }
        >
          <div className="table-felt">
            <div className="table-center">
              <PotSummary room={room} onShowPots={() => setShowPots(true)} />
            </div>
          </div>
          {arranged.map((player, index) => {
            const slot = slots[index];
            const side = slot.edge === 'left' || slot.edge === 'right';
            const sign = slot.edge === 'left' || slot.edge === 'top' ? -1 : 1;
            const cardWidth = dense ? 28 : 31;
            const cardHeight = dense ? 39 : 43;
            const chipWidth = dense ? 38 : 42;
            const chipHeight = dense ? 22 : 24;
            const frameWidth = side ? sideWidth : seatWidth;
            // Keep gaps in pixels so a wider viewport does not spread the pieces apart.
            const seatPoint = side
              ? { x: sign * (feltWidth / 2 + 3 + frameWidth / 2), y: (slot.along * feltHeight) / 2 }
              : { x: (slot.along * feltWidth) / 2, y: sign * (feltHeight / 2 + 3 + 23) };
            const cardPoint = side
              ? { x: sign * (feltWidth / 2 - 5 - 4 - cardWidth / 2), y: seatPoint.y }
              : { x: seatPoint.x, y: sign * (feltHeight / 2 - 5 - 4 - cardHeight / 2) };
            const chipPoint = side
              ? {
                  x: cardPoint.x - sign * (cardWidth / 2 + 4 + chipWidth / 2),
                  y: cardPoint.y + (arranged.length <= 8 ? -26 : 0),
                }
              : { x: cardPoint.x, y: cardPoint.y - sign * (cardHeight / 2 + 4 + chipHeight / 2) };
            const seatStyle = {
              left: tableWidth / 2 + seatPoint.x,
              top: tableHeight / 2 + seatPoint.y,
              width: frameWidth,
              '--card-x': `${cardPoint.x - seatPoint.x}px`,
              '--card-y': `${cardPoint.y - seatPoint.y}px`,
              '--chip-x': `${chipPoint.x - seatPoint.x}px`,
              '--chip-y': `${chipPoint.y - seatPoint.y}px`,
              '--muck-x': `${-seatPoint.x}px`,
              '--muck-y': `${-seatPoint.y}px`,
            } as CSSProperties;
            return (
              <div
                className={`seat-node ${side ? 'side-seat' : ''}`}
                key={player.id}
                style={seatStyle}
              >
                <PlayerCard
                  room={room}
                  player={player}
                  onSelect={() => setSelectedPlayerId(player.id)}
                />
                <SeatCards room={room} player={player} />
                <SeatBet room={room} player={player} />
              </div>
            );
          })}
        </section>
      ) : (
        <section className="player-list-view" aria-label="玩家列表牌桌">
          <div className="list-pot-card">
            <PotSummary room={room} />
          </div>
          <div className="list-players">
            {seated.map((player) => (
              <PlayerListRow
                room={room}
                player={player}
                key={player.id}
                onSelect={() => setSelectedPlayerId(player.id)}
              />
            ))}
          </div>
        </section>
      )}
      {showPots && hand && (
        <>
          <button
            className="player-popover-backdrop"
            aria-label="关闭底池明细"
            onClick={() => setShowPots(false)}
          />
          <section
            className="player-popover pot-details"
            role="dialog"
            aria-modal="true"
            aria-label="底池明细"
          >
            <header>
              <strong>底池明细</strong>
              <button aria-label="关闭" onClick={() => setShowPots(false)}>
                <X size={20} />
              </button>
            </header>
            {hand.pots.map((pot, index) => (
              <article key={pot.id}>
                <div>
                  <b>{index === 0 ? '主池' : `边池 ${index}`}</b>
                  <strong>{amount(pot.amount)}</strong>
                </div>
                <p>
                  {pot.eligibleIds
                    .map((id) => room.participants.find((item) => item.id === id)?.name)
                    .join(' / ')}
                </p>
              </article>
            ))}
            {hand.uncalled && <p>待跟：{amount(hand.uncalled.amount)}</p>}
          </section>
        </>
      )}
      {selectedPlayer && (
        <PlayerDetailPopover
          room={room}
          player={selectedPlayer}
          onClose={() => setSelectedPlayerId(null)}
        />
      )}
      {layout === 'list' && <OnlineHoleCards room={room} />}
      <OnlineShowdown room={room} />
      {!online && <DealerPrompt room={room} busy={busy} command={command} />}
      {!online && <Showdown room={room} busy={busy} command={command} />}
      {betweenHands && <CashGameControls room={room} busy={busy} command={command} />}
      {betweenHands && <StartPanel room={room} busy={busy} command={command} />}
      {hand && !betweenHands && <ActionBar room={room} busy={busy} command={command} />}
    </>
  );
}

function SeatMoveControls({
  room,
  player,
  busy,
  command,
}: {
  room: RoomView;
  player: Participant;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const seated = room.participants
    .filter((item) => item.active && item.seat !== null)
    .sort((a, b) => a.seat! - b.seat!);
  const index = seated.findIndex((item) => item.id === player.id);
  const canMove = index >= 0 && seated.length > 1;
  return (
    <div className="seat-move-controls" aria-label={`${player.name} 的换位操作`}>
      {(['left', 'right'] as const).map((direction) => {
        const offset = direction === 'left' ? 1 : -1;
        const neighbor = canMove ? seated[(index + offset + seated.length) % seated.length] : null;
        const label = direction === 'left' ? '左移' : '右移';
        return (
          <button
            className="secondary"
            key={direction}
            disabled={busy || !canMove}
            aria-label={
              neighbor ? `${player.name} ${label}，越过 ${neighbor.name}` : `${label}，没有相邻玩家`
            }
            onClick={() => void command({ type: 'move-seat', participantId: player.id, direction })}
          >
            {direction === 'left' ? <ArrowLeft size={16} /> : <ArrowRight size={16} />}
            <span>
              <b>{label}</b>
              <small>{neighbor ? `越过 ${neighbor.name}` : '没有相邻玩家'}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function CashGameControls({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const self = room.participants.find((item) => item.id === room.me.participantId);
  const [expanded, setExpanded] = useState<'refill' | 'seat' | null>(null);
  const [refillText, setRefillText] = useState(String(room.config.defaultRefill));
  const refillAmount = Number(refillText);
  const refillValid =
    Number.isSafeInteger(refillAmount) &&
    refillAmount > 0 &&
    refillAmount % room.config.chipUnit === 0;

  if (!self)
    return (
      <section className="card cash-controls">
        <button
          className="primary"
          disabled={busy || room.participants.filter((item) => item.active).length >= 10}
          onClick={() => void command({ type: 'seat-member', memberId: room.me.memberId })}
        >
          <Users size={16} /> 加入牌桌 · {amount(room.config.initialStack)} 筹码
        </button>
      </section>
    );

  const seated = self.active && self.seat !== null;
  const tableFull =
    room.participants.filter((item) => item.active && item.seat !== null).length >= 10;
  return (
    <section className="card cash-controls" aria-label="我的牌桌操作">
      <div className="cash-toolbar">
        <button
          className={`secondary ${expanded === 'refill' ? 'selected' : ''}`}
          aria-expanded={expanded === 'refill'}
          aria-controls="cash-refill-options"
          onClick={() => setExpanded(expanded === 'refill' ? null : 'refill')}
        >
          <Coins size={16} /> 补充
        </button>
        {seated && (
          <button
            className={`secondary ${expanded === 'seat' ? 'selected' : ''}`}
            aria-expanded={expanded === 'seat'}
            aria-controls="cash-seat-options"
            onClick={() => setExpanded(expanded === 'seat' ? null : 'seat')}
          >
            <ArrowLeftRight size={16} /> 换位
          </button>
        )}
        <button
          className="cash-seat-toggle"
          disabled={busy || (!seated && (self.stack === 0 || tableFull))}
          title={!seated && self.stack === 0 ? '请先补充筹码' : undefined}
          onClick={async () => {
            if (
              await command({
                type: 'set-participant-active',
                participantId: self.id,
                active: !seated,
              })
            )
              setExpanded(null);
          }}
        >
          {seated ? <Eye size={16} /> : <Users size={16} />}
          {seated ? '旁观' : '入座'}
        </button>
      </div>
      {expanded === 'refill' && (
        <form
          id="cash-refill-options"
          className="cash-expanded"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !busy &&
              refillValid &&
              (await command({ type: 'refill', participantId: self.id, amount: refillAmount }))
            )
              setExpanded(null);
          }}
        >
          <label htmlFor="cash-refill-amount">
            补充筹码 <span>当前 {amount(self.stack)}</span>
          </label>
          <div className="cash-control-grid">
            <input
              id="cash-refill-amount"
              type="number"
              inputMode="numeric"
              min={room.config.chipUnit}
              step={room.config.chipUnit}
              value={refillText}
              onChange={(event) => setRefillText(event.target.value)}
            />
            <button className="primary" disabled={busy || !refillValid}>
              确认补充
            </button>
          </div>
        </form>
      )}
      {expanded === 'seat' && seated && (
        <div id="cash-seat-options" className="cash-expanded">
          <SeatMoveControls room={room} player={self} busy={busy} command={command} />
        </div>
      )}
    </section>
  );
}

function StartPanel({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const seated = room.participants
    .filter((item) => item.active && item.seat !== null && item.stack > 0)
    .sort((a, b) => a.seat! - b.seat!);
  const [buttonId, setButtonId] = useState(seated[0]?.id ?? '');
  const selectedButton = seated.some((item) => item.id === buttonId)
    ? buttonId
    : (seated[0]?.id ?? '');
  const nextBlinds = room.nextBlinds ?? room.config.blindLevels[room.blindLevel];
  if (!room.me.isDealer)
    return (
      <section className="card empty">
        <p>等待房主或荷官开始下一手</p>
      </section>
    );
  return (
    <section className="card start-panel">
      <h2>{room.hand ? '本手已结束' : '准备第一手'}</h2>
      <p className="next-blinds">
        下一手盲注{' '}
        <strong>
          {nextBlinds.smallBlind}/{nextBlinds.bigBlind}
        </strong>
      </p>
      {!room.lastButtonId && (
        <label>
          首手 Button
          <select value={selectedButton} onChange={(event) => setButtonId(event.target.value)}>
            {seated.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        className="primary wide"
        disabled={busy || seated.length < 2}
        onClick={() =>
          void command({
            type: 'start-hand',
            ...(!room.lastButtonId ? { buttonId: selectedButton } : {}),
          })
        }
      >
        {(room.config.mode ?? 'chips') === 'online' ? '开始下一手并发牌' : '开始下一手并扣盲'}
      </button>
    </section>
  );
}

function HistoryView({ room }: { room: RoomView }) {
  return (
    <section className="card history-list">
      <h2>Action History</h2>
      {[...room.events].reverse().map((item) => (
        <article key={item.id} className={item.revertedBy ? 'reverted' : ''}>
          <div className="event-dot" />
          <div>
            <strong>{item.detail}</strong>
            <small>
              {new Date(item.at).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })}
              {item.revertedBy ? ' · 已撤销' : ''}
            </small>
          </div>
        </article>
      ))}
    </section>
  );
}

function SummaryView({ room }: { room: RoomView }) {
  return (
    <section className="card">
      <h2>整晚 Session Summary</h2>
      <div className="summary-table">
        {room.participants.map((player) => {
          const net =
            player.stack -
            player.initialChips -
            player.refillTotal -
            player.rebuyTotal -
            player.externalAdjustment;
          return (
            <article key={player.id}>
              <div>
                <span className="avatar small">{player.name.slice(0, 1)}</span>
                <strong>{player.name}</strong>
              </div>
              <dl>
                <div>
                  <dt>初始</dt>
                  <dd>{amount(player.initialChips)}</dd>
                </div>
                <div>
                  <dt>补码</dt>
                  <dd>
                    {player.refillCount + player.rebuyCount} 次 ·{' '}
                    {amount(player.refillTotal + player.rebuyTotal)}
                  </dd>
                </div>
                <div>
                  <dt>当前</dt>
                  <dd>{amount(player.stack)}</dd>
                </div>
                <div>
                  <dt>净变化</dt>
                  <dd className={net >= 0 ? 'positive' : 'negative'}>
                    {net > 0 ? '+' : ''}
                    {amount(net)}
                  </dd>
                </div>
                <div>
                  <dt>手数</dt>
                  <dd>{player.handsPlayed}</dd>
                </div>
                <div>
                  <dt>最大单池</dt>
                  <dd>{amount(player.largestPotShare)}</dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ManageView({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const [reason, setReason] = useState('线下筹码核对');
  const [correctionAmount, setCorrectionAmount] = useState(room.config.chipUnit);
  const [voidReason, setVoidReason] = useState('发牌或操作有误');
  const [ownerTarget, setOwnerTarget] = useState('');
  const [movingPlayerId, setMovingPlayerId] = useState<string | null>(null);
  const plannedBlinds = room.nextBlinds ?? room.config.blindLevels[room.blindLevel];
  const [nextSmallBlind, setNextSmallBlind] = useState(plannedBlinds.smallBlind);
  const [nextBigBlind, setNextBigBlind] = useState(plannedBlinds.bigBlind);
  useEffect(() => {
    setNextSmallBlind(plannedBlinds.smallBlind);
    setNextBigBlind(plannedBlinds.bigBlind);
  }, [plannedBlinds.smallBlind, plannedBlinds.bigBlind]);
  const nextBlindsValid =
    Number.isSafeInteger(nextSmallBlind) &&
    Number.isSafeInteger(nextBigBlind) &&
    nextSmallBlind > 0 &&
    nextSmallBlind <= nextBigBlind &&
    nextSmallBlind % room.config.chipUnit === 0 &&
    nextBigBlind % room.config.chipUnit === 0;
  const betweenHands = !room.hand || ['SETTLED', 'VOIDED'].includes(room.hand.phase);
  const activeMemberIds = new Set(room.members.map((item) => item.id));
  const currentPlayers = room.participants.filter((item) => activeMemberIds.has(item.memberId));
  const tableFull = currentPlayers.filter((item) => item.active && item.seat !== null).length >= 10;
  return (
    <div className="manage-stack">
      {room.me.isDealer && (
        <section className="card seat-management">
          <h2>玩家与座次</h2>
          {!betweenHands && <p className="muted">本手结束后可换位或调整入座。</p>}
          {room.members.map((member) => {
            const player = currentPlayers.find((item) => item.memberId === member.id);
            const seated = Boolean(player?.active && player.seat !== null);
            return (
              <div className="managed-member" key={member.id}>
                <div className="managed-member-row">
                  <div className="manage-player-copy">
                    <strong>{member.name}</strong>
                    <small>
                      {seated ? '在座' : '旁观'}
                      {player ? ` · ${amount(player.stack)}` : ''}
                    </small>
                  </div>
                  {seated && player && (
                    <button
                      className="chip-button"
                      disabled={busy || !betweenHands}
                      aria-label={`为 ${member.name} 换位`}
                      aria-expanded={movingPlayerId === player.id}
                      onClick={() =>
                        setMovingPlayerId(movingPlayerId === player.id ? null : player.id)
                      }
                    >
                      换位
                    </button>
                  )}
                  <button
                    className="chip-button"
                    disabled={
                      busy || !betweenHands || (!seated && (player?.stack === 0 || tableFull))
                    }
                    aria-label={seated ? `将 ${member.name} 移到旁观席` : `让 ${member.name} 入座`}
                    onClick={async () => {
                      const ok = await command(
                        player
                          ? {
                              type: 'set-participant-active',
                              participantId: player.id,
                              active: !seated,
                            }
                          : { type: 'seat-member', memberId: member.id },
                      );
                      if (ok) setMovingPlayerId(null);
                    }}
                  >
                    {seated ? '旁观' : '入座'}
                  </button>
                </div>
                {player && seated && movingPlayerId === player.id && (
                  <SeatMoveControls
                    room={room}
                    player={player}
                    busy={busy || !betweenHands}
                    command={command}
                  />
                )}
              </div>
            );
          })}
        </section>
      )}
      <section className="card">
        <h2>房间与荷官</h2>
        <p className="muted">Button 是牌桌位置；Dealer 是有管理权限的人，两者彼此独立。</p>
        {room.me.isOwner && (
          <label>
            额外 Dealer
            <select
              value={room.dealerMemberId ?? ''}
              onChange={(event) =>
                void command({ type: 'assign-dealer', memberId: event.target.value || null })
              }
            >
              <option value="">仅房主</option>
              {room.members
                .filter((item) => item.id !== room.ownerMemberId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.participantId ? ' · 玩家' : ' · 旁观'}
                  </option>
                ))}
            </select>
          </label>
        )}
        {room.me.isDealer && (
          <>
            <div className="blind-editor">
              <label>
                下一手 SB
                <input
                  type="number"
                  inputMode="numeric"
                  min={room.config.chipUnit}
                  step={room.config.chipUnit}
                  value={nextSmallBlind}
                  onChange={(event) => setNextSmallBlind(Number(event.target.value))}
                />
              </label>
              <label>
                下一手 BB
                <input
                  type="number"
                  inputMode="numeric"
                  min={room.config.chipUnit}
                  step={room.config.chipUnit}
                  value={nextBigBlind}
                  onChange={(event) => setNextBigBlind(Number(event.target.value))}
                />
              </label>
              <button
                className="secondary"
                disabled={busy || !nextBlindsValid}
                onClick={() =>
                  void command({
                    type: 'set-next-blinds',
                    smallBlind: nextSmallBlind,
                    bigBlind: nextBigBlind,
                  })
                }
              >
                保存下一手盲注
              </button>
            </div>
            <p className="muted">可在当前手进行中修改；只覆盖下一手，之后继续原有盲注计划。</p>
          </>
        )}
        <div className="tool-row">
          {room.me.isDealer &&
            (room.paused ? (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void command({ type: 'resume' })}
              >
                <CirclePlay size={18} />
                继续牌局
              </button>
            ) : (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void command({ type: 'pause' })}
              >
                <CirclePause size={18} />
                暂停牌局
              </button>
            ))}
          {room.me.isDealer && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void command({ type: 'undo' })}
            >
              <RotateCcw size={18} />
              撤销最近操作
            </button>
          )}
        </div>
        {room.me.isDealer && room.hand && !betweenHands && (
          <div className="danger-zone">
            <label>
              作废原因
              <input value={voidReason} onChange={(event) => setVoidReason(event.target.value)} />
            </label>
            <button
              className="danger"
              disabled={busy || voidReason.trim().length < 2}
              onClick={() => {
                if (window.confirm('确认作废当前手？本手投入会全部退回。'))
                  void command({ type: 'void-hand', reason: voidReason });
              }}
            >
              作废当前手并退回筹码
            </button>
          </div>
        )}
      </section>
      {room.me.isOwner && (
        <section className="card">
          <h2>成员与房主</h2>
          {room.members.map((item) => {
            const player = currentPlayers.find((candidate) => candidate.memberId === item.id);
            const status =
              player?.active && player.seat !== null ? `${player.seat + 1}号位` : '旁观';
            return (
              <div className="member-row" key={item.id}>
                <span>
                  {item.name} · {status}
                </span>
                <div className="member-actions">
                  {item.id !== room.ownerMemberId && (
                    <button
                      className="icon-danger"
                      aria-label={`移除 ${item.name}`}
                      disabled={busy || (Boolean(player) && !betweenHands)}
                      onClick={() => {
                        if (window.confirm(`确认让 ${item.name} 离开房间？历史账务会保留。`))
                          void command({ type: 'remove-member', memberId: item.id });
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <label>
            转移房主给
            <select value={ownerTarget} onChange={(event) => setOwnerTarget(event.target.value)}>
              <option value="">选择成员</option>
              {room.members
                .filter((item) => item.id !== room.ownerMemberId)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <button
            className="secondary"
            disabled={busy || !ownerTarget}
            onClick={() => {
              const target = room.members.find((item) => item.id === ownerTarget);
              if (target && window.confirm(`确认把房主转移给 ${target.name}？`))
                void command({ type: 'transfer-owner', memberId: ownerTarget });
            }}
          >
            确认转移房主
          </button>
        </section>
      )}
      {room.me.isDealer && (
        <section className="card">
          <h2>人工校正</h2>
          <div className="field-row">
            <label>
              校正原因
              <input value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <label>
              每次校正量
              <input
                type="number"
                inputMode="numeric"
                min={room.config.chipUnit}
                step={room.config.chipUnit}
                value={correctionAmount}
                onChange={(event) => setCorrectionAmount(Number(event.target.value))}
              />
            </label>
          </div>
          <p className="muted">校正仅在两手之间或暂停后使用，并永久保留在历史中。</p>
          {currentPlayers.map((player) => (
            <div className="adjust-row" key={player.id}>
              <span>{player.name}</span>
              <button
                disabled={busy || correctionAmount < room.config.chipUnit}
                onClick={() =>
                  void command({
                    type: 'adjust-chips',
                    participantId: player.id,
                    amount: -correctionAmount,
                    reason,
                  })
                }
              >
                −{amount(correctionAmount)}
              </button>
              <button
                disabled={busy || correctionAmount < room.config.chipUnit}
                onClick={() =>
                  void command({
                    type: 'adjust-chips',
                    participantId: player.id,
                    amount: correctionAmount,
                    reason,
                  })
                }
              >
                +{amount(correctionAmount)}
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Room({ game, room }: { game: ReturnType<typeof usePoker>; room: RoomView }) {
  const [tab, setTab] = useState<'table' | 'history' | 'summary' | 'manage'>('table');
  const [refreshing, setRefreshing] = useState(false);
  const invite = useMemo(
    () => `${location.origin}${import.meta.env.BASE_URL}?room=${room.code}`,
    [room.code],
  );
  const [showInvite, setShowInvite] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([
        game.sync(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 450)),
      ]);
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <main className="shell room-shell">
      <header className="room-header">
        <div className="room-identity">
          <Spade className="room-symbol" size={28} aria-hidden="true" />
          <div>
            <h1>房间 {room.code}</h1>
            <p className="eyebrow">
              {(room.config.mode ?? 'chips') === 'online' ? '线上发牌' : '电子筹码'}
            </p>
          </div>
        </div>
        <div className="header-actions">
          <span
            className={`connection ${game.connection}`}
            aria-label={
              game.connection === 'online'
                ? '在线'
                : game.connection === 'connecting'
                  ? '连接中'
                  : '离线'
            }
            title={
              game.connection === 'online'
                ? '在线'
                : game.connection === 'connecting'
                  ? '连接中'
                  : '离线'
            }
          >
            {game.connection === 'online'
              ? '在线'
              : game.connection === 'connecting'
                ? '连接中'
                : '离线'}
          </span>
          <button aria-label="邀请" onClick={() => setShowInvite(!showInvite)}>
            <Copy size={18} />
          </button>
          <button aria-label="退出当前页面" onClick={game.leaveLocal}>
            <LogOut size={18} />
          </button>
        </div>
      </header>
      {showInvite && (
        <section className="card invite">
          <QRCodeSVG value={invite} size={116} />
          <div>
            <strong>扫码加入 {room.code}</strong>
            <p>{invite}</p>
            <button
              className="secondary"
              onClick={() => void navigator.clipboard.writeText(invite)}
            >
              复制邀请链接
            </button>
          </div>
        </section>
      )}
      {room.paused && (
        <div className="banner warning">
          <CirclePause size={18} />
          牌局已暂停，可核对筹码或撤销操作
        </div>
      )}
      {tab === 'table' && <TableView room={room} busy={game.busy} command={game.command} />}
      {tab === 'history' && <HistoryView room={room} />}
      {tab === 'summary' && <SummaryView room={room} />}
      {tab === 'manage' && <ManageView room={room} busy={game.busy} command={game.command} />}
      <nav className="bottom-nav">
        <button className={tab === 'table' ? 'active' : ''} onClick={() => setTab('table')}>
          <Spade size={19} />
          牌桌
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <History size={19} />
          记录
        </button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>
          <Crown size={19} />
          汇总
        </button>
        <button className={tab === 'manage' ? 'active' : ''} onClick={() => setTab('manage')}>
          <Settings size={19} />
          管理
        </button>
        <button
          className={`refresh-button ${refreshing ? 'refreshing' : ''}`}
          aria-label="刷新牌局"
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw className={refreshing ? 'spinning' : ''} size={19} />
          刷新
        </button>
      </nav>
    </main>
  );
}

export default function App() {
  const game = usePoker();
  return (
    <>
      {game.error && (
        <div className="toast" role="alert">
          <AlertTriangle size={18} />
          <span>{game.error}</span>
          <button onClick={game.clearError}>×</button>
        </div>
      )}
      {game.hasPending && (
        <div className="pending-banner">
          上次操作结果待确认 <button onClick={() => void game.retryPending()}>立即确认</button>
        </div>
      )}
      {game.room ? (
        <Room game={game} room={game.room} />
      ) : (
        <Home busy={game.busy} create={game.create} join={game.join} />
      )}
    </>
  );
}
