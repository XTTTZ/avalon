import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Crown,
  DoorOpen,
  Flag,
  HelpCircle,
  Link2,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Plus,
  RotateCcw,
  RefreshCw,
  UserRoundMinus,
  ScrollText,
  Settings2,
  Share2,
  Shield,
  Sparkles,
  Swords,
  Users,
  WifiOff,
  X,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useGame } from './api';
import type { GameCommand, GameConfig, PublicPlayer, PublicRoom, RoomView } from '../shared/types';
import { LANCELOT_RULES, ROLE_META, standardConfig } from '../shared/rules';
import { RulesEditor, RulesSummary } from './components/RulesEditor';
import { SecretPanel } from './components/SecretPanel';
import { AssassinationPanel } from './components/AssassinationPanel';
import { eventText, playerInitial, playerName } from './player-names';
import { NotesPanel } from './components/NotesPanel';
import { PlayerSeats } from './components/PlayerSeats';
import './styles.css';

type Tab = 'table' | 'identity' | 'notes' | 'history';
type Confirmation = {
  title: string;
  message: string;
  action: () => Promise<void>;
  danger?: boolean;
};
const PHASE_LABELS = {
  lobby: '等待玩家',
  reveal: '确认身份',
  team: '队长选人',
  teamVote: '组队投票',
  questVote: '任务投票',
  lady: '湖中仙女',
  assassination: '刺杀梅林',
  finished: '本局结束',
};

