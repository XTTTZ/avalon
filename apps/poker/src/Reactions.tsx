import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReactionKind, RoomReaction, RoomView } from '../shared/types';
import type { usePoker } from './api/client';

const reactionFaces: Record<ReactionKind, { emoji: string; label: string }> = {
  smile: { emoji: '😊', label: '微笑' },
  laugh: { emoji: '😂', label: '大笑' },
  wow: { emoji: '😮', label: '惊讶' },
  cry: { emoji: '😭', label: '哭哭' },
  egg: { emoji: '🥚', label: '鸡蛋' },
  rose: { emoji: '🌹', label: '玫瑰' },
};
const selfReactions = ['smile', 'laugh', 'wow', 'cry'] as const;
const throwReactions = ['egg', 'rose'] as const;
const ANIMATION_MS = 2400;

interface ControlsProps {
  room: RoomView;
  busy: boolean;
  command: ReturnType<typeof usePoker>['command'];
}

/** The choices open upwards, leaving the compact table controls unchanged. */
export function EmojiPicker({ room, busy, command }: ControlsProps) {
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="emoji-picker" ref={picker}>
      <button
        className={`secondary emoji-toggle ${open ? 'selected' : ''}`}
        type="button"
        aria-label="发送表情"
        aria-expanded={open}
        disabled={busy || !room.me.participantId}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">😊</span>
      </button>
      {open && (
        <div className="emoji-options" role="group" aria-label="选择表情">
          {selfReactions.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-label={reactionFaces[kind].label}
              disabled={busy}
              onClick={() => {
                setOpen(false);
                void command({ type: 'react', kind });
              }}
            >
              <span aria-hidden="true">{reactionFaces[kind].emoji}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ThrowControls({
  room,
  busy,
  command,
  targetId,
  onSent,
}: ControlsProps & { targetId: string; onSent?: () => void }) {
  if (!room.me.participantId || room.me.participantId === targetId) return null;
  return (
    <div className="throw-controls" role="group" aria-label="向这位玩家发送">
      {throwReactions.map((kind) => (
        <button
          className="secondary"
          type="button"
          key={kind}
          disabled={busy}
          onClick={() => {
            void command({ type: 'react', kind, targetId });
            onSent?.();
          }}
        >
          <span aria-hidden="true">{reactionFaces[kind].emoji}</span>
          {kind === 'egg' ? '扔鸡蛋' : '送玫瑰'}
        </button>
      ))}
    </div>
  );
}

interface Point {
  x: number;
  y: number;
}

interface PlayingReaction {
  reaction: RoomReaction;
  source: Point | null;
  target: Point | null;
  description: string;
}

function playerPoint(surface: HTMLElement, participantId: string): Point | null {
  const seat = [...surface.querySelectorAll<HTMLElement>('[data-player-id]')].find(
    (node) => node.dataset.playerId === participantId,
  );
  if (!seat) return null;
  const avatar = seat.querySelector<HTMLElement>('.player-card, .list-player-row') ?? seat;
  const bounds = avatar.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return null;
  const parent = surface.getBoundingClientRect();
  return {
    x: bounds.left + bounds.width / 2 - parent.left + surface.scrollLeft,
    y: bounds.top + bounds.height / 2 - parent.top + surface.scrollTop,
  };
}

/** A fresh room snapshot establishes a baseline; reconnects never replay old reactions. */
export function ReactionLayer({ room }: { room: RoomView }) {
  const layer = useRef<HTMLDivElement>(null);
  const previousRoom = useRef<string | null>(null);
  const seen = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [playing, setPlaying] = useState<PlayingReaction[]>([]);

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    },
    [],
  );

  useLayoutEffect(() => {
    const reactions = room.reactions ?? [];
    if (previousRoom.current !== room.id) {
      previousRoom.current = room.id;
      seen.current = new Set(reactions.map((reaction) => reaction.id));
      timers.current.forEach(clearTimeout);
      timers.current.clear();
      setPlaying([]);
      return;
    }
    const fresh = reactions.filter((reaction) => !seen.current.has(reaction.id));
    if (!fresh.length) return;
    fresh.forEach((reaction) => seen.current.add(reaction.id));
    // Bound this local deduplication cache during long-running cash sessions.
    while (seen.current.size > 256) {
      const first = seen.current.values().next().value;
      if (first === undefined) break;
      seen.current.delete(first);
    }
    const surface = layer.current?.closest<HTMLElement>('.poker-reaction-surface');
    if (!surface) return;
    const nowPlaying = fresh.map((reaction): PlayingReaction => {
      const sender = room.participants.find((player) => player.id === reaction.senderId);
      const target = room.participants.find((player) => player.id === reaction.targetId);
      const face = reactionFaces[reaction.kind];
      return {
        reaction,
        source: playerPoint(surface, reaction.senderId),
        target: reaction.targetId ? playerPoint(surface, reaction.targetId) : null,
        description: reaction.targetId
          ? `${sender?.name ?? '玩家'} ${reaction.kind === 'egg' ? '向' : '送给'} ${target?.name ?? '玩家'} ${face.emoji}`
          : `${sender?.name ?? '玩家'} ${face.emoji}`,
      };
    });
    setPlaying((current) => [...current, ...nowPlaying].slice(-12));
    nowPlaying.forEach(({ reaction }) => {
      const timer = setTimeout(() => {
        setPlaying((current) => current.filter((entry) => entry.reaction.id !== reaction.id));
        timers.current.delete(reaction.id);
      }, ANIMATION_MS);
      timers.current.set(reaction.id, timer);
    });
  }, [room.id, room.reactions, room.participants]);

  return (
    <div className="reaction-layer" ref={layer} aria-live="polite" aria-atomic="false">
      {playing.map(({ reaction, source, target, description }) => {
        const thrown = reaction.kind === 'egg' || reaction.kind === 'rose';
        const fallback = !source || (thrown && !target);
        if (fallback) {
          return (
            <span className="reaction-toast" key={reaction.id}>
              {description}
            </span>
          );
        }
        const style = {
          '--reaction-from-x': `${source.x}px`,
          '--reaction-from-y': `${source.y}px`,
          '--reaction-to-x': `${target?.x ?? source.x}px`,
          '--reaction-to-y': `${target?.y ?? source.y}px`,
          '--reaction-mid-x': `${(source.x + (target?.x ?? source.x)) / 2}px`,
          '--reaction-mid-y': `${Math.min(source.y, target?.y ?? source.y) - 46}px`,
        } as CSSProperties;
        return (
          <span
            key={reaction.id}
            className={`table-reaction ${thrown ? 'reaction-throw' : 'reaction-self'} reaction-${reaction.kind}`}
            style={style}
            role="img"
            aria-label={description}
          >
            <span className="reaction-projectile" aria-hidden="true">
              {reactionFaces[reaction.kind].emoji}
            </span>
            {thrown && (
              <span className="reaction-impact" aria-hidden="true">
                {reaction.kind === 'rose' ? '🌹' : ''}
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}
