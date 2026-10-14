import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { guestLogin, issueToken, readAuthConfig, verifyToken, type AuthDeps } from '../server/auth';
import { FileStore } from '../server/store';

const now = 1_800_000_000_000;
function setup(extra: Partial<AuthDeps> = {}): AuthDeps {
  return {
    store: new FileStore(null),
    now: () => now,
    auth: readAuthConfig({ SESSION_SECRET: 's'.repeat(48) }),
    ...extra,
  };
}

describe('authenticated guest identity', () => {
  it('fails closed without strong server secrets', () => {
    expect(() => readAuthConfig({})).toThrow('SESSION_SECRET');
    expect(() => readAuthConfig({ SESSION_SECRET: 'short' })).toThrow();
    expect(() =>
      readAuthConfig({ SESSION_SECRET: 's'.repeat(48), IDENTITY_SECRET: 'short' }),
    ).toThrow();
  });

  it('derives stable, distinct, server-keyed identities and authenticates renewed sessions', async () => {
    const deps = setup();
    const first = await guestLogin('a'.repeat(48), deps);
    const second = await guestLogin('a'.repeat(48), deps);
    const other = await guestLogin('b'.repeat(48), deps);
    expect(first.userId).toBe(second.userId);
    expect(first.userId).not.toBe(other.userId);
    expect(first.userId).not.toContain('aaaa');
    expect(verifyToken(first.token, deps.auth, now).userId).toBe(first.userId);
    expect(() => verifyToken(`${first.token.slice(0, -3)}xyz`, deps.auth, now)).toThrow();
    expect(() => verifyToken(first.token, deps.auth, first.expiresAt)).toThrow();
  });

  it('rejects signed malformed claims, unsupported providers, wrong types, and excessive expiry', () => {
    const deps = setup();
    for (const claims of [
      null,
      {},
      { v: 1, userId: 'attacker', provider: 'guest', expiresAt: now + 1000 },
      { v: 1, userId: 'a'.repeat(43), provider: 'external', expiresAt: now + 1000 },
      { v: 1, userId: 'a'.repeat(43), provider: 'admin', expiresAt: now + 1000 },
    ]) {
      const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const signature = createHmac('sha256', deps.auth.sessionSecret)
        .update(`avalon:session:${body}`)
        .digest('base64url');
      expect(() => verifyToken(`${body}.${signature}`, deps.auth, now)).toThrow();
    }
    expect(() =>
      verifyToken(
        issueToken(
          { userId: 'a'.repeat(43), provider: 'guest', expiresAt: now + 400 * 86_400_000 },
          deps.auth,
        ),
        deps.auth,
        now,
      ),
    ).toThrow();
  });
});