function Sigil({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={small ? 'sigil small-sigil' : 'sigil'}
      viewBox="0 0 160 190"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M80 9 137 33v66c0 35-24 62-57 82-33-20-57-47-57-82V33L80 9Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="m80 20 47 20v58c0 30-19 52-47 72-28-20-47-42-47-72V40l47-20Z"
        stroke="currentColor"
        opacity=".35"
      />
      <circle cx="80" cy="87" r="34" stroke="currentColor" strokeWidth=".7" />
      <circle cx="80" cy="87" r="26" stroke="currentColor" strokeWidth=".7" opacity=".5" />
      <path
        d="M80 35v108m-6-94h12m-22 29 16-9 16 9-16 10-16-10Zm16 10v57m-25-25 25 13 25-13M80 8V1m0 188v-8M8 87h15m114 0h15"
        stroke="currentColor"
        strokeWidth="1.4"
      />
      <path d="m45 52 70 70M45 122l70-70" stroke="currentColor" strokeWidth=".7" opacity=".45" />
      <circle cx="80" cy="10" r="3" fill="currentColor" />
      <circle cx="80" cy="180" r="3" fill="currentColor" />
      <path
        d="m15 143 5 5-5 5-5-5 5-5Zm130-108 5 5-5 5-5-5 5-5Z"
        stroke="currentColor"
        opacity=".7"
      />
    </svg>
  );
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    const oldFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = 'hidden';
    ref.current?.querySelector<HTMLElement>('button,input,select,textarea,[tabindex="0"]')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current();
      if (event.key === 'Tab') {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
          ) ?? [],
        ).filter((el) => el.offsetParent !== null);
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', key);
      oldFocus?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? 'wide' : ''}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-top">
          <span>{title}</span>
          <button className="icon-button" onClick={onClose} aria-label="关闭弹窗">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function QuestTrack({ room }: { room: PublicRoom }) {
  return (
    <div className="quest-track" aria-label="任务进度">
      {room.config.quests.map((quest, index) => {
        const result = room.quests.find((q) => q.round === index + 1);
        const current =
          room.phase !== 'lobby' && room.phase !== 'finished' && room.round === index + 1;
        return (
          <div
            className={`quest-step ${current ? 'current' : ''} ${result ? (result.passed ? 'passed' : 'failed') : ''}`}
            key={index}
          >
            <span className="quest-round">第 {index + 1} 轮</span>
            <span
              className="quest-token"
              aria-label={`${quest.size} 人${result ? (result.passed ? '，成功' : '，失败') : ''}`}
            >
              {result ? result.passed ? <Check size={22} /> : <X size={21} /> : quest.size}
            </span>
            {result && <span className="quest-detail">{result.passed ? '成功' : '失败'}</span>}
            {quest.failsRequired > 1 && (
              <span className="quest-threshold">≥{quest.failsRequired} 失败票</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Welcome({
  busy,
  initialized,
  create,
  join,
  hasSavedRoom,
  restore,
}: {
  busy: boolean;
  initialized: boolean;
  create: (name: string, config: GameConfig) => Promise<boolean>;
  join: (code: string, name: string) => Promise<boolean>;
  hasSavedRoom: boolean;
  restore: () => Promise<void>;
}) {
  const [mode, setMode] = useState<'create' | 'join'>(() =>
    new URLSearchParams(window.location.search).has('room') ? 'join' : 'create',
  );
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('avalon.publicName') ?? '';
    } catch {
      return '';
    }
  });
  const [code, setCode] = useState(
    () => new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '',
  );
  const [count, setCount] = useState(7);
  const [localError, setLocalError] = useState('');
  const submit = async () => {
    setLocalError('');
    if (!name.trim()) {
      setLocalError('请输入名字');
      return;
    }
    try {
      localStorage.setItem('avalon.publicName', name.trim());
    } catch {
      /* The session remains usable when storage is blocked. */
    }
    try {
      if (mode === 'create') await create(name.trim(), standardConfig(count));
      else await join(code.trim().toUpperCase(), name.trim());
    } catch {
      /* API hook displays the error. */
    }
  };
  return (
    <main className="welcome">
      <section className="entry-card card">
        <div className="entry-heading">
          <h1>阿瓦隆</h1>
          <p>5–12 人</p>
        </div>
        <div className="segmented">
          <button className={mode === 'create' ? 'selected' : ''} onClick={() => setMode('create')}>
            创建
          </button>
          <button className={mode === 'join' ? 'selected' : ''} onClick={() => setMode('join')}>
            加入
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            你的公开名字
            <input
              autoComplete="nickname"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入名字"
              required
            />
          </label>
          {mode === 'create' ? (
            <>
              <label className="field">游戏人数</label>
              <div className="count-picker" aria-label="游戏人数">
                {[5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                  <button
                    type="button"
                    className={count === n ? 'selected' : ''}
                    aria-pressed={count === n}
                    key={n}
                    onClick={() => setCount(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="setup-preview">
                <span>
                  <i className="dot good" />
                  好人 {count - standardConfig(count).evilCount}
                </span>
                <span>
                  <i className="dot evil" />
                  坏人 {standardConfig(count).evilCount}
                </span>
                <span>{count > 10 ? '扩展规则' : '标准规则'}</span>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                房间号
                <input
                  className="room-code-input"
                  inputMode="numeric"
                  pattern="[0-9]{4}|[0-9]{6}"
                  autoComplete="off"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="4 位房间号"
                  required
                />
              </label>
            </>
          )}
          {localError && (
            <p className="error-box" role="alert">
              {localError}
            </p>
          )}
          <button
            className="button primary full create-button"
            disabled={busy || !initialized}
            type="submit"
          >
            {busy || !initialized ? (
              <LoaderCircle size={18} className="spin" />
            ) : mode === 'create' ? (
              <Plus size={18} />
            ) : (
              <ArrowRight size={18} />
            )}{' '}
            {!initialized ? '连接中…' : mode === 'create' ? '创建房间' : '加入房间'}
          </button>
        </form>
        {hasSavedRoom && (
          <button className="text-button full" onClick={() => void restore()}>
            <RotateCcw size={15} />
            回到上一个房间
          </button>
        )}
      </section>
    </main>
  );
}

function PublicActions({
  view,
  busy,
  command,
  setTab,
  selection,
  setSelection,
  confirm,
  onSort,
  displayName,
}: {
  view: RoomView;
  busy: boolean;
  command: (c: GameCommand) => Promise<void>;
  setTab: (tab: Tab) => void;
  selection: string[];
  setSelection: (ids: string[]) => void;
  confirm: (title: string, message: string, action: () => Promise<void>) => void;
  onSort: () => void;
  displayName: (id: string) => string;
}) {
  const { room, self } = view;
  const isHost = room.hostId === self.playerId;
  const name = (id: string | null) => (id ? displayName(id) : '玩家');
  const quest = room.config.quests[room.round - 1];
  if (room.phase === 'lobby')
    return (
      <div className="action-panel">
        <div className="action-icon">
          <Users size={24} />
        </div>
        <div className="action-copy">
          <h3>
            {room.players.length === room.config.playerCount
              ? '玩家已到齐'
              : `等待玩家（${room.players.length}/${room.config.playerCount}）`}
          </h3>
          <p>{isHost ? '人齐后即可开始。' : '等待房主开始。'}</p>
        </div>
        {isHost && (
          <button
            className="button primary"
            disabled={busy || room.players.length !== room.config.playerCount}
            onClick={() => void command({ type: 'start' })}
          >
            开始游戏 <ArrowRight size={16} />
          </button>
        )}
      </div>
    );
  if (room.phase === 'reveal')
    return (
      <div className="action-panel">
        <div className="action-icon">
          <LockKeyhole size={24} />
        </div>
        <div className="action-copy">
          <h3>请确认身份</h3>
          <p>
            {room.readyIds.length} / {room.players.length} 人已确认
          </p>
        </div>
        <button className="button primary" onClick={() => setTab('identity')}>
          {room.readyIds.includes(self.playerId) ? '再次查看身份' : '查看我的身份'}{' '}
          <ArrowRight size={16} />
        </button>
      </div>
    );
  if (room.phase === 'team')
    return (
      <div className="action-panel">
        <div className="action-icon">
          <Crown size={24} />
        </div>
        <div className="action-copy">
          <h3>
            {!room.leaderId
              ? '等待房主调整带队顺序'
              : room.leaderId === self.playerId
                ? '请选择队员'
                : `等待 ${name(room.leaderId)} 组队`}
          </h3>
          <p>
            {room.leaderId === self.playerId
              ? `选择 ${quest?.size} 人，可包含自己。`
              : `本轮需要 ${quest?.size} 人。`}
          </p>
        </div>
        {!room.leaderId && isHost && (
          <button className="button primary" onClick={onSort}>
            调整顺序
          </button>
        )}
        {room.leaderId === self.playerId && (
          <button
            className="button primary"
            disabled={busy || selection.length !== quest?.size}
            onClick={() => void command({ type: 'propose', team: selection })}
          >
            确认队伍 {selection.length}/{quest?.size}
          </button>
        )}
      </div>
    );
  if (room.phase === 'teamVote')
    return (
      <div className="action-panel vote-action">
        <div className="action-copy">
          <h3>组队投票</h3>
          <p>
            {room.proposedTeam.map((id) => name(id)).join('、')}
            <br />
            {room.teamVotedIds.length} / {room.players.length} 人已投票
          </p>
        </div>
        {self.teamVote !== null ? (
          <div className="submitted-badge">
            <Check size={17} />
            已投票，等待其他人
          </div>
        ) : (
          <div className="action-buttons">
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void command({ type: 'teamVote', approve: false })}
            >
              <X size={16} />
              反对
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void command({ type: 'teamVote', approve: true })}
            >
              <Check size={16} />
              同意
            </button>
          </div>
        )}
      </div>
    );
  if (room.phase === 'questVote')
    return (
      <div className="action-panel vote-action">
        <div className="action-icon">
          <Swords size={24} />
        </div>
        <div className="action-copy">
          <h3>任务投票</h3>
          <p>
            {room.proposedTeam.map((id) => name(id)).join('、')}
            <br />
            已收 {room.questSubmittedCount} / {room.proposedTeam.length} 票 · {quest?.failsRequired}{' '}
            张失败票判失败
          </p>
        </div>
        {room.proposedTeam.includes(self.playerId) &&
          (self.questSubmitted ? (
            <div className="submitted-badge">
              <Check size={17} />
              已投票，等待其他人
            </div>
          ) : (
            <div className="quest-ballot">
              <p className="small muted">好人须投成功；任务票匿名。</p>
              <div className="action-buttons">
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => void command({ type: 'questVote', success: true })}
                >
                  任务成功
                </button>
                <button
                  className="button danger"
                  disabled={busy}
                  onClick={() =>
                    confirm('提交失败票？', '提交后不能更改。', () =>
                      command({ type: 'questVote', success: false }),
                    )
                  }
                >
                  任务失败
                </button>
              </div>
            </div>
          ))}
        {!room.proposedTeam.includes(self.playerId) && <span className="muted">等待队员投票</span>}
      </div>
    );
  if (room.phase === 'lady')
    return (
      <div className="action-panel lady-action">
        <div className="action-copy">
          <h3>湖中仙女查验</h3>
          <p>
            {room.ladyHolderId === self.playerId
              ? '选择一人查验阵营，随后将湖中仙女交给对方。'
              : `等待 ${name(room.ladyHolderId)} 选择查验对象。`}
          </p>
          {room.ladyHolderId === self.playerId && (
            <>
              <div className="target-grid">
                {room.players
                  .filter((p) => !room.ladyHistory.includes(p.id) && p.id !== self.playerId)
                  .map((player) => (
                    <button
                      className={`target-chip ${selection[0] === player.id ? 'selected' : ''}`}
                      key={player.id}
                      onClick={() => setSelection([player.id])}
                    >
                      {name(player.id)}
                    </button>
                  ))}
              </div>
              <button
                className="button primary"
                disabled={busy || !selection[0]}
                onClick={() =>
                  confirm('确认查验对象？', `查验「${name(selection[0])}」，结果见身份页。`, () =>
                    command({ type: 'lady', targetId: selection[0] }),
                  )
                }
              >
                使用湖中仙女
              </button>
            </>
          )}
        </div>
      </div>
    );
  if (room.phase === 'assassination')
    return (
      <AssassinationPanel
        view={view}
        busy={busy}
        command={command}
        confirm={confirm}
        displayName={displayName}
      />
    );

  return (
    <div className={`finish-banner ${room.winner ?? 'aborted'}`}>
      <h2>
        {room.winner === 'good' ? '好人获胜' : room.winner === 'evil' ? '坏人获胜' : '本局已结束'}
      </h2>
      <p>{room.finishReason}</p>
      {isHost && (
        <button
          className="button primary"
          disabled={busy}
          onClick={() =>
            confirm('再来一局？', '所有玩家回到大厅，规则保留，身份将在新一局重新随机分配。', () =>
              command({ type: 'rematch' }),
            )
          }
        >
          <RotateCcw size={17} />
          再来一局
        </button>
      )}
    </div>
  );
}

function History({
  room,
  displayName: name,
}: {
  room: PublicRoom;
  displayName: (id: string, fallback?: string) => string;
}) {
  return (
    <div>
      <div className="section-heading">
        <div>
          <h2>圆桌战报</h2>
        </div>
        <span className="pill">公开记录</span>
      </div>
      {room.quests.length === 0 && room.teamVotes.length === 0 && room.ladyHistory.length === 0 && (
        <div className="card empty-state compact">
          <ScrollText size={28} />
          <h3>暂无记录</h3>
        </div>
      )}
      {room.quests.length > 0 && (
        <div className="history-group">
          <h3>任务结果</h3>
          {[...room.quests].reverse().map((quest) => (
            <article className="card history-card" key={quest.round}>
              <div className="subheading">
                <h3>第 {quest.round} 轮</h3>
                <span className={`result-badge ${quest.passed ? 'good' : 'evil'}`}>
                  {quest.passed ? '成功' : '失败'}
                </span>
              </div>
              <p>{quest.team.map((id) => name(id)).join(' · ')}</p>
              <div className="vote-totals">
                <span>
                  <i className="dot good" />
                  成功 {quest.successes} 票
                </span>
                <span>
                  <i className="dot evil" />
                  失败 {quest.fails} 票
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
      {room.teamVotes.length > 0 && (
        <div className="history-group">
          <h3>组队投票</h3>
          {[...room.teamVotes].reverse().map((vote, index) => (
            <details className="card vote-record" key={`${vote.round}-${vote.attempt}-${index}`}>
              <summary>
                <span>
                  <strong>
                    第 {vote.round} 轮 · 第 {vote.attempt} 次提名
                  </strong>
                  <small>
                    队长 {name(vote.leaderId)} · {vote.team.map((id) => name(id)).join('、')}
                  </small>
                </span>
                <span className={`result-badge ${vote.approved ? 'good' : 'evil'}`}>
                  {vote.approved ? '通过' : '拒绝'}
                </span>
                <ChevronDown size={15} />
              </summary>
              <div className="public-votes">
                {Object.entries(vote.votes).map(([id, approve]) => (
                  <span key={id} className={approve ? 'good' : 'evil'}>
                    {approve ? <Check size={13} /> : <X size={13} />} {name(id)}
                  </span>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
      {room.ladyHistory.length > 0 && (
        <div className="history-group">
          <h3>湖中仙女</h3>
          <article className="card lady-history-card">
            {room.ladyHistory.map((playerId, index) => (
              <div key={`${index}-${playerId}`}>
                <span>{index === 0 ? '初始持有人' : `第 ${index} 次交接`}</span>
                <strong>{name(playerId)}</strong>
              </div>
            ))}
          </article>
        </div>
      )}
      <div className="history-group">
        <h3>操作记录</h3>
        <ol className="event-list">
          {[...room.events].reverse().map((event) => (
            <li key={event.id}>
              <span className="event-dot" />
              <div>
                <p>{eventText(event, room.players, name)}</p>
                <time>
                  {new Date(event.at).toLocaleTimeString('zh-CN', {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export default function App() {
  const game = useGame();
  const [tab, setTab] = useState<Tab>('table');
  const [selection, setSelection] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'share' | 'rules' | 'help' | 'manage' | 'players' | null>(
    null,
  );
  const [confirmState, setConfirmState] = useState<Confirmation | null>(null);
  const [managing, setManaging] = useState<PublicPlayer | null>(null);
  const [sortOrder, setSortOrder] = useState<string[] | null>(null);
  const [sortError, setSortError] = useState('');
  const [rename, setRename] = useState('');
  const [copied, setCopied] = useState('');
  const [copyFailure, setCopyFailure] = useState(false);
  const busy = game.busy || game.pending;
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);
  useEffect(() => {
    if (game.pending) {
      setDialog(null);
      setConfirmState(null);
    }
  }, [game.pending]);
  const view = game.view;
  const room = view?.room;
  const displayName = (id: string, fallback?: string) =>
    playerName(
      [...(room?.players ?? []), ...(room?.departedPlayers ?? [])],
      game.notes,
      id,
      fallback,
    );
  const self = view?.self;
  const isHost = room?.hostId === self?.playerId;
  const canChangeOrder = room && room.phase !== 'finished' && room.phase !== 'assassination';
  const sortingBase = useRef('');
  const playersKey = room?.players.map((player) => player.id).join(',') ?? '';
  useEffect(() => {
    if (sortOrder && (!isHost || !canChangeOrder || playersKey !== sortingBase.current)) {
      setSortOrder(null);
      setSortError(playersKey !== sortingBase.current ? '玩家或顺序已更新，请重新排序。' : '');
    }
  }, [isHost, canChangeOrder, playersKey, sortOrder]);
  const beginSorting = () => {
    if (!room || !isHost || !canChangeOrder) return;
    setTab('table');
    sortingBase.current = playersKey;
    setSortError('');
    setSortOrder(room.players.map((player) => player.id));
    requestAnimationFrame(() =>
      document
        .querySelector('.player-board')
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
  };
  const saveOrder = async () => {
    if (!sortOrder) return;
    const saved = await game.command({ type: 'reorder', playerIds: sortOrder, mode: 'rotation' });
    if (saved) {
      setSortOrder(null);
      setSortError('');
    } else setSortError('顺序未保存，请重试。');
  };
  const command = async (action: GameCommand) => {
    try {
      await game.command(action);
    } catch {
      /* The hook exposes a visible recoverable error. */
    }
  };
  useEffect(() => {
    setSelection([]);
    setConfirmState(null);
  }, [room?.phaseKey]);
  useEffect(() => {
    const hide = () => setConfirmState(null);
    const visibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener('blur', hide);
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', hide);
      window.removeEventListener('pagehide', hide);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  useEffect(() => {
    setTab('table');
    setSortOrder(null);
    setDialog(null);
    setConfirmState(null);
  }, [room?.code, room?.gameId]);
  const confirm = (title: string, message: string, action: () => Promise<void>, danger = false) =>
    setConfirmState({ title, message, action, danger });
  const leaveRoom = () =>
    confirm(
      room?.phase === 'finished' ? '退出房间？' : '离开房间？',
      room?.phase === 'finished'
        ? '退出后仍会保留本局公开结算，但你不能再查看这个房间。'
        : isHost
          ? '你离开后，房主将自动转交给下一位玩家。'
          : '你的座位将被释放；之后可通过房间号重新加入。',
      () => command({ type: 'leave' }),
    );
  const dissolveRoom = () =>
    confirm(
      '解散房间？',
      '所有玩家将立即退出，房间和私人笔记作废，无法撤回。',
      () => command({ type: 'dissolve' }),
      true,
    );
  const removePlayer = (target: PublicPlayer) => {
    if (!room || !isHost || target.id === self?.playerId) return;
    setDialog(null);
    const active = room.phase !== 'lobby' && room.phase !== 'finished';
    confirm(
      active ? '结束本局并移除玩家？' : '移除玩家？',
      active
        ? `本局将结束并公开所有身份，然后移除「${displayName(target.id)}」，无法撤回。`
        : `将「${displayName(target.id)}」移出房间。`,
      () => command({ type: 'kick', targetId: target.id, ...(active ? { endGame: true } : {}) }),
    );
  };
  const shareUrl = room
    ? `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(room.code)}`
    : '';
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setCopyFailure(false);
      window.setTimeout(() => setCopied(''), 2200);
    } catch {
      setCopyFailure(true);
    }
  };
  const toggleSelection = (id: string) => {
    const limit = room?.config.quests[(room?.round ?? 1) - 1]?.size ?? 12;
    setSelection((previous) =>
      previous.includes(id)
        ? previous.filter((v) => v !== id)
        : previous.length < limit
          ? [...previous, id]
          : previous,
    );
  };
  return (
    <div className={`app ${view ? 'in-room' : 'at-home'}`}>
      <header className="app-header">
        <a
          href={window.location.pathname}
          className="wordmark"
          onClick={(event) => {
            event.preventDefault();
            if (room)
              confirm('返回首页？', '你的座位仍然保留，之后可以继续返回这个房间。', async () => {
                game.leaveView();
              });
          }}
        >
          <Sigil small />
          <span>
            阿瓦隆<small>AVALON</small>
          </span>
        </a>
        <div className="header-actions">
          {room && self && (
            <button
              className="icon-button"
              aria-label="修改我的公开名字"
              onClick={() => {
                const me = room.players.find((p) => p.id === self.playerId)!;
                setManaging(me);
                setRename(me.name);
                setDialog('manage');
              }}
            >
              <Pencil size={17} />
            </button>
          )}
          {room && (
            <button className="room-badge" onClick={() => setDialog('share')}>
              <span>房间</span>
              <strong>{room.code}</strong>
              <Share2 size={14} />
            </button>
          )}
          <span
            className={`connection-dot ${game.connection}`}
            aria-label={
              game.connection === 'online'
                ? '已连接'
                : game.connection === 'offline'
                  ? '网络断开'
                  : '正在连接'
            }
          />
          <button
            className="icon-button"
            onClick={() => setDialog('help')}
            aria-label="查看玩法帮助"
          >
            <HelpCircle size={21} />
          </button>
        </div>
      </header>
      {(game.error ||
        game.pending ||
        game.connection === 'offline' ||
        game.connection === 'reconnecting') && (
        <div className="status-stack" aria-live="polite">
          {(game.connection === 'offline' || game.connection === 'reconnecting') && (
            <div className="connection-banner">
              <WifiOff size={16} />
              <span>
                {game.connection === 'offline'
                  ? '网络暂时断开，座位和已提交的选择会保留。'
                  : '正在重新连接，恢复最新圆桌状态…'}
              </span>
              <button onClick={() => void game.refreshNow()}>重连</button>
            </div>
          )}
          {game.pending && (
            <div className="pending-banner">
              <LoaderCircle size={16} />
              <span>上一次操作结果尚未确认。请重试确认，避免重复操作。</span>
              <button disabled={game.busy} onClick={() => void game.retryPending()}>
                确认结果
              </button>
            </div>
          )}
          {game.error && (
            <div className="error-banner" role="alert">
              <span>{game.error}</span>
              <button className="icon-button" onClick={game.clearError} aria-label="关闭错误提示">
                <X size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      {!view ? (
        <Welcome
          busy={busy || game.loading}
          initialized={Boolean(game.session)}
          create={game.create}
          join={game.join}
          hasSavedRoom={Boolean(game.session?.lastRoom)}
          restore={game.restore}
        />
      ) : (
        <>
          <main className="room-main">
            <div className="room-heading">
              <div>
                <h1>
                  {room!.phase === 'lobby'
                    ? '游戏大厅'
                    : room!.phase === 'finished'
                      ? '本局结束'
                      : room!.phase === 'reveal'
                        ? '确认身份'
                        : `第 ${room!.round} 轮 · ${PHASE_LABELS[room!.phase]}`}
                </h1>
              </div>
              <div className="room-heading-meta">
                {room!.phase === 'finished' && (
                  <button className="text-button subdued" disabled={busy} onClick={leaveRoom}>
                    <DoorOpen size={15} />
                    退出房间
                  </button>
                )}
                <button
                  className="text-button refresh-button"
                  disabled={game.refreshing}
                  onClick={() => void game.refreshNow()}
                  aria-label="刷新游戏状态"
                  aria-busy={game.refreshing}
                >
                  <RefreshCw size={17} className={game.refreshing ? 'spinning' : ''} />
                  {game.refreshing ? '刷新中' : '刷新'}
                </button>
                <span className="pill">
                  <Users size={13} />
                  {room!.players.length} / {room!.config.playerCount} 人
                </span>
                <span className="pill subtle">
                  {room!.config.preset === 'standard' ? '标准规则' : '自定义扩展'}
                </span>
              </div>
            </div>
            <div hidden={tab !== 'table'} className="table-page">
              <PublicActions
                view={view}
                busy={busy || Boolean(sortOrder)}
                command={command}
                setTab={setTab}
                selection={selection}
                setSelection={setSelection}
                confirm={confirm}
                onSort={beginSorting}
                displayName={displayName}
              />
              <div className="card mission-board">
                <div className="subheading">
                  <h2>
                    <Flag size={17} />
                    任务进程
                  </h2>
                  <span className="small muted">目标 {room!.config.winsRequired} 次</span>
                </div>
                <QuestTrack room={room!} />
                <div className="mission-footer">
                  <span>
                    <i className="dot good" />
                    好人 <strong>{room!.quests.filter((q) => q.passed).length}</strong>
                    <span className="score-divider">:</span>
                    <strong>{room!.quests.filter((q) => !q.passed).length}</strong> 坏人
                    <i className="dot evil" />
                  </span>
                  <div className="rejection-meter">
                    <span>连续拒绝</span>
                    <div
                      aria-label={`连续拒绝 ${room!.rejectionCount}/${room!.config.rejectionLimit}`}
                    >
                      {Array.from({ length: room!.config.rejectionLimit }, (_, index) => (
                        <i key={index} className={index < room!.rejectionCount ? 'filled' : ''} />
                      ))}
                    </div>
                    <strong>
                      {room!.rejectionCount}/{room!.config.rejectionLimit}
                    </strong>
                  </div>
                </div>
              </div>
              <div className="table-columns">
                <section className="card player-board">
                  <div className="subheading">
                    <h2>
                      <Users size={18} />
                      玩家
                    </h2>
                    <div className="player-tools">
                      {isHost && canChangeOrder && !sortOrder && (
                        <button
                          className="text-button"
                          onClick={beginSorting}
                          aria-label="调整带队顺序"
                        >
                          排序
                        </button>
                      )}
                      {isHost && !sortOrder && (
                        <button
                          className="text-button"
                          onClick={() => setDialog('players')}
                          aria-label="踢人"
                        >
                          踢人
                        </button>
                      )}
                      {room!.phase === 'lobby' && !sortOrder && (
                        <button
                          className="text-button"
                          onClick={() => setDialog('share')}
                          aria-label="邀请好友"
                        >
                          邀请
                        </button>
                      )}
                    </div>
                  </div>
                  {sortOrder ? (
                    <div className="sort-toolbar">
                      <span>
                        {room!.phase === 'lobby'
                          ? '拖动玩家卡，按顺序带队'
                          : '拖动排序，当前队长不变'}
                      </span>
                      <div>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            setSortOrder(null);
                            setSortError('');
                          }}
                        >
                          取消
                        </button>
                        <button
                          className="button primary"
                          disabled={busy}
                          onClick={() => void saveOrder()}
                        >
                          保存顺序
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="seat-order-hint">
                      {room!.phase === 'lobby'
                        ? '开局随机排序和发身份'
                        : '按玩家卡从左到右循环带队'}
                    </p>
                  )}
                  {sortError && (
                    <p className="error-box" role="alert">
                      {sortError}
                    </p>
                  )}
                  <PlayerSeats
                    room={room!}
                    selfId={self!.playerId}
                    displayName={displayName}
                    sortOrder={sortOrder}
                    onOrderChange={setSortOrder}
                    selection={
                      room!.phase === 'team' && room!.leaderId === self!.playerId && !sortOrder
                        ? selection
                        : undefined
                    }
                    onSelect={
                      room!.phase === 'team' && room!.leaderId === self!.playerId && !sortOrder
                        ? toggleSelection
                        : undefined
                    }
                    disabled={busy}
                    onManage={
                      !sortOrder
                        ? (player) => {
                            setManaging(player);
                            setRename(player.name);
                            setDialog('manage');
                          }
                        : undefined
                    }
                  />
                  {room!.phase === 'finished' &&
                    (room!.departedPlayers ?? []).map((player) => {
                      const role = room!.revealedRoles.find(
                        (entry) => entry.playerId === player.id,
                      );
                      return (
                        <p className="departed-player" key={player.id}>
                          {displayName(player.id)} ·
                          {player.departure === 'left' ? ' 已离开' : ' 已移除'}
                          {role ? ` · ${ROLE_META[role.role].name}` : ''}
                        </p>
                      );
                    })}
                  {room!.ladyHolderId && (
                    <div className="lady-holder">
                      <Sparkles size={14} />
                      <span>湖中仙女 · {displayName(room!.ladyHolderId)}</span>
                    </div>
                  )}
                  {room!.lancelotChanges.length > 0 && (
                    <p className="lancelot-banner">
                      <RotateCcw size={13} />第 {room!.lancelotChanges.at(-1)!.round} 轮兰斯洛特：
                      {room!.lancelotChanges.at(-1)!.changed ? '双方阵营交换' : '阵营保持不变'}
                    </p>
                  )}
                </section>
                <aside className="card table-rules">
                  <div className="subheading">
                    <h2>
                      <ScrollText size={17} />
                      本局规则
                    </h2>
                    {isHost && room!.phase === 'lobby' && (
                      <button className="text-button" onClick={() => setDialog('rules')}>
                        <Settings2 size={14} />
                        调整
                      </button>
                    )}
                  </div>
                  <RulesSummary config={room!.config} />
                  <button className="text-button" onClick={() => setDialog('help')}>
                    了解玩法 <ArrowRight size={13} />
                  </button>
                </aside>
              </div>
              <div className="room-footer">
                {room!.phase === 'lobby' && (
                  <button className="text-button subdued" disabled={busy} onClick={leaveRoom}>
                    <DoorOpen size={14} />
                    离开房间
                  </button>
                )}
                {room!.phase !== 'lobby' && room!.phase !== 'finished' && isHost && (
                  <button
                    className="text-button subdued"
                    disabled={busy}
                    onClick={() =>
                      confirm('提前结束本局？', '结束后公开所有身份，不判胜负，无法撤回。', () =>
                        command({ type: 'abort' }),
                      )
                    }
                  >
                    结束本局
                  </button>
                )}
                {isHost && (
                  <button
                    className="text-button danger-text"
                    disabled={busy}
                    onClick={dissolveRoom}
                  >
                    解散房间
                  </button>
                )}
              </div>
            </div>
            {tab === 'identity' && (
              <SecretPanel view={view} busy={busy} command={command} displayName={displayName} />
            )}
            <div hidden={tab !== 'notes'}>
              <NotesPanel
                key={`${room!.createdAt}:${self!.playerId}`}
                players={[...room!.players, ...(room!.departedPlayers ?? [])]}
                departedPlayers={room!.departedPlayers}
                selfId={self!.playerId}
                notes={game.notes}
                revision={game.notesRevision}
                roomCode={room!.code}
                busy={busy}
                save={game.saveNotes}
              />
            </div>
            {tab === 'history' && <History room={room!} displayName={displayName} />}
          </main>
          <nav className="bottom-nav" aria-label="主要功能">
            {(
              [
                { id: 'table', label: '公共圆桌', icon: Users },
                { id: 'identity', label: '我的身份', icon: Shield },
                { id: 'notes', label: '私人笔记', icon: BookOpen },
                { id: 'history', label: '圆桌战报', icon: ScrollText },
              ] as const
            ).map((item) => (
              <button
                className={tab === item.id ? 'active' : ''}
                key={item.id}
                onClick={() => setTab(item.id)}
                aria-current={tab === item.id ? 'page' : undefined}
              >
                <item.icon size={21} strokeWidth={tab === item.id ? 2 : 1.6} />
                <span>{item.label}</span>
                {item.id === 'identity' &&
                  room!.phase === 'reveal' &&
                  !room!.readyIds.includes(self!.playerId) && <i className="nav-notification" />}
              </button>
            ))}
          </nav>
        </>
      )}
      {dialog === 'share' && room && (
        <Modal title="邀请好友" onClose={() => setDialog(null)}>
          <div className="share-content">
            <div className="qr-frame">
              <QRCodeSVG
                value={shareUrl}
                size={188}
                fgColor="#183f37"
                bgColor="#fffef9"
                level="M"
                marginSize={2}
              />
            </div>
            <span className="small muted">房间号</span>
            <button className="share-code" onClick={() => void copy(room.code, '房间号')}>
              {room.code}
              <Copy size={17} />
            </button>
            <button className="button primary full" onClick={() => void copy(shareUrl, '邀请链接')}>
              <Link2 size={17} />
              {copied ? `${copied}已复制` : '复制邀请链接'}
            </button>
            {copyFailure && (
              <label className="field copy-fallback">
                请长按下方链接复制
                <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} />
              </label>
            )}
          </div>
        </Modal>
      )}
      {dialog === 'rules' && room && (
        <Modal title="设置本局规则" onClose={() => setDialog(null)} wide>
          <RulesEditor
            initial={room.config}
            busy={busy}
            onCancel={() => setDialog(null)}
            onSave={async (config) => {
              if (await game.command({ type: 'configure', config })) setDialog(null);
              else throw new Error('规则未保存，请检查上方提示后重试。');
            }}
          />
        </Modal>
      )}
      {dialog === 'players' && room && isHost && (
        <Modal title="移除玩家" onClose={() => setDialog(null)}>
          <div className="remove-player-list">
            {room.players
              .filter((player) => player.id !== self!.playerId)
              .map((player) => (
                <button
                  className="button secondary"
                  key={player.id}
                  disabled={busy}
                  onClick={() => removePlayer(player)}
                >
                  <span>
                    {player.seat + 1}. {displayName(player.id)}
                  </span>
                  <UserRoundMinus size={18} />
                </button>
              ))}
            {room.players.length === 1 && <p className="muted">没有可移除的玩家</p>}
          </div>
        </Modal>
      )}
      {dialog === 'manage' && managing && room && (
        <Modal title="玩家" onClose={() => setDialog(null)}>
          <div className="manage-content">
            <span className="avatar">
              <span className="avatar-letter">{playerInitial(displayName(managing.id))}</span>
            </span>
            <h2>{displayName(managing.id)}</h2>
            <p className="muted">
              {managing.seat + 1} 号玩家{managing.id === room.hostId ? ' · 房主' : ''}
            </p>
            {managing.id === self!.playerId && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void game
                    .command({ type: 'rename', name: rename.trim() })
                    .then((ok) => {
                      if (ok) setDialog(null);
                    })
                    .catch(() => {});
                }}
              >
                <label className="field">
                  修改公开名字
                  <input
                    value={rename}
                    maxLength={24}
                    required
                    onChange={(e) => setRename(e.target.value)}
                  />
                </label>
                <button className="button primary full" disabled={busy || !rename.trim()}>
                  <Pencil size={15} />
                  保存名字
                </button>
              </form>
            )}
            {managing.id !== self!.playerId && (
              <button
                className="button secondary full"
                onClick={() => {
                  setDialog(null);
                  setTab('notes');
                }}
              >
                <BookOpen size={15} />
                私人笔记
              </button>
            )}
            {isHost && managing.id !== self!.playerId && (
              <div className="manage-host-actions">
                {room.phase === 'lobby' && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => {
                      setDialog(null);
                      confirm(
                        '转交房主？',
                        `将房主权限转交给「${displayName(managing.id)}」。`,
                        () => command({ type: 'transferHost', targetId: managing.id }),
                      );
                    }}
                  >
                    <Crown size={15} />
                    转交房主
                  </button>
                )}
                <button
                  className="text-button danger-text"
                  disabled={busy}
                  onClick={() => removePlayer(managing)}
                >
                  <DoorOpen size={15} />
                  移除玩家
                </button>
              </div>
            )}
          </div>
        </Modal>
      )}
      {dialog === 'help' && (
        <Modal title="游戏规则" onClose={() => setDialog(null)} wide>
          <div className="help-content">
            <ol className="help-steps">
              <li>
                <strong>查看身份</strong>
                <p>查看自己的角色和已知信息，然后确认身份。</p>
              </li>
              <li>
                <strong>队长提名队伍</strong>
                <p>按任务人数选择队员，可以包含自己。</p>
              </li>
              <li>
                <strong>全员组队投票</strong>
                <p>
                  严格超过半数同意才通过，平票视为拒绝。拒绝后更换队长；标准规则连续 5
                  次拒绝，坏人直接获胜。
                </p>
              </li>
              <li>
                <strong>队员秘密执行任务</strong>
                <p>
                  好人只能投成功，坏人可投成功或失败。只公布总票数。7–10 人标准规则的第 4
                  轮至少需要两张失败票。
                </p>
              </li>
              <li>
                <strong>最终刺杀与揭晓</strong>
                <p>
                  标准规则下，任务失败 3 次则坏人胜；成功 3
                  次后，刺客刺杀梅林，刺中坏人胜，刺错好人胜。
                </p>
              </li>
            </ol>
            <details className="help-detail">
              <summary>
                角色与已知信息
                <ChevronDown size={15} />
              </summary>
              {Object.entries(ROLE_META).map(([role, meta]) => (
                <p key={role}>
                  <strong>{meta.name}</strong> · {meta.description}
                </p>
              ))}
            </details>
            <details className="help-detail">
              <summary>
                湖中仙女与兰斯洛特
                <ChevronDown size={15} />
              </summary>
              <p>
                湖中仙女在第 2、3、4
                次任务结束、游戏仍继续时行动。持有人查看一位从未持有标记的玩家的当前阵营，再将标记交给对方。查验结果仅持有人可见。
              </p>
              <p>{LANCELOT_RULES}</p>
            </details>
          </div>
        </Modal>
      )}
      {confirmState && (
        <Modal title={confirmState.title} onClose={() => !game.busy && setConfirmState(null)}>
          <div className="confirm-content">
            <span className="confirm-icon">
              <Shield size={27} />
            </span>
            <h2>{confirmState.title}</h2>
            <p>{confirmState.message}</p>
            <div className="action-buttons">
              <button
                className="button secondary"
                disabled={game.busy}
                onClick={() => setConfirmState(null)}
              >
                取消
              </button>
              <button
                className={`button ${confirmState.danger ? 'danger' : 'primary'}`}
                disabled={busy}
                onClick={() => {
                  const action = confirmState.action;
                  setConfirmState(null);
                  void action();
                }}
              >
                确认
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
