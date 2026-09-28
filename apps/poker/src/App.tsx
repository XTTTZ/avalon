import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
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
        <h1>Poker 数字筹码</h1>
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
      <p className="footnote">筹码与下注公开 · 玩家操作自己 · 换街和结算由荷官确认</p>
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

function PlayerCard({ room, player }: { room: RoomView; player: Participant }) {
  const state = room.hand?.players.find((item) => item.participantId === player.id);
  const acting = room.hand?.actorId === player.id;
  return (
    <article className={`player-card ${acting ? 'acting' : ''} ${state?.folded ? 'folded' : ''}`}>
      <div className="player-title">
        <span className="avatar">{player.name.slice(0, 1)}</span>
        <div>
          <strong>{player.name}</strong>
          <PositionBadges room={room} id={player.id} />
        </div>
        {acting && <span className="turn-pill">行动中</span>}
      </div>
      <div className="stack">
        <Coins size={17} />
        <strong>{amount(player.stack)}</strong>
      </div>
      {state && (
        <div className="commitments">
          <span>本轮 {amount(state.streetCommitted)}</span>
          <span>本手 {amount(state.handCommitted)}</span>
        </div>
      )}
      <div className="status-row">
        {state?.folded && <span className="status fold">FOLD</span>}
        {state?.allIn && <span className="status allin">ALL-IN</span>}
        {!player.active && <span className="status">暂停参与</span>}
      </div>
    </article>
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
  return (
    <div className="action-bar">
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
            onClick={() => send(shortcut.action, shortcut.to)}
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
            确认金额
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
          onClick={() => send('all-in')}
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
  return (
    <section className="dealer-prompt">
      <p className="eyebrow">荷官提示</p>
      <h2>下注已齐平</h2>
      <p>请在线下发 {next}</p>
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
          <Check size={19} /> 确认已发 {next}
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
  const [choices, setChoices] = useState<SettlementChoice[]>(() => hand?.settlementDraft ?? []);
  useEffect(() => {
    if (hand?.phase === 'SHOWDOWN') setChoices(hand.settlementDraft);
  }, [hand?.id, hand?.phase, hand?.settlementDraft]);
  if (!hand || hand.phase !== 'SHOWDOWN') return null;
  const toggle = (potId: string, participantId: string) => {
    setChoices((current) => {
      const existing = current.find((item) => item.potId === potId);
      const winners = existing?.winnerIds.includes(participantId)
        ? existing.winnerIds.filter((id) => id !== participantId)
        : [...(existing?.winnerIds ?? []), participantId];
      return [...current.filter((item) => item.potId !== potId), { potId, winnerIds: winners }];
    });
  };
  return (
    <section className="card showdown">
      <p className="eyebrow">Showdown</p>
      <h2>指定每个底池赢家</h2>
      <p className="muted">多人勾选即平分；余数按 Button 左侧顺时针分配。</p>
      {hand.pots.map((pot, index) => (
        <div className="pot-choice" key={pot.id}>
          <div>
            <strong>
              {index === 0 ? '主池' : `边池 ${index}`} · {amount(pot.amount)}
            </strong>
          </div>
          <div className="winner-grid">
            {pot.eligibleIds.map((id) => {
              const player = room.participants.find((item) => item.id === id)!;
              const selected = choices
                .find((item) => item.potId === pot.id)
                ?.winnerIds.includes(id);
              return (
                <button
                  className={selected ? 'selected' : ''}
                  key={id}
                  onClick={() => toggle(pot.id, id)}
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
      {room.me.isDealer ? (
        <button
          className="primary wide"
          disabled={
            busy ||
            hand.pots.some(
              (pot) => !choices.find((item) => item.potId === pot.id)?.winnerIds.length,
            )
          }
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

function TableView({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const seated = [...room.participants]
    .filter((item) => item.seat !== null)
    .sort((a, b) => a.seat! - b.seat!);
  const hand = room.hand;
  const total = hand?.players.reduce((sum, item) => sum + item.handCommitted, 0) ?? 0;
  return (
    <>
      <section className="table-summary card">
        <div>
          <p className="eyebrow">{hand ? `第 ${hand.number} 手` : '牌桌准备'}</p>
          <h2>{hand ? streetName[hand.street] : '等待开局'}</h2>
        </div>
        <div className="pot-total">
          <span>当前总额</span>
          <strong>{amount(total)}</strong>
        </div>
        {hand && (
          <div className="table-meta">
            <span>
              盲注 {hand.smallBlind}/{hand.bigBlind}
            </span>
            {hand.phase === 'BETTING' ? (
              <>
                <span>
                  需跟{' '}
                  {amount(
                    Math.max(
                      0,
                      hand.currentBet -
                        (hand.actorId
                          ? (hand.players.find((item) => item.participantId === hand.actorId)
                              ?.streetCommitted ?? 0)
                          : 0),
                    ),
                  )}
                </span>
                <span>
                  {hand.currentBet > 0 ? '最低加到' : '最低下注'}{' '}
                  {amount(
                    hand.currentBet > 0 ? hand.currentBet + hand.lastFullRaiseSize : hand.bigBlind,
                  )}
                </span>
              </>
            ) : (
              <span>{hand.phase === 'SETTLED' ? '已结算' : '等待荷官'}</span>
            )}
          </div>
        )}
      </section>
      <section className="players-grid">
        {seated.map((player) => (
          <PlayerCard room={room} player={player} key={player.id} />
        ))}
      </section>
      {hand && hand.pots.length > 0 && (
        <section className="pots card">
          <h3>底池</h3>
          {hand.pots.map((pot, index) => (
            <div className="pot-line" key={pot.id}>
              <span>{index === 0 ? '主池' : `边池 ${index}`}</span>
              <strong>{amount(pot.amount)}</strong>
              <small>
                {pot.eligibleIds
                  .map((id) => room.participants.find((item) => item.id === id)?.name)
                  .join(' / ')}
              </small>
            </div>
          ))}
          {hand.uncalled && (
            <div className="pot-line pending">
              <span>待匹配</span>
              <strong>{amount(hand.uncalled.amount)}</strong>
              <small>
                {room.participants.find((item) => item.id === hand.uncalled?.participantId)?.name}
              </small>
            </div>
          )}
        </section>
      )}
      <DealerPrompt room={room} busy={busy} command={command} />
      <Showdown room={room} busy={busy} command={command} />
      {(!hand || ['SETTLED', 'VOIDED'].includes(hand.phase)) && (
        <StartPanel room={room} busy={busy} command={command} />
      )}
      {hand && !['SETTLED', 'VOIDED'].includes(hand.phase) && (
        <ActionBar room={room} busy={busy} command={command} />
      )}
    </>
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
  if (!room.me.isDealer)
    return (
      <section className="card empty">
        <p>等待房主或荷官开始下一手</p>
      </section>
    );
  return (
    <section className="card start-panel">
      <h2>{room.hand ? '本手已结束' : '准备第一手'}</h2>
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
        开始下一手并扣盲
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
  const [voidReason, setVoidReason] = useState('线下发牌或操作有误');
  const [ownerTarget, setOwnerTarget] = useState('');
  const betweenHands = !room.hand || ['SETTLED', 'VOIDED'].includes(room.hand.phase);
  const activeMemberIds = new Set(room.members.map((item) => item.id));
  const currentPlayers = room.participants.filter((item) => activeMemberIds.has(item.memberId));
  const seated = [...currentPlayers]
    .filter((item) => item.seat !== null)
    .sort((a, b) => a.seat! - b.seat!);
  const move = (id: string, direction: -1 | 1) => {
    const ids = seated.map((item) => item.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void command({ type: 'reorder', participantIds: ids });
  };
  return (
    <div className="manage-stack">
      <section className="card">
        <h2>房间与荷官</h2>
        <p className="muted">Button 是牌桌位置；Dealer 是有管理权限的人，两者彼此独立。</p>
        {room.me.isOwner && (
          <>
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
            <div className="field-row">
              <label>
                下一手盲注
                <select
                  value={room.blindLevel}
                  disabled={busy || !betweenHands || room.config.blindUpgrade === 'hands'}
                  onChange={(event) =>
                    void command({ type: 'set-blind-level', level: Number(event.target.value) })
                  }
                >
                  {room.config.blindLevels.map((level, index) => (
                    <option key={`${level.smallBlind}-${level.bigBlind}-${index}`} value={index}>
                      {index + 1}. {level.smallBlind}/{level.bigBlind}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                升级方式
                <input
                  value={
                    room.config.blindUpgrade === 'hands'
                      ? `每 ${room.config.handsPerLevel} 手自动`
                      : '手动'
                  }
                  readOnly
                />
              </label>
            </div>
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
      <section className="card">
        <h2>玩家与座次</h2>
        {currentPlayers.map((player) => {
          const index = seated.findIndex((item) => item.id === player.id);
          const isSeated = index >= 0 && player.active;
          const playerMember = room.members.find((item) => item.id === player.memberId)!;
          return (
            <div className="manage-player" key={player.id}>
              <div>
                <span className="avatar small">{player.name.slice(0, 1)}</span>
                <strong>{player.name}</strong>
                <small>{amount(player.stack)} 筹码</small>
              </div>
              {room.me.isOwner && (
                <div className="seat-tools">
                  {isSeated && (
                    <>
                      <button
                        aria-label="上移"
                        disabled={busy || !betweenHands || index === 0}
                        onClick={() => move(player.id, -1)}
                      >
                        <ArrowUp size={18} />
                      </button>
                      <button
                        aria-label="下移"
                        disabled={busy || !betweenHands || index === seated.length - 1}
                        onClick={() => move(player.id, 1)}
                      >
                        <ArrowDown size={18} />
                      </button>
                    </>
                  )}
                  <button
                    className="chip-button"
                    disabled={busy || !betweenHands}
                    onClick={() =>
                      void command({
                        type: 'set-participant-active',
                        participantId: player.id,
                        active: !isSeated,
                      })
                    }
                  >
                    {isSeated ? '暂停' : '入座'}
                  </button>
                  {playerMember.id !== room.ownerMemberId && (
                    <button
                      className="icon-danger"
                      aria-label={`移除 ${player.name}`}
                      disabled={busy || !betweenHands}
                      onClick={() => {
                        if (window.confirm(`确认让 ${player.name} 离开房间？历史账务会保留。`))
                          void command({ type: 'remove-member', memberId: playerMember.id });
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              )}
              {room.me.isDealer && (
                <button
                  className="chip-button"
                  disabled={busy || !betweenHands}
                  onClick={() =>
                    void command({
                      type: 'refill',
                      participantId: player.id,
                      amount: room.config.defaultRefill,
                    })
                  }
                >
                  +{amount(room.config.defaultRefill)}
                </button>
              )}
            </div>
          );
        })}
      </section>
      {room.me.isOwner && (
        <section className="card">
          <h2>成员与房主</h2>
          {room.members
            .filter((item) => !item.participantId)
            .map((item) => (
              <div className="member-row" key={item.id}>
                <span>{item.name} · 旁观</span>
                <div className="member-actions">
                  <button
                    className="chip-button"
                    disabled={busy || !betweenHands}
                    onClick={() => void command({ type: 'seat-member', memberId: item.id })}
                  >
                    入座为玩家
                  </button>
                  {item.id !== room.ownerMemberId && (
                    <button
                      className="icon-danger"
                      aria-label={`移除 ${item.name}`}
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`确认让 ${item.name} 离开房间？`))
                          void command({ type: 'remove-member', memberId: item.id });
                      }}
                    >
                      <Trash2 size={17} />
                    </button>
                  )}
                </div>
              </div>
            ))}
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
  const invite = useMemo(
    () => `${location.origin}${import.meta.env.BASE_URL}?room=${room.code}`,
    [room.code],
  );
  const [showInvite, setShowInvite] = useState(false);
  return (
    <main className="shell room-shell">
      <header className="room-header">
        <div>
          <p className="eyebrow">房间 {room.code}</p>
          <h1>
            <Spade size={24} /> Poker
          </h1>
        </div>
        <div className="header-actions">
          <span className={`connection ${game.connection}`}>
            {game.connection === 'online'
              ? '在线'
              : game.connection === 'connecting'
                ? '连接中'
                : '离线'}
          </span>
          <button aria-label="同步" onClick={() => void game.sync()}>
            <RefreshCw size={20} />
          </button>
          <button aria-label="邀请" onClick={() => setShowInvite(!showInvite)}>
            <Copy size={20} />
          </button>
          <button aria-label="退出当前页面" onClick={game.leaveLocal}>
            <LogOut size={20} />
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
