import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { GameError, type Session } from '../shared/types.js';
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
  provider: 'guest' | 'wechat';
  lastRoom: string | null;
  receipts: Receipt[];
  recentActions: { at: number; action: string }[];
  expiresAt: number;
}
export interface AuthConfig {
  sessionSecret: string;
  identitySecret: string;
  allowGuest: boolean;
  wechatAppId: string;
  wechatAppSecret: string;
  redirectUris: string[];
}
export interface AuthDeps {
  store: Store;
  auth: AuthConfig;
  now?: () => number;
  fetch?: typeof fetch;
}
export interface Claims {
  userId: string;
  provider: 'guest' | 'wechat';
  expiresAt: number;
}
const invalidAuth = () => new GameError('UNAUTHORIZED', '登录已失效，请重新进入游戏');
export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig {
  const sessionSecret = env.SESSION_SECRET ?? '';
  const identitySecret = env.IDENTITY_SECRET || sessionSecret;
  if (Buffer.byteLength(sessionSecret) < 32 || Buffer.byteLength(identitySecret) < 32) {
    throw new Error('SESSION_SECRET and IDENTITY_SECRET must contain at least 32 bytes');
  }
  const redirectUris = (env.WECHAT_REDIRECT_URIS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  for (const uri of redirectUris) {
    const url = new URL(uri);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('WECHAT_REDIRECT_URIS must contain exact HTTPS URLs without query/hash');
    }
  }
  return {
    sessionSecret,
    identitySecret,
    allowGuest: env.ALLOW_GUEST === 'true',
    wechatAppId: env.WECHAT_APP_ID ?? '',
    wechatAppSecret: env.WECHAT_APP_SECRET ?? '',
    redirectUris,
  };
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
    !['guest', 'wechat'].includes(String(claims.provider)) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    Number(claims.expiresAt) <= now ||
    Number(claims.expiresAt) > now + SESSION_TTL + DAY
  )
    throw invalidAuth();
  if (claims.provider === 'guest' && !auth.allowGuest) throw invalidAuth();
  return {
    userId: claims.userId,
    provider: claims.provider as Claims['provider'],
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
  if (!deps.auth.allowGuest) throw new GameError('FORBIDDEN', '此环境仅允许微信登录');
  if (typeof deviceSecret !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(deviceSecret)) {
    throw new GameError('INVALID', '设备凭据无效');
  }
  return login(identity(deps.auth, 'guest', deviceSecret), 'guest', deps);
}
interface OAuthState {
  verifierHash: string;
  expiresAt: number;
}
function validateVerifier(verifier: unknown): asserts verifier is string {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(verifier))
    throw new GameError('INVALID', '授权校验参数无效');
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function startWechat(redirectUri: unknown, verifier: unknown, deps: AuthDeps) {
  validateVerifier(verifier);
  if (!deps.auth.wechatAppId || !deps.auth.wechatAppSecret)
    throw new GameError('INVALID', '管理员尚未配置微信授权');
  if (typeof redirectUri !== 'string' || !deps.auth.redirectUris.includes(redirectUri))
    throw new GameError('FORBIDDEN', '微信回调地址不在允许列表');
  const state = randomBytes(32).toString('hex');
  const expiresAt = (deps.now ?? Date.now)() + 10 * 60_000;
  await deps.store.transaction((transaction) =>
    transaction.set('oauth', state, { verifierHash: hash(verifier), expiresAt }, expiresAt),
  );
  const params = new URLSearchParams({
    appid: deps.auth.wechatAppId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'snsapi_base',
    state,
  });
  return {
    url: `https://open.weixin.qq.com/connect/oauth2/authorize?${params.toString()}#wechat_redirect`,
    state,
  };
}
export async function finishWechat(
  code: unknown,
  state: unknown,
  verifier: unknown,
  deps: AuthDeps,
) {
  validateVerifier(verifier);
  if (
    typeof state !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state) ||
    typeof code !== 'string' ||
    !/^[A-Za-z0-9_-]{1,256}$/.test(code)
  )
    throw invalidAuth();
  if (!deps.auth.wechatAppId || !deps.auth.wechatAppSecret)
    throw new GameError('INVALID', '管理员尚未配置微信授权');
  const now = (deps.now ?? Date.now)();
  await deps.store.transaction(async (transaction) => {
    const record = await transaction.get<OAuthState>('oauth', state);
    if (!record || record.expiresAt <= now || record.verifierHash !== hash(verifier))
      throw invalidAuth();
    // Consume before external exchange: state/code can never be replayed, even in parallel.
    await transaction.delete('oauth', state);
  });
  const params = new URLSearchParams({
    appid: deps.auth.wechatAppId,
    secret: deps.auth.wechatAppSecret,
    code,
    grant_type: 'authorization_code',
  });
  let openId: unknown;
  try {
    const response = await (deps.fetch ?? fetch)(
      `https://api.weixin.qq.com/sns/oauth2/access_token?${params}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) throw invalidAuth();
    const result = (await response.json()) as { openid?: unknown; errcode?: unknown };
    if (result.errcode) throw invalidAuth();
    openId = result.openid;
  } catch {
    throw new GameError('UNAUTHORIZED', '微信授权未完成，请重新授权');
  }
  if (typeof openId !== 'string' || openId.length < 1 || openId.length > 128) throw invalidAuth();
  return login(identity(deps.auth, 'wechat', `${deps.auth.wechatAppId}:${openId}`), 'wechat', deps);
}
