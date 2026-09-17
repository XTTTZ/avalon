/** The only server-to-browser game contract. Never import server state in the UI. */
export type Alignment = 'good' | 'evil';
export type LeaderMode = 'rotation' | 'manual';
export type Role =
  | 'merlin'
  | 'percival'
  | 'assassin'
  | 'morgana'
  | 'mordred'
  | 'oberon'
  | 'loyalist'
  | 'minion'
  | 'lancelot_good'
  | 'lancelot_evil';
export type Phase =
  'lobby' | 'reveal' | 'team' | 'teamVote' | 'questVote' | 'lady' | 'assassination' | 'finished';
export interface QuestRule {
  size: number;
  failsRequired: number;
}
export interface GameConfig {
  preset: 'standard' | 'custom';
  playerCount: number;
  evilCount: number;
  roles: Role[];
  quests: QuestRule[];
  winsRequired: number;
  rejectionLimit: number;
  lady: boolean;
  lancelot: 'off' | 'fixed' | 'changing';
}
export interface PublicPlayer {
  id: string;
  name: string;
  seat: number;
}
export interface QuestResult {
  round: number;
  team: string[];
  fails: number;
  successes: number;
  passed: boolean;
}
export interface TeamVoteResult {
  round: number;
  attempt: number;
  leaderId: string;
  team: string[];
  votes: Record<string, boolean>;
  approved: boolean;
}
export interface PublicEvent {
  id: number;
  text: string;
  at: number;
}
export interface PublicRoom {
  code: string;
  version: number;
  gameId: string;
  phaseKey: string;
  phase: Phase;
  hostId: string;
  players: PublicPlayer[];
  config: GameConfig;
  leaderId: string | null;
  leaderMode: LeaderMode;
  nextLeaderId: string | null;
  round: number;
  rejectionCount: number;
  proposedTeam: string[];
  readyIds: string[];
  teamVotedIds: string[];
  questSubmittedCount: number;
  quests: QuestResult[];
  teamVotes: TeamVoteResult[];
  ladyHolderId: string | null;
  ladyHistory: string[];
  lancelotChanges: { round: number; changed: boolean }[];
  winner: Alignment | null;
  finishReason: string | null;
  assassinationTargetId: string | null;
  revealedRoles: { playerId: string; role: Role; alignment: Alignment }[];
  events: PublicEvent[];
  createdAt: number;
  expiresAt: number;
}
export interface KnownPlayer {
  playerId: string;
  kind: 'evil' | 'ally' | 'merlin_candidate' | 'lancelot';
  label: string;
}
export interface PrivateSelf {
  playerId: string;
  role: Role | null;
  alignment: Alignment | null;
  knownPlayers: KnownPlayer[];
  roleText: string;
  teamVote: boolean | null;
  questSubmitted: boolean;
  ladyResults: { round: number; targetId: string; alignment: Alignment }[];
  canAssassinate: boolean;
}
export interface RoomView {
  room: PublicRoom;
  self: PrivateSelf;
}
export interface PlayerNote {
  nickname: string;
  roleGuess: Role | '';
  alignmentGuess: Alignment | 'unknown';
  text: string;
}
export type Notes = Record<string, PlayerNote>;
export type GameCommand =
  | { type: 'configure'; config: GameConfig }
  | { type: 'reorder'; playerIds: string[]; mode?: LeaderMode }
  | { type: 'shuffleSeats'; mode?: LeaderMode }
  | { type: 'assignLeader'; targetId: string | null; timing: 'current' | 'next' }
  | { type: 'rename'; name: string }
  | { type: 'start' }
  | { type: 'ready' }
  | { type: 'propose'; team: string[] }
  | { type: 'teamVote'; approve: boolean }
  | { type: 'questVote'; success: boolean }
  | { type: 'lady'; targetId: string }
  | { type: 'assassinate'; targetId: string }
  | { type: 'transferHost'; targetId: string }
  | { type: 'kick'; targetId: string }
  | { type: 'leave' }
  | { type: 'abort' }
  | { type: 'rematch' };
export interface Session {
  token: string;
  userId: string;
  lastRoom: string | null;
  expiresAt: number;
  provider: 'guest' | 'wechat';
}
export type ApiRequest =
  | { action: 'auth.guest'; deviceSecret: string }
  | { action: 'auth.wechat.start'; redirectUri: string; verifier: string }
  | { action: 'auth.wechat.finish'; code: string; state: string; verifier: string }
  | { action: 'session' }
  | { action: 'create'; name: string; config: GameConfig; requestId: string }
  | { action: 'join'; code: string; name: string; requestId: string }
  | { action: 'get'; code: string; version?: number }
  | {
      action: 'command';
      code: string;
      command: GameCommand;
      expectedVersion: number;
      phaseKey: string;
      requestId: string;
    }
  | { action: 'notes.get'; code: string }
  | { action: 'notes.save'; code: string; notes: Notes; expectedRevision: number };
export interface NotesResult {
  notes: Notes;
  revision: number;
}
export type ApiErrorCode =
  | 'INVALID'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMIT'
  | 'EXPIRED'
  | 'INTERNAL';
export class GameError extends Error {
  constructor(
    public code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}
