import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { FileStore } from '../server/store';
import {
  finishWechat,
  guestLogin,
  issueToken,
  readAuthConfig,
  startWechat,
  verifyToken,
  type AuthDeps,
} from '../server/auth';

const now = 1_800_000_000_000;
function setup(extra: Partial<AuthDeps> = {}): AuthDeps {
  return {
    store: new FileStore(null),
    now: () => now,
    auth: readAuthConfig({
      SESSION_SECRET: 's'.repeat(48),
      ALLOW_GUEST: 'true',
      WECHAT_APP_ID: 'wx-test',
      WECHAT_APP_SECRET: 'app-secret',
      WECHAT_REDIRECT_URIS: 'https://avalon.example.com/',
    }),
    ...extra,
  };
}
describe('authenticated identity and OAuth', () => {
  it('fails closed without a strong server secret and does not enable guests implicitly', async () => {
    expect(() => readAuthConfig({})).toThrow('SESSION_SECRET');
    expect(() => readAuthConfig({ SESSION_SECRET: 'short' })).toThrow();
    const deps = setup();
    deps.auth.allowGuest = false;
    await expect(guestLogin('a'.repeat(48), deps)).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
    expect(() => verifyToken(first.token, { ...deps.auth, allowGuest: false }, now)).toThrow();
  });
  it('rejects signed malformed claims, null JSON, wrong types, and arbitrary users', () => {
    const deps = setup();
    for (const claims of [
      null,
      {},
      { v: 1, userId: 'attacker', provider: 'wechat', expiresAt: now + 1000 },
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
          { userId: 'a'.repeat(43), provider: 'wechat', expiresAt: now + 400 * 86_400_000 },
          deps.auth,
        ),
        deps.auth,
        now,
      ),
    ).toThrow();
  });
  it('requires exact allowlisted redirect and browser verifier', async () => {
    const deps = setup();
    await expect(startWechat('https://evil.example/', 'a'.repeat(48), deps)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      startWechat('https://avalon.example.com/?next=evil', 'a'.repeat(48), deps),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const start = await startWechat('https://avalon.example.com/', 'a'.repeat(48), deps);
    expect(new URL(start.url).searchParams.get('scope')).toBe('snsapi_base');
    await expect(finishWechat('code', start.state, 'b'.repeat(48), deps)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(await deps.store.get('oauth', start.state)).not.toBeNull();
  });
  it('consumes OAuth states atomically once, keeps OpenID and platform tokens private', async () => {
    let calls = 0;
    const deps = setup({
      fetch: (async () => {
        calls++;
        return new Response(
          JSON.stringify({
            openid: 'private-open-id',
            access_token: 'private-access-token',
            refresh_token: 'private-refresh-token',
          }),
        );
      }) as typeof fetch,
    });
    const start = await startWechat('https://avalon.example.com/', 'a'.repeat(48), deps);
    const results = await Promise.allSettled([
      finishWechat('code', start.state, 'a'.repeat(48), deps),
      finishWechat('code', start.state, 'a'.repeat(48), deps),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(calls).toBe(1);
    const success = results.find((result) => result.status === 'fulfilled')!;
    expect(JSON.stringify(success)).not.toContain('private-');
    expect(await deps.store.get('oauth', start.state)).toBeNull();
    const next = await startWechat('https://avalon.example.com/', 'a'.repeat(48), deps);
    const relogin = await finishWechat('new-code', next.state, 'a'.repeat(48), deps);
    expect(relogin.userId).toBe(success.status === 'fulfilled' ? success.value.userId : '');
  });
  it('rejects expired state without contacting WeChat and never returns API errors or secrets', async () => {
    let calls = 0;
    const deps = setup({
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ errcode: 40029, errmsg: 'platform secret detail' }));
      }) as typeof fetch,
    });
    const start = await startWechat('https://avalon.example.com/', 'a'.repeat(48), deps);
    await expect(
      finishWechat('code', start.state, 'a'.repeat(48), { ...deps, now: () => now + 11 * 60_000 }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(calls).toBe(0);
    const next = await startWechat('https://avalon.example.com/', 'a'.repeat(48), deps);
    await expect(finishWechat('code', next.state, 'a'.repeat(48), deps)).rejects.toThrow(
      '微信授权未完成',
    );
    expect(calls).toBe(1);
    expect(await deps.store.get('oauth', next.state)).toBeNull();
  });
});
