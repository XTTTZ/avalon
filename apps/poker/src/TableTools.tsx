import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BookOpen, Pencil, X } from 'lucide-react';
import type { RoomView } from '../shared/types';
import type { usePoker } from './api/client';

function TableDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="table-tools-dialog"
      aria-label={title}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="table-tools-content">
        <header>
          <h2>{title}</h2>
          <button type="button" className="tool-close" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

const rankings = [
  { name: '皇家同花顺', cards: ['A♠', 'K♠', 'Q♠', 'J♠', '10♠'], tip: '同一花色的 10 到 A' },
  { name: '同花顺', cards: ['9♥', '8♥', '7♥', '6♥', '5♥'], tip: '同一花色的五张顺子' },
  { name: '四条', cards: ['K♠', 'K♥', 'K♦', 'K♣', '3♠'], tip: '四张相同点数' },
  { name: '葫芦', cards: ['Q♠', 'Q♥', 'Q♦', '8♣', '8♠'], tip: '三条加一对' },
  { name: '同花', cards: ['A♦', 'J♦', '8♦', '6♦', '2♦'], tip: '五张同一花色' },
  { name: '顺子', cards: ['8♠', '7♥', '6♦', '5♣', '4♠'], tip: '五张连续点数' },
  { name: '三条', cards: ['7♠', '7♥', '7♦', 'K♣', '2♠'], tip: '三张相同点数' },
  { name: '两对', cards: ['J♠', 'J♥', '4♦', '4♣', 'A♠'], tip: '两组对子' },
  { name: '一对', cards: ['10♠', '10♥', 'A♦', '6♣', '3♠'], tip: '一组对子' },
  { name: '高牌', cards: ['A♠', 'J♥', '8♦', '6♣', '2♠'], tip: '以上都没有，比较最大点数' },
];

export function RulesButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="table-tool-button"
        onClick={() => setOpen(true)}
        aria-label="德州扑克牌型说明"
      >
        <BookOpen size={14} />
        <span>说明</span>
      </button>
      {open && (
        <TableDialog title="牌型大小" onClose={() => setOpen(false)}>
          <p className="rules-intro">从大到小 · 两张底牌与五张公共牌中，选最大的五张。</p>
          <ol className="hand-rankings">
            {rankings.map((hand, index) => (
              <li key={hand.name}>
                <span className="rank-order">{index + 1}</span>
                <div>
                  <strong>{hand.name}</strong>
                  <small>{hand.tip}</small>
                </div>
                <span className="rank-example" aria-label={hand.cards.join(' ')}>
                  {hand.cards.map((card, i) => (
                    <span key={i} data-suit={card.slice(-1)}>
                      {card}
                    </span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
          <ul className="rules-notes">
            <li>
              同牌型先比组成牌型的点数，再比剩余牌（踢脚），直到分出大小；五张完全相同则平分。
            </li>
            <li>
              点数 A &gt; K &gt; Q &gt; J &gt; 10 … 2。A 可在 A2345 中作最小牌，不能接成 QKA23。
            </li>
            <li>花色不分大小。可使用 0、1 或 2 张底牌，公共牌也能组成所有人的最佳牌。</li>
            <li>弃牌后不能赢底池；边池只在有资格的玩家之间比较。</li>
          </ul>
        </TableDialog>
      )}
    </>
  );
}

export function RenameButton({
  room,
  busy,
  command,
}: {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}) {
  const self = room.members.find((member) => member.id === room.me.memberId);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const normalized = name.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const duplicate = room.members.some(
    (member) =>
      member.id !== room.me.memberId &&
      member.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toUpperCase().toLowerCase() ===
        normalized.toUpperCase().toLowerCase(),
  );
  const valid = normalized.length > 0 && normalized.length <= 24 && !duplicate;
  return (
    <>
      <button
        type="button"
        className="table-tool-button"
        onClick={() => {
          setName(self?.name ?? '');
          setError('');
          setOpen(true);
        }}
      >
        <Pencil size={14} />
        <span>改名</span>
      </button>
      {open && (
        <TableDialog title="修改我的名字" onClose={() => setOpen(false)}>
          <form
            className="rename-form"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!valid || busy) return;
              const saved = await command({ type: 'rename-self', name: normalized });
              if (saved) {
                localStorage.setItem('poker.publicName', normalized);
                setOpen(false);
              } else setError('修改未成功，请检查房间提示后重试。');
            }}
          >
            <label>
              名字
              <input
                autoFocus
                maxLength={24}
                autoComplete="nickname"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError('');
                }}
              />
            </label>
            <p
              className={duplicate || error ? 'rename-error' : 'muted'}
              role={duplicate || error ? 'alert' : undefined}
            >
              {duplicate
                ? '房间里已有这个名字，请换一个。'
                : error || '1–24 个字符，房间内不能重名。'}
            </p>
            <button type="submit" className="primary wide" disabled={busy || !valid}>
              保存名字
            </button>
          </form>
        </TableDialog>
      )}
    </>
  );
}
