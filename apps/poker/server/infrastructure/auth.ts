import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PokerError, type Session } from '../../shared/types.js';
import type { Store, Transaction } from './store.js';

const DAY = 86_400_000;
const SESSION_TTL = 180 * DAY;
export const USER_TTL = 30 * DAY;

export interface Receipt {
  id: string;
  digest: string;
  code: string;
}

export interface UserRecord {
  userId: string;
  lastRoom: string | null;
  receipts: Receipt[];
  recentActions?: { at: number; action: string }[];
  expiresAt: number;
}

export interface AuthConfig {
  sessionSecret: string;
  identitySecret: string;
  allowGuest: boolean;
}

export interface AuthDeps {
  store: Store;
  auth: AuthConfig;
  now?: () => number;
}

interface Claims {
  aud: 'poker';
  userId: string;
  expiresAt: number;
}

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const sessionSecret = env.POKER_SESSION_SECRET ?? '';
  const identitySecret = env.POKER_IDENTITY_SECRET ?? '';
  if (Buffer.byteLength(sessionSecret) < 32 || Buffer.byteLength(identitySecret) < 32)
    throw new Error('Poker session and identity secrets must contain at least 32 bytes');
  return { sessionSecret, identitySecret, allowGuest: env.ALLOW_GUEST === 'true' };
}

const mac = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value).digest('base64url');

function issue(claims: Claims, config: AuthConfig) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${mac(config.sessionSecret, payload)}`;
}

export function verifyToken(token: string | undefined, config: AuthConfig, now = Date.now()) {
  if (!token) throw new PokerError('UNAUTHORIZED', '请先登录');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new PokerError('UNAUTHORIZED', '登录已失效');
  const expected = Buffer.from(mac(config.sessionSecret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new PokerError('UNAUTHORIZED', '登录已失效');
  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims;
  } catch {
    throw new PokerError('UNAUTHORIZED', '登录已失效');
  }
  if (claims.aud !== 'poker' || !claims.userId || claims.expiresAt <= now)
    throw new PokerError('UNAUTHORIZED', '登录已过期');
  return claims;
}

export async function ensureUser(
  transaction: Pick<Transaction, 'get' | 'set'>,
  userId: string,
  now: number,
) {
  const existing = await transaction.get<UserRecord>('users', userId);
  const user: UserRecord =
    existing && existing.expiresAt > now
      ? existing
      : {
          userId,
          lastRoom: null,
          receipts: [],
          recentActions: [],
          expiresAt: now + USER_TTL,
        };
  user.receipts ??= [];
  user.recentActions ??= [];
  user.expiresAt = now + USER_TTL;
  await transaction.set('users', userId, user, user.expiresAt);
  return user;
}

export async function guestLogin(deviceSecret: unknown, deps: AuthDeps): Promise<Session> {
  if (!deps.auth.allowGuest) throw new PokerError('FORBIDDEN', '当前未开放访客登录');
  if (typeof deviceSecret !== 'string' || !/^[a-f0-9]{64}$/.test(deviceSecret))
    throw new PokerError('INVALID', '设备身份无效');
  const now = (deps.now ?? Date.now)();
  const userId = createHash('sha256')
    .update(createHmac('sha256', deps.auth.identitySecret).update(`poker:${deviceSecret}`).digest())
    .digest('base64url');
  const user = await deps.store.transaction((transaction) => ensureUser(transaction, userId, now));
  const expiresAt = now + SESSION_TTL;
  return {
    token: issue({ aud: 'poker', userId, expiresAt }, deps.auth),
    userId,
    expiresAt,
    lastRoom: user.lastRoom,
  };
}

export async function renewSession(token: string | undefined, deps: AuthDeps): Promise<Session> {
  const now = (deps.now ?? Date.now)();
  const claims = verifyToken(token, deps.auth, now);
  const user = await deps.store.transaction((transaction) =>
    ensureUser(transaction, claims.userId, now),
  );
  const expiresAt = now + SESSION_TTL;
  return {
    token: issue({ aud: 'poker', userId: claims.userId, expiresAt }, deps.auth),
    userId: claims.userId,
    expiresAt,
    lastRoom: user.lastRoom,
  };
}
