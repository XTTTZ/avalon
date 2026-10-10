export type Variant = 'standard' | 'short-deck';
export type GameMode = 'chips' | 'online';
export type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN';
export type HandPhase =
  'BETTING' | 'AWAITING_STREET_CONFIRMATION' | 'SHOWDOWN' | 'SETTLED' | 'VOIDED';
export type PlayerAction = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'all-in';

export interface BlindLevel {
  smallBlind: number;
  bigBlind: number;
}

export interface GameConfig {
  mode?: GameMode;
  variant: Variant;
  initialStack: number;
  chipUnit: number;
  blindLevels: BlindLevel[];
  blindUpgrade: 'manual' | 'hands';
  handsPerLevel: number;
  defaultRefill: number;
}

export interface RoomMember {
  id: string;
  userId: string;
  name: string;
  joinedAt: number;
  lastActiveAt?: number;
  participantId?: string;
  removedAt?: number;
  isBot?: boolean;
}

export interface Participant {
  id: string;
  memberId: string;
  name: string;
  seat: number | null;
  stack: number;
  initialChips: number;
  refillCount: number;
  refillTotal: number;
  rebuyCount: number;
  rebuyTotal: number;
  externalAdjustment: number;
  handsPlayed: number;
  potsWon: number;
  largestPotShare: number;
  active: boolean;
  isBot?: boolean;
}

export interface HandPlayer {
  participantId: string;
  seat: number;
  streetCommitted: number;
  handCommitted: number;
  folded: boolean;
  allIn: boolean;
  hasActed: boolean;
  reopenAtBet: number | null;
}

export interface Pot {
  id: string;
  amount: number;
  contributorIds: string[];
  eligibleIds: string[];
  cap: number;
}

export interface SettlementChoice {
  potId: string;
  runs?: { winnerIds: string[] }[];
  winnerIds?: string[];
}

export interface ShowdownHand {
  participantId: string;
  cards: string[];
  label: string;
}

export interface HandState {
  id: string;
  number: number;
  phase: HandPhase;
  street: Street;
  players: HandPlayer[];
  buttonId: string;
  previousButtonId: string | null;
  smallBlindId: string;
  bigBlindId: string;
  actorId: string | null;
  needsAction: string[];
  currentBet: number;
  lastFullRaiseSize: number;
  smallBlind: number;
  bigBlind: number;
  pots: Pot[];
  uncalled: { participantId: string; amount: number } | null;
  settlementDraft: SettlementChoice[];
  communityCards?: string[];
  showdownHands?: ShowdownHand[];
  startedAt: number;
  settledAt?: number;
  revision: number;
}

export type EventType =
  | 'ROOM_CREATED'
  | 'MEMBER_JOINED'
  | 'MEMBER_REMOVED'
  | 'OWNER_CHANGED'
  | 'SEATS_CHANGED'
  | 'DEALER_CHANGED'
  | 'BLIND_LEVEL_CHANGED'
  | 'RULES_CHANGED'
  | 'SESSION_PAUSED'
  | 'SESSION_RESUMED'
  | 'HAND_STARTED'
  | 'BLIND_POSTED'
  | 'PLAYER_ACTED'
  | 'UNCALLED_RETURNED'
  | 'STREET_READY'
  | 'STREET_CONFIRMED'
  | 'HAND_SETTLED'
  | 'HAND_VOIDED'
  | 'CHIPS_ADDED'
  | 'CHIPS_ADJUSTED'
  | 'ACTION_UNDONE';

export interface PokerEvent {
  id: string;
  seq: number;
  type: EventType;
  at: number;
  actorMemberId: string;
  participantId?: string;
  amount?: number;
  action?: PlayerAction;
  street?: Street;
  detail: string;
  revertedBy?: string;
}

export interface LedgerEntry {
  id: string;
  eventId: string;
  participantId: string;
  type: 'INITIAL' | 'WAGER' | 'REFUND' | 'PAYOUT' | 'REFILL' | 'REBUY' | 'ADJUSTMENT';
  amount: number;
  at: number;
  handId?: string;
}

