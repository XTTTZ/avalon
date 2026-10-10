import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { RoomView } from '../shared/types';
import './tableAnimations.css';

const COLLECTION_MS = 450;
const DEAL_MS = 300;
const DEAL_STAGGER_MS = 100;

export interface CollectingBet {
  participantId: string;
  amount: number;
  key: string;
}

export interface TableAnimations {
  collecting: CollectingBet[];
  /** Keep the old seat order while chips from players who just busted are moving. */
  retainedParticipants: RoomView['participants'];
  /** Non-betting phases retain streetCommitted on the server; hide their static chips. */
  hideBets: boolean;
  dealFrom?: number;
  dealTo?: number;
  dealKey?: string;
  dealDelayMs: number;
}

interface AnimationState extends Omit<TableAnimations, 'hideBets'> {}

interface Snapshot {
  roomId: string;
  handId: string | null;
  street: NonNullable<RoomView['hand']>['street'] | null;
  phase: NonNullable<RoomView['hand']>['phase'] | null;
  board: string[];
  bets: Map<string, number>;
  participants: RoomView['participants'];
  eventIds: Set<string>;
  liveEventIds: Set<string>;
}

const emptyState = (): AnimationState => ({
  collecting: [],
  retainedParticipants: [],
  dealDelayMs: 0,
});

const isBoundary = (event: RoomView['events'][number]) =>
  event.type === 'STREET_READY' ||
  event.type === 'STREET_CONFIRMED' ||
  event.type === 'HAND_SETTLED';

function snapshot(room: RoomView): Snapshot {
  return {
    roomId: room.id,
    handId: room.hand?.id ?? null,
    street: room.hand?.street ?? null,
    phase: room.hand?.phase ?? null,
    board: [...(room.online?.communityCards ?? room.hand?.communityCards ?? [])],
    bets: new Map(
      room.hand?.players.map((player) => [player.participantId, player.streetCommitted]) ?? [],
    ),
    participants: room.participants
      .filter((player) => player.active && player.seat !== null)
      .map((player) => ({ ...player })),
    eventIds: new Set(room.events.map((event) => event.id)),
    liveEventIds: new Set(
      room.events.filter((event) => !event.revertedBy).map((event) => event.id),
    ),
  };
}

/**
 * Animation state is local and transient. The first snapshot is only a baseline,
 * so refreshing or returning to this screen never replays history.
 */
export function useTableAnimations(room: RoomView): TableAnimations {
  const previous = useRef<Snapshot | null>(null);
  const collectionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const collectionEndsAt = useRef(0);
  const [state, setState] = useState<AnimationState>(emptyState);

  useEffect(
    () => () => {
      clearTimeout(collectionTimer.current);
      clearTimeout(dealTimer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    const before = previous.current;
    const after = snapshot(room);
    previous.current = after;
    const reset = () => {
      clearTimeout(collectionTimer.current);
      clearTimeout(dealTimer.current);
      collectionEndsAt.current = 0;
      setState(emptyState());
    };

    if (!before) return;
    if (before.roomId !== after.roomId || before.handId !== after.handId || !after.handId) {
      reset();
      return;
    }

    const newEvents = room.events
      .filter((event) => !before.eventIds.has(event.id))
      .sort((left, right) => left.seq - right.seq);
    const undone =
      newEvents.some((event) => event.type === 'ACTION_UNDONE' || event.type === 'HAND_VOIDED') ||
      room.events.some((event) => event.revertedBy && before.liveEventIds.has(event.id));
    const boardReplaced = before.board.some((card, index) => after.board[index] !== card);
    if (undone || boardReplaced || after.phase === 'VOIDED') {
      reset();
      return;
    }

    const liveEvents = newEvents.filter((event) => !event.revertedBy);
    const boundary = liveEvents.find(isBoundary);
    if (!boundary) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      reset();
      return;
    }

    // An awaiting-confirmation snapshot has already collected this street.
    // Reconstruct only the first newly completed street visible to this client.
    if (before.phase === 'BETTING') {
      const bets = new Map(before.bets);
      for (const event of liveEvents) {
        if (isBoundary(event)) break;
        if (!event.participantId || event.street !== before.street || !event.amount) continue;
        if (event.type === 'PLAYER_ACTED' || event.type === 'BLIND_POSTED') {
          bets.set(event.participantId, (bets.get(event.participantId) ?? 0) + event.amount);
        } else if (event.type === 'UNCALLED_RETURNED') {
          bets.set(
            event.participantId,
            Math.max(0, (bets.get(event.participantId) ?? 0) - event.amount),
          );
        }
      }
      const collecting = [...bets]
        .filter(([, amount]) => amount > 0)
        .map(([participantId, amount]) => ({
          participantId,
          amount,
          key: `${after.handId}-${boundary.id}-${participantId}`,
        }));
      if (collecting.length > 0) {
        clearTimeout(collectionTimer.current);
        collectionEndsAt.current = Date.now() + COLLECTION_MS;
        setState((current) => ({
          ...current,
          collecting,
          retainedParticipants: before.participants,
        }));
        collectionTimer.current = setTimeout(() => {
          collectionEndsAt.current = 0;
          setState((current) => ({ ...current, collecting: [], retainedParticipants: [] }));
        }, COLLECTION_MS);
      }
    }

    if (after.board.length > before.board.length) {
      clearTimeout(dealTimer.current);
      const dealFrom = before.board.length;
      const dealDelayMs = Math.max(0, collectionEndsAt.current - Date.now());
      const dealKey = `${after.handId}-${liveEvents.filter(isBoundary).at(-1)!.id}`;
      setState((current) => ({
        ...current,
        dealFrom,
        dealTo: after.board.length,
        dealKey,
        dealDelayMs,
      }));
      dealTimer.current = setTimeout(
        () => {
          setState((current) => ({
            ...current,
            dealFrom: undefined,
            dealTo: undefined,
            dealKey: undefined,
            dealDelayMs: 0,
          }));
        },
        dealDelayMs + (after.board.length - dealFrom - 1) * DEAL_STAGGER_MS + DEAL_MS,
      );
    }
  }, [room]);

  return { ...state, hideBets: room.hand?.phase !== 'BETTING' };
}

/** Render inside the same .seat-node as the ordinary SeatBet. */
export function CollectingChips({ bet }: { bet: CollectingBet }) {
  return (
    <div className="seat-bet table-collecting-chip" aria-hidden="true">
      <strong>{String(bet.amount)}</strong>
    </div>
  );
}

/** Wrap each public card (including placeholders) without changing its size. */
export function CommunityCardMotion({
  index,
  animation,
  children,
}: {
  index: number;
  animation?: Pick<TableAnimations, 'dealFrom' | 'dealTo' | 'dealKey' | 'dealDelayMs'>;
  children: ReactNode;
}) {
  const dealing =
    animation?.dealFrom !== undefined &&
    index >= animation.dealFrom &&
    index < (animation.dealTo ?? 0);
  return (
    <span
      className={`community-card-motion${dealing ? ' dealing' : ''}`}
      key={dealing ? animation.dealKey : 'still'}
      style={
        dealing
          ? {
              animationDelay: `${animation.dealDelayMs + (index - animation.dealFrom!) * DEAL_STAGGER_MS}ms`,
            }
          : undefined
      }
    >
      {children}
    </span>
  );
}
