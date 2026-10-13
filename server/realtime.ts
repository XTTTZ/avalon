import { createHmac, timingSafeEqual } from 'node:crypto';
import { GameError, type RealtimeNotice, type RealtimeTicket } from '../shared/types.js';

const TICKET_TTL = 30_000;

export interface RealtimeTicketClaims {
  userId: string;
  sessionExpiresAt: number;
  roomInstanceId: string;
  gameId: string;
  version: number;
}

export interface VerifiedRealtimeTicket {
  userId: string;
  roomInstanceId: string;
  gameId: string;
  version: number;
  expiresAt: number;
  sessionExpiresAt: number;
}

function signature(secret: string, body: string) {
  return createHmac('sha256', secret).update(`avalon:realtime:${body}`).digest('base64url');
}

function validIdentifier(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9:_-]+$/.test(value)
  );
}

const invalidTicket = () => new GameError('UNAUTHORIZED', '实时连接已失效，请重新连接');

export function issueRealtimeTicket(
  claims: RealtimeTicketClaims,
  secret: string,
  now = Date.now(),
): RealtimeTicket {
  const expiresAt = Math.min(now + TICKET_TTL, claims.sessionExpiresAt);
  const body = Buffer.from(
    JSON.stringify({
      v: 1,
      userId: claims.userId,
      roomInstanceId: claims.roomInstanceId,
      gameId: claims.gameId,
      version: claims.version,
      expiresAt,
      sessionExpiresAt: claims.sessionExpiresAt,
    }),
  ).toString('base64url');
  const notice: RealtimeNotice = {
    type: 'room-version',
    roomInstanceId: claims.roomInstanceId,
    gameId: claims.gameId,
    version: claims.version,
  };
  return {
    ticket: `${body}.${signature(secret, body)}`,
    roomInstanceId: claims.roomInstanceId,
    expiresAt,
    notice,
  };
}

export function verifyRealtimeTicket(
  ticket: unknown,
  secret: string,
  now = Date.now(),
): VerifiedRealtimeTicket {
  if (typeof ticket !== 'string' || ticket.length > 2048) throw invalidTicket();
  const parts = ticket.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
    throw invalidTicket();
  const expected = Buffer.from(signature(secret, parts[0]));
  const received = Buffer.from(parts[1]);
  if (received.length !== expected.length || !timingSafeEqual(received, expected))
    throw invalidTicket();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw invalidTicket();
  }
  if (
    payload.v !== 1 ||
    !validIdentifier(payload.userId, 100) ||
    !validIdentifier(payload.roomInstanceId, 160) ||
    !validIdentifier(payload.gameId, 100) ||
    !Number.isSafeInteger(payload.version) ||
    Number(payload.version) < 1 ||
    !Number.isSafeInteger(payload.expiresAt) ||
    Number(payload.expiresAt) <= now ||
    Number(payload.expiresAt) > now + TICKET_TTL + 1_000 ||
    !Number.isSafeInteger(payload.sessionExpiresAt) ||
    Number(payload.sessionExpiresAt) < Number(payload.expiresAt) ||
    Number(payload.sessionExpiresAt) > now + 181 * 86_400_000
  )
    throw invalidTicket();
  return {
    userId: payload.userId,
    roomInstanceId: payload.roomInstanceId,
    gameId: payload.gameId,
    version: Number(payload.version),
    expiresAt: Number(payload.expiresAt),
    sessionExpiresAt: Number(payload.sessionExpiresAt),
  };
}