export interface UndoSnapshot {
  eventId: string;
  eventLength?: number;
  members?: RoomMember[];
  participants: Participant[];
  hand: HandState | null;
  ownerMemberId?: string;
  dealerMemberId?: string | null;
  paused?: boolean;
  config?: GameConfig;
  lastButtonId: string | null;
  completedHands: number;
  blindLevel: number;
  nextBlinds?: BlindLevel | null;
  ledgerLength: number;
}

export interface RoomState {
  id: string;
  code: string;
  version: number;
  phaseKey: string;
  createdAt: number;
  updatedAt: number;
  lastActiveAt?: number;
  expiresAt: number;
  ownerMemberId: string;
  dealerMemberId: string | null;
  paused: boolean;
  config: GameConfig;
  blindLevel: number;
  nextBlinds?: BlindLevel | null;
  completedHands: number;
  lastButtonId: string | null;
  members: RoomMember[];
  participants: Participant[];
  hand: HandState | null;
  events: PokerEvent[];
  ledger: LedgerEntry[];
  undo: UndoSnapshot[];
}

export interface LegalActions {
  participantId: string;
  actions: PlayerAction[];
  callNeeded: number;
  callPayable: number;
  minBetTo: number | null;
  minRaiseTo: number | null;
  maxTo: number;
  shortcuts: { label: string; action: 'bet' | 'raise' | 'all-in'; to: number }[];
}

export type PublicRoomMember = Omit<RoomMember, 'userId' | 'removedAt' | 'lastActiveAt'>;

export interface RoomView extends Omit<RoomState, 'undo' | 'ledger' | 'members'> {
  members: PublicRoomMember[];
  me: {
    memberId: string;
    participantId: string | null;
    isOwner: boolean;
    isDealer: boolean;
  };
  legalActions: LegalActions | null;
  online?: {
    holeCards: string[];
    communityCards: string[];
  };
}

export type PokerCommand =
  | { type: 'start-hand'; buttonId?: string }
  | { type: 'act'; action: PlayerAction; to?: number }
  | { type: 'confirm-street' }
  | { type: 'settle'; pots: SettlementChoice[] }
  | { type: 'save-settlement'; pots: SettlementChoice[] }
  | { type: 'undo' }
  | { type: 'void-hand'; reason: string }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'assign-dealer'; memberId: string | null }
  | { type: 'transfer-owner'; memberId: string }
  | { type: 'remove-member'; memberId: string }
  | { type: 'add-bot' }
  | { type: 'remove-bot'; participantId: string }
  | { type: 'seat-member'; memberId: string }
  | { type: 'reorder'; participantIds: string[] }
  | { type: 'change-seat'; participantId: string; seat: number }
  | { type: 'move-seat'; participantId: string; direction: 'left' | 'right' }
  | { type: 'set-participant-active'; participantId: string; active: boolean }
  | { type: 'set-blind-level'; level: number }
  | { type: 'set-next-blinds'; smallBlind: number; bigBlind: number }
  | { type: 'refill'; participantId: string; amount: number }
  | { type: 'adjust-chips'; participantId: string; amount: number; reason: string }
  | { type: 'configure'; config: GameConfig };

export type ApiRequest =
  | { action: 'auth.guest'; deviceSecret: string }
  | { action: 'session' }
  | { action: 'create'; name: string; config: GameConfig; requestId: string }
  | { action: 'join'; code: string; name: string; as: 'player' | 'spectator'; requestId: string }
  | { action: 'get'; code: string; version?: number }
  | { action: 'heartbeat'; code: string; version?: number }
  | {
      action: 'command';
      code: string;
      command: PokerCommand;
      expectedVersion: number;
      phaseKey: string;
      requestId: string;
    };

export type ApiErrorCode =
  'INVALID' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMIT' | 'INTERNAL';

export class PokerError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  token: string;
  userId: string;
  expiresAt: number;
  lastRoom: string | null;
}

export const DEFAULT_CONFIG: GameConfig = {
  mode: 'chips',
  variant: 'standard',
  initialStack: 2000,
  chipUnit: 1,
  blindLevels: [
    { smallBlind: 10, bigBlind: 20 },
    { smallBlind: 20, bigBlind: 40 },
    { smallBlind: 30, bigBlind: 60 },
    { smallBlind: 50, bigBlind: 100 },
  ],
  blindUpgrade: 'manual',
  handsPerLevel: 10,
  defaultRefill: 2000,
};
