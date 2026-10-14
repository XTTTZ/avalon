import { createHmac, timingSafeEqual } from 'node:crypto';
import { GameError, type RealtimeNotice, type Session } from '../shared/types.js';
import type { Store, Transaction } from './store.js';

export const DAY = 86_400_000;
const SESSION_TTL = 180 * DAY;
export const USER_TTL = 365 * DAY;
export interface Receipt {
  id: string;
  digest: string;
  code: string;
  at: number;
  left?: boolean;
}
export interface UserRecord {
  userId: string;
  provider: 'guest';
  lastRoom: string | null;
  receipts: Receipt[];
  recentActions: { at: number; action: string }[];
  expiresAt: number;
}
export interface AuthConfig {
  sessionSecret: string;
  identitySecret: string;
}
export interface AuthDeps {
  store: Store;
  auth: AuthConfig;
  now?: () => number;
  /** Best-effort public version notification, invoked only after a committed room write. */
  onRoomChange?: (notice: RealtimeNotice) => void;
}
export interface Claims {
  userId: string;
  provider: 'guest';
  expiresAt: number;
}
const invalidAuth = () => new GameError('UNAUTHORIZED', '登录已失效，请重新进入游戏');
export function readAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const sessionSecret = env.SESSION_SECRET ?? '';
  const identitySecret = env.IDENTITY_SECRET || sessionSecret;
  if (Buffer.byteLength(sessionSecret) < 32 || Buffer.byteLength(identitySecret) < 32) {
    throw new Error('SESSION_SECRET and IDENTITY_SECRET must contain at least 32 bytes');
  }
  return { sessionSecret, identitySecret };
}
function mac(secret: string, value: string) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}
export function identity(auth: AuthConfig, provider: Claims['provider'], externalId: string) {
  return mac(auth.identitySecret, `avalon:identity:${provider}:${externalId}`);
}
export function issueToken(claims: Claims, auth: AuthConfig) {
  const body = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString('base64url');
  return `${body}.${mac(auth.sessionSecret, `avalon:session:${body}`)}`;
}
export function verifyToken(token: unknown, auth: AuthConfig, now: number): Claims {
  if (typeof token !== 'string' || token.length > 1024) throw invalidAuth();
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)))
    throw invalidAuth();
  const expected = Buffer.from(mac(auth.sessionSecret, `avalon:session:${parts[0]}`));
  const signature = Buffer.from(parts[1]);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    throw invalidAuth();
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
  } catch {
    throw invalidAuth();
  }
  if (
    !claims ||
    claims.v !== 1 ||
    typeof claims.userId !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(claims.userId) ||
    claims.provider !== 'guest' ||
    !Number.isSafeInteger(claims.expiresAt) ||
    Number(claims.expiresAt) <= now ||
    Number(claims.expiresAt) > now + SESSION_TTL + DAY
  )
    throw invalidAuth();
  return {
    userId: claims.userId,
    provider: 'guest',
    expiresAt: Number(claims.expiresAt),
  };
}
export function newUser(userId: string, provider: Claims['provider'], now: number): UserRecord {
  return {
    userId,
    provider,
    lastRoom: null,
    receipts: [],
    recentActions: [],
    expiresAt: now + USER_TTL,
  };
}
export async function ensureUser(
  transaction: Transaction,
  userId: string,
  provider: Claims['provider'],
  now: number,
) {
  let user = await transaction.get<UserRecord>('users', userId);
  if (!user) user = newUser(userId, provider, now);
  else if (user.provider !== provider) throw invalidAuth();
  if (user.expiresAt < now + 90 * DAY) user.expiresAt = now + USER_TTL;
  return user;
}
export function sessionFor(user: UserRecord, auth: AuthConfig, now: number): Session {
  const claims = { userId: user.userId, provider: user.provider, expiresAt: now + SESSION_TTL };
  return { ...claims, token: issueToken(claims, auth), lastRoom: user.lastRoom };
}
async function login(userId: string, provider: Claims['provider'], deps: AuthDeps) {
  const now = (deps.now ?? Date.now)();
  return deps.store.transaction(async (transaction) => {
    const user = await ensureUser(transaction, userId, provider, now);
    await transaction.set('users', userId, user, user.expiresAt);
    return sessionFor(user, deps.auth, now);
  });
}
export async function guestLogin(deviceSecret: unknown, deps: AuthDeps) {
  if (typeof deviceSecret !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(deviceSecret)) {
    throw new GameError('INVALID', '设备凭据无效');
  }
  return login(identity(deps.auth, 'guest', deviceSecret), 'guest', deps);
}
